import {
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  COVER_MAX_HEALTH,
  COVER_SNAPSHOT_BYTES,
  OBJECTIVE_CAPTURE_TICKS,
  PICKUP_SNAPSHOT_BYTES,
  PLAYER_SNAPSHOT_BYTES,
  PROJECTILE_SNAPSHOT_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_HEADER_BYTES,
} from "./constants.ts";
import {
  CHASSIS_COUNT,
  CHASSIS_UNLOCK_MASK,
  WEAPON_COUNT,
  WEAPON_UPGRADE_COUNT,
  chassisUnlockBit,
  weaponUpgradeById,
} from "./content.ts";
import {
  ENVELOPE_MAGIC,
  MESSAGE_SNAPSHOT,
  PROTOCOL_VERSION,
  SNAPSHOT_DELTA,
  SNAPSHOT_FRAME_HEADER_BYTES,
  SNAPSHOT_KEYFRAME,
  SNAPSHOT_MESSAGE_BYTES,
} from "./protocol.ts";
import type { BattleWorld } from "./world.ts";

const SNAPSHOT_MAGIC = 0x57425331;
// Version 7 adds the authoritative tank/on-foot/dead player mode.
const SNAPSHOT_VERSION = 8;

export interface SnapshotFrameScratch {
  baseline: Uint8Array;
  readonly decoded: Uint8Array;
  baselineTick: number;
}

/** Reads the named delta base without allocating or decoding the frame. */
export function readSnapshotBaseTick(payload: Uint8Array): number {
  if (payload.byteLength < SNAPSHOT_FRAME_HEADER_BYTES) throw new Error("snapshot frame is truncated");
  return readUint32LE(payload, 10);
}

/**
 * Writes a complete authoritative keyframe. The source is the raw world
 * snapshot, not a framed protocol message. `-1` is never returned here:
 * callers size the fixed frame buffer with `SNAPSHOT_MESSAGE_BYTES`.
 */
export function writeSnapshotKeyframe(target: Uint8Array, tick: number, source: Uint8Array): number {
  if (source.byteLength < SNAPSHOT_BYTES) throw new RangeError("snapshot keyframe source is truncated");
  requireFrameCapacity(target);
  frameHeader(target, tick, SNAPSHOT_KEYFRAME, 0);
  copyBytes(target, SNAPSHOT_FRAME_HEADER_BYTES, source, 0, SNAPSHOT_BYTES);
  return SNAPSHOT_FRAME_HEADER_BYTES + SNAPSHOT_BYTES;
}

/**
 * Writes a deterministic run-list delta against `baseline`. Runs are sorted,
 * non-overlapping and contain only changed bytes. If the delta would be no
 * smaller than a keyframe, `-1` asks the caller to send a keyframe instead.
 */
export function writeSnapshotDelta(
  target: Uint8Array,
  tick: number,
  baselineTick: number,
  baseline: Uint8Array,
  current: Uint8Array,
): number {
  if (baseline.byteLength < SNAPSHOT_BYTES || current.byteLength < SNAPSHOT_BYTES) {
    throw new RangeError("snapshot delta source is truncated");
  }
  requireFrameCapacity(target);
  frameHeader(target, tick, SNAPSHOT_DELTA, baselineTick);
  let cursor = SNAPSHOT_FRAME_HEADER_BYTES;
  let runCount = 0;
  let index = 0;
  while (index < SNAPSHOT_BYTES) {
    while (index < SNAPSHOT_BYTES && baseline[index] === current[index]) index += 1;
    if (index === SNAPSHOT_BYTES) break;
    const start = index;
    while (index < SNAPSHOT_BYTES && baseline[index] !== current[index] && index - start < 0xffff) index += 1;
    const length = index - start;
    if (runCount >= 0xffff || cursor + 4 + length > SNAPSHOT_MESSAGE_BYTES) return -1;
    writeUint16LE(target, cursor, start);
    writeUint16LE(target, cursor + 2, length);
    copyBytes(target, cursor + 4, current, start, length);
    cursor += 4 + length;
    runCount += 1;
  }
  writeUint16LE(target, 14, runCount);
  // A delta header plus its runs is useful only when it is smaller than the
  // keyframe. Equal-sized frames are kept as keyframes for recovery clarity.
  return cursor < SNAPSHOT_MESSAGE_BYTES ? cursor : -1;
}

