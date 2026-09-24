import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HMR_SOAK_SCHEMA_VERSION,
  HMR_STATE_API,
  HISTORICAL_REGRESSION_COUNTS,
  formatHmrFailure,
  parseHmrStateEvent,
  runHmrStateSoak,
  validateHmrRuntimeHealth,
  validateHmrSoakEvidence,
} from "../integration/hmr-state-soak.mjs";
import {
  DEFAULT_INSTALLED_HMR_BUILD_SERVER,
  dependencyLinkType,
  assertInstalledPackageTreeSha256,
  cleanupOwnedHmrRun,
  installedHmrLaunchConfiguration,
  installedPackageTreeSha256,
  ownedPosixGroupAlive,
  parseCliEventLine,
  parseReloadMarker,
  runtimeErrorFromEvents,
  snapshotFromState,
  stopOwnedProcessTree,
  windowsTaskkillArguments,
} from "../integration/installed-hmr-driver.mjs";

const fingerprint = (value) => value.toString(16).padStart(64, "0");

test("installed HMR refreshes policy and uses the pinned local Extender by default", () => {
  const launch = installedHmrLaunchConfiguration({ PATH: "/bin" });
  assert.equal(launch.buildServer, DEFAULT_INSTALLED_HMR_BUILD_SERVER);
  assert.equal(Object.hasOwn(launch.environment, "DEHERM_OFFLINE"), false);
  assert.deepEqual(launch.environment, { PATH: "/bin" });

  const explicit = installedHmrLaunchConfiguration({
    DEHERM_BUILD_SERVER: "http://example.test:9000",
    DEHERM_OFFLINE: "1",
  });
  assert.equal(explicit.buildServer, "http://example.test:9000");
  assert.equal(explicit.environment.DEHERM_OFFLINE, "1");
});

test("installed HMR diagnostics preserve aggregate root causes", () => {
  const failure = new AggregateError(
    [new Error("policy surface is stale"), new Error("native compile failed")],
    "native HMR run and cleanup failed",
  );
  assert.equal(
    formatHmrFailure(failure),
    "native HMR run and cleanup failed; caused by: policy surface is stale; caused by: native compile failed",
  );
});

function snapshot(gameplayTick, componentCount = 51, transientPopulation = 0) {
  return {
    entityCount: 8,
    componentCount,
    gameplayTick,
    runtimeId: 4,
    instanceIds: Array.from({ length: componentCount }, (_, index) => ({ slot: index, generation: 1 })),
    persistentInstanceIds: Array.from({ length: 8 }, (_, index) => ({ slot: index, generation: 1 })),
    arenaInstanceId: { slot: 0, generation: 1 },
    transientInstanceIds: Array.from({ length: transientPopulation }, (_, index) => ({
      slot: 100 + index,
      generation: 1,
    })),
    transientPopulation,
    frameDtMs: 8,
    heapBytes: 1_000_000,
    heapPeakBytes: 2_000_000,
    callbackRoots: 4,
    luaHandles: 8,
    arenaHighWaterBytes: 1_024,
  };
}

function report(cycles = 2) {
  const output = {
    schemaVersion: HMR_SOAK_SCHEMA_VERSION,
    installedPackage: {
      verified: true,
      packageName: "@ts-defold/deherm",
      source: "npm-pack",
      treeSha256: fingerprint(99),
    },
    runtimeApi: { name: HMR_STATE_API, available: true, target: "native" },
    cyclesRequired: cycles,
    initialFingerprint: fingerprint(1),
    baseline: snapshot(10),
    cycles: [],
  };
  for (let index = 0; index < cycles; ++index) {
    const accepted = fingerprint(index + 2);
    output.cycles.push({
      index,
      accepted: {
        status: "activated",
        fingerprint: accepted,
        activeFingerprint: accepted,
        runtimeId: 4,
        snapshot: snapshot(11 + index * 2, 51, index === 0 ? 1 : 0),
      },
    });
  }
  return output;
}

test("installed HMR validator accepts repeated compatible transactions", () => {
  const result = validateHmrSoakEvidence(report());
  assert.equal(result.cyclesRequired, 2);
  assert.equal(result.baseline.componentCount, 51);
  assert.equal(result.baseline.gameplayTick, 10);
  assert.equal(result.baseline.runtimeId, 4);
  assert.deepEqual(
    result.baseline.persistentInstanceIds,
    Array.from({ length: 8 }, (_, index) => `${index}:1`),
  );
  assert.equal(result.telemetry.maxComponentCount, 51);
  assert.equal(result.telemetry.maxGameplayTick, 13);
  assert.equal(result.telemetry.transientEvidence.mode, "post-reload-detach");
  assert.equal(result.telemetry.transientEvidence.detachedAfterFirstAccepted, 1);
});

