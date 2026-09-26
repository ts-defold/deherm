import assert from "node:assert/strict";
import test from "node:test";

import {
  BattleWorld,
  CHASSIS_UNLOCK_MASK,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  NETWORK_PROJECTILE_SNAPSHOT_BYTES,
  NETWORK_PLAYER_SNAPSHOT_BYTES,
  NETWORK_SNAPSHOT_BYTES,
  NETWORK_SNAPSHOT_MESSAGE_BYTES,
  PLAYER_SNAPSHOT_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_HEADER_BYTES,
  TANK_MAX_IMPULSE_SPEED,
  WEAPON_RICOCHET,
  WEAPON_UPGRADE_RICOCHET_SHARD,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  compactNetworkSnapshot,
  expandNetworkSnapshot,
  readNetworkSnapshotFrame,
  SNAPSHOT_SCHEMA_DELTA,
  writeNetworkSnapshotDelta,
  writeNetworkSnapshotKeyframe,
} from "../core/index.ts";

const rawProjectileOffset = SNAPSHOT_HEADER_BYTES + MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES;
const networkProjectileOffset = SNAPSHOT_HEADER_BYTES + MAX_PLAYERS * NETWORK_PLAYER_SNAPSHOT_BYTES;

function fixture() {
  const world = new BattleWorld(77, 0x1234_5678);
  for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) world.addPlayer(playerId);
  world.projectileActive[0] = 1;
  world.projectileGeneration[0] = 0xffff;
  world.projectileOwner[0] = MAX_PLAYERS;
  world.projectileWeapon[0] = WEAPON_RICOCHET;
  world.projectileUpgrade[0] = WEAPON_UPGRADE_RICOCHET_SHARD;
  world.projectileBounces[0] = 7;
  world.projectilePierce[0] = 3;
  world.projectileDamage[0] = 511;
  world.projectileX[0] = WORLD_MIN_X;
  world.projectileY[0] = WORLD_MAX_Y;
  world.projectileDirectionX[0] = -256;
  world.projectileDirectionY[0] = 256;
  world.projectileLife[0] = 255;
  world.projectileSpeed[0] = 1_023;
  world.projectileRadius[0] = 255;
  const rollback = new Uint8Array(SNAPSHOT_BYTES);
  world.writeSnapshot(rollback);
  return { rollback, world };
}

function writeNetworkPlayerBits(target, slot, bitOffset, bitCount, value) {
  const record = SNAPSHOT_HEADER_BYTES + slot * NETWORK_PLAYER_SNAPSHOT_BYTES;
  for (let bit = 0; bit < bitCount; bit += 1) {
    const absolute = bitOffset + bit;
    const byte = record + (absolute >> 3);
    const mask = 1 << (absolute & 7);
    target[byte] = (target[byte] & ~mask) | (((value >>> bit) & 1) === 0 ? 0 : mask);
  }
}

test("the compact network image preserves every exact rollback field at its declared bounds", () => {
  const { rollback } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);

  assert.equal(compactNetworkSnapshot(rollback, network), NETWORK_SNAPSHOT_BYTES);
  assert.equal(expandNetworkSnapshot(network, expanded), SNAPSHOT_BYTES);
  assert.deepEqual(expanded, rollback);
  assert.equal(
    SNAPSHOT_BYTES - NETWORK_SNAPSHOT_BYTES,
    MAX_PLAYERS * (PLAYER_SNAPSHOT_BYTES - NETWORK_PLAYER_SNAPSHOT_BYTES) +
      MAX_PROJECTILES * (28 - NETWORK_PROJECTILE_SNAPSHOT_BYTES),
  );
});

