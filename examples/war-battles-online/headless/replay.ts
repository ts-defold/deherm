import {
  INPUT_BUTTON_FIRE,
  INPUT_PACKET_BYTES,
  MAX_PLAYERS,
  readInputPacket,
  writeInputPacket,
  type InputCommand,
} from "../core/index.ts";

const REPLAY_MAGIC = 0x3152_4257; // "WBR1" little-endian
const REPLAY_VERSION = 1;
export const REPLAY_HEADER_BYTES = 32;

export interface ReplayOptions {
  readonly players: number;
  readonly ticks: number;
  readonly seed: number;
  readonly matchId: number;
}

export interface ReplayHeader extends ReplayOptions {
  readonly packetCount: number;
  readonly bodyHash: number;
}

export function buildBotReplay(options: Readonly<ReplayOptions>): Uint8Array {
  validateOptions(options);
  const packetCount = options.players * options.ticks;
  const replay = new Uint8Array(REPLAY_HEADER_BYTES + packetCount * INPUT_PACKET_BYTES);
  const view = new DataView(replay.buffer);
  view.setUint32(0, REPLAY_MAGIC, true);
  view.setUint16(4, REPLAY_VERSION, true);
  view.setUint8(6, options.players);
  view.setUint32(8, options.ticks, true);
  view.setUint32(12, options.seed, true);
  view.setUint32(16, options.matchId, true);
  view.setUint32(20, packetCount, true);
  view.setUint32(28, REPLAY_HEADER_BYTES, true);

  const command = emptyCommand();
  let offset = REPLAY_HEADER_BYTES;
  for (let tick = 1; tick <= options.ticks; tick += 1) {
    for (let playerId = 1; playerId <= options.players; playerId += 1) {
      botCommand(command, options, playerId, tick);
      offset = writeInputPacket(replay, offset, command);
    }
  }
  view.setUint32(24, fnv1a(replay, REPLAY_HEADER_BYTES), true);
  return replay;
}

export function readReplayHeader(replay: Uint8Array): ReplayHeader {
  if (replay.byteLength < REPLAY_HEADER_BYTES) throw new Error("replay header is truncated");
  const view = new DataView(replay.buffer, replay.byteOffset, replay.byteLength);
  if (view.getUint32(0, true) !== REPLAY_MAGIC) throw new Error("replay magic mismatch");
  if (view.getUint16(4, true) !== REPLAY_VERSION) throw new Error("replay version mismatch");
  if (view.getUint32(28, true) !== REPLAY_HEADER_BYTES) throw new Error("replay header size mismatch");
  const players = view.getUint8(6);
  const ticks = view.getUint32(8, true);
  const seed = view.getUint32(12, true);
  const matchId = view.getUint32(16, true);
  const packetCount = view.getUint32(20, true);
  const bodyHash = view.getUint32(24, true);
  validateOptions({ players, ticks, seed, matchId });
  if (packetCount !== players * ticks) throw new Error("replay packet count mismatch");
  if (replay.byteLength !== REPLAY_HEADER_BYTES + packetCount * INPUT_PACKET_BYTES) {
    throw new Error("replay byte length mismatch");
  }
  if (fnv1a(replay, REPLAY_HEADER_BYTES) !== bodyHash) throw new Error("replay body hash mismatch");
  return Object.freeze({ players, ticks, seed, matchId, packetCount, bodyHash });
}

export function readReplayCommand(
  replay: Uint8Array,
  header: Readonly<ReplayHeader>,
  tick: number,
  playerId: number,
  output: InputCommand,
): void {
  if (!Number.isInteger(tick) || tick < 1 || tick > header.ticks) throw new RangeError("replay tick is out of range");
  if (!Number.isInteger(playerId) || playerId < 1 || playerId > header.players) throw new RangeError("replay player is out of range");
  const packet = (tick - 1) * header.players + playerId - 1;
  readInputPacket(replay, REPLAY_HEADER_BYTES + packet * INPUT_PACKET_BYTES, output);
}

export function emptyCommand(): InputCommand {
  return {
    matchId: 0,
    playerId: 1,
    tick: 1,
    sequence: 1,
    moveX: 0,
    moveY: 0,
    aimX: 127,
    aimY: 0,
    buttons: 0,
    fireSubtick: 255,
    latestSnapshotTick: 0,
    snapshotAckBits: 0,
  };
}

function botCommand(
  command: InputCommand,
  options: Readonly<ReplayOptions>,
  playerId: number,
  tick: number,
): void {
  const teamOne = playerId <= Math.ceil(options.players / 2);
  const noise = mix32(options.seed ^ Math.imul(tick, 0x9e37_79b1) ^ Math.imul(playerId, 0x85eb_ca6b));
  command.matchId = options.matchId;
  command.playerId = playerId;
  command.tick = tick;
  command.sequence = tick & 0xffff;
  command.moveX = teamOne ? 1 : -1;
  command.moveY = ((noise >>> 8) % 3) - 1;
  command.aimX = teamOne ? 127 : -127;
  command.aimY = ((noise >>> 16) % 5) === 0 ? (((noise >>> 24) & 1) === 0 ? -127 : 127) : 0;
  command.buttons = ((noise & 15) === 0 || tick % (6 + playerId % 13) === 0) ? INPUT_BUTTON_FIRE : 0;
  command.fireSubtick = command.buttons === 0 ? 255 : noise % 255;
  command.latestSnapshotTick = tick > 2 ? tick - 2 : 0;
  command.snapshotAckBits = tick > 32 ? 0xffff_ffff : (2 ** tick - 1) >>> 0;
}

function validateOptions(options: Readonly<ReplayOptions>): void {
  if (!Number.isInteger(options.players) || options.players < 1 || options.players > MAX_PLAYERS) {
    throw new RangeError(`players must be in [1, ${MAX_PLAYERS}]`);
  }
  if (!Number.isInteger(options.ticks) || options.ticks < 1 || options.ticks > 0xffff_ffff) {
    throw new RangeError("ticks must be a positive uint32");
  }
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) {
    throw new RangeError("seed must be a uint32");
  }
  if (!Number.isInteger(options.matchId) || options.matchId < 0 || options.matchId > 0xffff_ffff) {
    throw new RangeError("matchId must be a uint32");
  }
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb_352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846c_a68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function fnv1a(bytes: Uint8Array, start: number): number {
  let hash = 0x811c_9dc5;
  for (let index = start; index < bytes.byteLength; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}
