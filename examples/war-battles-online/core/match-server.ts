// The authoritative match server.
//
// It owns one `BattleWorld`, one session per connected client, and a roster of
// bots that fill whatever the humans have not taken. It is transport-agnostic:
// everything below talks to `GameTransport`, so the same server runs over the
// in-memory pair in a unit test, over Deno's QUIC endpoint in `server/`, or over
// anything else that implements the four methods.
//
// Admission authentication and its bounded restart ledger are injected as
// control-plane seams. They never participate in the fixed-step simulation.

import {
  INPUT_HISTORY_TICKS,
  MAX_PLAYERS,
  NETWORK_SNAPSHOT_BYTES,
  SNAPSHOT_BASE_HISTORY_FRAMES,
  SNAPSHOT_BYTES,
  TICK_RATE,
} from "./constants.ts";
import {
  CONTROL_BUY_UPGRADE,
  CONTROL_SET_WEAPON,
  CONTROL_SET_CHASSIS,
  CONTROL_SET_WEAPON_UPGRADE,
  INPUT_PACKET_BYTES,
  INPUT_BUNDLE_MAX_COMMANDS,
  CONTROL_SUICIDE,
  MESSAGE_CONTROL,
  MESSAGE_HELLO,
  MESSAGE_PING,
  MESSAGE_WELCOME_ACK,
  REJECT_FULL,
  REJECT_BAD_RESUME,
  REJECT_MAXIMUM_BYTES,
  REJECT_RATE_LIMITED,
  REJECT_VERSION,
  RESUME_TOKEN_BYTES,
  NETWORK_SNAPSHOT_MESSAGE_BYTES,
  SNAPSHOT_NORMAL_MAX_BYTES,
  SNAPSHOT_RECOVERY_INTERVAL_MILLISECONDS,
  SNAPSHOT_RECOVERY_MAX_BYTES,
  SNAPSHOT_KEYFRAME_INTERVAL,
  WELCOME_BYTES,
  createInputCommand,
  messageKind,
  readControl,
  readHello,
  readInputPacket,
  readPing,
  readWelcomeAck,
  writePing,
  writeReject,
  writeWelcome,
  type ControlMessage,
  type HelloMessage,
  type InputCommand,
  type PingMessage,
  type WelcomeAckMessage,
} from "./protocol.ts";
import { compactNetworkSnapshot, writeNetworkSnapshotDelta, writeNetworkSnapshotKeyframe } from "./snapshot.ts";
import { isWeaponId, isWeaponUpgradeId } from "./content.ts";
import { BotController } from "./bots.ts";
import { BattleWorld } from "./world.ts";
import {
  TRANSPORT_CHANNEL_CONTROL,
  TRANSPORT_CHANNEL_SESSION,
  TRANSPORT_CHANNEL_SNAPSHOT,
  type GameTransport,
  type ReliableChannel,
  type SendDisposition,
  type TransportReceiver,
} from "./transport.ts";
import { SessionTokenService, type SessionTokenProvider } from "./session-auth.ts";
import { SessionLedger } from "./session-persistence.ts";
import { MAX_TICK_SPAN, tickAfter, tickDeadline, tickNext } from "./ticks.ts";

export interface MatchServerOptions {
  readonly matchId?: number;
  readonly mapSeed?: number;
  /** Slots the match uses in total, humans plus bots. */
  readonly rosterSize?: number;
  /** Ticks between authoritative snapshots. 4 is 15 Hz at a 60 Hz tick. */
  readonly snapshotIntervalTicks?: number;
  readonly botSkill?: number;
  readonly teams?: boolean;
  /** Tick inputs accepted from one session per tick before it is throttled. */
  readonly inputBudgetPerTick?: number;
  /** Ticks a disconnected authenticated slot remains reserved for resume. */
  readonly resumeGraceTicks?: number;
  /** Legacy deterministic test seam; production callers should provide resumeKey. */
  readonly resumeSecret?: number;
  /** HMAC key material for authenticated resume credentials. */
  readonly resumeKey?: Uint8Array;
  /** Injected token service for key rotation or an external auth boundary. */
  readonly resumeTokenService?: SessionTokenProvider;
  /** Fixed-capacity durable admission ledger, restored by the host first. */
  readonly sessionLedger?: SessionLedger;
  /** Called after commit/release so a host can checkpoint outside the tick loop. */
  readonly onSessionStateChange?: (reason: "commit" | "release", tick: number) => void;
  readonly onError?: (error: unknown) => void;
  readonly onLog?: (line: string) => void;
  /** Monotonic-ish host clock for transport deadlines; injectable by deterministic harnesses. */
  readonly nowMilliseconds?: () => number;
}

export interface MatchServerStats {
  tick: number;
  humans: number;
  bots: number;
  snapshotsSent: number;
  snapshotBytesSent: number;
  snapshotNormalFramesSent: number;
  snapshotRecoveryFramesSent: number;
  snapshotFramesSkippedByBudget: number;
  inputsAccepted: number;
  inputsRejected: number;
  /** Valid authoritative commands first observed after their simulation tick. */
  inputsLate: number;
}

const SNAPSHOT_IN_FLIGHT_STREAMS = 8;
const SNAPSHOT_STALE_MILLISECONDS = 300;
// The ordered client stream can deliver several complete frames while the
// first HELLO is waiting on an asynchronous credential provider. Preserve the
// stream's order in a fixed-capacity queue instead of dispatching later control
// frames ahead of admission.
const RELIABLE_DISPATCH_CAPACITY = 32;
const RELIABLE_DISPATCH_BYTE_CAPACITY = 256 * 1024;

