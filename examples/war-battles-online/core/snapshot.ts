import {
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  MAX_ARMOR,
  COVER_MAX_HEALTH,
  COVER_SNAPSHOT_BYTES,
  NETWORK_PLAYER_SNAPSHOT_BYTES,
  NETWORK_PROJECTILE_SNAPSHOT_BYTES,
  NETWORK_SNAPSHOT_BYTES,
  OBJECTIVE_CAPTURE_TICKS,
  OVERDRIVE_TICKS,
  PICKUP_SNAPSHOT_BYTES,
  PLAYER_SNAPSHOT_BYTES,
  PROJECTILE_SNAPSHOT_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_HEADER_BYTES,
  TANK_BOOST_CAPACITY,
  WORLD_MAX_X,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  WORLD_MIN_Y,
} from "./constants.ts";
import {
  CHASSIS_COUNT,
  CHASSIS_UNLOCK_MASK,
  WEAPON_COUNT,
  WEAPON_UPGRADE_COUNT,
  chassisUnlockBit,
  weaponById,
  weaponUpgradeById,
} from "./content.ts";
import {
  ENVELOPE_MAGIC,
  MESSAGE_SNAPSHOT,
  NETWORK_SNAPSHOT_MESSAGE_BYTES,
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
// Snapshot runs use unsigned LEB128 for the gap from the previous run and the
// run length. Typical gaps and lengths therefore cost two bytes total instead
// of four fixed bytes. Carrying one unchanged byte is always cheaper than a
// second run; larger gaps stay separate because measured varint-boundary cases
// can make otherwise equal-size coalescing marginally worse.
const RUN_COALESCE_GAP_BYTES = 1;
const NETWORK_MAX_PLAYER_HEALTH = 240;

export interface SnapshotFrameScratch {
  baseline: Uint8Array;
  readonly decoded: Uint8Array;
  baselineTick: number;
}

const RAW_PROJECTILE_OFFSET = SNAPSHOT_HEADER_BYTES + MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES;
const NETWORK_PLAYER_OFFSET = SNAPSHOT_HEADER_BYTES;
const NETWORK_PROJECTILE_OFFSET = NETWORK_PLAYER_OFFSET + MAX_PLAYERS * NETWORK_PLAYER_SNAPSHOT_BYTES;
const RAW_PICKUP_OFFSET = RAW_PROJECTILE_OFFSET + MAX_PROJECTILES * PROJECTILE_SNAPSHOT_BYTES;
const NETWORK_PICKUP_OFFSET = NETWORK_PROJECTILE_OFFSET + MAX_PROJECTILES * NETWORK_PROJECTILE_SNAPSHOT_BYTES;
const RAW_COVER_OFFSET = RAW_PICKUP_OFFSET + MAX_PICKUPS * PICKUP_SNAPSHOT_BYTES;
const NETWORK_COVER_OFFSET = NETWORK_PICKUP_OFFSET + MAX_PICKUPS * PICKUP_SNAPSHOT_BYTES;

/**
 * Projects the broad rollback image into the exact fixed-point network image.
 * No backing arrays are acquired; callers own both buffers. The short-lived
 * DataView wrapper is reported separately by the allocation-shape evidence.
 */
export function compactNetworkSnapshot(source: Uint8Array, target: Uint8Array): number {
  if (source.byteLength < SNAPSHOT_BYTES) throw new RangeError("rollback snapshot source is truncated");
  if (target.byteLength < NETWORK_SNAPSHOT_BYTES) throw new RangeError("network snapshot target is truncated");
  copyBytes(target, 0, source, 0, SNAPSHOT_HEADER_BYTES);
  const sourceView = new DataView(source.buffer, source.byteOffset, SNAPSHOT_BYTES);
  const snapshotTick = sourceView.getUint32(8, true);
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    compactNetworkPlayer(sourceView, target, slot);
  }
  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    const raw = RAW_PROJECTILE_OFFSET + slot * PROJECTILE_SNAPSHOT_BYTES;
    const packed = NETWORK_PROJECTILE_OFFSET + slot * NETWORK_PROJECTILE_SNAPSHOT_BYTES;
    for (let byte = 0; byte < NETWORK_PROJECTILE_SNAPSHOT_BYTES; byte += 1) target[packed + byte] = 0;
    const active = sourceView.getUint8(raw);
    const generation = sourceView.getUint16(raw + 2, true);
    requirePackedUnsigned(active, 1, "projectile active");
    let bit = 0;
    bit = writePackedBits(target, packed, bit, active, 1);
    bit = writePackedBits(target, packed, bit, generation, 16);
    if (active === 0) continue;
    const weapon = sourceView.getUint8(raw + 1);
    const owner = sourceView.getUint8(raw + 4);
    const bounces = sourceView.getUint8(raw + 5);
    const damage = sourceView.getInt16(raw + 6, true);
    const x = sourceView.getInt32(raw + 8, true);
    const y = sourceView.getInt32(raw + 12, true);
    const directionX = sourceView.getInt16(raw + 16, true);
    const directionY = sourceView.getInt16(raw + 18, true);
    const life = sourceView.getUint16(raw + 20, true);
    const speed = sourceView.getUint16(raw + 22, true);
    const radius = sourceView.getUint16(raw + 24, true);
    const pierce = sourceView.getUint8(raw + 26);
    const upgrade = sourceView.getUint8(raw + 27);
    requirePackedRange(owner, 1, MAX_PLAYERS, "projectile owner");
    requirePackedRange(weapon, 1, WEAPON_COUNT, "projectile weapon");
    requirePackedUnsigned(upgrade, 4, "projectile upgrade");
    if (upgrade > WEAPON_UPGRADE_COUNT || (upgrade !== 0 && weaponUpgradeById(upgrade).weaponId !== weapon)) {
      throw new RangeError("projectile upgrade does not match its weapon");
    }
    requirePackedUnsigned(bounces, 3, "projectile bounces");
    requirePackedUnsigned(pierce, 2, "projectile pierce");
    requirePackedUnsigned(damage, 9, "projectile damage");
    requirePackedRange(x, WORLD_MIN_X, WORLD_MAX_X, "projectile x");
    requirePackedRange(y, WORLD_MIN_Y, WORLD_MAX_Y, "projectile y");
    requirePackedRange(directionX, -256, 256, "projectile direction x");
    requirePackedRange(directionY, -256, 256, "projectile direction y");
    requirePackedUnsigned(life, 8, "projectile life");
    requirePackedUnsigned(speed, 10, "projectile speed");
    requirePackedUnsigned(radius, 8, "projectile radius");
    bit = writePackedBits(target, packed, bit, owner - 1, 5);
    bit = writePackedBits(target, packed, bit, weapon - 1, 3);
    bit = writePackedBits(target, packed, bit, upgrade, 4);
    bit = writePackedBits(target, packed, bit, bounces, 3);
    bit = writePackedBits(target, packed, bit, pierce, 2);
    bit = writePackedBits(target, packed, bit, damage, 9);
    // Encode a trajectory invariant rather than the current position. The
    // fixed-point simulation advances a straight segment by the same integer
    // displacement each tick, so (position - tick * displacement) modulo the
    // coordinate field is constant until a bounce/correction changes the
    // trajectory. Likewise (tick + remaining life) modulo 256 is constant.
    // The ordinary snapshot delta codec therefore carries spawn, trajectory
    // change and despawn events instead of paying for motion every snapshot.
    const velocityX = projectileDisplacementPerTick(directionX, speed);
    const velocityY = projectileDisplacementPerTick(directionY, speed);
    const phaseX = positiveModulo(x - WORLD_MIN_X - snapshotTick * velocityX, 1 << 15);
    const phaseY = positiveModulo(y - WORLD_MIN_Y - snapshotTick * velocityY, 1 << 15);
    const expiryTick = (snapshotTick + life) & 0xff;
    bit = writePackedBits(target, packed, bit, phaseX, 15);
    bit = writePackedBits(target, packed, bit, phaseY, 15);
    bit = writePackedBits(target, packed, bit, directionX + 256, 10);
    bit = writePackedBits(target, packed, bit, directionY + 256, 10);
    bit = writePackedBits(target, packed, bit, expiryTick, 8);
    bit = writePackedBits(target, packed, bit, speed, 10);
    writePackedBits(target, packed, bit, radius, 8);
  }
  copyBytes(target, NETWORK_PICKUP_OFFSET, source, RAW_PICKUP_OFFSET, MAX_PICKUPS * PICKUP_SNAPSHOT_BYTES);
  copyBytes(target, NETWORK_COVER_OFFSET, source, RAW_COVER_OFFSET, COVER_SNAPSHOT_BYTES);
  return NETWORK_SNAPSHOT_BYTES;
}

