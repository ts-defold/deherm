// The networked client.
//
// It keeps a locally predicted `BattleWorld`, sends one input per tick on the
// unreliable lane, and reconciles against the authoritative snapshots that come
// back on the reliable one. Reconciliation is the ordinary rollback: restore the
// server's state, then re-apply every local input newer than it and step forward
// to where the client already was, so the local tank does not rubber-band while
// the rest of the arena snaps to the truth.
//
// Remote tanks are not re-simulated from their inputs during a replay - the
// client does not have them. They coast on their last known input for the few
// ticks of the replay window, which is exactly what `INPUT_HOLD_TICKS` is for.

import {
  DIRECTION_SCALE,
  INPUT_BUTTON_BOOST,
  INPUT_BUTTON_FIRE,
  INPUT_HISTORY_TICKS,
  MAX_PLAYERS,
  SNAPSHOT_BYTES,
  TICK_MILLISECONDS,
} from "./constants.ts";
import { isWeaponId, isWeaponUpgradeId } from "./content.ts";
import { clamp, createDirection, normalizeInto, type Direction } from "./fixed.ts";
import { assistedAim, type PlayControls } from "./playable.ts";
import {
  CONTROL_BYTES,
  CONTROL_SET_CHASSIS,
  CONTROL_SET_WEAPON_UPGRADE,
  HELLO_BYTES,
  INPUT_PACKET_BYTES,
  MESSAGE_PONG,
  MESSAGE_REJECT,
  MESSAGE_SNAPSHOT,
  MESSAGE_WELCOME,
  PING_BYTES,
  RESUME_TOKEN_BYTES,
  SNAPSHOT_KEYFRAME,
  WELCOME_ACK_BYTES,
  WELCOME_BYTES,
  createInputCommand,
  messageKind,
  readReject,
  readSnapshotTick,
  readWelcome,
  writeControl,
  writeHello,
  writeInputPacket,
  writePing,
  writeWelcomeAck,
  type InputCommand,
  type RejectMessage,
  type WelcomeMessage,
} from "./protocol.ts";
import { readSnapshotFrame, type SnapshotFrameScratch } from "./snapshot.ts";
import {
  TRANSPORT_CHANNEL_CONTROL,
  TRANSPORT_CHANNEL_SESSION,
  TRANSPORT_CHANNEL_SNAPSHOT,
  sendTickInput,
  type GameTransport,
  type ReliableChannel,
  type TransportReceiver,
} from "./transport.ts";
import { BattleWorld } from "./world.ts";

export type ClientState = "idle" | "connecting" | "ready" | "rejected" | "closed";

/** A caller-owned presentation transform. Values are simulation units/directions. */
export interface PlayerTransform {
  x: number;
  y: number;
  hullX: number;
  hullY: number;
  turretX: number;
  turretY: number;
}

export interface ClientClose {
  readonly code: number;
  readonly reason: string;
  readonly state: ClientState;
  /** True when the welcome handshake completed before this close. */
  readonly welcomed: boolean;
}

/** Default cadence used by legacy welcomes and callers without a configuration. */
export const REMOTE_INTERPOLATION_TICKS = 3;

export interface BattleClientOptions {
  readonly name?: string;
  /** Optional override for servers that do not advertise their snapshot cadence. */
  readonly snapshotIntervalTicks?: number;
  /** Ticks the client runs ahead of the last snapshot it applied. */
  readonly leadTicks?: number;
  /** Turret assist, as in the offline match. Disable for a pointing device. */
  readonly assistAim?: boolean;
  readonly onWelcome?: (welcome: Readonly<WelcomeMessage>) => void;
  readonly onReject?: (reject: Readonly<RejectMessage>) => void;
  readonly onClose?: (close: Readonly<ClientClose>) => void;
  readonly onError?: (error: unknown) => void;
  readonly onLog?: (line: string) => void;
}

export interface ClientStats {
  snapshotsApplied: number;
  snapshotsIgnored: number;
  replayedTicks: number;
  inputsSent: number;
  inputsDropped: number;
  lastServerTick: number;
  lastRoundTripMilliseconds: number;
  pongsReceived: number;
}