interface SnapshotStreamSend {
  readonly tick: number;
  readonly controller: AbortController;
  readonly staleAtMilliseconds: number;
}
const WELCOME_ACK_TIMEOUT_TICKS = TICK_RATE * 5;

export class MatchServer {
  readonly world: BattleWorld;
  readonly rosterSize: number;
  readonly snapshotIntervalTicks: number;
  readonly botSkill: number;
  readonly teams: boolean;
  readonly inputBudgetPerTick: number;
  readonly resumeGraceTicks: number;

  private readonly sessions = new Set<ServerSession>();
  /** Slot ownership: index is a slot, value is the owning session or undefined. */
  private readonly slotOwner: (ServerSession | undefined)[] = [];
  private readonly bots = new BotController();
  private readonly botCommand: InputCommand;
  private readonly snapshotBuffers: Uint8Array[] = [];
  private readonly snapshotTicks = new Uint32Array(SNAPSHOT_BASE_HISTORY_FRAMES);
  private readonly snapshotValid = new Uint8Array(SNAPSHOT_BASE_HISTORY_FRAMES);
  private snapshotBufferCursor = 0;
  private readonly onError: (error: unknown) => void;
  private readonly onLog: (line: string) => void;
  readonly nowMilliseconds: () => number;
  readonly resumeTokenService: SessionTokenProvider;
  readonly sessionLedger: SessionLedger;
  /** World ticks restart at zero; admission ticks continue from the checkpoint. */
  private sessionTickBase: number;
  private readonly onSessionStateChange: (reason: "commit" | "release", tick: number) => void;
  private nextSessionId = 1;
  private closed = false;

  readonly stats: MatchServerStats = {
    tick: 0,
    humans: 0,
    bots: 0,
    snapshotsSent: 0,
    snapshotBytesSent: 0,
    snapshotNormalFramesSent: 0,
    snapshotRecoveryFramesSent: 0,
    snapshotFramesSkippedByBudget: 0,
    inputsAccepted: 0,
    inputsRejected: 0,
    inputsLate: 0,
  };