/** Expands and validates one compact network image into the rollback layout. */
export function expandNetworkSnapshot(source: Uint8Array, target: Uint8Array, expectedTick?: number): number {
  if (source.byteLength < NETWORK_SNAPSHOT_BYTES) throw new RangeError("network snapshot source is truncated");
  if (target.byteLength < SNAPSHOT_BYTES) throw new RangeError("rollback snapshot target is truncated");
  copyBytes(target, 0, source, 0, SNAPSHOT_HEADER_BYTES);
  const targetView = new DataView(target.buffer, target.byteOffset, SNAPSHOT_BYTES);
  const snapshotTick = targetView.getUint32(8, true);
  if (expectedTick !== undefined && snapshotTick !== expectedTick >>> 0) {
    throw new Error("snapshot frame tick does not match its projected world state");
  }
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    expandNetworkPlayer(source, targetView, slot);
  }
  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    const packed = NETWORK_PROJECTILE_OFFSET + slot * NETWORK_PROJECTILE_SNAPSHOT_BYTES;
    const raw = RAW_PROJECTILE_OFFSET + slot * PROJECTILE_SNAPSHOT_BYTES;
    let bit = 0;
    const active = readPackedBits(source, packed, bit, 1);
    bit += 1;
    const generation = readPackedBits(source, packed, bit, 16);
    bit += 16;
    targetView.setUint8(raw, active);
    targetView.setUint16(raw + 2, generation, true);
    if (active === 0) {
      if (packedRecordHasNonZeroBits(source, packed, bit, 120 - bit)) {
        throw new Error("inactive projectile network record is noncanonical");
      }
      targetView.setUint8(raw + 1, 0);
      for (let byte = 4; byte < PROJECTILE_SNAPSHOT_BYTES; byte += 1) targetView.setUint8(raw + byte, 0);
      continue;
    }
    const owner = readPackedBits(source, packed, bit, 5) + 1;
    bit += 5;
    const weapon = readPackedBits(source, packed, bit, 3) + 1;
    bit += 3;
    const upgrade = readPackedBits(source, packed, bit, 4);
    bit += 4;
    const bounces = readPackedBits(source, packed, bit, 3);
    bit += 3;
    const pierce = readPackedBits(source, packed, bit, 2);
    bit += 2;
    const damage = readPackedBits(source, packed, bit, 9);
    bit += 9;
    const phaseX = readPackedBits(source, packed, bit, 15);
    bit += 15;
    const phaseY = readPackedBits(source, packed, bit, 15);
    bit += 15;
    const directionX = readPackedBits(source, packed, bit, 10) - 256;
    bit += 10;
    const directionY = readPackedBits(source, packed, bit, 10) - 256;
    bit += 10;
    const expiryTick = readPackedBits(source, packed, bit, 8);
    bit += 8;
    const speed = readPackedBits(source, packed, bit, 10);
    bit += 10;
    const radius = readPackedBits(source, packed, bit, 8);
    bit += 8;
    if (readPackedBits(source, packed, bit, 1) !== 0) throw new Error("projectile network reserved bit is nonzero");
    const velocityX = projectileDisplacementPerTick(directionX, speed);
    const velocityY = projectileDisplacementPerTick(directionY, speed);
    const x = WORLD_MIN_X + positiveModulo(phaseX + snapshotTick * velocityX, 1 << 15);
    const y = WORLD_MIN_Y + positiveModulo(phaseY + snapshotTick * velocityY, 1 << 15);
    const life = positiveModulo(expiryTick - (snapshotTick & 0xff), 1 << 8);
    requirePackedRange(owner, 1, MAX_PLAYERS, "projectile owner");
    requirePackedRange(weapon, 1, WEAPON_COUNT, "projectile weapon");
    if (upgrade > WEAPON_UPGRADE_COUNT || (upgrade !== 0 && weaponUpgradeById(upgrade).weaponId !== weapon)) {
      throw new Error("projectile network upgrade does not match its weapon");
    }
    requirePackedRange(x, WORLD_MIN_X, WORLD_MAX_X, "projectile x");
    requirePackedRange(y, WORLD_MIN_Y, WORLD_MAX_Y, "projectile y");
    requirePackedRange(directionX, -256, 256, "projectile direction x");
    requirePackedRange(directionY, -256, 256, "projectile direction y");
    targetView.setUint8(raw + 1, weapon);
    targetView.setUint8(raw + 4, owner);
    targetView.setUint8(raw + 5, bounces);
    targetView.setInt16(raw + 6, damage, true);
    targetView.setInt32(raw + 8, x, true);
    targetView.setInt32(raw + 12, y, true);
    targetView.setInt16(raw + 16, directionX, true);
    targetView.setInt16(raw + 18, directionY, true);
    targetView.setUint16(raw + 20, life, true);
    targetView.setUint16(raw + 22, speed, true);
    targetView.setUint16(raw + 24, radius, true);
    targetView.setUint8(raw + 26, pierce);
    targetView.setUint8(raw + 27, upgrade);
  }
  copyBytes(target, RAW_PICKUP_OFFSET, source, NETWORK_PICKUP_OFFSET, MAX_PICKUPS * PICKUP_SNAPSHOT_BYTES);
  copyBytes(target, RAW_COVER_OFFSET, source, NETWORK_COVER_OFFSET, COVER_SNAPSHOT_BYTES);
  return SNAPSHOT_BYTES;
}

