// The authoritative match server.
//
// It owns one `BattleWorld`, one session per connected client, and a roster of
// bots that fill whatever the humans have not taken. It is transport-agnostic:
// everything below talks to `GameTransport`, so the same server runs over the
// in-memory pair in a unit test, over Deno's QUIC endpoint in `server/`, or over
// anything else that implements the four methods.
//
// What is deliberately NOT here, and what a deployment must add: authentication,
// matchmaking, persistence, and a signed resume token. `issueResumeToken` below
// is a non-cryptographic placeholder that proves the resume *path*, not the
// resume *security*; see the comment on it.

import {
  MAX_PLAYERS,
  SNAPSHOT_BYTES,
  TICK_RATE,
} from "./constants.ts";
import {
  CONTROL_BUY_UPGRADE,
  CONTROL_SET_WEAPON,
  INPUT_PACKET_BYTES,
  CONTROL_SUICIDE,
  MESSAGE_CONTROL,
  MESSAGE_HELLO,
  MESSAGE_PING,
  REJECT_FULL,
  REJECT_MAXIMUM_BYTES,
  REJECT_RATE_LIMITED,
  REJECT_VERSION,
  RESUME_TOKEN_BYTES,
  SNAPSHOT_BODY_OFFSET,
  SNAPSHOT_MESSAGE_BYTES,
  WELCOME_BYTES,
  createInputCommand,
  messageKind,
  readControl,
  readHello,
  readInputPacket,
  readPing,
  writePing,
  writeReject,
  writeSnapshotHeader,
  writeWelcome,
  type ControlMessage,
  type HelloMessage,
  type InputCommand,
  type PingMessage,
} from "./protocol.ts";
import { isWeaponId } from "./content.ts";
import { BotController } from "./bots.ts";
import { BattleWorld } from "./world.ts";
import {
  TRANSPORT_CHANNEL_CONTROL,
  TRANSPORT_CHANNEL_SESSION,
  TRANSPORT_CHANNEL_SNAPSHOT,
  type GameTransport,
  type ReliableChannel,
  type TransportReceiver,
} from "./transport.ts";

export interface MatchServerOptions {
  readonly matchId?: number;
  readonly mapSeed?: number;
  /** Slots the match uses in total, humans plus bots. */
  readonly rosterSize?: number;
  /** Ticks between authoritative snapshots. 3 is 20 Hz at a 60 Hz tick. */
  readonly snapshotIntervalTicks?: number;
  readonly botSkill?: number;
  readonly teams?: boolean;
  /** Tick inputs accepted from one session per tick before it is throttled. */
  readonly inputBudgetPerTick?: number;
  readonly onError?: (error: unknown) => void;
  readonly onLog?: (line: string) => void;
}

export interface MatchServerStats {
  tick: number;
  humans: number;
  bots: number;
  snapshotsSent: number;
  inputsAccepted: number;
  inputsRejected: number;
}

const SNAPSHOT_BUFFER_RING = 8;

export class MatchServer {
  readonly world: BattleWorld;
  readonly rosterSize: number;
  readonly snapshotIntervalTicks: number;
  readonly botSkill: number;
  readonly teams: boolean;
  readonly inputBudgetPerTick: number;

  private readonly sessions = new Set<ServerSession>();
  /** Slot ownership: index is a slot, value is the owning session or undefined. */
  private readonly slotOwner: (ServerSession | undefined)[] = [];
  private readonly bots = new BotController();
  private readonly botCommand: InputCommand;
  private readonly snapshotBuffers: Uint8Array[] = [];
  private snapshotBufferCursor = 0;
  private readonly onError: (error: unknown) => void;
  private readonly onLog: (line: string) => void;
  private readonly salt: number;
  private closed = false;

  readonly stats: MatchServerStats = {
    tick: 0, humans: 0, bots: 0, snapshotsSent: 0, inputsAccepted: 0, inputsRejected: 0,
  };