  constructor(options: MatchServerOptions = {}) {
    const matchId = (options.matchId ?? 77) >>> 0;
    this.world = new BattleWorld(matchId, options.mapSeed);
    this.rosterSize = clampInteger(options.rosterSize ?? 8, 2, MAX_PLAYERS);
    this.snapshotIntervalTicks = clampInteger(options.snapshotIntervalTicks ?? 4, 1, 30);
    this.botSkill = clampInteger(options.botSkill ?? 2, 0, 3);
    this.teams = options.teams ?? false;
    this.inputBudgetPerTick = clampInteger(options.inputBudgetPerTick ?? 8, 1, 64);
    this.resumeGraceTicks = clampInteger(options.resumeGraceTicks ?? TICK_RATE * 30, 1, MAX_TICK_SPAN);
    this.onError = options.onError ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
    this.nowMilliseconds = options.nowMilliseconds ?? (() => performance.now());
    this.resumeTokenService =
      options.resumeTokenService ??
      new SessionTokenService({
        keys: [{ id: 1, secret: options.resumeKey ?? localDevelopmentResumeKey(options.resumeSecret) }],
      });
    this.sessionLedger =
      options.sessionLedger ??
      new SessionLedger({
        matchId,
        rosterSize: this.rosterSize,
        restartReservationTicks: this.resumeGraceTicks,
      });
    if (this.sessionLedger.matchId !== matchId || this.sessionLedger.rosterSize !== this.rosterSize) {
      throw new Error("session ledger context does not match the match server");
    }
    this.sessionTickBase = this.sessionLedger.persistedCheckpointTick;
    this.onSessionStateChange = options.onSessionStateChange ?? (() => {});
    this.botCommand = createInputCommand(matchId, 1);
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) this.slotOwner.push(undefined);
    for (let index = 0; index < SNAPSHOT_BASE_HISTORY_FRAMES; index += 1) {
      this.snapshotBuffers.push(new Uint8Array(SNAPSHOT_BYTES));
    }
    // Every slot is occupied from the first tick; a joining human takes one over
    // from a bot, so a match is never empty and never changes size mid-round.
    for (let playerId = 1; playerId <= this.rosterSize; playerId += 1) {
      this.world.addPlayer(playerId, this.teams ? (playerId <= this.rosterSize / 2 ? 1 : 2) : 0);
      this.world.setBotSkill(playerId, this.botSkill);
    }
    this.refreshStats();
  }

  /**
   * Creates a session. The returned object is the `TransportReceiver` the
   * transport must be built with; hand the finished transport back to
   * `session.attach` so the session can answer.
   */
  createSession(): ServerSession {
    const session = new ServerSession(this, this.nextSessionId);
    this.nextSessionId += 1;
    this.sessions.add(session);
    return session;
  }

  step(): void {
    if (this.closed) return;
    const tick = tickNext(this.world.tick);
    for (let playerId = 1; playerId <= this.rosterSize; playerId += 1) {
      const slot = playerId - 1;
      if (this.world.playerActive[slot] === 0) continue;
      if (this.slotOwner[slot] !== undefined) continue;
      this.botCommand.playerId = playerId;
      this.bots.stage(this.world, this.botCommand, playerId, tick);
      this.world.submitInput(this.botCommand);
    }
    for (const session of this.sessions) session.beginTick();
    this.world.step();
    this.stats.tick = this.world.tick;
    if (this.world.tick % this.snapshotIntervalTicks === 0) this.broadcastSnapshot();
  }

  /** Steps as many whole ticks as `elapsedMilliseconds` has paid for. */
  advance(elapsedMilliseconds: number, maximumSteps = 8): number {
    const steps = Math.min(maximumSteps, Math.max(0, Math.floor((elapsedMilliseconds * TICK_RATE) / 1000)));
    for (let step = 0; step < steps; step += 1) this.step();
    return steps;
  }

  close(code = 1000, reason = "server closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions) session.close(code, reason);
  }

  countHumans(): number {
    let humans = 0;
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) if (this.slotOwner[slot] !== undefined) humans += 1;
    return humans;
  }

  /** @internal Guards async admission continuations against a closed session. */
  ownsSlot(session: ServerSession, slot: number): boolean {
    return this.slotOwner[slot] === session && !session.closed;
  }

  /** Logical admission tick used by credentials and grace windows. */
  sessionTick(): number {
    return (this.sessionTickBase + this.world.tick) >>> 0;
  }

  /** Rebase admission time after restoring a world checkpoint. */
  rebaseSessionClock(): void {
    this.sessionTickBase = (this.sessionLedger.persistedCheckpointTick - this.world.tick) >>> 0;
  }

  // --- session plumbing -----------------------------------------------------

  /** @internal */
  async claimSlot(session: ServerSession, resumeToken: Uint8Array): Promise<number> {
    const hasResumeToken = !isZeroToken(resumeToken);
    if (hasResumeToken) {
      const claims = await this.resumeTokenService.verify(resumeToken, {
        matchId: this.world.matchId,
        nowTick: this.sessionTick(),
        rosterSize: this.rosterSize,
      });
      if (session.closed || !this.sessions.has(session)) return -1;
      const resumed = claims?.slot ?? -1;
      // A non-zero token is an explicit resume request. It must never fall
      // through to a fresh slot: accepting that fallback would turn a stale,
      // foreign, or forged credential into a different authenticated player.
      if (
        resumed < 0 ||
        claims === null ||
        this.sessionLedger.generation[resumed] !== claims.generation ||
        this.slotOwner[resumed] !== undefined ||
        !this.sessionLedger.isReserved(resumed, this.sessionTick())
      )
        return -1;
      this.slotOwner[resumed] = session;
      session.resumed = true;
      this.refreshStats();
      return resumed;
    }
    for (let slot = 0; slot < this.rosterSize; slot += 1) {
      if (this.slotOwner[slot] !== undefined) continue;
      // A slot that has already welcomed a human remains reserved through the
      // bounded resume grace period. Fresh anonymous joins may only take a slot
      // that has never authenticated, or one whose reservation has expired.
      if (this.sessionLedger.generation[slot] !== 0 && this.sessionLedger.isReserved(slot, this.sessionTick()))
        continue;
      this.slotOwner[slot] = session;
      // A human takes the slot over exactly as it stands: the bot's score, its
      // position and its ammunition all continue. Nothing is reset mid-round.
      this.refreshStats();
      return slot;
    }
    return -1;
  }

  /** @internal */
  releaseSlot(session: ServerSession): void {
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      if (this.slotOwner[slot] !== session) continue;
      this.slotOwner[slot] = undefined;
      // A failed welcome must not extend an already-expired credential. The
      // reservation is renewed only for a session whose own welcome committed;
      // a fresh takeover of an expired slot leaves its old token stale.
      if (this.sessionLedger.generation[slot] !== 0 && session.resumeCommitted) {
        this.sessionLedger.reserveFor(slot, this.sessionTick(), this.resumeGraceTicks);
        this.onSessionStateChange("release", this.sessionTick());
      }
    }
    this.sessions.delete(session);
    this.refreshStats();
  }

  /** @internal Issues and commits an authenticated credential. */
  async issueResumeToken(slot: number, target: Uint8Array): Promise<void> {
    const generation = await this.prepareResumeToken(slot, target);
    this.commitResumeToken(slot, generation, target);
  }

  /** @internal Stages a token for a welcome without invalidating the current one. */
  async prepareResumeToken(slot: number, target: Uint8Array): Promise<number> {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.rosterSize)
      throw new RangeError("resume slot is outside the roster");
    if (target.byteLength !== RESUME_TOKEN_BYTES) throw new RangeError("resume token target has the wrong size");
    const generation = (this.sessionLedger.generation[slot]! + 1) >>> 0 || 1;
    const token = await this.resumeTokenService.issue({
      matchId: this.world.matchId,
      slot,
      generation,
      issuedAtTick: this.sessionTick(),
      expiresAtTick: 0,
    });
    if (token.byteLength !== RESUME_TOKEN_BYTES) {
      throw new Error(`resume token provider returned ${token.byteLength} bytes; expected ${RESUME_TOKEN_BYTES}`);
    }
    target.set(token);
    return generation;
  }

  /** @internal Commits the staged token only after the client echoes it. */
  commitResumeToken(slot: number, generation: number, token: Uint8Array): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.rosterSize)
      throw new RangeError("resume slot is outside the roster");
    if (token.byteLength !== RESUME_TOKEN_BYTES) throw new RangeError("resume token has the wrong size");
    const expected = (this.sessionLedger.generation[slot]! + 1) >>> 0 || 1;
    if (generation !== expected) throw new Error("resume token generation is stale");
    this.sessionLedger.commit(slot, generation);
    this.onSessionStateChange("commit", this.sessionTick());
  }

  private refreshStats(): void {
    this.stats.humans = this.countHumans();
    this.stats.bots = this.rosterSize - this.stats.humans;
  }

  private broadcastSnapshot(): void {
    const index = this.snapshotBufferCursor;
    const buffer = this.snapshotBuffers[index]!;
    this.snapshotBufferCursor = (this.snapshotBufferCursor + 1) % SNAPSHOT_BASE_HISTORY_FRAMES;
    this.world.writeSnapshot(buffer);
    this.snapshotTicks[index] = this.world.tick;
    this.snapshotValid[index] = 1;
    for (const session of this.sessions) {
      if (!session.ready) continue;
      if (session.sendSnapshot(buffer, this.world.tick)) this.stats.snapshotsSent += 1;
    }
  }

  /** @internal Returns an immutable-for-the-current-ring-turn snapshot base. */
  snapshotAt(tick: number): Uint8Array | undefined {
    for (let index = 0; index < SNAPSHOT_BASE_HISTORY_FRAMES; index += 1) {
      if (this.snapshotValid[index] !== 0 && this.snapshotTicks[index] === tick >>> 0) {
        return this.snapshotBuffers[index];
      }
    }
    return undefined;
  }

  /** @internal */
  report(error: unknown): void {
    this.onError(error);
  }

  /** @internal */
  log(line: string): void {
    this.onLog(line);
  }
}

