import {
  BotController,
  INPUT_PACKET_BYTES,
  MAX_PLAYERS,
  createInputCommand,
  readInputPacket,
  writeInputPacket,
  type InputCommand,
} from "../core/index.ts";
import { initializeFixtureWorld } from "./fixture.ts";

const REPLAY_MAGIC = 0x3152_4257; // "WBR1" little-endian
// Version 2 carries protocol version 2 packets, which added the weapon byte.
const REPLAY_VERSION = 2;
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

/**
 * Records a real match and hands back its input stream.
 *
 * The commands are produced by the actual `BotController` driving the actual
 * fixture world, not by a noise function, so replaying them exercises the
 * weapons, the pickups, the cover and the respawns a match really uses. The
 * output is still only inputs: the simulation is never serialised here.
 */
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

  const world = initializeFixtureWorld(options.matchId, options.players, options.seed);
  const bots = new BotController();
  const commands: InputCommand[] = [];
  for (let playerId = 1; playerId <= options.players; playerId += 1) {
    commands.push(createInputCommand(options.matchId, playerId));
  }
  let offset = REPLAY_HEADER_BYTES;
  for (let tick = 1; tick <= options.ticks; tick += 1) {
    for (let playerId = 1; playerId <= options.players; playerId += 1) {
      const command = commands[playerId - 1]!;
      bots.stage(world, command, playerId, tick);
      offset = writeInputPacket(replay, offset, command);
      world.submitInput(command);
    }
    world.step();
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
  return createInputCommand(0, 1);
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

function fnv1a(bytes: Uint8Array, start: number): number {
  let hash = 0x811c_9dc5;
  for (let index = start; index < bytes.byteLength; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}
