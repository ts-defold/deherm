import assert from "node:assert/strict";
import test from "node:test";

import {
  BattleClient,
  MatchServer,
  createInMemoryTransportPair,
} from "../core/index.ts";
import { restoreWorldBeforeAdmission } from "../server/deno-main.ts";
import {
  DurableWorldCheckpoint,
  encodeWorldCheckpoint,
  MemoryWorldCheckpointStorage,
  WORLD_CHECKPOINT_BYTES,
  WORLD_CHECKPOINT_HEADER_BYTES,
  WORLD_CHECKPOINT_VERSION,
  WorldCheckpointError,
} from "../server/world-persistence.ts";
import { crc32 } from "../core/session-persistence.ts";

async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

function reseal(bytes) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(bytes.byteLength - 4, crc32(bytes.subarray(0, bytes.byteLength - 4)), true);
  return bytes;
}

function checkpointContext(server) {
  return {
    matchId: server.world.matchId,
    mapSeed: server.world.mapSeed,
    rosterSize: server.rosterSize,
    teams: server.teams,
  };
}

test("authoritative world checkpoint round-trips the complete fixed state across server restart", async () => {
  const storage = new MemoryWorldCheckpointStorage();
  const first = new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 2, teams: true });
  for (let tick = 0; tick < 120; tick += 1) first.step();
  first.world.playerScore[0] = 321;
  first.world.objectiveProgress = 17;
  first.world.objectiveTeamOneScore = 2;
  const expectedHash = first.world.stateHash();
  const persistence = new DurableWorldCheckpoint(storage, checkpointContext(first));
  await persistence.flush(first.world);
  assert.equal((await storage.read())?.byteLength, WORLD_CHECKPOINT_BYTES);

  const restarted = new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 2, teams: true });
  restarted.sessionLedger.markCheckpoint(first.world.tick);
  assert.notEqual(restarted.world.stateHash(), expectedHash);
  assert.equal(await restoreWorldBeforeAdmission(restarted, new DurableWorldCheckpoint(storage, checkpointContext(restarted))), true);
  assert.equal(restarted.world.tick, first.world.tick);
  assert.equal(restarted.world.stateHash(), expectedHash);
  assert.equal(restarted.stats.tick, first.world.tick, "readiness stats must reflect the restored tick");
  assert.equal(restarted.sessionTick(), first.world.tick, "restoring world and ledger ticks must not double-count the world tick");

  // Admission happens after restore: the first welcomed client receives the
  // restored state rather than a constructor-default world.
  const client = new BattleClient({ name: "after-restart" });
  const session = restarted.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(client, session);
  session.attach(serverTransport);
  client.attach(clientTransport);
  for (let tick = 0; tick < 3; tick += 1) restarted.step();
  await settle();
  client.update(0);
  assert.equal(client.state, "ready");
  assert.equal(restarted.world.playerScore[0], 321, "the authoritative world remains restored after admission");
  first.close();
  restarted.close();
});