/** One connected client, from the server's side. */
export class ServerSession implements TransportReceiver {
  readonly server: MatchServer;
  slot = -1;
  name = "";
  /** True when the hello resumed a previously welcomed slot. */
  resumed = false;
  /** True only after this session's welcome has been delivered and committed. */
  resumeCommitted = false;
  ready = false;
  closed = false;
  readonly diagnosticId: number;

  private transport?: GameTransport;
  private readonly hello: HelloMessage = {
    clientSalt: 0,
    name: "",
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
    preferredTeam: 0,
  };
  private readonly control: ControlMessage = { action: 0, argument: 0 };
  private readonly ping: PingMessage = { clientTime: 0, serverTick: 0 };
  private readonly welcomeAck: WelcomeAckMessage = { resumeToken: new Uint8Array(RESUME_TOKEN_BYTES) };
  private readonly command: InputCommand;
  /** Exact accepted ticks distinguish redundant old copies from true late arrivals. */
  private readonly acceptedInputTicks = new Float64Array(INPUT_HISTORY_TICKS);
  /** Exact late ticks ensure a redundant bundle cannot inflate late accounting. */
  private readonly lateInputTicks = new Float64Array(INPUT_HISTORY_TICKS);
  private readonly welcomeBuffer = new Uint8Array(WELCOME_BYTES);
  private readonly rejectBuffer = new Uint8Array(REJECT_MAXIMUM_BYTES);
  private readonly pingBuffer = new Uint8Array(12);
  private readonly resumeToken = new Uint8Array(RESUME_TOKEN_BYTES);
  private readonly snapshotBaseline = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  private readonly snapshotCurrent = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  private readonly snapshotFrame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  private snapshotBaselineTick = -1;
  private snapshotFramesSinceKeyframe = 0;
  private forceSnapshotKeyframe = true;
  private readonly snapshotSends: Array<SnapshotStreamSend | undefined> = Array.from({
    length: SNAPSHOT_IN_FLIGHT_STREAMS,
  });
  private snapshotSendCursor = 0;
  private nextSnapshotRecoveryAtMilliseconds = 0;
  private inputBudget = 0;
  /** Closes the double-hello race while async HMAC verification is pending. */
  private sessionHandling = false;
  private readonly reliableDispatchChannels = new Uint8Array(RELIABLE_DISPATCH_CAPACITY);
  private readonly reliableDispatchPayloads: Array<Uint8Array | undefined> = Array.from({
    length: RELIABLE_DISPATCH_CAPACITY,
  });
  private reliableDispatchHead = 0;
  private reliableDispatchSize = 0;
  private reliableDispatchBytes = 0;
  private reliableDispatchActive = false;
  // QUIC datagrams are unordered relative to the reliable session stream. Keep
  // exactly the latest bounded bundle that arrives after WELCOME but before
  // WELCOME_ACK, then admit it on the first authoritative tick after the ACK.
  private readonly preReadyInput = new Uint8Array(INPUT_PACKET_BYTES * INPUT_BUNDLE_MAX_COMMANDS);
  private preReadyInputBytes = 0;
  private awaitingWelcomeAck = false;
  private stagedResumeGeneration = 0;
  private welcomeAckDeadline = 0;

  constructor(server: MatchServer, diagnosticId: number) {
    this.server = server;
    this.diagnosticId = diagnosticId;
    this.command = createInputCommand(server.world.matchId, 1);
    this.acceptedInputTicks.fill(-1);
    this.lateInputTicks.fill(-1);
  }

  attach(transport: GameTransport): void {
    this.transport = transport;
  }