/**
 * The player wire schema is 522 bits (66 bytes, with six reserved bits), versus the 96-byte rollback
 * record. Every narrowed field is bounded by the simulation/content schema;
 * the two signed Int32 velocities and three signed Int32 counters stay full
 * width because their values are not otherwise bounded by gameplay rules.
 *
 * Field order is deliberately shared by compactNetworkPlayer and
 * expandNetworkPlayer. It is a fixed record, not a variable-length bitstream,
 * so the projection remains bounded and does not acquire per-call storage.
 */
function compactNetworkPlayer(source: DataView, target: Uint8Array, slot: number): void {
  const raw = SNAPSHOT_HEADER_BYTES + slot * PLAYER_SNAPSHOT_BYTES;
  const packed = NETWORK_PLAYER_OFFSET + slot * NETWORK_PLAYER_SNAPSHOT_BYTES;
  for (let byte = 0; byte < NETWORK_PLAYER_SNAPSHOT_BYTES; byte += 1) target[packed + byte] = 0;
  let bit = 0;

  const active = source.getUint8(raw);
  const team = source.getUint8(raw + 1);
  const weapon = source.getUint8(raw + 2);
  const damageLevel = source.getUint8(raw + 3);
  const mobilityLevel = source.getUint8(raw + 4);
  const armorLevel = source.getUint8(raw + 5);
  const generation = source.getUint16(raw + 6, true);
  const x = source.getInt32(raw + 8, true);
  const y = source.getInt32(raw + 12, true);
  const velocityX = source.getInt32(raw + 16, true);
  const velocityY = source.getInt32(raw + 20, true);
  const hullX = source.getInt16(raw + 24, true);
  const hullY = source.getInt16(raw + 26, true);
  const turretX = source.getInt16(raw + 28, true);
  const turretY = source.getInt16(raw + 30, true);
  const aimX = source.getInt16(raw + 32, true);
  const aimY = source.getInt16(raw + 34, true);
  const health = source.getInt16(raw + 36, true);
  const armor = source.getInt16(raw + 38, true);
  const cooldown = source.getUint16(raw + 40, true);
  const respawnTicks = source.getUint16(raw + 42, true);
  const spawnProtectTicks = source.getUint16(raw + 44, true);
  const overdriveTicks = source.getUint16(raw + 46, true);
  const boostCharge = source.getUint16(raw + 48, true);
  const lastSequence = source.getUint16(raw + 50, true);
  const score = source.getInt32(raw + 52, true);
  const deaths = source.getInt32(raw + 56, true);
  const credits = source.getInt32(raw + 60, true);
  const lastInputTick = source.getUint32(raw + 64, true);
  const lastMoveX = source.getInt8(raw + 68);
  const lastMoveY = source.getInt8(raw + 69);
  const lastAimX = source.getInt8(raw + 70);
  const lastAimY = source.getInt8(raw + 71);
  const lastButtons = source.getUint8(raw + 72);
  const weaponRequest = source.getUint8(raw + 73);
  const botSkill = source.getUint8(raw + 74);
  const boostTicks = source.getUint8(raw + 75);
  const chassis = source.getUint8(raw + 76);
  const chassisUnlocks = source.getUint8(raw + 77);
  const weaponUpgradeUnlocks = source.getUint16(raw + 78, true);
  const weaponUpgradeSelections = source.getUint16(raw + 80, true);
  const mode = source.getUint8(raw + 94);
  const lastInputValid = source.getUint8(raw + 95);

  requirePackedUnsigned(active, 1, "player active");
  requirePackedRange(weapon, 0, WEAPON_COUNT, "player weapon");
  requirePackedUnsigned(damageLevel, 2, "player damage level");
  requirePackedUnsigned(mobilityLevel, 2, "player mobility level");
  requirePackedUnsigned(armorLevel, 2, "player armor level");
  requirePackedRange(x, WORLD_MIN_X, WORLD_MAX_X, "player x");
  requirePackedRange(y, WORLD_MIN_Y, WORLD_MAX_Y, "player y");
  requirePackedRange(hullX, -256, 256, "player hull x");
  requirePackedRange(hullY, -256, 256, "player hull y");
  requirePackedRange(turretX, -256, 256, "player turret x");
  requirePackedRange(turretY, -256, 256, "player turret y");
  requirePackedRange(aimX, -256, 256, "player aim x");
  requirePackedRange(aimY, -256, 256, "player aim y");
  requirePackedRange(health, 0, NETWORK_MAX_PLAYER_HEALTH, "player health");
  requirePackedRange(armor, 0, MAX_ARMOR, "player armor");
  requirePackedUnsigned(cooldown, 8, "player cooldown");
  requirePackedUnsigned(respawnTicks, 8, "player respawn ticks");
  requirePackedUnsigned(spawnProtectTicks, 8, "player spawn protect ticks");
  requirePackedRange(overdriveTicks, 0, OVERDRIVE_TICKS, "player overdrive ticks");
  requirePackedRange(boostCharge, 0, TANK_BOOST_CAPACITY, "player boost charge");
  requirePackedUnsigned(lastButtons, 2, "player last buttons");
  requirePackedRange(weaponRequest, 0, WEAPON_COUNT, "player weapon request");
  requirePackedUnsigned(boostTicks, 1, "player boost ticks");
  requirePackedRange(chassis, 0, CHASSIS_COUNT, "player chassis");
  requirePackedUnsigned(chassisUnlocks, 4, "player chassis unlocks");
  requirePackedUnsigned(weaponUpgradeUnlocks, 12, "player weapon upgrade unlocks");
  requirePackedUnsigned(weaponUpgradeSelections, 12, "player weapon upgrade selections");
  requirePackedUnsigned(mode, 2, "player mode");
  requirePackedUnsigned(lastInputValid, 1, "player input valid");
  if (lastInputValid === 0 && lastInputTick !== 0) throw new RangeError("invalid player input tick sentinel");
  if (mode > 2) throw new RangeError("player mode is invalid");
  if (active !== 0 && weapon === 0) throw new RangeError("active player weapon is invalid");
  if (active !== 0 && chassis === 0) throw new RangeError("active player chassis is invalid");
  if (active !== 0 && (chassisUnlocks & chassisUnlockBit(chassis)) === 0) {
    throw new RangeError("active player chassis is not unlocked");
  }
  if ((chassisUnlocks & ~CHASSIS_UNLOCK_MASK) !== 0) throw new RangeError("player chassis unlock mask is invalid");
  if ((weaponUpgradeUnlocks & ~((1 << WEAPON_UPGRADE_COUNT) - 1)) !== 0) {
    throw new RangeError("player weapon upgrade mask is invalid");
  }
  for (let weaponId = 1; weaponId <= WEAPON_COUNT; weaponId += 1) {
    const branch = (weaponUpgradeSelections >>> ((weaponId - 1) * 2)) & 3;
    if (branch > 2) throw new RangeError("player weapon upgrade selection is invalid");
    if (branch !== 0) {
      const upgradeId = (weaponId - 1) * 2 + branch;
      if ((weaponUpgradeUnlocks & (1 << (upgradeId - 1))) === 0)
        throw new RangeError("player selected weapon upgrade is locked");
    }
    const maximumAmmo = weaponById(weaponId).maximumAmmo;
    requirePackedUnsigned(source.getUint16(raw + 82 + (weaponId - 1) * 2, true), 9, "player ammo");
    if (source.getUint16(raw + 82 + (weaponId - 1) * 2, true) > maximumAmmo) {
      throw new RangeError("player ammo exceeds weapon capacity");
    }
  }

  bit = writePackedBits(target, packed, bit, active, 1);
  bit = writePackedBits(target, packed, bit, team, 8);
  bit = writePackedBits(target, packed, bit, weapon, 3);
  bit = writePackedBits(target, packed, bit, damageLevel, 2);
  bit = writePackedBits(target, packed, bit, mobilityLevel, 2);
  bit = writePackedBits(target, packed, bit, armorLevel, 2);
  bit = writePackedBits(target, packed, bit, generation, 16);
  bit = writePackedBits(target, packed, bit, x - WORLD_MIN_X, 15);
  bit = writePackedBits(target, packed, bit, y - WORLD_MIN_Y, 15);
  bit = writePackedBits(target, packed, bit, velocityX >>> 0, 32);
  bit = writePackedBits(target, packed, bit, velocityY >>> 0, 32);
  bit = writePackedBits(target, packed, bit, hullX + 256, 10);
  bit = writePackedBits(target, packed, bit, hullY + 256, 10);
  bit = writePackedBits(target, packed, bit, turretX + 256, 10);
  bit = writePackedBits(target, packed, bit, turretY + 256, 10);
  bit = writePackedBits(target, packed, bit, aimX + 256, 10);
  bit = writePackedBits(target, packed, bit, aimY + 256, 10);
  bit = writePackedBits(target, packed, bit, health, 8);
  bit = writePackedBits(target, packed, bit, armor, 7);
  bit = writePackedBits(target, packed, bit, cooldown, 8);
  bit = writePackedBits(target, packed, bit, respawnTicks, 8);
  bit = writePackedBits(target, packed, bit, spawnProtectTicks, 8);
  bit = writePackedBits(target, packed, bit, overdriveTicks, 10);
  bit = writePackedBits(target, packed, bit, boostTicks, 1);
  bit = writePackedBits(target, packed, bit, boostCharge, 7);
  bit = writePackedBits(target, packed, bit, lastSequence, 16);
  bit = writePackedBits(target, packed, bit, score >>> 0, 32);
  bit = writePackedBits(target, packed, bit, deaths >>> 0, 32);
  bit = writePackedBits(target, packed, bit, credits >>> 0, 32);
  bit = writePackedBits(target, packed, bit, lastInputTick, 32);
  bit = writePackedBits(target, packed, bit, lastInputValid, 1);
  bit = writePackedBits(target, packed, bit, lastMoveX + 128, 8);
  bit = writePackedBits(target, packed, bit, lastMoveY + 128, 8);
  bit = writePackedBits(target, packed, bit, lastAimX + 128, 8);
  bit = writePackedBits(target, packed, bit, lastAimY + 128, 8);
  bit = writePackedBits(target, packed, bit, lastButtons, 2);
  bit = writePackedBits(target, packed, bit, weaponRequest, 3);
  bit = writePackedBits(target, packed, bit, botSkill, 8);
  bit = writePackedBits(target, packed, bit, chassis, 3);
  bit = writePackedBits(target, packed, bit, chassisUnlocks, 4);
  bit = writePackedBits(target, packed, bit, weaponUpgradeUnlocks, 12);
  bit = writePackedBits(target, packed, bit, weaponUpgradeSelections, 12);
  bit = writePackedBits(target, packed, bit, mode, 2);
  for (let weaponId = 1; weaponId <= WEAPON_COUNT; weaponId += 1) {
    bit = writePackedBits(target, packed, bit, source.getUint16(raw + 80 + weaponId * 2, true), 9);
  }
  bit = writePackedBits(target, packed, bit, 0, 6);
  if (bit !== NETWORK_PLAYER_SNAPSHOT_BYTES * 8) throw new Error("network player schema width mismatch");
}