export class BattleClient implements TransportReceiver {
  state: ClientState = "idle";
  world?: BattleWorld;
  playerId = 0;
  team = 0;
  rosterSize = 0;
  /** Ticks the client's prediction is ahead of the last applied snapshot. */
  readonly leadTicks: number;
  readonly resumeToken = new Uint8Array(RESUME_TOKEN_BYTES);
  readonly stats: ClientStats = {
    snapshotsApplied: 0,
    snapshotsIgnored: 0,
    replayedTicks: 0,
    inputsSent: 0,
    inputsDropped: 0,
    lastServerTick: 0,
    lastRoundTripMilliseconds: 0,
    pongsReceived: 0,
  };

  private transport?: GameTransport;
  private readonly options: BattleClientOptions;
  private readonly assistAim: boolean;
  private readonly configuredSnapshotIntervalTicks?: number;
  private readonly welcome: WelcomeMessage = {
    matchId: 0,
    playerId: 0,
    team: 0,
    maximumPlayers: 0,
    botCount: 0,
    mapSeed: 0,
    serverTick: 0,
    tickRate: 60,
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
  };
  private readonly reject: RejectMessage = { code: 0, reason: "" };
  private readonly helloBuffer = new Uint8Array(HELLO_BYTES);
  private readonly controlBuffer = new Uint8Array(CONTROL_BYTES);
  private readonly pingBuffer = new Uint8Array(PING_BYTES);
  private readonly welcomeAckBuffer = new Uint8Array(WELCOME_ACK_BYTES);
  private readonly inputBuffer = new Uint8Array(INPUT_PACKET_BYTES);
  private readonly history: InputCommand[] = [];
  private readonly historyTick = new Int32Array(INPUT_HISTORY_TICKS);
  private readonly aim: Direction = createDirection();
  private readonly staging: InputCommand;

  // Presentation history is deliberately fixed-capacity. The simulation world
  // remains authoritative/predicted; these stores only hold the two remote
  // transform samples needed by the Defold render components.
  private readonly remotePreviousX = new Int32Array(MAX_PLAYERS);
  private readonly remotePreviousY = new Int32Array(MAX_PLAYERS);
  private readonly remotePreviousHullX = new Int16Array(MAX_PLAYERS);
  private readonly remotePreviousHullY = new Int16Array(MAX_PLAYERS);
  private readonly remotePreviousTurretX = new Int16Array(MAX_PLAYERS);
  private readonly remotePreviousTurretY = new Int16Array(MAX_PLAYERS);
  private readonly remoteCurrentX = new Int32Array(MAX_PLAYERS);
  private readonly remoteCurrentY = new Int32Array(MAX_PLAYERS);
  private readonly remoteCurrentHullX = new Int16Array(MAX_PLAYERS);
  private readonly remoteCurrentHullY = new Int16Array(MAX_PLAYERS);
  private readonly remoteCurrentTurretX = new Int16Array(MAX_PLAYERS);
  private readonly remoteCurrentTurretY = new Int16Array(MAX_PLAYERS);
  private readonly remoteHaveSample = new Uint8Array(MAX_PLAYERS);

  private accumulator = 0;
  private remoteInterpolationMilliseconds = 0;
  private remoteInterpolationTicks = REMOTE_INTERPOLATION_TICKS;
  private localTick = 0;
  private appliedSnapshotTick = -1;
  private snapshotAckBits = 0;
  private sequence = 0;
  private readonly pendingSnapshot = new Uint8Array(SNAPSHOT_BYTES);
  private readonly snapshotBaseline = new Uint8Array(SNAPSHOT_BYTES);
  private readonly snapshotDecoded = new Uint8Array(SNAPSHOT_BYTES);
  private readonly snapshotScratch: SnapshotFrameScratch = {
    baseline: this.snapshotBaseline,
    decoded: this.snapshotDecoded,
    baselineTick: -1,
  };
  private pendingSnapshotReady = false;
  private pendingSnapshotTick = -1;
  private pendingSnapshotKeyframe = false;
  private awaitingSnapshotKeyframe = false;
  private welcomed = false;