/**
 * Decodes one frame into caller-owned storage. A delta without the exact
 * advertised base tick is rejected; callers must wait for the next keyframe.
 */
export function readSnapshotFrame(payload: Uint8Array, scratch: SnapshotFrameScratch, commitBaseline = true): number {
  if (payload.byteLength < SNAPSHOT_FRAME_HEADER_BYTES) throw new Error("snapshot frame is truncated");
  if (readUint16LE(payload, 0) !== ENVELOPE_MAGIC) throw new Error("snapshot frame envelope magic mismatch");
  if (payload[2] !== PROTOCOL_VERSION || payload[3] !== MESSAGE_SNAPSHOT)
    throw new Error("snapshot frame envelope mismatch");
  const tick = readUint32LE(payload, 4);
  const kind = payload[8]!;
  if (payload[9] !== 0) throw new Error("snapshot frame reserved byte is nonzero");
  const baseTick = readUint32LE(payload, 10);
  const runCount = readUint16LE(payload, 14);
  if (scratch.baseline.byteLength < SNAPSHOT_BYTES || scratch.decoded.byteLength < SNAPSHOT_BYTES) {
    throw new RangeError("snapshot decode storage is truncated");
  }
  if (kind === SNAPSHOT_KEYFRAME) {
    if (baseTick !== 0 || runCount !== 0 || payload.byteLength !== SNAPSHOT_MESSAGE_BYTES)
      throw new Error("invalid snapshot keyframe");
    copyBytes(scratch.decoded, 0, payload, SNAPSHOT_FRAME_HEADER_BYTES, SNAPSHOT_BYTES);
  } else if (kind === SNAPSHOT_DELTA) {
    if (scratch.baselineTick < 0 || baseTick !== scratch.baselineTick >>> 0) {
      throw new Error("snapshot delta base is unavailable");
    }
    scratch.decoded.set(scratch.baseline);
    let cursor = SNAPSHOT_FRAME_HEADER_BYTES;
    let previousEnd = 0;
    for (let run = 0; run < runCount; run += 1) {
      if (cursor + 4 > payload.byteLength) throw new Error("snapshot delta run header is truncated");
      const offset = readUint16LE(payload, cursor);
      const length = readUint16LE(payload, cursor + 2);
      if (length === 0 || offset < previousEnd || offset + length > SNAPSHOT_BYTES) {
        throw new Error("snapshot delta run is invalid");
      }
      if (cursor + 4 + length > payload.byteLength) throw new Error("snapshot delta run is truncated");
      copyBytes(scratch.decoded, offset, payload, cursor + 4, length);
      cursor += 4 + length;
      previousEnd = offset + length;
    }
    if (cursor !== payload.byteLength) throw new Error("snapshot delta has trailing bytes");
  } else {
    throw new Error("unknown snapshot frame kind");
  }
  if (commitBaseline) {
    scratch.baseline.set(scratch.decoded);
    scratch.baselineTick = tick;
  }
  return tick;
}

function frameHeader(target: Uint8Array, tick: number, kind: number, baseTick: number): void {
  writeUint16LE(target, 0, ENVELOPE_MAGIC);
  target[2] = PROTOCOL_VERSION;
  target[3] = MESSAGE_SNAPSHOT;
  writeUint32LE(target, 4, tick);
  target[8] = kind;
  target[9] = 0;
  writeUint32LE(target, 10, baseTick);
  writeUint16LE(target, 14, 0);
}

function requireFrameCapacity(target: Uint8Array): void {
  if (target.byteLength < SNAPSHOT_MESSAGE_BYTES) {
    throw new RangeError(`snapshot frame requires ${SNAPSHOT_MESSAGE_BYTES} bytes`);
  }
}