test("all player slots preserve the exact schema boundaries and rollback bytes", () => {
  const { rollback, world } = fixture();
  const ammoMaximums = [0, 400, 20, 40, 24, 120];
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    world.playerTeam[slot] = 0xff;
    world.playerWeapon[slot] = 6;
    world.playerDamageLevel[slot] = 3;
    world.playerMobilityLevel[slot] = 3;
    world.playerArmorLevel[slot] = 3;
    world.playerX[slot] = WORLD_MIN_X;
    world.playerY[slot] = WORLD_MAX_Y;
    world.playerVelocityX[slot] = TANK_MAX_IMPULSE_SPEED;
    world.playerVelocityY[slot] = -TANK_MAX_IMPULSE_SPEED;
    world.playerHullX[slot] = 256;
    world.playerHullY[slot] = -256;
    world.playerTurretX[slot] = 256;
    world.playerTurretY[slot] = -256;
    world.playerAimX[slot] = 256;
    world.playerAimY[slot] = -256;
    world.playerHealth[slot] = 240;
    world.playerArmor[slot] = 100;
    world.playerCooldown[slot] = 108;
    world.playerRespawnTicks[slot] = 96;
    world.playerSpawnProtectTicks[slot] = 60;
    world.playerOverdriveTicks[slot] = 600;
    world.playerBoostTicks[slot] = 1;
    world.playerBoostCharge[slot] = 90;
    world.playerLastSequence[slot] = 0xffff;
    world.playerScore[slot] = -0x8000_0000;
    world.playerDeaths[slot] = 0x7fff_ffff;
    world.playerCredits[slot] = 0x7fff_ffff;
    world.playerLastInputTick[slot] = 0xffff_ffff;
    world.playerLastMoveX[slot] = -128;
    world.playerLastMoveY[slot] = 127;
    world.playerLastAimX[slot] = -128;
    world.playerLastAimY[slot] = 127;
    world.playerLastButtons[slot] = 3;
    world.playerWeaponRequest[slot] = 6;
    world.playerBotSkill[slot] = 0xff;
    world.playerChassis[slot] = 4;
    world.playerChassisUnlocks[slot] = CHASSIS_UNLOCK_MASK;
    world.playerWeaponUpgradeUnlocks[slot] = 0xfff;
    world.playerWeaponUpgradeSelections[slot] = 0xaaa;
    world.playerMode[slot] = 2;
    for (let weapon = 0; weapon < ammoMaximums.length; weapon += 1) {
      world.playerAmmo[slot * ammoMaximums.length + weapon] = ammoMaximums[weapon];
    }
  }
  world.writeSnapshot(rollback);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);
  compactNetworkSnapshot(rollback, network);
  expandNetworkSnapshot(network, expanded);
  assert.deepEqual(expanded, rollback);
  assert.equal(NETWORK_PLAYER_SNAPSHOT_BYTES, 62);
});

test("player countdown and input phases stay exact across uint32 tick wrap", () => {
  const world = new BattleWorld(77, 0x1234_5678);
  world.addPlayer(1);
  world.tick = 0xffff_fffe;
  world.playerCooldown[0] = 108;
  world.playerRespawnTicks[0] = 96;
  world.playerSpawnProtectTicks[0] = 60;
  world.playerOverdriveTicks[0] = 600;
  world.playerLastSequence[0] = 0xfffd;
  world.playerLastInputTick[0] = 0xffff_fffd;
  const rollback = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);

  world.writeSnapshot(rollback);
  compactNetworkSnapshot(rollback, network);
  expandNetworkSnapshot(network, expanded, world.tick);

  assert.deepEqual(expanded, rollback);
});

test("a nonzero countdown encoding may not alias the zero sentinel", () => {
  const { rollback } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);
  compactNetworkSnapshot(rollback, network);

  // Cooldown begins at bit 175. At snapshot tick zero, encoded value one
  // would otherwise decode to zero and alias the canonical zero sentinel.
  writeNetworkPlayerBits(network, 0, 175, 8, 1);

  assert.throws(() => expandNetworkSnapshot(network, expanded), /network countdown is noncanonical/u);
});