  private moveX = 0;
  private moveY = 0;
  private fire = false;
  private boost = false;
  private weapon = 0;
  private aimX = DIRECTION_SCALE;
  private aimY = 0;
  private reliableSendTail: Promise<void> = Promise.resolve();

  constructor(options: BattleClientOptions = {}) {
    this.options = options;
    this.leadTicks = clamp(Math.trunc(options.leadTicks ?? 2), 0, 16);
    this.assistAim = options.assistAim ?? true;
    this.configuredSnapshotIntervalTicks =
      options.snapshotIntervalTicks === undefined ? undefined : clamp(Math.trunc(options.snapshotIntervalTicks), 1, 30);
    this.remoteInterpolationTicks = this.configuredSnapshotIntervalTicks ?? REMOTE_INTERPOLATION_TICKS;
    this.staging = createInputCommand(0, 1);
    for (let index = 0; index < INPUT_HISTORY_TICKS; index += 1) this.history.push(createInputCommand(0, 1));
    this.historyTick.fill(-1);
  }

  /** Attaches a connected transport and sends the session hello. */
  attach(transport: GameTransport): void {
    this.transport = transport;
    this.state = "connecting";
    // A transport reconnect starts a fresh snapshot stream. Keep the resume
    // credential and predicted world until the new welcome arrives, but make
    // any late frame from the old connection unable to seed the new baseline.
    this.snapshotScratch.baselineTick = -1;
    this.pendingSnapshotReady = false;
    this.pendingSnapshotTick = -1;
    this.pendingSnapshotKeyframe = false;
    this.awaitingSnapshotKeyframe = false;
    this.snapshotAckBits = 0;
    writeHello(this.helloBuffer, {
      clientSalt: (Date.now() & 0xffff_ffff) >>> 0,
      name: this.options.name ?? "",
      resumeToken: this.resumeToken,
      preferredTeam: 0,
    });
    void this.send(TRANSPORT_CHANNEL_SESSION, this.helloBuffer);
  }

  setControls(controls: Readonly<PlayControls>): void {
    this.moveX = controls.moveX < 0 ? -1 : controls.moveX > 0 ? 1 : 0;
    this.moveY = controls.moveY < 0 ? -1 : controls.moveY > 0 ? 1 : 0;
    this.fire = controls.fire;
    this.boost = controls.boost === true;
    if (controls.weapon !== undefined && isWeaponId(controls.weapon)) this.weapon = controls.weapon;
  }

  /** Explicit turret aim, in world units relative to the local tank. */
  setAim(x: number, y: number): void {
    if (normalizeInto(x, y, this.aim)) {
      this.aimX = this.aim.x;
      this.aimY = this.aim.y;
    }
  }

  /**
   * Samples one tank for presentation into caller-owned storage. The local
   * predicted tank is always read immediately from `world`; remote tanks use
   * the bounded pair of authoritative samples at the advertised cadence.
   */
  samplePlayerTransform(slot: number, output: PlayerTransform): boolean {
    const world = this.world;
    if (world === undefined || !Number.isInteger(slot) || slot < 0 || slot >= MAX_PLAYERS) return false;
    if (slot === this.playerId - 1 || this.remoteHaveSample[slot] === 0) {
      output.x = world.playerX[slot]!;
      output.y = world.playerY[slot]!;
      output.hullX = world.playerHullX[slot]!;
      output.hullY = world.playerHullY[slot]!;
      output.turretX = world.playerTurretX[slot]!;
      output.turretY = world.playerTurretY[slot]!;
      return true;
    }
    const alpha = Math.min(
      1,
      this.remoteInterpolationMilliseconds / (TICK_MILLISECONDS * this.remoteInterpolationTicks),
    );
    output.x = interpolate(this.remotePreviousX[slot]!, this.remoteCurrentX[slot]!, alpha);
    output.y = interpolate(this.remotePreviousY[slot]!, this.remoteCurrentY[slot]!, alpha);
    output.hullX = interpolate(this.remotePreviousHullX[slot]!, this.remoteCurrentHullX[slot]!, alpha);
    output.hullY = interpolate(this.remotePreviousHullY[slot]!, this.remoteCurrentHullY[slot]!, alpha);
    output.turretX = interpolate(this.remotePreviousTurretX[slot]!, this.remoteCurrentTurretX[slot]!, alpha);
    output.turretY = interpolate(this.remotePreviousTurretY[slot]!, this.remoteCurrentTurretY[slot]!, alpha);
    return true;
  }