  constructor(options: MatchServerOptions = {}) {
    const matchId = (options.matchId ?? 77) >>> 0;
    this.world = new BattleWorld(matchId, options.mapSeed);
    this.rosterSize = clampInteger(options.rosterSize ?? 8, 2, MAX_PLAYERS);
    this.snapshotIntervalTicks = clampInteger(options.snapshotIntervalTicks ?? 3, 1, 30);
    this.botSkill = clampInteger(options.botSkill ?? 2, 0, 3);
    this.teams = options.teams ?? false;
    this.inputBudgetPerTick = clampInteger(options.inputBudgetPerTick ?? 8, 1, 64);
    this.onError = options.onError ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
    this.salt = (matchId * 0x9e37_79b1) >>> 0;
    this.botCommand = createInputCommand(matchId, 1);
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) this.slotOwner.push(undefined);
    for (let index = 0; index < SNAPSHOT_BUFFER_RING; index += 1) {
      this.snapshotBuffers.push(new Uint8Array(SNAPSHOT_MESSAGE_BYTES));
    }
    // Every slot is occupied from the first tick; a joining human takes one over
    // from a bot, so a match is never empty and never changes size mid-round.
    for (let playerId = 1; playerId <= this.rosterSize; playerId += 1) {
      this.world.addPlayer(playerId, this.teams ? (playerId <= this.rosterSize / 2 ? 1 : 2) : 0);
      this.world.setBotSkill(playerId, this.botSkill);
    }
  }

  /**
   * Creates a session. The returned object is the `TransportReceiver` the
   * transport must be built with; hand the finished transport back to
   * `session.attach` so the session can answer.
   */
  createSession(): ServerSession {
    const session = new ServerSession(this);
    this.sessions.add(session);
    return session;
  }

  step(): void {
    if (this.closed) return;
    const tick = this.world.tick + 1;
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
    for (const session of [...this.sessions]) session.close(code, reason);
  }

  countHumans(): number {
    let humans = 0;
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) if (this.slotOwner[slot] !== undefined) humans += 1;
    return humans;
  }

  // --- session plumbing -----------------------------------------------------

  /** @internal */
  claimSlot(session: ServerSession, resumeToken: Uint8Array): number {
    const resumed = this.slotForToken(resumeToken);
    if (resumed >= 0 && this.slotOwner[resumed] === undefined) {
      this.slotOwner[resumed] = session;
      this.refreshStats();
      return resumed;
    }
    for (let slot = 0; slot < this.rosterSize; slot += 1) {
      if (this.slotOwner[slot] !== undefined) continue;
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
      if (this.slotOwner[slot] === session) this.slotOwner[slot] = undefined;
    }
    this.sessions.delete(session);
    this.refreshStats();
  }

  /**
   * @internal
   * A placeholder resume token: a keyed hash of the match, the slot and a
   * process-lifetime salt. It is NOT a signed credential - anyone who can see a
   * token can reuse it, and anyone who can guess the salt can forge one. A
   * deployment must replace this with a token minted and verified by whatever
   * authenticates the player. It exists so that the reconnect *path* has a real
   * implementation to exercise, and it is called out here rather than buried.
   */
  issueResumeToken(slot: number, target: Uint8Array): void {
    let state = (this.salt ^ (slot * 0x85eb_ca6b)) >>> 0;
    for (let index = 0; index < RESUME_TOKEN_BYTES; index += 1) {
      state = (Math.imul(state ^ index, 0x2545_f491) >>> 0) ^ (state >>> 13);
      target[index] = state & 0xff;
    }
  }

  private slotForToken(token: Uint8Array): number {
    const candidate = new Uint8Array(RESUME_TOKEN_BYTES);
    let empty = true;
    for (let index = 0; index < RESUME_TOKEN_BYTES; index += 1) if (token[index] !== 0) empty = false;
    if (empty) return -1;
    for (let slot = 0; slot < this.rosterSize; slot += 1) {
      this.issueResumeToken(slot, candidate);
      let match = true;
      for (let index = 0; index < RESUME_TOKEN_BYTES; index += 1) {
        if (candidate[index] !== token[index]) { match = false; break; }
      }
      if (match) return slot;
    }
    return -1;
  }

  private refreshStats(): void {
    this.stats.humans = this.countHumans();
    this.stats.bots = this.rosterSize - this.stats.humans;
  }

  private broadcastSnapshot(): void {
    const buffer = this.snapshotBuffers[this.snapshotBufferCursor]!;
    this.snapshotBufferCursor = (this.snapshotBufferCursor + 1) % SNAPSHOT_BUFFER_RING;
    writeSnapshotHeader(buffer, this.world.tick);
    this.world.writeSnapshot(buffer, SNAPSHOT_BODY_OFFSET);
    for (const session of this.sessions) {
      if (!session.ready) continue;
      session.sendReliable(TRANSPORT_CHANNEL_SNAPSHOT, buffer);
      this.stats.snapshotsSent += 1;
    }
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
  ready = false;
  closed = false;

  private transport?: GameTransport;
  private readonly hello: HelloMessage = {
    clientSalt: 0, name: "", resumeToken: new Uint8Array(RESUME_TOKEN_BYTES), preferredTeam: 0,
  };
  private readonly control: ControlMessage = { action: 0, argument: 0 };
  private readonly ping: PingMessage = { clientTime: 0, serverTick: 0 };
  private readonly command: InputCommand;
  private readonly welcomeBuffer = new Uint8Array(WELCOME_BYTES);
  private readonly rejectBuffer = new Uint8Array(REJECT_MAXIMUM_BYTES);
  private readonly pingBuffer = new Uint8Array(12);
  private readonly resumeToken = new Uint8Array(RESUME_TOKEN_BYTES);
  private inputBudget = 0;

  constructor(server: MatchServer) {
    this.server = server;
    this.command = createInputCommand(server.world.matchId, 1);
  }

  attach(transport: GameTransport): void {
    this.transport = transport;
  }

  /** @internal */
  beginTick(): void {
    this.inputBudget = this.server.inputBudgetPerTick;
  }

  onReliable(channel: ReliableChannel, payload: Uint8Array): void {
    try {
      if (channel === TRANSPORT_CHANNEL_SESSION) this.handleSession(payload);
      else if (channel === TRANSPORT_CHANNEL_CONTROL) this.handleControl(payload);
      else if (channel === 4) this.handleInput(payload);
      else throw new Error(`client sent an unexpected reliable channel ${channel}`);
    } catch (error: unknown) {
      this.server.report(error);
      this.close(4_003, "protocol error");
    }
  }

  onDatagram(payload: Uint8Array): void {
    try {
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
    this.ready = false;
    this.server.log(`session-closed:${code}:${reason}`);
    this.server.releaseSlot(this);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.transport?.close(code, reason);
    this.onClose(code, reason);
  }

  /** @internal */
  sendReliable(channel: ReliableChannel, payload: Uint8Array): void {
    const transport = this.transport;
    if (transport === undefined || this.closed) return;
    void transport.sendReliable(channel, payload).then(
      (disposition) => {
        if (disposition === "closed") this.onClose(1_001, "transport closed");
      },
      (error: unknown) => this.server.report(error),
    );
  }

  private handleSession(payload: Uint8Array): void {
    const kind = messageKind(payload);
    if (kind === MESSAGE_PING) {
      readPing(payload, this.ping);
      this.ping.serverTick = this.server.world.tick;
      writePing(this.pingBuffer, this.ping, true);
      this.sendReliable(TRANSPORT_CHANNEL_SESSION, this.pingBuffer);
      return;
    }
    if (kind !== MESSAGE_HELLO) throw new Error("first session message must be a hello");
    if (this.ready) throw new Error("session already established");
    readHello(payload, this.hello);
    const slot = this.server.claimSlot(this, this.hello.resumeToken);
    if (slot < 0) {
      const length = writeReject(this.rejectBuffer, { code: REJECT_FULL, reason: "match is full" });
      this.sendReliable(TRANSPORT_CHANNEL_SESSION, this.rejectBuffer.subarray(0, length));
      this.close(4_004, "match is full");
      return;
    }
    this.slot = slot;
    this.name = this.hello.name === "" ? `player${slot + 1}` : this.hello.name;
    this.server.issueResumeToken(slot, this.resumeToken);
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
    this.ready = true;
    // The client can send its first datagram immediately after processing the
    // welcome, before the match's next fixed tick calls beginTick(). Grant the
    // same bounded initial budget here so a healthy first input is not mistaken
    // for a rate-limit violation.
    this.inputBudget = this.server.inputBudgetPerTick;
    this.sendReliable(TRANSPORT_CHANNEL_SESSION, this.welcomeBuffer);
    this.server.log(`session-joined:${this.name}:slot=${slot + 1}`);
  }

  private handleControl(payload: Uint8Array): void {
    if (!this.ready) throw new Error("control message before hello");
    if (messageKind(payload) !== MESSAGE_CONTROL) throw new Error("control lane carried a non-control message");
    readControl(payload, this.control);
    const playerId = this.slot + 1;
    if (this.control.action === CONTROL_BUY_UPGRADE) {
      this.server.world.applyUpgrade(playerId, this.control.argument);
    } else if (this.control.action === CONTROL_SET_WEAPON) {
      if (isWeaponId(this.control.argument)) this.server.world.playerWeaponRequest[this.slot] = this.control.argument;
    } else if (this.control.action === CONTROL_SUICIDE) {
      this.server.world.playerHealth[this.slot] = 0;
    }
  }

  private handleInput(payload: Uint8Array): void {
    if (!this.ready) return;
    if (payload.byteLength < INPUT_PACKET_BYTES) throw new Error("input packet is truncated");
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
    readInputPacket(payload, 0, this.command);
    // A session may only ever move its own tank, whatever the packet says.
    if (this.command.playerId !== this.slot + 1) {
      this.server.stats.inputsRejected += 1;
      return;
    }
    if (this.server.world.submitInput(this.command)) this.server.stats.inputsAccepted += 1;
    else this.server.stats.inputsRejected += 1;
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer)) return minimum;
  return integer < minimum ? minimum : integer > maximum ? maximum : integer;
}

/** Exported so a host can size its own buffers without importing the layout. */
export const SERVER_SNAPSHOT_MESSAGE_BYTES = SNAPSHOT_MESSAGE_BYTES;
export const SERVER_SNAPSHOT_BODY_BYTES = SNAPSHOT_BYTES;
export const SERVER_REJECT_VERSION = REJECT_VERSION;