  /** @internal */
  beginTick(): void {
    this.expireStaleSnapshots(this.server.nowMilliseconds());
    if (this.awaitingWelcomeAck && tickAfter(this.server.sessionTick(), this.welcomeAckDeadline)) {
      this.close(4_008, "welcome acknowledgement timeout");
      return;
    }
    this.inputBudget = this.server.inputBudgetPerTick;
    if (this.ready && this.preReadyInputBytes > 0) {
      const byteLength = this.preReadyInputBytes;
      this.preReadyInputBytes = 0;
      try {
        this.handleInput(this.preReadyInput, byteLength);
      } catch (error: unknown) {
        this.server.stats.inputsRejected += 1;
        this.server.report(error);
      }
    }
  }

  onReliable(channel: ReliableChannel, payload: Uint8Array): void {
    if (this.closed) return;
    if (
      this.reliableDispatchSize >= RELIABLE_DISPATCH_CAPACITY ||
      this.reliableDispatchBytes + payload.byteLength > RELIABLE_DISPATCH_BYTE_CAPACITY
    ) {
      this.server.report(new Error("ordered reliable dispatch capacity exceeded"));
      this.close(4_003, "protocol queue capacity exceeded");
      return;
    }
    const tail = (this.reliableDispatchHead + this.reliableDispatchSize) % RELIABLE_DISPATCH_CAPACITY;
    this.reliableDispatchChannels[tail] = channel;
    // Every transport hands ownership of this immutable frame to the receiver;
    // retaining the reference avoids a second copy while admission is pending.
    this.reliableDispatchPayloads[tail] = payload;
    this.reliableDispatchSize += 1;
    this.reliableDispatchBytes += payload.byteLength;
    if (this.reliableDispatchActive) return;
    this.reliableDispatchActive = true;
    void this.drainReliableDispatch();
  }

  onDatagram(payload: Uint8Array): void {
    try {
      if (!this.ready && this.awaitingWelcomeAck && this.slot >= 0) {
        this.requireInputBundleSize(payload.byteLength, payload.byteLength);
        this.preReadyInput.set(payload, 0);
        this.preReadyInputBytes = payload.byteLength;
        return;
      }
      this.handleInput(payload);
    } catch (error: unknown) {
      // A malformed datagram is dropped rather than closing the session: on an
      // unreliable lane, one bad packet is not evidence of a bad peer.
      this.server.stats.inputsRejected += 1;
      this.server.report(error);
    }
  }

  onClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (let index = 0; index < this.snapshotSends.length; index += 1) {
      const send = this.snapshotSends[index];
      if (send === undefined) continue;
      send.controller.abort("session closed");
      this.snapshotSends[index] = undefined;
    }
    this.sessionHandling = false;
    this.clearReliableDispatch();
    this.preReadyInputBytes = 0;
    this.ready = false;
    this.server.log(`session-closed:${code}:${reason}:session=${this.diagnosticId}:slot=${this.slot + 1}`);
    this.server.releaseSlot(this);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.transport?.close(code, reason);
    this.onClose(code, reason);
  }

  /** @internal */
  sendReliable(
    channel: ReliableChannel,
    payload: Uint8Array,
    onDisposition?: (disposition: SendDisposition) => void,
  ): void {
    const transport = this.transport;
    if (transport === undefined || this.closed) return;
    void transport.sendReliable(channel, payload).then(
      (disposition) => {
        onDisposition?.(disposition);
        if (disposition === "closed") this.onClose(1_001, "transport closed");
      },
      (error: unknown) => {
        onDisposition?.("closed");
        this.server.report(error);
      },
    );
  }

  /**
   * Encodes one bounded authoritative frame for this session. Baselines are
   * session-local because a late joiner starts with a keyframe while an
   * established client can receive a compact delta stream.
   */
  sendSnapshot(source: Uint8Array, tick: number): boolean {
    const transport = this.transport;
    if (transport === undefined || this.closed) return false;
    const now = this.server.nowMilliseconds();
    this.expireStaleSnapshots(now);
    // The client retains the same fixed 64-frame history as the server. An
    // ACK may lag the newest send by more than the eight-stream window while
    // still remaining a valid delta base; throttling at eight frames created a
    // false ~3 Hz ceiling on healthy high-RTT links. Only the actual history
    // bound forces recovery to a keyframe.
    if (this.snapshotBaselineTick >= 0) {
      const acknowledgedAgeTicks = (tick - this.snapshotBaselineTick) >>> 0;
      const historyAgeTicks = this.server.snapshotIntervalTicks * (SNAPSHOT_BASE_HISTORY_FRAMES - 1);
      if (acknowledgedAgeTicks >= historyAgeTicks) this.forceSnapshotKeyframe = true;
    }
    compactNetworkSnapshot(source, this.snapshotCurrent);
    let length = -1;
    let keyframe = false;
    if (
      this.snapshotBaselineTick >= 0 &&
      !this.forceSnapshotKeyframe &&
      this.snapshotFramesSinceKeyframe < SNAPSHOT_KEYFRAME_INTERVAL - 1
    ) {
      length = writeNetworkSnapshotDelta(
        this.snapshotFrame,
        tick,
        this.snapshotBaselineTick,
        this.snapshotBaseline,
        this.snapshotCurrent,
      );
    }
    if (length < 0) {
      length = writeNetworkSnapshotKeyframe(this.snapshotFrame, tick, this.snapshotCurrent);
      keyframe = true;
    }
    if (length > SNAPSHOT_RECOVERY_MAX_BYTES) {
      const error = new RangeError(
        `snapshot frame ${length} exceeds the ${SNAPSHOT_RECOVERY_MAX_BYTES}-byte recovery ceiling`,
      );
      this.server.report(error);
      this.close(4_003, "snapshot recovery ceiling exceeded");
      return false;
    }
    const recovery = length > SNAPSHOT_NORMAL_MAX_BYTES;
    if (recovery && now < this.nextSnapshotRecoveryAtMilliseconds) {
      this.server.stats.snapshotFramesSkippedByBudget += 1;
      if (keyframe) this.forceSnapshotKeyframe = true;
      return false;
    }
    // Only an admitted replacement supersedes older state. In particular, a
    // recovery frame denied by its one-per-second budget must not cancel the
    // last frame still crossing the transport boundary.
    for (const send of this.snapshotSends) {
      if (send !== undefined && !send.controller.signal.aborted) {
        send.controller.abort("snapshot superseded by newer state");
      }
    }
    let streamSlot = -1;
    for (let offset = 0; offset < this.snapshotSends.length; offset += 1) {
      const candidate = (this.snapshotSendCursor + offset) % this.snapshotSends.length;
      if (this.snapshotSends[candidate] !== undefined) continue;
      streamSlot = candidate;
      this.snapshotSendCursor = (candidate + 1) % this.snapshotSends.length;
      break;
    }
    if (streamSlot < 0) return false;
    if (recovery) {
      this.nextSnapshotRecoveryAtMilliseconds = now + SNAPSHOT_RECOVERY_INTERVAL_MILLISECONDS;
      this.server.stats.snapshotRecoveryFramesSent += 1;
    } else {
      this.server.stats.snapshotNormalFramesSent += 1;
    }
    this.server.stats.snapshotBytesSent += length;
    if (keyframe) {
      this.forceSnapshotKeyframe = this.snapshotBaselineTick < 0;
      this.snapshotFramesSinceKeyframe = 0;
    } else {
      this.snapshotFramesSinceKeyframe += 1;
    }
    // Every state packet owns an independent QUIC stream. Streams may finish
    // out of order without QUIC stream-order head-of-line blocking; newer
    // state supersedes any unfinished older write. The stale deadline and
    // fixed ring remain the hard bound when a host ignores cancellation.
    const controller = new AbortController();
    const send: SnapshotStreamSend = {
      tick,
      controller,
      staleAtMilliseconds: now + SNAPSHOT_STALE_MILLISECONDS,
    };
    this.snapshotSends[streamSlot] = send;
    void transport
      .sendReliable(TRANSPORT_CHANNEL_SNAPSHOT, this.snapshotFrame.subarray(0, length), controller.signal)
      .then(
        (disposition) => {
          if (this.snapshotSends[streamSlot] === send) {
            this.snapshotSends[streamSlot] = undefined;
          }
          if (disposition === "closed") {
            this.onClose(1_001, "transport closed");
          }
        },
        (error: unknown) => {
          if (this.snapshotSends[streamSlot] === send) {
            this.snapshotSends[streamSlot] = undefined;
          }
          this.server.report(error);
        },
      );
    return true;
  }

  private async handleSession(payload: Uint8Array): Promise<void> {
    const kind = messageKind(payload);
    if (kind === MESSAGE_PING) {
      if (!this.ready) throw new Error("session message before hello");
      readPing(payload, this.ping);
      this.ping.serverTick = this.server.world.tick;
      writePing(this.pingBuffer, this.ping, true);
      this.sendReliable(TRANSPORT_CHANNEL_SESSION, this.pingBuffer);
      return;
    }
    if (kind === MESSAGE_WELCOME_ACK) {
      this.handleWelcomeAck(payload);
      return;
    }
    if (kind !== MESSAGE_HELLO) throw new Error("first session message must be a hello");
    if (this.ready || this.sessionHandling) throw new Error("session handshake already established or pending");
    this.sessionHandling = true;
    readHello(payload, this.hello);
    const slot = await this.server.claimSlot(this, this.hello.resumeToken);
    if (slot < 0) {
      const hasResumeToken = !isZeroToken(this.hello.resumeToken);
      const length = writeReject(
        this.rejectBuffer,
        hasResumeToken
          ? { code: REJECT_BAD_RESUME, reason: "resume token is invalid, stale, or belongs to another match" }
          : { code: REJECT_FULL, reason: "match is full" },
      );
      this.sendReliable(TRANSPORT_CHANNEL_SESSION, this.rejectBuffer.subarray(0, length));
      this.close(hasResumeToken ? 4_005 : 4_004, hasResumeToken ? "resume refused" : "match is full");
      return;
    }
    this.slot = slot;
    this.name = this.hello.name === "" ? `player${slot + 1}` : this.hello.name;
    const stagedResumeGeneration = await this.server.prepareResumeToken(slot, this.resumeToken);
    if (this.closed || !this.server.ownsSlot(this, slot)) return;
    writeWelcome(this.welcomeBuffer, {
      matchId: this.server.world.matchId,
      playerId: slot + 1,
      team: this.server.world.playerTeam[slot]!,
      maximumPlayers: this.server.rosterSize,
      botCount: this.server.rosterSize - this.server.countHumans(),
      mapSeed: this.server.world.mapSeed,
      serverTick: this.server.world.tick,
      tickRate: TICK_RATE,
      snapshotIntervalTicks: this.server.snapshotIntervalTicks,
      resumeToken: this.resumeToken,
    });
    this.stagedResumeGeneration = stagedResumeGeneration;
    this.awaitingWelcomeAck = true;
    this.welcomeAckDeadline = tickDeadline(this.server.sessionTick(), WELCOME_ACK_TIMEOUT_TICKS);
    // The client can send its first datagram immediately after processing the
    // welcome, before the match's next fixed tick calls beginTick(). Grant the
    // same bounded initial budget here so a healthy first input is not mistaken
    // for a rate-limit violation.
    this.inputBudget = this.server.inputBudgetPerTick;
    this.sendReliable(TRANSPORT_CHANNEL_SESSION, this.welcomeBuffer, (disposition) => {
      if (disposition === "sent" && !this.closed) return;
      // The staged credential was never made current. Release the slot so an
      // initial join can retry anonymously and an established player can retry
      // with its previous credential during the normal grace window.
      this.close(1_001, "welcome delivery failed");
    });
  }

  private async drainReliableDispatch(): Promise<void> {
    try {
      while (!this.closed && this.reliableDispatchSize > 0) {
        const index = this.reliableDispatchHead;
        const channel = this.reliableDispatchChannels[index]! as ReliableChannel;
        const payload = this.reliableDispatchPayloads[index]!;
        this.reliableDispatchPayloads[index] = undefined;
        this.reliableDispatchHead = (index + 1) % RELIABLE_DISPATCH_CAPACITY;
        this.reliableDispatchSize -= 1;
        this.reliableDispatchBytes -= payload.byteLength;
        if (channel === TRANSPORT_CHANNEL_SESSION) await this.handleSession(payload);
        else if (channel === TRANSPORT_CHANNEL_CONTROL) this.handleControl(payload);
        else if (channel === 4) this.handleInput(payload);
        else throw new Error(`client sent an unexpected reliable channel ${channel}`);
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.server.report(
        new Error(
          `reliable-dispatch:session=${this.diagnosticId}:slot=${this.slot + 1}:ready=${this.ready}:` +
            `awaiting-ack=${this.awaitingWelcomeAck}:${detail}`,
        ),
      );
      this.close(4_003, "protocol error");
    } finally {
      this.reliableDispatchActive = false;
      // A transport callback can enqueue reentrantly while the last handler is
      // settling. Restart exactly once if work arrived after the loop's check.
      if (!this.closed && this.reliableDispatchSize > 0) {
        this.reliableDispatchActive = true;
        void this.drainReliableDispatch();
      }
    }
  }

  private clearReliableDispatch(): void {
    for (let offset = 0; offset < this.reliableDispatchSize; offset += 1) {
      const index = (this.reliableDispatchHead + offset) % RELIABLE_DISPATCH_CAPACITY;
      this.reliableDispatchPayloads[index] = undefined;
    }
    this.reliableDispatchHead = 0;
    this.reliableDispatchSize = 0;
    this.reliableDispatchBytes = 0;
  }

  private handleWelcomeAck(payload: Uint8Array): void {
    if (!this.awaitingWelcomeAck || this.ready || this.slot < 0) {
      throw new Error("unexpected welcome acknowledgement");
    }
    readWelcomeAck(payload, this.welcomeAck);
    if (!equalBytes(this.welcomeAck.resumeToken, this.resumeToken)) {
      throw new Error("welcome acknowledgement credential mismatch");
    }
    this.server.commitResumeToken(this.slot, this.stagedResumeGeneration, this.resumeToken);
    this.awaitingWelcomeAck = false;
    this.stagedResumeGeneration = 0;
    this.welcomeAckDeadline = 0;
    this.resumeCommitted = true;
    this.ready = true;
    this.server.log(`session-joined:${this.name}:slot=${this.slot + 1}`);
  }

  private handleControl(payload: Uint8Array): void {
    if (!this.ready) {
      throw new Error(
        this.slot < 0 ? "control message before hello" : "control message before welcome acknowledgement",
      );
    }
    if (messageKind(payload) !== MESSAGE_CONTROL) throw new Error("control lane carried a non-control message");
    readControl(payload, this.control);
    const playerId = this.slot + 1;
    if (this.control.action === CONTROL_BUY_UPGRADE) {
      this.server.world.applyUpgrade(playerId, this.control.argument);
    } else if (this.control.action === CONTROL_SET_WEAPON) {
      if (isWeaponId(this.control.argument)) this.server.world.playerWeaponRequest[this.slot] = this.control.argument;
    } else if (this.control.action === CONTROL_SET_CHASSIS) {
      this.server.world.selectChassis(playerId, this.control.argument);
    } else if (this.control.action === CONTROL_SET_WEAPON_UPGRADE) {
      if (isWeaponUpgradeId(this.control.argument))
        this.server.world.applyWeaponUpgrade(playerId, this.control.argument);
    } else if (this.control.action === CONTROL_SUICIDE) {
      this.server.world.playerHealth[this.slot] = 0;
    }
  }

  private handleInput(payload: Uint8Array, byteLength = payload.byteLength): void {
    if (!this.ready) return;
    this.requireInputBundleSize(byteLength, payload.byteLength);
    if (this.inputBudget <= 0) {
      // A client flooding the input lane is throttled, not disconnected: the
      // honest cause is a burst after a stall.
      this.server.stats.inputsRejected += 1;
      const length = writeReject(this.rejectBuffer, { code: REJECT_RATE_LIMITED, reason: "input rate exceeded" });
      if (this.inputBudget === 0) this.sendReliable(TRANSPORT_CHANNEL_CONTROL, this.rejectBuffer.subarray(0, length));
      this.inputBudget = -1;
      return;
    }
    this.inputBudget -= 1;
    // Commands are oldest-first. Already-consumed redundancy is a benign
    // duplicate, not a protocol rejection; future commands are still staged so
    // one lost datagram does not create a movement hole.
    for (let offset = 0; offset < byteLength; offset += INPUT_PACKET_BYTES) {
      readInputPacket(payload, offset, this.command);
      // A session may only ever move its own tank, whatever the packet says.
      if (this.command.playerId !== this.slot + 1) {
        this.server.stats.inputsRejected += 1;
        continue;
      }
      if (
        this.command.matchId !== this.server.world.matchId ||
        tickAfter(this.command.tick, tickDeadline(this.server.world.tick, INPUT_HISTORY_TICKS - 1))
      ) {
        this.server.stats.inputsRejected += 1;
        continue;
      }
      this.observeSnapshotAcknowledgement(this.command);
      const acceptedSlot = this.command.tick % this.acceptedInputTicks.length;
      if (!tickAfter(this.command.tick, this.server.world.tick)) {
        if (
          this.acceptedInputTicks[acceptedSlot] !== this.command.tick &&
          this.lateInputTicks[acceptedSlot] !== this.command.tick
        ) {
          this.lateInputTicks[acceptedSlot] = this.command.tick;
          this.server.stats.inputsLate += 1;
        }
        continue;
      }
      if (this.server.world.submitInput(this.command)) {
        this.acceptedInputTicks[acceptedSlot] = this.command.tick;
        this.server.stats.inputsAccepted += 1;
      }
      // A false result after the explicit authority/time checks is an older
      // copy of a future command already staged by another redundant bundle.
      // Treat that as successful loss protection, not hostile input.
    }
  }

  private requireInputBundleSize(byteLength: number, capacity: number): void {
    if (
      byteLength === 0 ||
      byteLength > capacity ||
      byteLength % INPUT_PACKET_BYTES !== 0 ||
      byteLength > INPUT_PACKET_BYTES * INPUT_BUNDLE_MAX_COMMANDS
    ) {
      throw new Error(
        byteLength < INPUT_PACKET_BYTES
          ? "input packet is truncated"
          : "input packet has trailing bytes or too many bundled commands",
      );
    }
  }

  private observeSnapshotAcknowledgement(command: Readonly<InputCommand>): void {
    if ((command.snapshotAckBits & 1) === 0) return;
    if (this.snapshotBaselineTick >= 0 && !tickAfter(command.latestSnapshotTick, this.snapshotBaselineTick)) return;
    if (tickAfter(command.latestSnapshotTick, this.server.world.tick)) return;
    const acknowledged = this.server.snapshotAt(command.latestSnapshotTick);
    if (acknowledged === undefined) return;
    compactNetworkSnapshot(acknowledged, this.snapshotBaseline);
    this.snapshotBaselineTick = command.latestSnapshotTick;
    this.forceSnapshotKeyframe = false;
    for (let index = 0; index < this.snapshotSends.length; index += 1) {
      const send = this.snapshotSends[index];
      if (send === undefined || tickAfter(send.tick, this.snapshotBaselineTick)) continue;
      send.controller.abort("snapshot acknowledged");
      this.snapshotSends[index] = undefined;
    }
  }

  private expireStaleSnapshots(now: number): void {
    for (let index = 0; index < this.snapshotSends.length; index += 1) {
      const send = this.snapshotSends[index];
      if (send === undefined || now < send.staleAtMilliseconds) continue;
      send.controller.abort("stale snapshot");
      if (this.snapshotSends[index] === send) this.snapshotSends[index] = undefined;
    }
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer)) return minimum;
  return integer < minimum ? minimum : integer > maximum ? maximum : integer;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function isZeroToken(token: Uint8Array): boolean {
  if (token.byteLength !== RESUME_TOKEN_BYTES) return false;
  for (let index = 0; index < RESUME_TOKEN_BYTES; index += 1) if (token[index] !== 0) return false;
  return true;
}

function localDevelopmentResumeKey(seed: number | undefined): Uint8Array {
  const key = new Uint8Array(32);
  if (seed !== undefined) {
    let state = seed >>> 0;
    for (let index = 0; index < key.length; index += 1) {
      state = (Math.imul(state ^ index, 0x2545_f491) >>> 0) ^ (state >>> 13);
      key[index] = state & 0xff;
    }
    return key;
  }
  // Local development still gets an unpredictable bearer secret. Production
  // hosts should inject a rotated secret from their secret manager.
  globalThis.crypto.getRandomValues(key);
  return key;
}

/** Exported so a host can size its own buffers without importing the layout. */
export const SERVER_SNAPSHOT_MESSAGE_BYTES = NETWORK_SNAPSHOT_MESSAGE_BYTES;
export const SERVER_SNAPSHOT_BODY_BYTES = SNAPSHOT_BYTES;
export const SERVER_REJECT_VERSION = REJECT_VERSION;