  /**
   * Advances the local clock. Applies at most one pending snapshot per call, so
   * a burst that arrives while the caller was away costs one reconciliation
   * rather than one per snapshot.
   */
  update(elapsedMilliseconds: number, maximumSteps = 8): number {
    if (this.state !== "ready" || this.world === undefined) return 0;
    this.applyPendingSnapshot();
    this.remoteInterpolationMilliseconds = Math.min(
      TICK_MILLISECONDS * this.remoteInterpolationTicks,
      this.remoteInterpolationMilliseconds + Math.max(0, elapsedMilliseconds),
    );
    this.accumulator += elapsedMilliseconds;
    let steps = 0;
    while (this.accumulator >= TICK_MILLISECONDS && steps < maximumSteps) {
      this.accumulator -= TICK_MILLISECONDS;
      this.advanceOneTick();
      steps += 1;
    }
    if (steps === maximumSteps) this.accumulator = 0;
    return steps;
  }

  sendControl(action: number, argument: number): void {
    writeControl(this.controlBuffer, { action, argument });
    void this.send(TRANSPORT_CHANNEL_CONTROL, this.controlBuffer);
  }

  /** Purchases/switches the local player's chassis on the reliable control lane. */
  sendChassis(chassisId: number): void {
    this.sendControl(CONTROL_SET_CHASSIS, chassisId);
  }

  /** Purchases/selects a weapon branch on the reliable control lane. */
  sendWeaponUpgrade(upgradeId: number): void {
    if (!isWeaponUpgradeId(upgradeId)) return;
    this.sendControl(CONTROL_SET_WEAPON_UPGRADE, upgradeId);
  }

  ping(clientTime: number): void {
    writePing(this.pingBuffer, { clientTime: clientTime >>> 0, serverTick: 0 });
    void this.send(TRANSPORT_CHANNEL_SESSION, this.pingBuffer);
  }

  close(code = 1000, reason = "client closed"): void {
    if (this.state === "closed") return;
    this.transport?.close(code, reason);
    this.state = "closed";
  }

  // --- TransportReceiver ----------------------------------------------------

  onReliable(channel: ReliableChannel, payload: Uint8Array): void {
    try {
      const kind = messageKind(payload);
      if (kind === MESSAGE_WELCOME) this.handleWelcome(payload);
      else if (kind === MESSAGE_REJECT) this.handleReject(payload);
      else if (kind === MESSAGE_SNAPSHOT) this.handleSnapshot(payload);
      else if (kind === MESSAGE_PONG) this.handlePong(payload);
      else if (channel === TRANSPORT_CHANNEL_SNAPSHOT) throw new Error("snapshot lane carried a non-snapshot message");
    } catch (error: unknown) {
      this.options.onError?.(error);
    }
  }

  onDatagram(payload: Uint8Array): void {
    // The server never sends datagrams in this protocol; a stray one is data the
    // client did not ask for and is dropped rather than parsed.
    void payload;
  }

  onClose(code: number, reason: string): void {
    // A rejection is why the session closed, so it stays the reported state: a
    // caller that only sees "closed" cannot tell a full match from a dead link.
    if (this.state !== "rejected") this.state = "closed";
    this.options.onLog?.(`client-closed:${code}:${reason}`);
    this.options.onClose?.({ code, reason, state: this.state, welcomed: this.welcomed });
  }

  // --- internals ------------------------------------------------------------

