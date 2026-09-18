import {
  MAX_PLAYERS,
  MAX_PROJECTILES,
  PLAYER_SNAPSHOT_BYTES,
  PROJECTILE_SNAPSHOT_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_HEADER_BYTES,
} from "./constants.ts";
import type { BattleWorld } from "./world.ts";

const SNAPSHOT_MAGIC = 0x57425331;
const SNAPSHOT_VERSION = 1;

export function writeWorldSnapshot(world: BattleWorld, target: Uint8Array, byteOffset: number): number {
  requireSnapshotRange(target, byteOffset);
  const view = new DataView(target.buffer, target.byteOffset + byteOffset, SNAPSHOT_BYTES);
  view.setUint32(0, SNAPSHOT_MAGIC, true);
  view.setUint16(4, SNAPSHOT_VERSION, true);
  view.setUint16(6, SNAPSHOT_BYTES, true);
  view.setUint32(8, world.tick, true);
  view.setUint32(12, world.matchId, true);
  view.setUint16(16, world.projectileCursor, true);
  view.setUint16(18, 0, true);
  let cursor = SNAPSHOT_HEADER_BYTES;
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    view.setUint8(cursor, world.playerActive[slot]!);
    view.setUint8(cursor + 1, world.playerTeam[slot]!);
    view.setUint8(cursor + 2, world.playerWeapon[slot]!);
    view.setUint8(cursor + 3, world.playerDamageLevel[slot]!);
    view.setUint8(cursor + 4, world.playerMobilityLevel[slot]!);
    view.setUint8(cursor + 5, world.playerArmorLevel[slot]!);
    view.setUint16(cursor + 6, world.playerGeneration[slot]!, true);
    view.setInt32(cursor + 8, world.playerX[slot]!, true);
    view.setInt32(cursor + 12, world.playerY[slot]!, true);
    view.setInt16(cursor + 16, world.playerAimX[slot]!, true);
    view.setInt16(cursor + 18, world.playerAimY[slot]!, true);
    view.setInt16(cursor + 20, world.playerHealth[slot]!, true);
    view.setUint16(cursor + 22, world.playerCooldown[slot]!, true);
    view.setInt32(cursor + 24, world.playerScore[slot]!, true);
    view.setInt32(cursor + 28, world.playerCredits[slot]!, true);
    view.setInt32(cursor + 32, world.playerLastInputTick[slot]!, true);
    view.setUint16(cursor + 36, world.playerLastSequence[slot]!, true);
    view.setInt8(cursor + 38, world.playerLastMoveX[slot]!);
    view.setInt8(cursor + 39, world.playerLastMoveY[slot]!);
    view.setInt8(cursor + 40, world.playerLastAimX[slot]!);
    view.setInt8(cursor + 41, world.playerLastAimY[slot]!);
    view.setUint8(cursor + 42, world.playerLastButtons[slot]!);
    view.setUint8(cursor + 43, 0);
    cursor += PLAYER_SNAPSHOT_BYTES;
  }
  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    view.setUint8(cursor, world.projectileActive[slot]!);
    view.setUint8(cursor + 1, world.projectileWeapon[slot]!);
    view.setUint16(cursor + 2, world.projectileGeneration[slot]!, true);
    view.setUint16(cursor + 4, world.projectileOwner[slot]!, true);
    view.setInt16(cursor + 6, world.projectileDamage[slot]!, true);
    view.setInt32(cursor + 8, world.projectileX[slot]!, true);
    view.setInt32(cursor + 12, world.projectileY[slot]!, true);
    view.setInt16(cursor + 16, world.projectileDirectionX[slot]!, true);
    view.setInt16(cursor + 18, world.projectileDirectionY[slot]!, true);
    view.setUint16(cursor + 20, world.projectileLife[slot]!, true);
    view.setUint16(cursor + 22, 0, true);
    cursor += PROJECTILE_SNAPSHOT_BYTES;
  }
  return byteOffset + SNAPSHOT_BYTES;
}