test("an inactive player's retained sequence remains exact", () => {
  const { rollback } = fixture();
  const player = new DataView(rollback.buffer, rollback.byteOffset + SNAPSHOT_HEADER_BYTES, PLAYER_SNAPSHOT_BYTES);
  player.setUint16(50, 0xbeef, true);
  player.setUint32(64, 0, true);
  player.setUint8(95, 0);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);

  compactNetworkSnapshot(rollback, network);
  expandNetworkSnapshot(network, expanded);

  assert.deepEqual(expanded, rollback);
});

test("straight projectile motion leaves its trajectory record byte-identical", () => {
  const world = new BattleWorld(77, 0x1234_5678);
  world.tick = 65_534;
  world.projectileActive[0] = 1;
  world.projectileGeneration[0] = 17;
  world.projectileOwner[0] = 1;
  world.projectileWeapon[0] = WEAPON_RICOCHET;
  world.projectileUpgrade[0] = WEAPON_UPGRADE_RICOCHET_SHARD;
  world.projectileBounces[0] = 2;
  world.projectilePierce[0] = 0;
  world.projectileDamage[0] = 31;
  world.projectileX[0] = -1_024;
  world.projectileY[0] = 2_048;
  world.projectileDirectionX[0] = 181;
  world.projectileDirectionY[0] = -181;
  world.projectileLife[0] = 200;
  world.projectileSpeed[0] = 208;
  world.projectileRadius[0] = 48;

  const firstRaw = new Uint8Array(SNAPSHOT_BYTES);
  const secondRaw = new Uint8Array(SNAPSHOT_BYTES);
  const firstNetwork = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const secondNetwork = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  world.writeSnapshot(firstRaw);
  compactNetworkSnapshot(firstRaw, firstNetwork);

  // speed=208 uses two substeps, each truncating 181*208/(256*2).
  const displacement = Math.trunc((181 * 208) / (256 * 2)) * 2;
  world.tick += 4;
  world.projectileX[0] += displacement * 4;
  world.projectileY[0] -= displacement * 4;
  world.projectileLife[0] -= 4;
  world.writeSnapshot(secondRaw);
  compactNetworkSnapshot(secondRaw, secondNetwork);

  assert.deepEqual(
    secondNetwork.subarray(networkProjectileOffset, networkProjectileOffset + NETWORK_PROJECTILE_SNAPSHOT_BYTES),
    firstNetwork.subarray(networkProjectileOffset, networkProjectileOffset + NETWORK_PROJECTILE_SNAPSHOT_BYTES),
  );
  const expanded = new Uint8Array(SNAPSHOT_BYTES);
  expandNetworkSnapshot(secondNetwork, expanded);
  assert.deepEqual(expanded, secondRaw);
});

test("the compact network image rejects values outside its exact fixed-point contract", () => {
  const { rollback } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const projectile = new DataView(rollback.buffer, rollback.byteOffset + rawProjectileOffset, 28);

  projectile.setInt16(6, 512, true);
  assert.throws(() => compactNetworkSnapshot(rollback, network), /projectile damage must fit 9 unsigned bits/u);
});

test("the player projection rejects out-of-schema rollback values", () => {
  const { rollback } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const player = new DataView(rollback.buffer, rollback.byteOffset + SNAPSHOT_HEADER_BYTES, PLAYER_SNAPSHOT_BYTES);

  player.setInt16(36, 241, true);
  assert.throws(() => compactNetworkSnapshot(rollback, network), /player health must be in/u);

  player.setInt16(36, 100, true);
  player.setUint16(82 + 2, 401, true);
  assert.throws(() => compactNetworkSnapshot(rollback, network), /player ammo exceeds weapon capacity/u);

  player.setUint16(82 + 2, 0, true);
  player.setInt32(8, WORLD_MIN_X - 1, true);
  assert.throws(() => compactNetworkSnapshot(rollback, network), /player x must be in/u);

  player.setInt32(8, WORLD_MIN_X, true);
  player.setUint16(46, 601, true);
  assert.throws(() => compactNetworkSnapshot(rollback, network), /player overdrive ticks must be in/u);

  player.setUint16(46, 0, true);
  player.setUint16(48, 91, true);
  assert.throws(() => compactNetworkSnapshot(rollback, network), /player boost charge must be in/u);

  player.setUint16(48, 0, true);
  player.setInt32(16, TANK_MAX_IMPULSE_SPEED + 1, true);
  assert.throws(() => compactNetworkSnapshot(rollback, network), /player velocity x must be in/u);
});