test("installed HMR validator rejects monotonic transient identity accumulation", () => {
  const invalid = report(3);
  invalid.cycles[0].accepted.snapshot = snapshot(11, 52, 1);
  invalid.cycles[1].accepted.snapshot = snapshot(13, 53, 2);
  invalid.cycles[2].accepted.snapshot = snapshot(15, 54, 3);
  assert.throws(() => validateHmrSoakEvidence(invalid), /never detached after the first accepted HMR generation/);
});

test("installed HMR validator rejects the historical 51→95→127 duplication trace", () => {
  const invalid = report(2);
  invalid.cycles[0].accepted.snapshot.componentCount = HISTORICAL_REGRESSION_COUNTS[1];
  invalid.cycles[0].accepted.snapshot.persistentInstanceIds.push({ slot: 95, generation: 1 });
  assert.throws(() => validateHmrSoakEvidence(invalid), /cycle 0 accepted\.persistentInstanceIds changed across HMR/);
});

test("installed HMR validator fails closed when the native state API is absent", () => {
  const invalid = report();
  invalid.runtimeApi = { name: HMR_STATE_API, available: false };
  assert.throws(() => validateHmrSoakEvidence(invalid), /native runtime state API/);
  invalid.runtimeApi = { name: "browser-component-bridge/v1", available: true };
  assert.throws(() => validateHmrSoakEvidence(invalid), /native runtime state API/);
});

test("installed HMR validator rejects an activation from a different runtime", () => {
  const invalid = report();
  invalid.cycles[0].accepted.runtimeId = 99;
  assert.throws(() => validateHmrSoakEvidence(invalid), /activation runtimeId 99 disagrees/);
});

test("installed HMR validator requires complete runtime and persistent identity evidence", () => {
  for (const mutate of [
    (invalid) => {
      delete invalid.baseline.runtimeId;
    },
    (invalid) => {
      delete invalid.baseline.persistentInstanceIds;
    },
    (invalid) => {
      delete invalid.baseline.arenaInstanceId;
    },
    (invalid) => {
      delete invalid.cycles[0].accepted.runtimeId;
    },
    (invalid) => {
      delete invalid.cycles[0].accepted.snapshot.runtimeId;
    },
  ]) {
    const invalid = report();
    mutate(invalid);
    assert.throws(() => validateHmrSoakEvidence(invalid), /runtimeId|persistentInstanceIds|arenaInstanceId/);
  }
});

test("Windows cleanup targets the complete owned process tree", () => {
  assert.equal(dependencyLinkType("win32"), "junction");
  assert.equal(dependencyLinkType("darwin"), "dir");
  assert.deepEqual(windowsTaskkillArguments(123), ["/PID", "123", "/T"]);
  assert.deepEqual(windowsTaskkillArguments(123, true), ["/PID", "123", "/T", "/F"]);
  assert.throws(() => windowsTaskkillArguments(0), /invalid owned Windows process id/);
});

test("POSIX cleanup treats an existing process group as live after its leader exits", () => {
  const calls = [];
  assert.equal(
    ownedPosixGroupAlive(123, (pid, signal) => {
      calls.push([pid, signal]);
    }),
    true,
  );
  assert.deepEqual(calls, [[-123, 0]]);
  assert.equal(
    ownedPosixGroupAlive(123, () => {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }),
    false,
  );
  assert.equal(
    ownedPosixGroupAlive(123, () => {
      const error = new Error("not permitted");
      error.code = "EPERM";
      throw error;
    }),
    true,
  );
});