export function readWorldSnapshot(world: BattleWorld, source: Uint8Array, byteOffset: number): number {
  requireSnapshotRange(source, byteOffset);
  const view = new DataView(source.buffer, source.byteOffset + byteOffset, SNAPSHOT_BYTES);
  if (view.getUint32(0, true) !== SNAPSHOT_MAGIC) throw new Error("snapshot magic mismatch");
  if (view.getUint16(4, true) !== SNAPSHOT_VERSION) throw new Error("snapshot version mismatch");
  if (view.getUint16(6, true) !== SNAPSHOT_BYTES) throw new Error("snapshot size mismatch");
  if (view.getUint32(12, true) !== world.matchId) throw new Error("snapshot match id mismatch");
  world.tick = view.getUint32(8, true);
  world.projectileCursor = view.getUint16(16, true);
  if (world.projectileCursor >= MAX_PROJECTILES) throw new Error("snapshot projectile cursor is invalid");
  let cursor = SNAPSHOT_HEADER_BYTES;
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    world.playerActive[slot] = view.getUint8(cursor);
    world.playerTeam[slot] = view.getUint8(cursor + 1);
    world.playerWeapon[slot] = view.getUint8(cursor + 2);
    world.playerDamageLevel[slot] = view.getUint8(cursor + 3);
    world.playerMobilityLevel[slot] = view.getUint8(cursor + 4);
    world.playerArmorLevel[slot] = view.getUint8(cursor + 5);
    world.playerGeneration[slot] = view.getUint16(cursor + 6, true);
    world.playerX[slot] = view.getInt32(cursor + 8, true);
    world.playerY[slot] = view.getInt32(cursor + 12, true);
    world.playerAimX[slot] = view.getInt16(cursor + 16, true);
    world.playerAimY[slot] = view.getInt16(cursor + 18, true);
    world.playerHealth[slot] = view.getInt16(cursor + 20, true);
    world.playerCooldown[slot] = view.getUint16(cursor + 22, true);
    world.playerScore[slot] = view.getInt32(cursor + 24, true);
    world.playerCredits[slot] = view.getInt32(cursor + 28, true);
    world.playerLastInputTick[slot] = view.getInt32(cursor + 32, true);
    world.playerLastSequence[slot] = view.getUint16(cursor + 36, true);
    world.playerLastMoveX[slot] = view.getInt8(cursor + 38);
    world.playerLastMoveY[slot] = view.getInt8(cursor + 39);
    world.playerLastAimX[slot] = view.getInt8(cursor + 40);
    world.playerLastAimY[slot] = view.getInt8(cursor + 41);
    world.playerLastButtons[slot] = view.getUint8(cursor + 42);
    cursor += PLAYER_SNAPSHOT_BYTES;
  }
  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    world.projectileActive[slot] = view.getUint8(cursor);
    world.projectileWeapon[slot] = view.getUint8(cursor + 1);
    world.projectileGeneration[slot] = view.getUint16(cursor + 2, true);
    world.projectileOwner[slot] = view.getUint16(cursor + 4, true);
    world.projectileDamage[slot] = view.getInt16(cursor + 6, true);
    world.projectileX[slot] = view.getInt32(cursor + 8, true);
    world.projectileY[slot] = view.getInt32(cursor + 12, true);
    world.projectileDirectionX[slot] = view.getInt16(cursor + 16, true);
    world.projectileDirectionY[slot] = view.getInt16(cursor + 18, true);
    world.projectileLife[slot] = view.getUint16(cursor + 20, true);
    cursor += PROJECTILE_SNAPSHOT_BYTES;
  }
  return byteOffset + SNAPSHOT_BYTES;
}

function requireSnapshotRange(bytes: Uint8Array, byteOffset: number): void {
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + SNAPSHOT_BYTES > bytes.byteLength) {
    throw new RangeError(`snapshot requires ${SNAPSHOT_BYTES} bytes at the requested offset`);
  }
}