function expandNetworkPlayer(source: Uint8Array, target: DataView, slot: number): void {
  const raw = SNAPSHOT_HEADER_BYTES + slot * PLAYER_SNAPSHOT_BYTES;
  const packed = NETWORK_PLAYER_OFFSET + slot * NETWORK_PLAYER_SNAPSHOT_BYTES;
  let bit = 0;
  const active = readPackedBits(source, packed, bit, 1);
  bit += 1;
  const team = readPackedBits(source, packed, bit, 8);
  bit += 8;
  const weapon = readPackedBits(source, packed, bit, 3);
  bit += 3;
  const damageLevel = readPackedBits(source, packed, bit, 2);
  bit += 2;
  const mobilityLevel = readPackedBits(source, packed, bit, 2);
  bit += 2;
  const armorLevel = readPackedBits(source, packed, bit, 2);
  bit += 2;
  const generation = readPackedBits(source, packed, bit, 16);
  bit += 16;
  const x = readPackedBits(source, packed, bit, 15) + WORLD_MIN_X;
  bit += 15;
  const y = readPackedBits(source, packed, bit, 15) + WORLD_MIN_Y;
  bit += 15;
  const velocityX = readPackedBits(source, packed, bit, 32) | 0;
  bit += 32;
  const velocityY = readPackedBits(source, packed, bit, 32) | 0;
  bit += 32;
  const hullX = readPackedBits(source, packed, bit, 10) - 256;
  bit += 10;
  const hullY = readPackedBits(source, packed, bit, 10) - 256;
  bit += 10;
  const turretX = readPackedBits(source, packed, bit, 10) - 256;
  bit += 10;
  const turretY = readPackedBits(source, packed, bit, 10) - 256;
  bit += 10;
  const aimX = readPackedBits(source, packed, bit, 10) - 256;
  bit += 10;
  const aimY = readPackedBits(source, packed, bit, 10) - 256;
  bit += 10;
  const health = readPackedBits(source, packed, bit, 8);
  bit += 8;
  const armor = readPackedBits(source, packed, bit, 7);
  bit += 7;
  const cooldown = readPackedBits(source, packed, bit, 8);
  bit += 8;
  const respawnTicks = readPackedBits(source, packed, bit, 8);
  bit += 8;
  const spawnProtectTicks = readPackedBits(source, packed, bit, 8);
  bit += 8;
  const overdriveTicks = readPackedBits(source, packed, bit, 10);
  bit += 10;
  const boostTicks = readPackedBits(source, packed, bit, 1);
  bit += 1;
  const boostCharge = readPackedBits(source, packed, bit, 7);
  bit += 7;
  const lastSequence = readPackedBits(source, packed, bit, 16);
  bit += 16;
  const score = readPackedBits(source, packed, bit, 32) | 0;
  bit += 32;
  const deaths = readPackedBits(source, packed, bit, 32) | 0;
  bit += 32;
  const credits = readPackedBits(source, packed, bit, 32) | 0;
  bit += 32;
  const lastInputTick = readPackedBits(source, packed, bit, 32);
  bit += 32;
  const lastInputValid = readPackedBits(source, packed, bit, 1);
  bit += 1;
  const lastMoveX = readPackedBits(source, packed, bit, 8) - 128;
  bit += 8;
  const lastMoveY = readPackedBits(source, packed, bit, 8) - 128;
  bit += 8;
  const lastAimX = readPackedBits(source, packed, bit, 8) - 128;
  bit += 8;
  const lastAimY = readPackedBits(source, packed, bit, 8) - 128;
  bit += 8;
  const lastButtons = readPackedBits(source, packed, bit, 2);
  bit += 2;
  const weaponRequest = readPackedBits(source, packed, bit, 3);
  bit += 3;
  const botSkill = readPackedBits(source, packed, bit, 8);
  bit += 8;
  const chassis = readPackedBits(source, packed, bit, 3);
  bit += 3;
  const chassisUnlocks = readPackedBits(source, packed, bit, 4);
  bit += 4;
  const weaponUpgradeUnlocks = readPackedBits(source, packed, bit, 12);
  bit += 12;
  const weaponUpgradeSelections = readPackedBits(source, packed, bit, 12);
  bit += 12;
  const mode = readPackedBits(source, packed, bit, 2);
  bit += 2;
  if (bit + WEAPON_COUNT * 9 + 6 !== NETWORK_PLAYER_SNAPSHOT_BYTES * 8) {
    throw new Error("network player schema width mismatch");
  }
  if (active > 1 || weapon > WEAPON_COUNT || damageLevel > 3 || mobilityLevel > 3 || armorLevel > 3) {
    throw new Error("network player progression field is invalid");
  }
  if (x < WORLD_MIN_X || x > WORLD_MAX_X || y < WORLD_MIN_Y || y > WORLD_MAX_Y) {
    throw new Error("network player position is invalid");
  }
  if (
    hullX < -256 ||
    hullX > 256 ||
    hullY < -256 ||
    hullY > 256 ||
    turretX < -256 ||
    turretX > 256 ||
    turretY < -256 ||
    turretY > 256 ||
    aimX < -256 ||
    aimX > 256 ||
    aimY < -256 ||
    aimY > 256
  ) {
    throw new Error("network player direction is invalid");
  }
  if (
    health > NETWORK_MAX_PLAYER_HEALTH ||
    armor > MAX_ARMOR ||
    lastButtons > 3 ||
    weaponRequest > WEAPON_COUNT ||
    chassis > CHASSIS_COUNT ||
    chassisUnlocks > CHASSIS_UNLOCK_MASK ||
    mode > 2 ||
    lastInputValid > 1 ||
    (lastInputValid === 0 && lastInputTick !== 0) ||
    overdriveTicks > OVERDRIVE_TICKS ||
    boostCharge > TANK_BOOST_CAPACITY
  ) {
    throw new Error("network player bounded field is invalid");
  }
  if (active !== 0 && (weapon === 0 || chassis === 0)) throw new Error("active network player identity is invalid");
  if (active !== 0 && (chassisUnlocks & chassisUnlockBit(chassis)) === 0) {
    throw new Error("active network player chassis is not unlocked");
  }
  if ((weaponUpgradeUnlocks & ~((1 << WEAPON_UPGRADE_COUNT) - 1)) !== 0) {
    throw new Error("network player weapon upgrade mask is invalid");
  }
  for (let weaponId = 1; weaponId <= WEAPON_COUNT; weaponId += 1) {
    const branch = (weaponUpgradeSelections >>> ((weaponId - 1) * 2)) & 3;
    if (branch > 2) throw new Error("network player weapon upgrade selection is invalid");
    if (branch !== 0) {
      const upgradeId = (weaponId - 1) * 2 + branch;
      if ((weaponUpgradeUnlocks & (1 << (upgradeId - 1))) === 0)
        throw new Error("network player selected upgrade is locked");
    }
    const ammo = readPackedBits(source, packed, bit, 9);
    bit += 9;
    if (ammo > weaponById(weaponId).maximumAmmo) throw new Error("network player ammo exceeds weapon capacity");
    target.setUint16(raw + 82 + (weaponId - 1) * 2, ammo, true);
  }
  if (packedRecordHasNonZeroBits(source, packed, bit, 6)) throw new Error("network player reserved bits are nonzero");

  target.setUint8(raw, active);
  target.setUint8(raw + 1, team);
  target.setUint8(raw + 2, weapon);
  target.setUint8(raw + 3, damageLevel);
  target.setUint8(raw + 4, mobilityLevel);
  target.setUint8(raw + 5, armorLevel);
  target.setUint16(raw + 6, generation, true);
  target.setInt32(raw + 8, x, true);
  target.setInt32(raw + 12, y, true);
  target.setInt32(raw + 16, velocityX, true);
  target.setInt32(raw + 20, velocityY, true);
  target.setInt16(raw + 24, hullX, true);
  target.setInt16(raw + 26, hullY, true);
  target.setInt16(raw + 28, turretX, true);
  target.setInt16(raw + 30, turretY, true);
  target.setInt16(raw + 32, aimX, true);
  target.setInt16(raw + 34, aimY, true);
  target.setInt16(raw + 36, health, true);
  target.setInt16(raw + 38, armor, true);
  target.setUint16(raw + 40, cooldown, true);
  target.setUint16(raw + 42, respawnTicks, true);
  target.setUint16(raw + 44, spawnProtectTicks, true);
  target.setUint16(raw + 46, overdriveTicks, true);
  target.setUint16(raw + 48, boostCharge, true);
  target.setUint16(raw + 50, lastSequence, true);
  target.setInt32(raw + 52, score, true);
  target.setInt32(raw + 56, deaths, true);
  target.setInt32(raw + 60, credits, true);
  target.setUint32(raw + 64, lastInputTick, true);
  target.setInt8(raw + 68, lastMoveX);
  target.setInt8(raw + 69, lastMoveY);
  target.setInt8(raw + 70, lastAimX);
  target.setInt8(raw + 71, lastAimY);
  target.setUint8(raw + 72, lastButtons);
  target.setUint8(raw + 73, weaponRequest);
  target.setUint8(raw + 74, botSkill);
  target.setUint8(raw + 75, boostTicks);
  target.setUint8(raw + 76, chassis);
  target.setUint8(raw + 77, chassisUnlocks);
  target.setUint16(raw + 78, weaponUpgradeUnlocks, true);
  target.setUint16(raw + 80, weaponUpgradeSelections, true);
  target.setUint8(raw + 94, mode);
  target.setUint8(raw + 95, lastInputValid);
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
  return writeSnapshotKeyframeSized(target, tick, source, SNAPSHOT_BYTES, SNAPSHOT_MESSAGE_BYTES);
}