test("POSIX cleanup signals and escalates the owned group independently of leader state", async () => {
  let groupAlive = true;
  const signals = [];
  const result = await stopOwnedProcessTree({
    pid: 123,
    ownsProcessGroup: true,
    leaderExited: () => true,
    groupAlive: () => groupAlive,
    signalGroup: (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") groupAlive = false;
    },
    exited: Promise.resolve({ code: 0, signal: null }),
    shutdownMs: 0,
    sleep: async () => {},
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result, { code: 0, signal: null });
});

test("Windows cleanup preserves taskkill tree then forced tree escalation", async () => {
  let leaderExited = false;
  const taskkills = [];
  const result = await stopOwnedProcessTree({
    pid: 123,
    ownsProcessGroup: false,
    leaderExited: () => leaderExited,
    groupAlive: () => !leaderExited,
    signalGroup: () => {
      throw new Error("POSIX signal must not run on Windows");
    },
    taskkill: async (force, pid) => {
      taskkills.push({ force, pid });
      leaderExited = true;
    },
    exited: Promise.resolve({ code: 0, signal: null }),
  });
  assert.deepEqual(taskkills, [{ force: false, pid: 123 }]);
  assert.deepEqual(result, { code: 0, signal: null });
});

test("Windows cleanup fails closed when a vanished leader prevents tree termination", async () => {
  await assert.rejects(
    () =>
      stopOwnedProcessTree({
        pid: 123,
        ownsProcessGroup: false,
        leaderExited: () => true,
        groupAlive: () => false,
        signalGroup: () => {
          throw new Error("POSIX signal must not run on Windows");
        },
        taskkill: async () => {
          throw new Error("process not found");
        },
        exited: Promise.resolve({ code: 0, signal: null }),
      }),
    /could not terminate owned Windows HMR process tree/,
  );
});

test("installed HMR cleanup restores source state even when process cleanup fails", async () => {
  let restored = false;
  await assert.rejects(
    () =>
      cleanupOwnedHmrRun({
        stopOwnedTree: async () => {
          throw new Error("tree cleanup failed");
        },
        childClosed: Promise.resolve(),
        restoreOwnedFiles: async () => {
          restored = true;
        },
      }),
    /tree cleanup failed/,
  );
  assert.equal(restored, true);
});

test("installed package tree identity is deterministic and excludes dependency links", async () => {
  const root = fileURLToPath(new URL("./fixtures/hmr-package-tree/", import.meta.url));
  const first = await installedPackageTreeSha256(root);
  const second = await installedPackageTreeSha256(root);
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first, second);
});

test("installed package evidence accepts the current package tree identity", async () => {
  const root = fileURLToPath(new URL("./fixtures/hmr-package-tree/", import.meta.url));
  const current = await installedPackageTreeSha256(root);
  assert.equal(assertInstalledPackageTreeSha256(current, current), true);
});

test("installed package evidence rejects a stale package tree identity", async () => {
  const root = fileURLToPath(new URL("./fixtures/hmr-package-tree/", import.meta.url));
  const current = await installedPackageTreeSha256(root);
  assert.throws(
    () => assertInstalledPackageTreeSha256(fingerprint(99), fingerprint(100)),
    /does not match the current packed package/,
  );
  assert.throws(
    () => assertInstalledPackageTreeSha256(fingerprint(99), current),
    /does not match the current packed package/,
  );
});

test("native state events can be read from JSON session lines and DEHERM_EVENT logs", () => {
  assert.deepEqual(
    parseHmrStateEvent(JSON.stringify({ schemaVersion: 1, event: { type: "hmr-state", phase: "accepted", cycle: 0 } })),
    { type: "hmr-state", phase: "accepted", cycle: 0 },
  );
  const event = parseHmrStateEvent(
    "INFO:DEFOLD_HERMES: DEHERM_EVENT hmr-state phase=accepted cycle=2 runtime_id=4 entity_count=8 component_instances=51 gameplay_tick=99 frame_dt_us=8333 heap_bytes=1024 heap_peak_bytes=2048 callback_roots=3 lua_handles=7 arena_high_water_bytes=128",
  );
  assert.deepEqual(event, {
    type: "hmr-state",
    phase: "accepted",
    cycle: 2,
    runtimeId: 4,
    entityCount: 8,
    componentInstances: 51,
    gameplayTick: 99,
    frameDtMs: 8.333,
    heapBytes: 1024,
    heapPeakBytes: 2048,
    callbackRoots: 3,
    luaHandles: 7,
    arenaHighWaterBytes: 128,
  });
});

test("installed driver projects authoritative instance identities and gameplay marker", () => {
  assert.deepEqual(parseReloadMarker("INFO war-battles:hmr-reload:edit=cycle-1:tick=77:entities=12:elapsed=1.283"), {
    edit: "cycle-1",
    gameplayTick: 77,
    worldEntityCount: 12,
    elapsedSeconds: 1.283,
  });
  const projected = snapshotFromState(
    {
      targets: [
        {
          id: "local-engine",
          telemetry: {
            frameDtMs: 8,
            componentInstances: 2,
            callbackRoots: 1,
            luaRegistryUsed: 3,
            arenaHighWaterBytes: 9,
          },
          componentSnapshot: { runtimeId: 5, sequence: 4 },
          instanceProjection: { complete: true },
          instances: [
            { instanceId: { slot: 2, generation: 1 }, source: "main/arena.script.ts" },
            { instanceId: { slot: 8, generation: 3 }, source: "main/player.script.ts" },
          ],
        },
      ],
    },
    { gameplayTick: 77, worldEntityCount: 12 },
  );
  assert.deepEqual(projected.instanceIds, [
    { slot: 2, generation: 1 },
    { slot: 8, generation: 3 },
  ]);
  assert.deepEqual(projected.persistentInstanceIds, [
    { slot: 2, generation: 1 },
    { slot: 8, generation: 3 },
  ]);
  assert.equal(projected.runtimeId, 5);
  assert.equal(projected.gameplayTick, 77);
  assert.equal(projected.entityCount, 12);
});