test("world checkpoints fail closed on truncation, corruption, identity, configuration, version, tick, and payload errors", async () => {
  const source = new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1 });
  source.step();
  const encoded = new DurableWorldCheckpoint(new MemoryWorldCheckpointStorage(), checkpointContext(source));
  await encoded.flush(source.world);
  const bytes = await encoded.storage.read();

  const truncated = {
    read: async () => bytes.subarray(0, bytes.byteLength - 1),
    write: async () => {},
  };
  await assert.rejects(
    new DurableWorldCheckpoint(truncated, checkpointContext(source)).restore(new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1 }).world),
    (error) => error instanceof WorldCheckpointError && error.code === "world-checkpoint-length",
  );

  const corruptedBytes = new Uint8Array(bytes);
  corruptedBytes[corruptedBytes.length - 5] ^= 0x80;
  const corrupted = {
    read: async () => corruptedBytes,
    write: async () => {},
  };
  await assert.rejects(
    new DurableWorldCheckpoint(corrupted, checkpointContext(source)).restore(new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1 }).world),
    (error) => error instanceof WorldCheckpointError && error.code === "world-checkpoint-checksum",
  );

  await assert.rejects(
    new DurableWorldCheckpoint(encoded.storage, checkpointContext(new MatchServer({ matchId: 78, mapSeed: 0x1234, rosterSize: 1 }))).restore(new MatchServer({ matchId: 78, mapSeed: 0x1234, rosterSize: 1 }).world),
    /another match/,
  );
  await assert.rejects(
    new DurableWorldCheckpoint(encoded.storage, checkpointContext(new MatchServer({ matchId: 77, mapSeed: 0x5678, rosterSize: 1 }))).restore(new MatchServer({ matchId: 77, mapSeed: 0x5678, rosterSize: 1 }).world),
    /another arena/,
  );

  const wrongVersion = encodeWorldCheckpoint(source.world, checkpointContext(source));
  new DataView(wrongVersion.buffer).setUint16(4, WORLD_CHECKPOINT_VERSION + 1, true);
  await assert.rejects(
    new DurableWorldCheckpoint({ read: async () => wrongVersion, write: async () => {} }, checkpointContext(source))
      .restore(new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1 }).world),
    (error) => error instanceof WorldCheckpointError && error.code === "world-checkpoint-version",
  );

  const mismatchedTick = encodeWorldCheckpoint(source.world, checkpointContext(source));
  new DataView(mismatchedTick.buffer).setUint32(20, source.world.tick + 1, true);
  reseal(mismatchedTick);
  await assert.rejects(
    new DurableWorldCheckpoint({ read: async () => mismatchedTick, write: async () => {} }, checkpointContext(source))
      .restore(new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1 }).world),
    (error) => error instanceof WorldCheckpointError && error.code === "world-checkpoint-tick",
  );

  const invalidPayload = encodeWorldCheckpoint(source.world, checkpointContext(source));
  new DataView(invalidPayload.buffer).setUint32(WORLD_CHECKPOINT_HEADER_BYTES, 0, true);
  reseal(invalidPayload);
  const invalidPersistence = new DurableWorldCheckpoint({ read: async () => invalidPayload, write: async () => {} }, checkpointContext(source));
  await assert.rejects(
    invalidPersistence.restore(new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1 }).world),
    (error) => error instanceof WorldCheckpointError && error.code === "world-checkpoint-payload",
  );
  assert.equal(invalidPersistence.isHealthy, false);

  const rosterMismatch = new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 3 });
  await assert.rejects(
    new DurableWorldCheckpoint(encoded.storage, checkpointContext(rosterMismatch)).restore(rosterMismatch.world),
    (error) => error instanceof WorldCheckpointError && error.code === "world-checkpoint-roster",
  );
  const teamMismatch = new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1, teams: true });
  await assert.rejects(
    new DurableWorldCheckpoint(encoded.storage, checkpointContext(teamMismatch)).restore(teamMismatch.world),
    (error) => error instanceof WorldCheckpointError && error.code === "world-checkpoint-teams",
  );
  source.close();
  rosterMismatch.close();
  teamMismatch.close();
});

test("slow checkpoint storage retains one active write and one coalesced latest snapshot", async () => {
  const writes = [];
  const releases = [];
  const storage = {
    read: async () => undefined,
    write: async (bytes) => {
      writes.push(new Uint8Array(bytes));
      await new Promise((resolve) => releases.push(resolve));
    },
  };
  const server = new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1 });
  const persistence = new DurableWorldCheckpoint(storage, checkpointContext(server));

  server.step();
  const first = persistence.flush(server.world);
  await settle();
  assert.equal(writes.length, 1);

  server.step();
  const superseded = persistence.flush(server.world);
  server.step();
  const latest = persistence.flush(server.world);
  assert.equal(superseded, latest, "pending callers share one bounded coalesced write");
  assert.equal(writes.length, 1, "a slow store cannot create an unbounded write backlog");

  releases.shift()();
  await first;
  await settle();
  assert.equal(writes.length, 2);
  const latestView = new DataView(writes[1].buffer, writes[1].byteOffset, writes[1].byteLength);
  assert.equal(latestView.getUint32(20, true), server.world.tick, "the retained write is the newest snapshot");

  releases.shift()();
  await latest;
  assert.equal(persistence.isHealthy, true);
  server.close();
});

test("a failed active checkpoint does not poison the bounded latest retry", async () => {
  let releaseFirst;
  let attempt = 0;
  const writes = [];
  const storage = {
    read: async () => undefined,
    write: async (bytes) => {
      writes.push(new Uint8Array(bytes));
      attempt += 1;
      if (attempt === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        throw new Error("simulated storage failure");
      }
    },
  };
  const server = new MatchServer({ matchId: 77, mapSeed: 0x1234, rosterSize: 1 });
  const persistence = new DurableWorldCheckpoint(storage, checkpointContext(server));
  server.step();
  const failed = persistence.flush(server.world);
  await settle();
  server.step();
  const recovered = persistence.flush(server.world);
  releaseFirst();
  await assert.rejects(failed, /simulated storage failure/u);
  await recovered;

  assert.equal(writes.length, 2);
  const retry = new DataView(writes[1].buffer, writes[1].byteOffset, writes[1].byteLength);
  assert.equal(retry.getUint32(20, true), server.world.tick);
  assert.equal(persistence.isHealthy, true);
  server.close();
});