test("the compact network image rejects reserved and inactive payload bits before expansion", () => {
  const { rollback, world } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);
  compactNetworkSnapshot(rollback, network);

  const reserved = network.slice();
  reserved[networkProjectileOffset + NETWORK_PROJECTILE_SNAPSHOT_BYTES - 1] |= 0x80;
  assert.throws(() => expandNetworkSnapshot(reserved, expanded), /reserved bit/u);

  world.projectileActive[0] = 0;
  world.writeSnapshot(rollback);
  compactNetworkSnapshot(rollback, network);
  network[networkProjectileOffset + 2] |= 0x02;
  assert.throws(() => expandNetworkSnapshot(network, expanded), /inactive projectile network record is noncanonical/u);

  compactNetworkSnapshot(rollback, network);
  const playerReserved = 32 + NETWORK_PLAYER_SNAPSHOT_BYTES - 1;
  network[playerReserved] |= 0x40;
  assert.throws(() => expandNetworkSnapshot(network, expanded), /player reserved bits/u);
});

test("the projected world tick must match its enclosing snapshot frame", () => {
  const { rollback } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);
  compactNetworkSnapshot(rollback, network);

  assert.throws(
    () => expandNetworkSnapshot(network, expanded, 1),
    /snapshot frame tick does not match its projected world state/u,
  );
});

test("the declared compact image is below the 12 KiB recovery ceiling", () => {
  assert.equal(NETWORK_SNAPSHOT_BYTES, 10_144);
  assert.ok(NETWORK_SNAPSHOT_BYTES + 16 < 12 * 1_024);
});

test("an adversarial all-projectile keyframe stays inside the fixed recovery frame", () => {
  const { world } = fixture();
  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    world.projectileActive[slot] = 1;
    world.projectileGeneration[slot] = slot + 1;
    world.projectileOwner[slot] = (slot % MAX_PLAYERS) + 1;
    world.projectileWeapon[slot] = WEAPON_RICOCHET;
    world.projectileUpgrade[slot] = WEAPON_UPGRADE_RICOCHET_SHARD;
    world.projectileBounces[slot] = slot & 3;
    world.projectilePierce[slot] = 0;
    world.projectileDamage[slot] = 31;
    world.projectileX[slot] = WORLD_MIN_X + (slot % 120) * 256;
    world.projectileY[slot] = WORLD_MAX_Y - (slot % 90) * 256;
    world.projectileDirectionX[slot] = slot & 1 ? 256 : -256;
    world.projectileDirectionY[slot] = slot & 2 ? 181 : -181;
    world.projectileLife[slot] = 200 - (slot % 100);
    world.projectileSpeed[slot] = 208;
    world.projectileRadius[slot] = 48;
  }
  const rollback = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  world.writeSnapshot(rollback);
  compactNetworkSnapshot(rollback, network);

  const length = writeNetworkSnapshotKeyframe(frame, world.tick, network);
  assert.ok(length <= NETWORK_SNAPSHOT_MESSAGE_BYTES);
  assert.ok(length <= 12 * 1_024);
});