test("installed driver captures error logs and rejected activations in each edit window", () => {
  const events = [
    { type: "log", level: "error", source: "engine", message: "stale prior error" },
    { type: "build-succeeded", fingerprint: fingerprint(1) },
    { type: "log", level: "info", source: "engine", message: "healthy" },
    { type: "log", level: "error", source: "engine", message: "onReload threw" },
  ];
  assert.deepEqual(runtimeErrorFromEvents(events, 1), {
    type: "log",
    source: "engine",
    message: "onReload threw",
  });
  assert.deepEqual(
    runtimeErrorFromEvents([
      { type: "runtime-activation-rejected", fingerprint: fingerprint(2), diagnostic: "rejected" },
    ]),
    {
      type: "runtime-activation-rejected",
      diagnostic: "rejected",
      fingerprint: fingerprint(2),
    },
  );
  assert.deepEqual(
    runtimeErrorFromEvents([{ type: "log", level: "error", source: "stdout-protocol", message: "raw failure" }]),
    {
      type: "log",
      source: "stdout-protocol",
      message: "raw failure",
    },
  );
  assert.equal(runtimeErrorFromEvents(events, events.length), undefined);
});

test("installed driver turns non-JSON stdout into a fail-closed protocol event", () => {
  assert.deepEqual(parseCliEventLine('{"event":{"type":"build-succeeded","fingerprint":"ok"}}'), {
    event: { type: "build-succeeded", fingerprint: "ok" },
    protocolError: false,
  });
  assert.deepEqual(parseCliEventLine("raw failure"), {
    event: {
      type: "log",
      level: "error",
      source: "stdout-protocol",
      message: "raw failure",
    },
    protocolError: true,
  });
});

test("final HMR health sweep rejects errors, rejections, protocol failures, and stderr", () => {
  assert.equal(validateHmrRuntimeHealth([{ type: "log", level: "info" }], ""), true);
  for (const event of [
    { type: "error", message: "runtime" },
    { type: "runtime-activation-rejected", diagnostic: "rejected" },
    { type: "protocol-error", message: "bad JSON" },
    { type: "log", level: "error", message: "engine" },
    { type: "log", source: "stdout-protocol", message: "raw" },
    { type: "build-failed", message: "compile" },
  ])
    assert.throws(() => validateHmrRuntimeHealth([event]), /native HMR emitted/);
  assert.throws(() => validateHmrRuntimeHealth([], "native diagnostic"), /stderr/);
});

test("runHmrStateSoak performs the final full-event health sweep", async () => {
  let checked = false;
  let closed = false;
  const adapter = {
    installedPackage: { verified: true, treeSha256: fingerprint(99) },
    runtimeApi: { name: HMR_STATE_API, available: true },
    baselineSnapshot: async () => snapshot(1),
    activeFingerprint: async () => fingerprint(1),
    applyAcceptedComponentBodyReload: async () => {},
    waitForAccepted: async (index) => ({ status: "activated", fingerprint: fingerprint(index + 2), runtimeId: 4 }),
    snapshot: async (label) => snapshot(label === "accepted-0" ? 2 : 3, 51, label === "accepted-0" ? 1 : 0),
    assertClean: async () => {
      assert.equal(closed, true);
      checked = true;
      validateHmrRuntimeHealth([], "");
    },
    close: async () => {
      closed = true;
    },
  };
  await runHmrStateSoak(adapter, { cycles: 2 });
  assert.equal(checked, true);
});

test("runHmrStateSoak requires the native adapter and closes it after a failed validation", async () => {
  let closed = false;
  const adapter = {
    installedPackage: { verified: true, treeSha256: fingerprint(99) },
    runtimeApi: { name: HMR_STATE_API, available: true },
    baselineSnapshot: async () => snapshot(1),
    activeFingerprint: async () => fingerprint(1),
    applyAcceptedComponentBodyReload: async () => {},
    waitForAccepted: async () => ({ status: "activated", fingerprint: fingerprint(2), runtimeId: 4 }),
    snapshot: async () => snapshot(1),
    assertClean: async () => {},
    close: async () => {
      closed = true;
    },
  };
  await assert.rejects(() => runHmrStateSoak(adapter, { cycles: 1 }), /did not advance gameplay/);
  assert.equal(closed, true);
});