export function writeNetworkSnapshotKeyframe(target: Uint8Array, tick: number, source: Uint8Array): number {
  return writeSnapshotKeyframeSized(target, tick, source, NETWORK_SNAPSHOT_BYTES, NETWORK_SNAPSHOT_MESSAGE_BYTES);
}

function writeSnapshotKeyframeSized(
  target: Uint8Array,
  tick: number,
  source: Uint8Array,
  imageBytes: number,
  messageBytes: number,
): number {
  if (source.byteLength < imageBytes) throw new RangeError("snapshot keyframe source is truncated");
  requireFrameCapacity(target, messageBytes);
  frameHeader(target, tick, SNAPSHOT_KEYFRAME, 0);
  const sparseLength = writeSnapshotRuns(target, source, imageBytes, messageBytes);
  if (sparseLength >= 0) return sparseLength;
  // The fixed raw form is the bounded fallback for an adversarial snapshot
  // whose sparse run metadata would exceed the source itself. runCount=0 plus
  // the full frame length distinguishes it from an all-zero sparse keyframe.
  frameHeader(target, tick, SNAPSHOT_KEYFRAME, 0);
  copyBytes(target, SNAPSHOT_FRAME_HEADER_BYTES, source, 0, imageBytes);
  return messageBytes;
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
  return writeSnapshotDeltaSized(target, tick, baselineTick, baseline, current, SNAPSHOT_BYTES, SNAPSHOT_MESSAGE_BYTES);
}