  private handleWelcome(payload: Uint8Array): void {
    readWelcome(payload, this.welcome);
    this.playerId = this.welcome.playerId;
    this.team = this.welcome.team;
    this.rosterSize = this.welcome.maximumPlayers;
    this.resumeToken.set(this.welcome.resumeToken);
    writeWelcomeAck(this.welcomeAckBuffer, { resumeToken: this.resumeToken });
    void this.send(TRANSPORT_CHANNEL_SESSION, this.welcomeAckBuffer);
    this.remoteInterpolationTicks =
      payload.byteLength >= WELCOME_BYTES
        ? clamp(Math.trunc(this.welcome.snapshotIntervalTicks ?? REMOTE_INTERPOLATION_TICKS), 1, 30)
        : (this.configuredSnapshotIntervalTicks ?? REMOTE_INTERPOLATION_TICKS);
    this.world = new BattleWorld(this.welcome.matchId, this.welcome.mapSeed);
    // A welcome is the authentication boundary for this connection. The
    // server's first post-welcome snapshot is always a keyframe, so discard
    // every byte and acknowledgement bit belonging to the previous stream.
    this.snapshotBaseline.fill(0);
    this.snapshotDecoded.fill(0);
    this.pendingSnapshot.fill(0);
    this.snapshotScratch.baselineTick = -1;
    this.pendingSnapshotReady = false;
    this.pendingSnapshotTick = -1;
    this.pendingSnapshotKeyframe = false;
    this.awaitingSnapshotKeyframe = false;
    this.snapshotAckBits = 0;
    this.remoteHaveSample.fill(0);
    this.remoteInterpolationMilliseconds = 0;
    // The roster is fixed for the round, so the client can build it up front and
    // let the first snapshot overwrite everything it just guessed.
    for (let playerId = 1; playerId <= this.welcome.maximumPlayers; playerId += 1) {
      this.world.addPlayer(playerId);
    }
    this.world.tick = this.welcome.serverTick;
    this.localTick = this.welcome.serverTick;
    this.appliedSnapshotTick = -1;
    this.historyTick.fill(-1);
    for (const command of this.history) {
      command.matchId = this.welcome.matchId;
      command.playerId = this.welcome.playerId;
    }
    this.staging.matchId = this.welcome.matchId;
    this.staging.playerId = this.welcome.playerId;
    this.state = "ready";
    this.welcomed = true;
    this.options.onWelcome?.(this.welcome);
    this.options.onLog?.(
      `client-welcome:player=${this.playerId}:tick=${this.welcome.serverTick}:seed=${this.welcome.mapSeed}`,
    );
  }

  private handleReject(payload: Uint8Array): void {
    readReject(payload, this.reject);
    this.state = "rejected";
    this.options.onReject?.(this.reject);
    this.options.onLog?.(`client-rejected:${this.reject.code}:${this.reject.reason}`);
  }

  private handleSnapshot(payload: Uint8Array): void {
    const isKeyframe = payload.byteLength >= 9 && payload[8] === SNAPSHOT_KEYFRAME;
    // Once a frame fails to decode, only a complete keyframe can re-establish
    // the baseline. Dependent deltas are dropped without repeatedly surfacing
    // the same root error or touching the partially decoded storage.
    if (this.awaitingSnapshotKeyframe && !isKeyframe) {
      this.stats.snapshotsIgnored += 1;
      return;
    }
    try {
      const tick = readSnapshotTick(payload);
      if (tick <= this.appliedSnapshotTick || tick <= this.pendingSnapshotTick) {
        this.stats.snapshotsIgnored += 1;
        return;
      }
      // Decode into fixed caller-owned storage: the transport's buffer belongs
      // to the transport, and the snapshot is applied on the next `update`
      // rather than inside a receive callback. A delta without its exact base
      // fails closed and waits for the next periodic keyframe.
      readSnapshotFrame(payload, this.snapshotScratch);
      // The decoded keyframe is now the exact base for any following frames
      // already buffered by the transport. Restore remains guarded below; if
      // it fails, applyPendingSnapshot re-latches the stream before exposing
      // any state to the simulation.
      if (isKeyframe) this.awaitingSnapshotKeyframe = false;
      this.pendingSnapshot.set(this.snapshotDecoded);
      this.pendingSnapshotReady = true;
      this.pendingSnapshotTick = tick;
      this.pendingSnapshotKeyframe = isKeyframe;
    } catch (error: unknown) {
      this.snapshotScratch.baselineTick = -1;
      this.pendingSnapshotReady = false;
      this.pendingSnapshotTick = -1;
      this.pendingSnapshotKeyframe = false;
      this.stats.snapshotsIgnored += 1;
      if (!this.awaitingSnapshotKeyframe) {
        this.awaitingSnapshotKeyframe = true;
        this.options.onError?.(error);
      }
    }
  }

