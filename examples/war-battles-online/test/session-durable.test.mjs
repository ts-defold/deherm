import assert from "node:assert/strict";
import test from "node:test";

import {
  DurableSessionPersistence,
  BattleClient,
  MatchServer,
  MemorySessionStateStorage,
  SESSION_STATE_BYTES,
  SessionLedger,
  SessionPersistenceError,
  SessionTokenService,
  SESSION_TOKEN_BYTES,
  decodeSessionState,
  encodeSessionState,
  createInMemoryTransportPair,
  tickDeadline,
} from "../core/index.ts";
import {
  admitNewSession,
  configuredResumeKey,
  createSessionAdmissionGate,
  websocketOriginAllowed,
} from "../server/deno-main.ts";

async function settle() {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function settleUntil(predicate, maximumTurns = 64) {
  for (let turn = 0; turn < maximumTurns; turn += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

test("session tokens are authenticated, scoped, expiring, and key-rotatable", async () => {
  const service = new SessionTokenService({
    keys: [
      { id: 7, secret: new Uint8Array(32).fill(0x41) },
      { id: 8, secret: new Uint8Array(32).fill(0x52) },
    ],
    activeKeyId: 7,
  });
  const claims = { matchId: 77, slot: 3, generation: 9, issuedAtTick: 100, expiresAtTick: 120 };
  const token = await service.issue(claims);
  assert.equal(token.byteLength, SESSION_TOKEN_BYTES);
  assert.deepEqual(await service.verify(token, { matchId: 77, nowTick: 100, rosterSize: 8 }), claims);
  assert.equal(await service.verify(token, { matchId: 78, nowTick: 100, rosterSize: 8 }), null);
  assert.equal(await service.verify(token, { matchId: 77, nowTick: 121, rosterSize: 8 }), null);

  const forged = new Uint8Array(token);
  forged[12] ^= 1;
  assert.equal(await service.verify(forged, { matchId: 77, nowTick: 100, rosterSize: 8 }), null);

  const rotated = new SessionTokenService({
    keys: [
      { id: 8, secret: new Uint8Array(32).fill(0x52) },
      { id: 7, secret: new Uint8Array(32).fill(0x41) },
    ],
    activeKeyId: 8,
  });
  assert.deepEqual(await rotated.verify(token, { matchId: 77, nowTick: 100, rosterSize: 8 }), claims);
  const next = await rotated.issue({ ...claims, generation: 10 });
  assert.deepEqual(await rotated.verify(next, { matchId: 77, nowTick: 100, rosterSize: 8 }), {
    ...claims,
    generation: 10,
  });
});

test("credential expiry and ledger reservations remain ordered across uint32 wrap", async () => {
  const service = new SessionTokenService({ keys: [{ id: 1, secret: new Uint8Array(32).fill(0x55) }] });
  const token = await service.issue({
    matchId: 77,
    slot: 0,
    generation: 1,
    issuedAtTick: 0xffff_fffe,
    expiresAtTick: 1,
  });
  assert.notEqual(await service.verify(token, { matchId: 77, nowTick: 0, rosterSize: 1 }), null);
  assert.notEqual(await service.verify(token, { matchId: 77, nowTick: 1, rosterSize: 1 }), null);
  assert.equal(await service.verify(token, { matchId: 77, nowTick: 2, rosterSize: 1 }), null);
  await assert.rejects(
    service.issue({ matchId: 77, slot: 0, generation: 2, issuedAtTick: 1, expiresAtTick: 0x8000_0001 }),
    /serial-order horizon/,
  );

  const ledger = new SessionLedger({ matchId: 77, rosterSize: 1 });
  ledger.commit(0, 1);
  ledger.reserveFor(0, 0xffff_fffe, 3);
  assert.equal(ledger.expiresAtTick[0], tickDeadline(0xffff_fffe, 3));
  assert.equal(ledger.isReserved(0, 0xffff_ffff), true);
  assert.equal(ledger.isReserved(0, 0), true);
  assert.equal(ledger.isReserved(0, 1), true);
  assert.equal(ledger.isReserved(0, 2), false);
  assert.equal(ledger.expire(2), 1);
});

test("WebSocket Origin admission is exact in production and loopback-only by default", () => {
  assert.equal(websocketOriginAllowed("http://localhost:8000", []), true);
  assert.equal(websocketOriginAllowed("https://127.0.0.1:8443", []), true);
  assert.equal(websocketOriginAllowed("https://game.example", []), false);
  assert.equal(websocketOriginAllowed(null, []), false);
  assert.equal(websocketOriginAllowed("https://game.example", ["https://game.example"]), true);
  assert.equal(websocketOriginAllowed("https://evil.example", ["https://game.example"]), false);
  assert.equal(websocketOriginAllowed("https://game.example", ["not an origin"]), false);
  assert.equal(websocketOriginAllowed("https://game.example/path", ["https://game.example"]), false);
});

test("durable session state is fixed-size, deterministic, versioned, and restartable", async () => {
  const storage = new MemorySessionStateStorage();
  const first = new SessionLedger({ matchId: 77, rosterSize: 4 });
  first.commit(2, 1, 0x1234);
  for (let generation = 2; generation <= 11; generation += 1) first.commit(2, generation, 0x1234);
  first.reserveUntil(2, 80);
  const persistence = new DurableSessionPersistence(first, storage);
  await persistence.flush(70);

  const bytes = await storage.read();
  assert.equal(bytes?.byteLength, SESSION_STATE_BYTES);
  const same = await storage.read();
  assert.deepEqual([...bytes], [...same]);

  const restarted = new SessionLedger({ matchId: 77, rosterSize: 4 });
  const restartedPersistence = new DurableSessionPersistence(restarted, storage);
  assert.equal(await restartedPersistence.restore(), true);
  assert.equal(restarted.generation[2], 11);
  assert.equal(restarted.expiresAtTick[2], 80);
  assert.equal(restarted.identityTag[2], 0x1234);
  assert.equal(restarted.isReserved(2, 80), true);
  assert.equal(restarted.isReserved(2, 81), false);
  assert.equal(restarted.expire(81), 1);
  assert.equal(restarted.hasCredential(2), false);
});

test("durable session state fails closed on corruption and foreign context", () => {
  const ledger = new SessionLedger({ matchId: 77, rosterSize: 4 });
  ledger.commit(0, 1);
  const bytes = ledger.encode(10);
  const corrupt = new Uint8Array(bytes);
  corrupt[35] ^= 0x80;
  assert.throws(
    () => decodeSessionState(corrupt, { matchId: 77, rosterSize: 4 }),
    (error) => {
      assert.ok(error instanceof SessionPersistenceError);
      assert.equal(error.code, "session-state-checksum");
      return true;
    },
  );
  assert.throws(() => decodeSessionState(bytes, { matchId: 78, rosterSize: 4 }), /another match/);
  const badVersion = new Uint8Array(bytes);
  badVersion[4] = 2;
  assert.throws(
    () => decodeSessionState(badVersion, { matchId: 77, rosterSize: 4 }),
    /unsupported session state version/,
  );
  assert.deepEqual([...encodeSessionState(ledger.snapshot(10))], [...bytes]);
});

test("a failed durable write does not poison the serialized retry", async () => {
  const storage = new MemorySessionStateStorage();
  let failWrites = 1;
  let writes = 0;
  const flaky = {
    read: () => storage.read(),
    async write(bytes) {
      writes += 1;
      if (failWrites > 0) {
        failWrites -= 1;
        throw new Error("injected storage failure");
      }
      await storage.write(bytes);
    },
  };
  const ledger = new SessionLedger({ matchId: 77, rosterSize: 1 });
  ledger.commit(0, 1);
  const persistence = new DurableSessionPersistence(ledger, flaky);
  await assert.rejects(persistence.flush(10), /injected storage failure/);
  assert.equal(persistence.isHealthy, false);
  assert.equal(ledger.isDirty, true);
  await persistence.flush(11);
  assert.equal(writes, 2);
  assert.equal(persistence.isHealthy, true);
  assert.equal(ledger.isDirty, false);
  assert.equal(ledger.persistedCheckpointTick, 11);
});

test("durable server state requires an explicitly configured resume key", () => {
  assert.throws(() => configuredResumeKey(undefined, "/tmp/war-battles-session.bin"), /requires --resume-key/);
  assert.throws(() => configuredResumeKey("not-hex", undefined), /exactly 64 hexadecimal/);
  assert.equal(configuredResumeKey(undefined, undefined), undefined);
  assert.equal(configuredResumeKey("aa".repeat(32), "/tmp/war-battles-session.bin")?.byteLength, 32);
});

test("persistence admission gate rejects new sessions until a write recovers", () => {
  const admission = createSessionAdmissionGate();
  let created = 0;
  const create = () => {
    created += 1;
    return created;
  };
  assert.equal(admitNewSession(admission, create), 1);
  assert.equal(created, 1);
  assert.equal(admission.allowed, true);
  admission.fail();
  assert.equal(admission.allowed, false);
  assert.equal(admitNewSession(admission, create), undefined);
  assert.equal(created, 1, "unhealthy persistence must not create a session");
  admission.recover();
  assert.equal(admission.allowed, true);
  assert.equal(admitNewSession(admission, create), 2);
});

test("active crash checkpoints become bounded restart reservations", async () => {
  const storage = new MemorySessionStateStorage();
  const ledger = new SessionLedger({ matchId: 77, rosterSize: 1, restartReservationTicks: 10 });
  ledger.commit(0, 1);
  await new DurableSessionPersistence(ledger, storage).flush(500);
  const restarted = new SessionLedger({ matchId: 77, rosterSize: 1, restartReservationTicks: 10 });
  await new DurableSessionPersistence(restarted, storage).restore();
  assert.equal(restarted.expiresAtTick[0], 510);
  assert.equal(restarted.isReserved(0, 510), true);
  assert.equal(restarted.isReserved(0, 511), false);
});

test("a configured token and ledger resume after new server construction", async () => {
  const key = new Uint8Array(32).fill(0x6a);
  const service = new SessionTokenService({ keys: [{ id: 1, secret: key }] });
  const storage = new MemorySessionStateStorage();
  const ledgerA = new SessionLedger({ matchId: 77, rosterSize: 2 });
  const persistenceA = new DurableSessionPersistence(ledgerA, storage);
  const serverA = new MatchServer({
    matchId: 77,
    rosterSize: 2,
    resumeTokenService: service,
    sessionLedger: ledgerA,
    onSessionStateChange: (_reason, tick) => void persistenceA.flush(tick),
  });
  for (let tick = 0; tick < 120; tick += 1) serverA.step();
  const first = new BattleClient({ name: "first" });
  const firstSession = serverA.createSession();
  const [firstClientTransport, firstServerTransport] = createInMemoryTransportPair(first, firstSession);
  firstSession.attach(firstServerTransport);
  first.attach(firstClientTransport);
  await settle();
  const token = first.resumeToken.slice();
  const playerId = first.playerId;
  first.close(1_001, "restart");
  await settle();

  const ledgerB = new SessionLedger({ matchId: 77, rosterSize: 2 });
  const persistenceB = new DurableSessionPersistence(ledgerB, storage);
  assert.equal(await persistenceB.restore(), true);
  const serverB = new MatchServer({
    matchId: 77,
    rosterSize: 2,
    resumeTokenService: service,
    sessionLedger: ledgerB,
    onSessionStateChange: (_reason, tick) => void persistenceB.flush(tick),
  });
  const resumed = new BattleClient({ name: "resumed" });
  resumed.resumeToken.set(token);
  const resumedSession = serverB.createSession();
  const [resumedClientTransport, resumedServerTransport] = createInMemoryTransportPair(resumed, resumedSession);
  resumedSession.attach(resumedServerTransport);
  resumed.attach(resumedClientTransport);
  assert.equal(await settleUntil(() => resumed.state !== "connecting"), true, "resume handshake did not settle");
  assert.equal(resumed.state, "ready");
  assert.equal(resumed.playerId, playerId);
  serverA.close();
  serverB.close();
});

test("async admission closes fail closed during verify and issue", async () => {
  const key = new Uint8Array(32).fill(0x3c);
  const real = new SessionTokenService({ keys: [{ id: 1, secret: key }] });
  let releaseVerify;
  const verifyGate = new Promise((resolve) => {
    releaseVerify = resolve;
  });
  const delayedVerify = {
    verify: async () => {
      await verifyGate;
      return null;
    },
    issue: (claims) => real.issue(claims),
  };
  const verifyServer = new MatchServer({ rosterSize: 1, resumeTokenService: delayedVerify });
  const verifyClient = new BattleClient({});
  verifyClient.resumeToken.fill(1);
  const verifySession = verifyServer.createSession();
  const [verifyClientTransport, verifyServerTransport] = createInMemoryTransportPair(verifyClient, verifySession);
  verifySession.attach(verifyServerTransport);
  verifyClient.attach(verifyClientTransport);
  await Promise.resolve();
  verifySession.close(1_001, "closed while verifying");
  releaseVerify();
  await settle();
  assert.equal(verifyServer.countHumans(), 0);
  assert.equal(verifyServer.sessionLedger.generation[0], 0);

  let releaseIssue;
  const issueGate = new Promise((resolve) => {
    releaseIssue = resolve;
  });
  const delayedIssue = {
    verify: async () => null,
    issue: async (claims) => {
      await issueGate;
      return real.issue(claims);
    },
  };
  const issueServer = new MatchServer({ rosterSize: 1, resumeTokenService: delayedIssue });
  const issueClient = new BattleClient({});
  issueClient.resumeToken.fill(0);
  const issueSession = issueServer.createSession();
  const [issueClientTransport, issueServerTransport] = createInMemoryTransportPair(issueClient, issueSession);
  issueSession.attach(issueServerTransport);
  issueClient.attach(issueClientTransport);
  await Promise.resolve();
  await Promise.resolve();
  issueSession.close(1_001, "closed while issuing");
  releaseIssue();
  await settle();
  assert.equal(issueServer.countHumans(), 0);
  assert.equal(issueServer.sessionLedger.generation[0], 0);
});

test("a token provider with a malformed result cannot commit admission", async () => {
  const malformedProvider = {
    verify: async () => null,
    issue: async () => new Uint8Array([1]),
  };
  const server = new MatchServer({ rosterSize: 1, resumeTokenService: malformedProvider });
  const client = new BattleClient({});
  const session = server.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(client, session);
  session.attach(serverTransport);
  client.attach(clientTransport);
  await settle();
  assert.equal(client.state, "closed");
  assert.equal(server.countHumans(), 0);
  assert.equal(server.sessionLedger.generation[0], 0);
});