export function writeNetworkSnapshotDelta(
  target: Uint8Array,
  tick: number,
  baselineTick: number,
  baseline: Uint8Array,
  current: Uint8Array,
): number {
  return writeSnapshotDeltaSized(
    target,
    tick,
    baselineTick,
    baseline,
    current,
    NETWORK_SNAPSHOT_BYTES,
    NETWORK_SNAPSHOT_MESSAGE_BYTES,
  );
}

function writeSnapshotDeltaSized(
  target: Uint8Array,
  tick: number,
  baselineTick: number,
  baseline: Uint8Array,
  current: Uint8Array,
  imageBytes: number,
  messageBytes: number,
): number {
  if (baseline.byteLength < imageBytes || current.byteLength < imageBytes) {
    throw new RangeError("snapshot delta source is truncated");
  }
  requireFrameCapacity(target, messageBytes);
  frameHeader(target, tick, SNAPSHOT_DELTA, baselineTick);
  const length = writeSnapshotRuns(target, current, imageBytes, messageBytes, baseline);
  // Compare against the actual sparse keyframe representation, not the fixed
  // in-memory capacity. A delta that costs at least as much should reset the
  // recovery chain instead.
  return length >= 0 && length < Math.min(snapshotRunLength(current, imageBytes), messageBytes) ? length : -1;
}