  private handlePong(payload: Uint8Array): void {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const clientTime = view.getUint32(4, true);
    this.stats.lastServerTick = view.getUint32(8, true);
    this.stats.lastRoundTripMilliseconds = ((Date.now() & 0xffff_ffff) - clientTime) >>> 0;
    this.stats.pongsReceived += 1;
  }

  private applyPendingSnapshot(): void {
    if (!this.pendingSnapshotReady || this.world === undefined) return;
    const snapshotTick = this.pendingSnapshotTick;
    this.pendingSnapshotReady = false;
    this.pendingSnapshotTick = -1;
    const snapshotKeyframe = this.pendingSnapshotKeyframe;
    this.pendingSnapshotKeyframe = false;
    if (snapshotTick <= this.appliedSnapshotTick) {
      this.stats.snapshotsIgnored += 1;
      return;
    }
    const world = this.world;
    const target = this.localTick;
    try {
      world.restoreSnapshot(this.pendingSnapshot);
    } catch (error: unknown) {
      const report = !this.awaitingSnapshotKeyframe;
      this.snapshotScratch.baselineTick = -1;
      this.awaitingSnapshotKeyframe = true;
      this.stats.snapshotsIgnored += 1;
      if (report) this.options.onError?.(error);
      return;
    }
    this.captureRemoteSnapshot(world);
    this.appliedSnapshotTick = snapshotTick;
    this.snapshotAckBits = ((this.snapshotAckBits << 1) | 1) >>> 0;
    this.stats.snapshotsApplied += 1;
    this.stats.lastServerTick = snapshotTick;
    if (snapshotKeyframe) this.awaitingSnapshotKeyframe = false;

    // Replay the local inputs the server has not yet folded in. If the client
    // had fallen behind the server, there is nothing to replay and the local
    // clock jumps forward instead.
    if (target <= world.tick) {
      this.localTick = world.tick;
      return;
    }
    let replayed = 0;
    while (world.tick < target && replayed < INPUT_HISTORY_TICKS) {
      const next: number = world.tick + 1;
      const slot = next % INPUT_HISTORY_TICKS;
      if (this.historyTick[slot] === next) world.submitInput(this.history[slot]!);
      world.step();
      replayed += 1;
    }
    this.localTick = world.tick;
    this.stats.replayedTicks += replayed;
  }