test("schema player deltas round-trip exact modular field changes", () => {
  const { world } = fixture();
  const baselineRaw = new Uint8Array(SNAPSHOT_BYTES);
  const currentRaw = new Uint8Array(SNAPSHOT_BYTES);
  const baseline = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const current = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const decoded = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);

  world.writeSnapshot(baselineRaw);
  compactNetworkSnapshot(baselineRaw, baseline);
  world.tick = 6;
  world.playerX[0] += 17;
  world.playerVelocityX[0] = -127;
  world.playerHullX[0] = -181;
  world.playerScore[0] = -0x8000_0000;
  world.playerLastMoveX[0] = -1;
  world.playerAmmo[1] = 399;
  world.writeSnapshot(currentRaw);
  compactNetworkSnapshot(currentRaw, current);

  const length = writeNetworkSnapshotDelta(frame, world.tick, 0, baseline, current);
  assert.ok(length > 0 && length < NETWORK_SNAPSHOT_MESSAGE_BYTES);
  assert.equal(frame[8], SNAPSHOT_SCHEMA_DELTA);
  const scratch = { baseline, decoded, baselineTick: 0 };
  assert.equal(readNetworkSnapshotFrame(frame.subarray(0, length), scratch, false), world.tick);
  assert.deepEqual(decoded, current);
  expandNetworkSnapshot(decoded, expanded, world.tick);
  assert.deepEqual(expanded, currentRaw);
});

test("schema player delta masks fail closed on reserved fields", () => {
  const { world } = fixture();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const baseline = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const current = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  world.writeSnapshot(raw);
  compactNetworkSnapshot(raw, baseline);
  world.playerX[0] += 1;
  world.writeSnapshot(raw);
  compactNetworkSnapshot(raw, current);
  const length = writeNetworkSnapshotDelta(frame, 0, 0, baseline, current);
  assert.equal(frame[8], SNAPSHOT_SCHEMA_DELTA);
  // Header (16) + player slot mask (4) + final byte of player-zero's
  // seven-byte field mask. Only bit zero names field 48; the rest are reserved.
  frame[26] |= 0x80;
  const scratch = { baseline, decoded: new Uint8Array(NETWORK_SNAPSHOT_BYTES), baselineTick: 0 };
  assert.throws(
    () => readNetworkSnapshotFrame(frame.subarray(0, length), scratch, false),
    /field mask has reserved bits/u,
  );
});

test("schema player delta masks reject a named zero delta", () => {
  const { world } = fixture();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const baseline = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const current = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  world.writeSnapshot(raw);
  compactNetworkSnapshot(raw, baseline);
  world.playerX[0] += 1;
  world.writeSnapshot(raw);
  compactNetworkSnapshot(raw, current);
  const length = writeNetworkSnapshotDelta(frame, 1, 0, baseline, current);
  // Header (16), slot mask (4), field mask (7), then the first named delta.
  frame[27] = 0;
  const scratch = { baseline, decoded: new Uint8Array(NETWORK_SNAPSHOT_BYTES), baselineTick: 0 };
  assert.throws(
    () => readNetworkSnapshotFrame(frame.subarray(0, length), scratch, false),
    /field delta names no change/u,
  );
});

test("schema generic runs reject noncanonical gap and length varints", () => {
  const baseline = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const record = baseline.subarray(SNAPSHOT_HEADER_BYTES, SNAPSHOT_HEADER_BYTES + NETWORK_PLAYER_SNAPSHOT_BYTES);
  record.fill(0x55);
  record[record.length - 1] &= 0x3f;
  const current = baseline.slice();
  current[networkProjectileOffset] = 1;
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const length = writeNetworkSnapshotDelta(frame, 1, 0, baseline, current);
  assert.ok(length > 0);

  const overlongAt = (offset) => {
    let terminal = offset;
    while ((frame[terminal] & 0x80) !== 0) terminal += 1;
    const malformed = new Uint8Array(length + 1);
    malformed.set(frame.subarray(0, terminal), 0);
    malformed[terminal] = frame[terminal] | 0x80;
    malformed[terminal + 1] = 0;
    malformed.set(frame.subarray(terminal + 1, length), terminal + 2);
    return { malformed, next: terminal + 2 };
  };
  const gap = overlongAt(20);
  const scratch = { baseline, decoded: new Uint8Array(NETWORK_SNAPSHOT_BYTES), baselineTick: 0 };
  assert.throws(() => readNetworkSnapshotFrame(gap.malformed, scratch, false), /run value is noncanonical/u);

  let lengthOffset = 20;
  while ((frame[lengthOffset++] & 0x80) !== 0) {}
  const runLength = overlongAt(lengthOffset);
  assert.throws(() => readNetworkSnapshotFrame(runLength.malformed, scratch, false), /run value is noncanonical/u);
});