function writeSnapshotRuns(
  target: Uint8Array,
  current: Uint8Array,
  imageBytes: number,
  messageBytes: number,
  baseline?: Uint8Array,
): number {
  let cursor = SNAPSHOT_FRAME_HEADER_BYTES;
  let runCount = 0;
  let index = 0;
  let previousEnd = 0;
  while (index < imageBytes) {
    while (index < imageBytes && current[index] === (baseline?.[index] ?? 0)) index += 1;
    if (index === imageBytes) break;
    const start = index;
    let lastChanged = index;
    let unchanged = 0;
    while (index < imageBytes && index - start < 0xffff) {
      if (current[index] !== (baseline?.[index] ?? 0)) {
        lastChanged = index;
        unchanged = 0;
      } else {
        unchanged += 1;
        if (unchanged > RUN_COALESCE_GAP_BYTES) break;
      }
      index += 1;
    }
    const length = lastChanged - start + 1;
    const gap = start - previousEnd;
    const headerBytes = varUintByteLength(gap) + varUintByteLength(length);
    if (runCount >= 0xffff || cursor + headerBytes + length > messageBytes) return -1;
    cursor = writeVarUint(target, cursor, gap);
    cursor = writeVarUint(target, cursor, length);
    copyBytes(target, cursor, current, start, length);
    cursor += length;
    runCount += 1;
    previousEnd = start + length;
  }
  writeUint16LE(target, 14, runCount);
  return cursor;
}

function snapshotRunLength(current: Uint8Array, imageBytes: number): number {
  let length = SNAPSHOT_FRAME_HEADER_BYTES;
  let index = 0;
  let previousEnd = 0;
  while (index < imageBytes) {
    while (index < imageBytes && current[index] === 0) index += 1;
    if (index === imageBytes) break;
    const start = index;
    let lastChanged = index;
    let unchanged = 0;
    while (index < imageBytes && index - start < 0xffff) {
      if (current[index] !== 0) {
        lastChanged = index;
        unchanged = 0;
      } else if (++unchanged > RUN_COALESCE_GAP_BYTES) {
        break;
      }
      index += 1;
    }
    const runLength = lastChanged - start + 1;
    length += varUintByteLength(start - previousEnd) + varUintByteLength(runLength) + runLength;
    previousEnd = start + runLength;
  }
  return length;
}

/**
 * Decodes one frame into caller-owned storage. A delta without the exact
 * advertised base tick is rejected; callers must wait for the next keyframe.
 */
export function readSnapshotFrame(payload: Uint8Array, scratch: SnapshotFrameScratch, commitBaseline = true): number {
  return readSnapshotFrameSized(payload, scratch, SNAPSHOT_BYTES, SNAPSHOT_MESSAGE_BYTES, commitBaseline);
}

export function readNetworkSnapshotFrame(
  payload: Uint8Array,
  scratch: SnapshotFrameScratch,
  commitBaseline = true,
): number {
  return readSnapshotFrameSized(
    payload,
    scratch,
    NETWORK_SNAPSHOT_BYTES,
    NETWORK_SNAPSHOT_MESSAGE_BYTES,
    commitBaseline,
  );
}

