import {
  INPUT_BUTTON_MASK,
  MAX_PLAYERS,
} from "./constants.ts";

export const PROTOCOL_VERSION = 1;
export const INPUT_PACKET_BYTES = 32;
const PACKET_MAGIC = 0x5742;
const PACKET_KIND_INPUT = 1;

export interface InputCommand {
  matchId: number;
  playerId: number;
  tick: number;
  sequence: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  buttons: number;
  /** 0-254 is the firing instant within the tick; 255 means no sub-tick shot. */
  fireSubtick: number;
  /** Most recent authoritative snapshot tick observed by this client. */
  latestSnapshotTick: number;
  /** Receipt bits for latestSnapshotTick and its 31 predecessors. */
  snapshotAckBits: number;
}

export function validateInputCommand(command: Readonly<InputCommand>): void {
  unsigned(command.matchId, 0xffff_ffff, "matchId");
  unsigned(command.tick, 0xffff_ffff, "tick");
  unsigned(command.sequence, 0xffff, "sequence");
  unsigned(command.playerId, MAX_PLAYERS, "playerId");
  if (command.playerId === 0) throw new RangeError("playerId must be in [1, 32]");
  signedAxis(command.moveX, "moveX");
  signedAxis(command.moveY, "moveY");
  signedAxis(command.aimX, "aimX");
  signedAxis(command.aimY, "aimY");
  unsigned(command.buttons, 0xff, "buttons");
  if ((command.buttons & ~INPUT_BUTTON_MASK) !== 0) throw new RangeError("buttons contains an unknown bit");
  unsigned(command.fireSubtick, 0xff, "fireSubtick");
  unsigned(command.latestSnapshotTick, 0xffff_ffff, "latestSnapshotTick");
  unsigned(command.snapshotAckBits, 0xffff_ffff, "snapshotAckBits");
}

export function writeInputPacket(
  target: Uint8Array,
  byteOffset: number,
  command: Readonly<InputCommand>,
): number {
  validateInputCommand(command);
  requirePacketRange(target, byteOffset);
  const view = new DataView(target.buffer, target.byteOffset + byteOffset, INPUT_PACKET_BYTES);
  view.setUint16(0, PACKET_MAGIC, true);
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, PACKET_KIND_INPUT);
  view.setUint32(4, command.matchId, true);
  view.setUint8(8, command.playerId);
  view.setUint8(9, command.buttons);
  view.setInt8(10, command.moveX);
  view.setInt8(11, command.moveY);
  view.setInt8(12, command.aimX);
  view.setInt8(13, command.aimY);
  view.setUint8(14, command.fireSubtick);
  view.setUint8(15, 0);
  view.setUint32(16, command.tick, true);
  view.setUint16(20, command.sequence, true);
  view.setUint32(22, command.latestSnapshotTick, true);
  view.setUint32(26, command.snapshotAckBits, true);
  view.setUint16(30, packetChecksum(target, byteOffset, 30), true);
  return byteOffset + INPUT_PACKET_BYTES;
}

export function readInputPacket(
  source: Uint8Array,
  byteOffset: number,
  output: InputCommand,
): number {
  requirePacketRange(source, byteOffset);
  const view = new DataView(source.buffer, source.byteOffset + byteOffset, INPUT_PACKET_BYTES);
  if (view.getUint16(0, true) !== PACKET_MAGIC) throw new Error("input packet magic mismatch");
  if (view.getUint8(2) !== PROTOCOL_VERSION) throw new Error("input packet version mismatch");
  if (view.getUint8(3) !== PACKET_KIND_INPUT) throw new Error("packet is not an input command");
  if (view.getUint16(30, true) !== packetChecksum(source, byteOffset, 30)) throw new Error("input packet checksum mismatch");
  output.matchId = view.getUint32(4, true);
  output.playerId = view.getUint8(8);
  output.buttons = view.getUint8(9);
  output.moveX = view.getInt8(10);
  output.moveY = view.getInt8(11);
  output.aimX = view.getInt8(12);
  output.aimY = view.getInt8(13);
  output.fireSubtick = view.getUint8(14);
  output.tick = view.getUint32(16, true);
  output.sequence = view.getUint16(20, true);
  output.latestSnapshotTick = view.getUint32(22, true);
  output.snapshotAckBits = view.getUint32(26, true);
  validateInputCommand(output);
  return byteOffset + INPUT_PACKET_BYTES;
}

function packetChecksum(bytes: Uint8Array, offset: number, length: number): number {
  let first = 0xff;
  let second = 0xff;
  for (let index = 0; index < length; index += 1) {
    first = (first + bytes[offset + index]!) % 255;
    second = (second + first) % 255;
  }
  return (second << 8) | first;
}

function requirePacketRange(bytes: Uint8Array, byteOffset: number): void {
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + INPUT_PACKET_BYTES > bytes.byteLength) {
    throw new RangeError("input packet does not fit in the supplied byte range");
  }
}

function unsigned(value: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} is outside its wire range`);
  }
}

function signedAxis(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -127 || value > 127) {
    throw new RangeError(`${label} must be an integer in [-127, 127]`);
  }
}
