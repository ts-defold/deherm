import assert from "node:assert/strict";
import test from "node:test";

import {
  BattleWorld,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  NETWORK_PROJECTILE_SNAPSHOT_BYTES,
  NETWORK_SNAPSHOT_BYTES,
  NETWORK_SNAPSHOT_MESSAGE_BYTES,
  PLAYER_SNAPSHOT_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_HEADER_BYTES,
  WEAPON_RICOCHET,
  WEAPON_UPGRADE_RICOCHET_SHARD,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  compactNetworkSnapshot,
  expandNetworkSnapshot,
  writeNetworkSnapshotKeyframe,
} from "../core/index.ts";

const projectileOffset = SNAPSHOT_HEADER_BYTES + MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES;

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

test("the compact network image preserves every exact rollback field at its declared bounds", () => {
  const { rollback } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);

  assert.equal(compactNetworkSnapshot(rollback, network), NETWORK_SNAPSHOT_BYTES);
  assert.equal(expandNetworkSnapshot(network, expanded), SNAPSHOT_BYTES);
  assert.deepEqual(expanded, rollback);
  assert.equal(SNAPSHOT_BYTES - NETWORK_SNAPSHOT_BYTES, MAX_PROJECTILES * (28 - NETWORK_PROJECTILE_SNAPSHOT_BYTES));
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
    secondNetwork.subarray(projectileOffset, projectileOffset + NETWORK_PROJECTILE_SNAPSHOT_BYTES),
    firstNetwork.subarray(projectileOffset, projectileOffset + NETWORK_PROJECTILE_SNAPSHOT_BYTES),
  );
  const expanded = new Uint8Array(SNAPSHOT_BYTES);
  expandNetworkSnapshot(secondNetwork, expanded);
  assert.deepEqual(expanded, secondRaw);
});

test("the compact network image rejects values outside its exact fixed-point contract", () => {
  const { rollback } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const projectile = new DataView(rollback.buffer, rollback.byteOffset + projectileOffset, 28);

  projectile.setInt16(6, 512, true);
  assert.throws(() => compactNetworkSnapshot(rollback, network), /projectile damage must fit 9 unsigned bits/u);
});

test("the compact network image rejects reserved and inactive payload bits before expansion", () => {
  const { rollback, world } = fixture();
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const expanded = new Uint8Array(SNAPSHOT_BYTES);
  compactNetworkSnapshot(rollback, network);

  const reserved = network.slice();
  reserved[projectileOffset + NETWORK_PROJECTILE_SNAPSHOT_BYTES - 1] |= 0x80;
  assert.throws(() => expandNetworkSnapshot(reserved, expanded), /reserved bit/u);

  world.projectileActive[0] = 0;
  world.writeSnapshot(rollback);
  compactNetworkSnapshot(rollback, network);
  network[projectileOffset + 2] |= 0x02;
  assert.throws(() => expandNetworkSnapshot(network, expanded), /inactive projectile network record is noncanonical/u);
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
  assert.equal(NETWORK_SNAPSHOT_BYTES, 11_232);
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