function readSnapshotFrameSized(
  payload: Uint8Array,
  scratch: SnapshotFrameScratch,
  imageBytes: number,
  messageBytes: number,
  commitBaseline: boolean,
): number {
  if (payload.byteLength < SNAPSHOT_FRAME_HEADER_BYTES) throw new Error("snapshot frame is truncated");
  if (readUint16LE(payload, 0) !== ENVELOPE_MAGIC) throw new Error("snapshot frame envelope magic mismatch");
  if (payload[2] !== PROTOCOL_VERSION || payload[3] !== MESSAGE_SNAPSHOT)
    throw new Error("snapshot frame envelope mismatch");
  const tick = readUint32LE(payload, 4);
  const kind = payload[8]!;
  if (payload[9] !== 0) throw new Error("snapshot frame reserved byte is nonzero");
  const baseTick = readUint32LE(payload, 10);
  const runCount = readUint16LE(payload, 14);
  if (scratch.baseline.byteLength < imageBytes || scratch.decoded.byteLength < imageBytes) {
    throw new RangeError("snapshot decode storage is truncated");
  }
  let rawKeyframe = false;
  if (kind === SNAPSHOT_KEYFRAME) {
    if (baseTick !== 0) throw new Error("invalid snapshot keyframe");
    rawKeyframe = runCount === 0 && payload.byteLength === messageBytes;
    if (rawKeyframe) copyBytes(scratch.decoded, 0, payload, SNAPSHOT_FRAME_HEADER_BYTES, imageBytes);
    else scratch.decoded.fill(0, 0, imageBytes);
  } else if (kind === SNAPSHOT_DELTA) {
    if (scratch.baselineTick < 0 || baseTick !== scratch.baselineTick >>> 0) {
      throw new Error("snapshot delta base is unavailable");
    }
    scratch.decoded.set(scratch.baseline);
  } else {
    throw new Error("unknown snapshot frame kind");
  }
  let cursor = rawKeyframe ? payload.byteLength : SNAPSHOT_FRAME_HEADER_BYTES;
  let previousEnd = 0;
  for (let run = 0; run < runCount; run += 1) {
    const packedGap = readVarUint(payload, cursor);
    cursor = packedGap & 0xffff;
    const gap = packedGap >>> 16;
    const packedLength = readVarUint(payload, cursor);
    cursor = packedLength & 0xffff;
    const length = packedLength >>> 16;
    const offset = previousEnd + gap;
    if (length === 0 || offset < previousEnd || offset + length > imageBytes) {
      throw new Error("snapshot run is invalid");
    }
    if (cursor + length > payload.byteLength) throw new Error("snapshot run is truncated");
    copyBytes(scratch.decoded, offset, payload, cursor, length);
    cursor += length;
    previousEnd = offset + length;
  }
  if (cursor !== payload.byteLength) throw new Error("snapshot frame has trailing bytes");
  if (commitBaseline) {
    scratch.baseline.set(scratch.decoded);
    scratch.baselineTick = tick;
  }
  return tick;
}

function varUintByteLength(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError("snapshot run value is invalid");
  return value < 0x80 ? 1 : value < 0x4000 ? 2 : 3;
}

function writeVarUint(target: Uint8Array, offset: number, value: number): number {
  let remaining = value;
  do {
    const continuation = remaining >= 0x80;
    requireFrameRange(target, offset, 1);
    target[offset++] = (remaining & 0x7f) | (continuation ? 0x80 : 0);
    remaining >>>= 7;
  } while (remaining !== 0);
  return offset;
}

/** Returns `(value << 16) | nextOffset` without allocating a tuple/object. */
function readVarUint(source: Uint8Array, offset: number): number {
  let value = 0;
  for (let byte = 0; byte < 3; byte += 1) {
    if (offset >= source.byteLength) throw new Error("snapshot run header is truncated");
    const current = source[offset++]!;
    value |= (current & 0x7f) << (byte * 7);
    if ((current & 0x80) === 0) {
      if (value > 0xffff) throw new Error("snapshot run value is invalid");
      return ((value << 16) | offset) >>> 0;
    }
  }
  throw new Error("snapshot run value is invalid");
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

function requireFrameCapacity(target: Uint8Array, messageBytes: number): void {
  if (target.byteLength < messageBytes) {
    throw new RangeError(`snapshot frame requires ${messageBytes} bytes`);
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

function requirePackedUnsigned(value: number, width: number, label: string): void {
  const maximum = 2 ** width - 1;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must fit ${width} unsigned bits`);
  }
}

function requirePackedRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be in [${minimum}, ${maximum}]`);
  }
}

/** Exact net displacement produced by BattleWorld's fixed substep loop. */
function projectileDisplacementPerTick(direction: number, speed: number): number {
  const substeps = 1 + (speed >> 7);
  return Math.trunc((direction * speed) / (256 * substeps)) * substeps;
}

function positiveModulo(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

function writePackedBits(target: Uint8Array, base: number, bitOffset: number, value: number, width: number): number {
  requirePackedUnsigned(value, width, "packed value");
  let remaining = width;
  let source = value;
  let cursor = bitOffset;
  while (remaining > 0) {
    const byteOffset = base + (cursor >>> 3);
    const shift = cursor & 7;
    const count = Math.min(remaining, 8 - shift);
    const mask = (1 << count) - 1;
    target[byteOffset] = target[byteOffset]! | ((source & mask) << shift);
    source = Math.trunc(source / 2 ** count);
    cursor += count;
    remaining -= count;
  }
  return cursor;
}

function readPackedBits(source: Uint8Array, base: number, bitOffset: number, width: number): number {
  let result = 0;
  let resultShift = 0;
  let remaining = width;
  let cursor = bitOffset;
  while (remaining > 0) {
    const byteOffset = base + (cursor >>> 3);
    const shift = cursor & 7;
    const count = Math.min(remaining, 8 - shift);
    const mask = (1 << count) - 1;
    result += ((source[byteOffset]! >>> shift) & mask) * 2 ** resultShift;
    resultShift += count;
    cursor += count;
    remaining -= count;
  }
  return result;
}

function packedRecordHasNonZeroBits(source: Uint8Array, base: number, bitOffset: number, width: number): boolean {
  let remaining = width;
  let cursor = bitOffset;
  while (remaining > 0) {
    const count = Math.min(remaining, 16);
    if (readPackedBits(source, base, cursor, count) !== 0) return true;
    cursor += count;
    remaining -= count;
  }
  return false;
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
    const active = world.projectileActive[slot]!;
    view.setUint8(cursor, active);
    // Dead projectile slots retain old values in the fixed simulation pool,
    // but those bytes are not logical world state. Canonicalizing them keeps
    // snapshots deterministic while preserving the generation required for
    // stale-handle rejection and prevents expired shots from consuming wire
    // bandwidth forever.
    if (active === 0) {
      view.setUint8(cursor + 1, 0);
      view.setUint16(cursor + 2, world.projectileGeneration[slot]!, true);
      for (let byte = 4; byte < PROJECTILE_SNAPSHOT_BYTES; byte += 1) view.setUint8(cursor + byte, 0);
      cursor += PROJECTILE_SNAPSHOT_BYTES;
      continue;
    }
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