function writeUint16LE(target: Uint8Array, offset: number, value: number): void {
  requireFrameRange(target, offset, 2);
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  requireFrameRange(target, offset, 4);
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function readUint16LE(source: Uint8Array, offset: number): number {
  requireFrameRange(source, offset, 2);
  return source[offset]! | (source[offset + 1]! << 8);
}

function readUint32LE(source: Uint8Array, offset: number): number {
  requireFrameRange(source, offset, 4);
  return (
    (source[offset]! | (source[offset + 1]! << 8) | (source[offset + 2]! << 16) | (source[offset + 3]! << 24)) >>> 0
  );
}

function requireFrameRange(bytes: Uint8Array, offset: number, width: number): void {
  if (offset < 0 || offset + width > bytes.byteLength) throw new RangeError("snapshot frame field is out of bounds");
}

/** Copies a bounded byte range without allocating a transient typed-array view. */
function copyBytes(
  target: Uint8Array,
  targetOffset: number,
  source: Uint8Array,
  sourceOffset: number,
  length: number,
): void {
  for (let index = 0; index < length; index += 1) {
    target[targetOffset + index] = source[sourceOffset + index]!;
  }
}

/**
 * A caller-owned full snapshot. The arena grid is deliberately absent: it is
 * derived from `mapSeed`, which is here, so terrain costs four bytes on the wire
 * rather than 10,800. The external input replay log is also separate and must be
 * re-submitted after a rollback.
 */
export function writeWorldSnapshot(world: BattleWorld, target: Uint8Array, byteOffset: number): number {
  requireSnapshotRange(target, byteOffset);
  const view = new DataView(target.buffer, target.byteOffset + byteOffset, SNAPSHOT_BYTES);
  view.setUint32(0, SNAPSHOT_MAGIC, true);
  view.setUint16(4, SNAPSHOT_VERSION, true);
  view.setUint16(6, SNAPSHOT_BYTES, true);
  view.setUint32(8, world.tick, true);
  view.setUint32(12, world.matchId, true);
  view.setUint16(16, world.projectileCursor, true);
  view.setInt16(18, world.objectiveProgress, true);
  view.setUint8(20, world.objectiveOwner);
  view.setUint8(21, 0);
  view.setUint16(22, world.objectiveTeamOneScore, true);
  view.setUint16(24, world.objectiveTeamTwoScore, true);
  view.setUint16(26, 0, true);
  view.setUint32(28, world.mapSeed, true);

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
    view.setInt32(cursor + 16, world.playerVelocityX[slot]!, true);
    view.setInt32(cursor + 20, world.playerVelocityY[slot]!, true);
    view.setInt16(cursor + 24, world.playerHullX[slot]!, true);
    view.setInt16(cursor + 26, world.playerHullY[slot]!, true);
    view.setInt16(cursor + 28, world.playerTurretX[slot]!, true);
    view.setInt16(cursor + 30, world.playerTurretY[slot]!, true);
    view.setInt16(cursor + 32, world.playerAimX[slot]!, true);
    view.setInt16(cursor + 34, world.playerAimY[slot]!, true);
    view.setInt16(cursor + 36, world.playerHealth[slot]!, true);
    view.setInt16(cursor + 38, world.playerArmor[slot]!, true);
    view.setUint16(cursor + 40, world.playerCooldown[slot]!, true);
    view.setUint16(cursor + 42, world.playerRespawnTicks[slot]!, true);
    view.setUint16(cursor + 44, world.playerSpawnProtectTicks[slot]!, true);
    view.setUint16(cursor + 46, world.playerOverdriveTicks[slot]!, true);
    view.setUint16(cursor + 48, world.playerBoostCharge[slot]!, true);
    view.setUint16(cursor + 50, world.playerLastSequence[slot]!, true);
    view.setInt32(cursor + 52, world.playerScore[slot]!, true);
    view.setInt32(cursor + 56, world.playerDeaths[slot]!, true);
    view.setInt32(cursor + 60, world.playerCredits[slot]!, true);
    view.setUint32(cursor + 64, world.playerLastInputTick[slot]! < 0 ? 0 : world.playerLastInputTick[slot]!, true);
    view.setInt8(cursor + 68, world.playerLastMoveX[slot]!);
    view.setInt8(cursor + 69, world.playerLastMoveY[slot]!);
    view.setInt8(cursor + 70, world.playerLastAimX[slot]!);
    view.setInt8(cursor + 71, world.playerLastAimY[slot]!);
    view.setUint8(cursor + 72, world.playerLastButtons[slot]!);
    view.setUint8(cursor + 73, world.playerWeaponRequest[slot]!);
    view.setUint8(cursor + 74, world.playerBotSkill[slot]!);
    view.setUint8(cursor + 75, world.playerBoostTicks[slot]!);
    view.setUint8(cursor + 76, world.playerChassis[slot]!);
    view.setUint8(cursor + 77, world.playerChassisUnlocks[slot]!);
    view.setUint16(cursor + 78, world.playerWeaponUpgradeUnlocks[slot]!, true);
    view.setUint16(cursor + 80, world.playerWeaponUpgradeSelections[slot]!, true);
    for (let weapon = 0; weapon < WEAPON_COUNT; weapon += 1) {
      view.setUint16(cursor + 82 + weapon * 2, world.playerAmmo[slot * WEAPON_COUNT + weapon]!, true);
    }
    view.setUint8(cursor + 94, world.playerMode[slot]!);
    view.setUint8(cursor + 95, world.playerLastInputTick[slot]! < 0 ? 0 : 1);
    cursor += PLAYER_SNAPSHOT_BYTES;
  }

  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    view.setUint8(cursor, world.projectileActive[slot]!);
    view.setUint8(cursor + 1, world.projectileWeapon[slot]!);
    view.setUint16(cursor + 2, world.projectileGeneration[slot]!, true);
    view.setUint8(cursor + 4, world.projectileOwner[slot]!);
    view.setUint8(cursor + 5, world.projectileBounces[slot]!);
    view.setInt16(cursor + 6, world.projectileDamage[slot]!, true);
    view.setInt32(cursor + 8, world.projectileX[slot]!, true);
    view.setInt32(cursor + 12, world.projectileY[slot]!, true);
    view.setInt16(cursor + 16, world.projectileDirectionX[slot]!, true);
    view.setInt16(cursor + 18, world.projectileDirectionY[slot]!, true);
    view.setUint16(cursor + 20, world.projectileLife[slot]!, true);
    view.setUint16(cursor + 22, world.projectileSpeed[slot]!, true);
    view.setUint16(cursor + 24, world.projectileRadius[slot]!, true);
    view.setUint8(cursor + 26, world.projectilePierce[slot]!);
    view.setUint8(cursor + 27, world.projectileUpgrade[slot]!);
    cursor += PROJECTILE_SNAPSHOT_BYTES;
  }

  for (let index = 0; index < MAX_PICKUPS; index += 1) {
    view.setUint8(cursor, world.pickupKind[index]!);
    view.setUint8(cursor + 1, world.pickupActive[index]!);
    view.setUint16(cursor + 2, world.pickupRespawnTicks[index]!, true);
    view.setInt32(cursor + 4, world.pickupX[index]!, true);
    view.setInt32(cursor + 8, world.pickupY[index]!, true);
    cursor += PICKUP_SNAPSHOT_BYTES;
  }

  for (let panel = 0; panel < COVER_SNAPSHOT_BYTES; panel += 1) {
    view.setUint8(cursor, world.map.coverHealth[panel]!);
    cursor += 1;
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
  if (view.getUint32(28, true) !== world.mapSeed) throw new Error("snapshot arena seed mismatch");
  const objectiveProgress = view.getInt16(18, true);
  const objectiveOwner = view.getUint8(20);
  if (objectiveProgress < -OBJECTIVE_CAPTURE_TICKS || objectiveProgress > OBJECTIVE_CAPTURE_TICKS)
    throw new Error("snapshot objective progress is invalid");
  if (objectiveOwner > 2 || view.getUint8(21) !== 0 || view.getUint16(26, true) !== 0) {
    throw new Error("snapshot objective header is invalid");
  }
  world.objectiveProgress = objectiveProgress;
  world.objectiveOwner = objectiveOwner;
  world.objectiveTeamOneScore = view.getUint16(22, true);
  world.objectiveTeamTwoScore = view.getUint16(24, true);
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
    world.playerVelocityX[slot] = view.getInt32(cursor + 16, true);
    world.playerVelocityY[slot] = view.getInt32(cursor + 20, true);
    world.playerHullX[slot] = view.getInt16(cursor + 24, true);
    world.playerHullY[slot] = view.getInt16(cursor + 26, true);
    world.playerTurretX[slot] = view.getInt16(cursor + 28, true);
    world.playerTurretY[slot] = view.getInt16(cursor + 30, true);
    world.playerAimX[slot] = view.getInt16(cursor + 32, true);
    world.playerAimY[slot] = view.getInt16(cursor + 34, true);
    world.playerHealth[slot] = view.getInt16(cursor + 36, true);
    world.playerArmor[slot] = view.getInt16(cursor + 38, true);
    world.playerCooldown[slot] = view.getUint16(cursor + 40, true);
    world.playerRespawnTicks[slot] = view.getUint16(cursor + 42, true);
    world.playerSpawnProtectTicks[slot] = view.getUint16(cursor + 44, true);
    world.playerOverdriveTicks[slot] = view.getUint16(cursor + 46, true);
    world.playerBoostCharge[slot] = view.getUint16(cursor + 48, true);
    world.playerLastSequence[slot] = view.getUint16(cursor + 50, true);
    world.playerScore[slot] = view.getInt32(cursor + 52, true);
    world.playerDeaths[slot] = view.getInt32(cursor + 56, true);
    world.playerCredits[slot] = view.getInt32(cursor + 60, true);
    const lastInputValid = view.getUint8(cursor + 95);
    if (lastInputValid > 1) throw new Error("snapshot player input-valid flag is invalid");
    world.playerLastInputTick[slot] = lastInputValid === 0 ? -1 : view.getUint32(cursor + 64, true);
    world.playerLastMoveX[slot] = view.getInt8(cursor + 68);
    world.playerLastMoveY[slot] = view.getInt8(cursor + 69);
    world.playerLastAimX[slot] = view.getInt8(cursor + 70);
    world.playerLastAimY[slot] = view.getInt8(cursor + 71);
    world.playerLastButtons[slot] = view.getUint8(cursor + 72);
    world.playerWeaponRequest[slot] = view.getUint8(cursor + 73);
    world.playerBotSkill[slot] = view.getUint8(cursor + 74);
    world.playerBoostTicks[slot] = view.getUint8(cursor + 75);
    const chassis = view.getUint8(cursor + 76);
    const chassisUnlocks = view.getUint8(cursor + 77);
    const weaponUpgradeUnlocks = view.getUint16(cursor + 78, true);
    const weaponUpgradeSelections = view.getUint16(cursor + 80, true);
    const mode = view.getUint8(cursor + 94);
    if (mode > 2) throw new Error("snapshot player mode is invalid");
    if (world.playerActive[slot] !== 0 && (chassis < 1 || chassis > CHASSIS_COUNT))
      throw new Error("snapshot chassis id is invalid");
    if ((chassisUnlocks & ~CHASSIS_UNLOCK_MASK) !== 0) throw new Error("snapshot chassis unlock mask is invalid");
    if (world.playerActive[slot] !== 0 && (chassisUnlocks & chassisUnlockBit(chassis)) === 0) {
      throw new Error("snapshot active chassis is not unlocked");
    }
    if ((weaponUpgradeUnlocks & ~((1 << WEAPON_UPGRADE_COUNT) - 1)) !== 0)
      throw new Error("snapshot weapon upgrade mask is invalid");
    for (let weapon = 0; weapon < WEAPON_COUNT; weapon += 1) {
      const branch = (weaponUpgradeSelections >>> (weapon * 2)) & 3;
      if (branch > 2) throw new Error("snapshot weapon upgrade selection is invalid");
      if (branch !== 0) {
        const upgradeId = weapon * 2 + branch;
        if ((weaponUpgradeUnlocks & (1 << (upgradeId - 1))) === 0)
          throw new Error("snapshot selected weapon upgrade is locked");
      }
    }
    world.playerChassis[slot] = chassis;
    world.playerChassisUnlocks[slot] = chassisUnlocks;
    world.playerWeaponUpgradeUnlocks[slot] = weaponUpgradeUnlocks;
    world.playerWeaponUpgradeSelections[slot] = weaponUpgradeSelections;
    world.playerMode[slot] = mode;
    for (let weapon = 0; weapon < WEAPON_COUNT; weapon += 1) {
      world.playerAmmo[slot * WEAPON_COUNT + weapon] = view.getUint16(cursor + 82 + weapon * 2, true);
    }
    cursor += PLAYER_SNAPSHOT_BYTES;
  }

  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    world.projectileActive[slot] = view.getUint8(cursor);
    world.projectileWeapon[slot] = view.getUint8(cursor + 1);
    world.projectileGeneration[slot] = view.getUint16(cursor + 2, true);
    world.projectileOwner[slot] = view.getUint8(cursor + 4);
    world.projectileBounces[slot] = view.getUint8(cursor + 5);
    world.projectileDamage[slot] = view.getInt16(cursor + 6, true);
    world.projectileX[slot] = view.getInt32(cursor + 8, true);
    world.projectileY[slot] = view.getInt32(cursor + 12, true);
    world.projectileDirectionX[slot] = view.getInt16(cursor + 16, true);
    world.projectileDirectionY[slot] = view.getInt16(cursor + 18, true);
    world.projectileLife[slot] = view.getUint16(cursor + 20, true);
    world.projectileSpeed[slot] = view.getUint16(cursor + 22, true);
    world.projectileRadius[slot] = view.getUint16(cursor + 24, true);
    world.projectilePierce[slot] = view.getUint8(cursor + 26);
    const projectileUpgrade = view.getUint8(cursor + 27);
    if (projectileUpgrade > WEAPON_UPGRADE_COUNT) throw new Error("snapshot projectile upgrade is invalid");
    if (projectileUpgrade !== 0 && weaponUpgradeById(projectileUpgrade).weaponId !== world.projectileWeapon[slot]) {
      throw new Error("snapshot projectile upgrade weapon mismatch");
    }
    world.projectileUpgrade[slot] = projectileUpgrade;
    cursor += PROJECTILE_SNAPSHOT_BYTES;
  }

  for (let index = 0; index < MAX_PICKUPS; index += 1) {
    world.pickupKind[index] = view.getUint8(cursor);
    world.pickupActive[index] = view.getUint8(cursor + 1);
    world.pickupRespawnTicks[index] = view.getUint16(cursor + 2, true);
    world.pickupX[index] = view.getInt32(cursor + 4, true);
    world.pickupY[index] = view.getInt32(cursor + 8, true);
    cursor += PICKUP_SNAPSHOT_BYTES;
  }

  for (let panel = 0; panel < COVER_SNAPSHOT_BYTES; panel += 1) {
    const health = view.getUint8(cursor);
    if (health > COVER_MAX_HEALTH) throw new Error("snapshot cover health is invalid");
    world.map.coverHealth[panel] = health;
    cursor += 1;
  }

  return byteOffset + SNAPSHOT_BYTES;
}

function requireSnapshotRange(bytes: Uint8Array, byteOffset: number): void {
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + SNAPSHOT_BYTES > bytes.byteLength) {
    throw new RangeError(`snapshot requires ${SNAPSHOT_BYTES} bytes at the requested offset`);
  }
}