  private captureRemoteSnapshot(world: BattleWorld): void {
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      if (slot === this.playerId - 1) continue;
      if (this.remoteHaveSample[slot] !== 0) {
        this.remotePreviousX[slot] = this.remoteCurrentX[slot]!;
        this.remotePreviousY[slot] = this.remoteCurrentY[slot]!;
        this.remotePreviousHullX[slot] = this.remoteCurrentHullX[slot]!;
        this.remotePreviousHullY[slot] = this.remoteCurrentHullY[slot]!;
        this.remotePreviousTurretX[slot] = this.remoteCurrentTurretX[slot]!;
        this.remotePreviousTurretY[slot] = this.remoteCurrentTurretY[slot]!;
      }
      this.remoteCurrentX[slot] = world.playerX[slot]!;
      this.remoteCurrentY[slot] = world.playerY[slot]!;
      this.remoteCurrentHullX[slot] = world.playerHullX[slot]!;
      this.remoteCurrentHullY[slot] = world.playerHullY[slot]!;
      this.remoteCurrentTurretX[slot] = world.playerTurretX[slot]!;
      this.remoteCurrentTurretY[slot] = world.playerTurretY[slot]!;
      if (this.remoteHaveSample[slot] === 0) {
        this.remotePreviousX[slot] = this.remoteCurrentX[slot]!;
        this.remotePreviousY[slot] = this.remoteCurrentY[slot]!;
        this.remotePreviousHullX[slot] = this.remoteCurrentHullX[slot]!;
        this.remotePreviousHullY[slot] = this.remoteCurrentHullY[slot]!;
        this.remotePreviousTurretX[slot] = this.remoteCurrentTurretX[slot]!;
        this.remotePreviousTurretY[slot] = this.remoteCurrentTurretY[slot]!;
        this.remoteHaveSample[slot] = 1;
      }
    }
    this.remoteInterpolationMilliseconds = 0;
  }

  private advanceOneTick(): void {
    const world = this.world;
    if (world === undefined) return;
    const tick = world.tick + 1;
    const slot = tick % INPUT_HISTORY_TICKS;
    const command = this.history[slot]!;
    this.stageCommand(command, tick);
    this.historyTick[slot] = tick;
    world.submitInput(command);
    world.step();
    this.localTick = world.tick;
    this.transmit(command);
  }

  private stageCommand(command: InputCommand, tick: number): void {
    const world = this.world;
    const slot = this.playerId - 1;
    if (world !== undefined && this.assistAim && assistedAim(world, slot, this.aim)) {
      this.aimX = this.aim.x;
      this.aimY = this.aim.y;
    } else if (this.moveX !== 0 || this.moveY !== 0) {
      if (normalizeInto(this.moveX, this.moveY, this.aim)) {
        this.aimX = this.aim.x;
        this.aimY = this.aim.y;
      }
    }
    this.sequence = (this.sequence + 1) & 0xffff;
    command.tick = tick;
    command.sequence = this.sequence;
    command.moveX = this.moveX;
    command.moveY = this.moveY;
    command.aimX = clamp(Math.trunc((this.aimX * 127) / DIRECTION_SCALE), -127, 127);
    command.aimY = clamp(Math.trunc((this.aimY * 127) / DIRECTION_SCALE), -127, 127);
    command.buttons = (this.fire ? INPUT_BUTTON_FIRE : 0) | (this.boost ? INPUT_BUTTON_BOOST : 0);
    command.weaponRequest = this.weapon;
    command.fireSubtick = this.fire ? 127 : 255;
    command.latestSnapshotTick = this.appliedSnapshotTick < 0 ? 0 : this.appliedSnapshotTick;
    command.snapshotAckBits = this.snapshotAckBits;
    this.weapon = 0;
  }

  private transmit(command: InputCommand): void {
    const transport = this.transport;
    if (transport === undefined) return;
    // The command the server must see is the one for the tick it has not run
    // yet, which is `leadTicks` ahead of the tick the client just simulated.
    const staged = this.staging;
    staged.tick = command.tick + this.leadTicks;
    staged.sequence = command.sequence;
    staged.moveX = command.moveX;
    staged.moveY = command.moveY;
    staged.aimX = command.aimX;
    staged.aimY = command.aimY;
    staged.buttons = command.buttons;
    staged.weaponRequest = command.weaponRequest;
    staged.fireSubtick = command.fireSubtick;
    staged.latestSnapshotTick = command.latestSnapshotTick;
    staged.snapshotAckBits = command.snapshotAckBits;
    writeInputPacket(this.inputBuffer, 0, staged);
    void sendTickInput(transport, this.inputBuffer).then(
      (result) => {
        if (result.disposition === "sent") this.stats.inputsSent += 1;
        else this.stats.inputsDropped += 1;
      },
      (error: unknown) => this.options.onError?.(error),
    );
  }

  private async send(channel: ReliableChannel, payload: Uint8Array): Promise<void> {
    const transport = this.transport;
    if (transport === undefined) return;
    // QUIC only orders bytes within one stream. The browser transport uses an
    // independent stream per reliable message, so preserve the program order
    // of hello, acknowledgement, control and ping messages here. Own the bytes
    // before queueing because every protocol buffer above is reused in place.
    const ownedPayload = payload.slice();
    const pending = this.reliableSendTail.then(async () => {
      if (this.transport !== transport || this.state === "closed") return;
      await transport.sendReliable(channel, ownedPayload);
    });
    this.reliableSendTail = pending.catch((error: unknown) => {
      this.options.onError?.(error);
    });
    await this.reliableSendTail;
  }
}

function interpolate(previous: number, current: number, alpha: number): number {
  return Math.trunc(previous + (current - previous) * alpha);
}