test("schema player deltas round-trip every exact field width", () => {
  const widths = [
    1, 8, 3, 2, 2, 2, 16, 15, 15, 18, 18, 10, 10, 10, 10, 10, 10, 8, 7, 8, 8, 8, 10, 1, 7, 16, 32, 32, 32, 32, 1, 8, 8,
    8, 8, 2, 3, 8, 3, 4, 12, 12, 2, 9, 9, 9, 9, 9, 9,
  ];
  const byteLength = (value) =>
    value < 0x80 ? 1 : value < 0x4000 ? 2 : value < 0x20_0000 ? 3 : value < 0x1000_0000 ? 4 : 5;
  let bitOffset = 0;
  for (const width of widths) {
    const modulus = 2 ** width;
    const maximum = modulus - 1;
    const half = modulus / 2;
    const transitions = [
      [0, maximum],
      [maximum, 0],
      [0, half],
      [half, 0],
    ];
    for (const [previous, next] of transitions) {
      const baseline = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
      const record = baseline.subarray(SNAPSHOT_HEADER_BYTES, SNAPSHOT_HEADER_BYTES + NETWORK_PLAYER_SNAPSHOT_BYTES);
      record.fill(0x55);
      record[record.length - 1] &= 0x3f;
      const current = baseline.slice();
      writeNetworkPlayerBits(baseline, 0, bitOffset, width, previous);
      writeNetworkPlayerBits(current, 0, bitOffset, width, next);

      let delta = (((next - previous) % modulus) + modulus) % modulus;
      if (delta >= half) delta -= modulus;
      const encoded = delta >= 0 ? delta * 2 : -delta * 2 - 1;
      const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
      const length = writeNetworkSnapshotDelta(frame, 0xffff_ffff, 0xffff_fffe, baseline, current);
      assert.equal(length, 27 + byteLength(encoded), `field width ${width} should have one canonical delta`);
      const decoded = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
      const scratch = { baseline, decoded, baselineTick: 0xffff_fffe };
      assert.equal(readNetworkSnapshotFrame(frame.subarray(0, length), scratch, false), 0xffff_ffff);
      assert.deepEqual(decoded, current, `field width ${width} transition ${previous} -> ${next} should round-trip`);
    }
    bitOffset += width;
  }
  assert.equal(bitOffset, 494);
});

test("a dense schema delta falls back when a sparse keyframe is smaller", () => {
  const baseline = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const current = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  let state = 0x50a1_5eed;
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    const offset = SNAPSHOT_HEADER_BYTES + slot * NETWORK_PLAYER_SNAPSHOT_BYTES;
    for (let byte = 0; byte < NETWORK_PLAYER_SNAPSHOT_BYTES; byte += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      baseline[offset + byte] = state >>> 24;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      current[offset + byte] = state >>> 24;
    }
    baseline[offset + NETWORK_PLAYER_SNAPSHOT_BYTES - 1] &= 0x3f;
    current[offset + NETWORK_PLAYER_SNAPSHOT_BYTES - 1] &= 0x3f;
  }
  assert.equal(
    writeNetworkSnapshotDelta(
      new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES),
      0xffff_ffff,
      0xffff_fffe,
      baseline,
      current,
    ),
    -1,
  );
});
