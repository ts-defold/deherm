// Validation and driver contract for the installed War Battles HMR soak.
// Compatible implementation edits are the installed gate. Schema migration
// and rejection behavior are covered by the native standalone harness.

export const HMR_SOAK_SCHEMA_VERSION = 1;
export const HMR_STATE_API = "deherm.native-hmr-state/v1";
export const DEFAULT_HMR_SOAK_CYCLES = 6;
export const HISTORICAL_REGRESSION_COUNTS = Object.freeze([51, 95, 127]);
export const DEFAULT_HMR_SOAK_LIMITS = Object.freeze({
  maxEntityCount: 256,
  maxComponentCount: 256,
  maxHeapGrowthBytes: 8 * 1024 * 1024,
  maxHeapPeakGrowthBytes: 16 * 1024 * 1024,
  maxCallbackRootGrowth: 16,
  maxLuaHandleGrowth: 32,
  maxArenaHighWaterGrowthBytes: 256 * 1024,
  maxFrameDtMs: 250,
});

function fail(message) {
  throw new Error(`war-battles-hmr-soak:${message}`);
}
function integer(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${label} must be a safe integer >= ${min}`);
  return value;
}
function finite(value, label, { min = 0 } = {}) {
  if (!Number.isFinite(value) || value < min) fail(`${label} must be a finite number >= ${min}`);
  return value;
}
function firstDefined(value, keys) {
  for (const key of keys) if (value?.[key] !== undefined) return value[key];
  return undefined;
}
function stableInstanceId(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Number.isSafeInteger(value.slot) || !Number.isSafeInteger(value.generation)) return undefined;
  return `${value.slot}:${value.generation}`;
}

export function normalizeHmrSnapshot(value, label = "snapshot") {
  if (!value || typeof value !== "object") fail(`${label} is missing`);
  const snapshot = {
    ...value,
    entityCount: integer(firstDefined(value, ["entityCount", "entities"]), `${label}.entityCount`, { min: 1 }),
    componentCount: integer(firstDefined(value, ["componentCount", "componentInstances"]), `${label}.componentCount`, {
      min: 1,
    }),
    gameplayTick: integer(
      firstDefined(value, ["gameplayTick", "gameplayTicks", "updates", "frames"]),
      `${label}.gameplayTick`,
    ),
    ...(value.runtimeId !== undefined ? { runtimeId: integer(value.runtimeId, `${label}.runtimeId`) } : {}),
    ...(value.instanceIds !== undefined
      ? {
          instanceIds: (Array.isArray(value.instanceIds)
            ? value.instanceIds
            : fail(`${label}.instanceIds must be an array`)
          )
            .map((id) => {
              const normalized = stableInstanceId(id);
              if (normalized === undefined) fail(`${label}.instanceIds contains an invalid identity`);
              return normalized;
            })
            .sort(),
        }
      : {}),
    ...(value.persistentInstanceIds !== undefined
      ? {
          persistentInstanceIds: (Array.isArray(value.persistentInstanceIds)
            ? value.persistentInstanceIds
            : fail(`${label}.persistentInstanceIds must be an array`)
          )
            .map((id) => {
              const normalized = stableInstanceId(id);
              if (normalized === undefined) fail(`${label}.persistentInstanceIds contains an invalid identity`);
              return normalized;
            })
            .sort(),
        }
      : {}),
    ...(value.transientInstanceIds !== undefined
      ? {
          transientInstanceIds: (Array.isArray(value.transientInstanceIds)
            ? value.transientInstanceIds
            : fail(`${label}.transientInstanceIds must be an array`)
          )
            .map((id) => {
              const normalized = stableInstanceId(id);
              if (normalized === undefined) fail(`${label}.transientInstanceIds contains an invalid identity`);
              return normalized;
            })
            .sort(),
        }
      : {}),
    ...(value.transientPopulation !== undefined
      ? { transientPopulation: integer(value.transientPopulation, `${label}.transientPopulation`) }
      : {}),
    ...(value.arenaInstanceId !== undefined ? { arenaInstanceId: stableInstanceId(value.arenaInstanceId) } : {}),
    ...(value.frameDtMs !== undefined ? { frameDtMs: finite(value.frameDtMs, `${label}.frameDtMs`) } : {}),
    ...(value.heapBytes !== undefined ? { heapBytes: integer(value.heapBytes, `${label}.heapBytes`) } : {}),
    ...(value.heapPeakBytes !== undefined
      ? { heapPeakBytes: integer(value.heapPeakBytes, `${label}.heapPeakBytes`) }
      : {}),
    ...(value.callbackRoots !== undefined
      ? { callbackRoots: integer(value.callbackRoots, `${label}.callbackRoots`) }
      : {}),
    ...(value.luaHandles !== undefined ? { luaHandles: integer(value.luaHandles, `${label}.luaHandles`) } : {}),
    ...(value.arenaHighWaterBytes !== undefined
      ? { arenaHighWaterBytes: integer(value.arenaHighWaterBytes, `${label}.arenaHighWaterBytes`) }
      : {}),
  };
  if (snapshot.instanceIds !== undefined && new Set(snapshot.instanceIds).size !== snapshot.instanceIds.length)
    fail(`${label}.instanceIds contains duplicates`);
  if (
    snapshot.persistentInstanceIds !== undefined &&
    new Set(snapshot.persistentInstanceIds).size !== snapshot.persistentInstanceIds.length
  )
    fail(`${label}.persistentInstanceIds contains duplicates`);
  if (
    snapshot.transientInstanceIds !== undefined &&
    new Set(snapshot.transientInstanceIds).size !== snapshot.transientInstanceIds.length
  )
    fail(`${label}.transientInstanceIds contains duplicates`);
  if (
    snapshot.transientPopulation !== undefined &&
    snapshot.transientInstanceIds !== undefined &&
    snapshot.transientPopulation !== snapshot.transientInstanceIds.length
  )
    fail(`${label}.transientPopulation disagrees with transientInstanceIds`);
  if (value.arenaInstanceId !== undefined && snapshot.arenaInstanceId === undefined)
    fail(`${label}.arenaInstanceId is invalid`);
  if (snapshot.frameDtMs !== undefined && snapshot.frameDtMs > DEFAULT_HMR_SOAK_LIMITS.maxFrameDtMs)
    fail(`${label}.frameDtMs exceeds responsiveness limit`);
  return snapshot;
}

function validateBounded(snapshot, baseline, limits, label) {
  if (snapshot.entityCount > limits.maxEntityCount)
    fail(`${label}.entityCount ${snapshot.entityCount} exceeds ${limits.maxEntityCount}`);
  if (snapshot.componentCount > limits.maxComponentCount)
    fail(`${label}.componentCount ${snapshot.componentCount} exceeds ${limits.maxComponentCount}`);
  for (const [key, limitKey] of [
    ["heapBytes", "maxHeapGrowthBytes"],
    ["heapPeakBytes", "maxHeapPeakGrowthBytes"],
    ["callbackRoots", "maxCallbackRootGrowth"],
    ["luaHandles", "maxLuaHandleGrowth"],
    ["arenaHighWaterBytes", "maxArenaHighWaterGrowthBytes"],
  ]) {
    if (snapshot[key] === undefined || baseline[key] === undefined) continue;
    if (snapshot[key] - baseline[key] > limits[limitKey])
      fail(`${label}.${key} grew by ${snapshot[key] - baseline[key]}, limit ${limits[limitKey]}`);
  }
  if (baseline.runtimeId !== undefined && snapshot.runtimeId !== baseline.runtimeId)
    fail(`${label}.runtimeId changed from ${baseline.runtimeId} to ${snapshot.runtimeId}`);
  if (
    baseline.persistentInstanceIds !== undefined &&
    (!snapshot.persistentInstanceIds ||
      JSON.stringify(snapshot.persistentInstanceIds) !== JSON.stringify(baseline.persistentInstanceIds))
  )
    fail(`${label}.persistentInstanceIds changed across HMR`);
  if (baseline.arenaInstanceId !== undefined && snapshot.arenaInstanceId !== baseline.arenaInstanceId)
    fail(`${label}.arenaInstanceId changed across HMR`);
}
function validateTransientEvidence(snapshots) {
  if (
    !snapshots.every(
      (snapshot) => snapshot.transientInstanceIds !== undefined && snapshot.transientPopulation !== undefined,
    )
  ) {
    fail("transient component evidence is required");
  }
  const populations = snapshots.map((snapshot) => snapshot.transientPopulation);
  if (!populations.some((population) => population > 0)) {
    fail("transient component evidence never observed a live transient instance");
  }
  const detachedByTransition = [];
  for (let index = 1; index < snapshots.length; ++index) {
    const previous = new Set(snapshots[index - 1].transientInstanceIds);
    const current = new Set(snapshots[index].transientInstanceIds);
    detachedByTransition.push([...previous].filter((id) => !current.has(id)).length);
  }
  // Baseline -> first accepted can include objects that finished before the
  // replacement definitions began running. Require a later detach: this is
  // the exact evidence the historical module-singleton regression lacked
  // while its live set climbed from 51 to 222.
  const detachedAfterFirstAccepted = detachedByTransition.slice(1).reduce((sum, count) => sum + count, 0);
  if (detachedAfterFirstAccepted === 0) {
    fail("transient component identities never detached after the first accepted HMR generation");
  }
  return { mode: "post-reload-detach", populations, detachedByTransition, detachedAfterFirstAccepted };
}
function validateResponsive(snapshot, previous, label) {
  if (snapshot.gameplayTick <= previous.gameplayTick)
    fail(`${label} did not advance gameplay (${previous.gameplayTick} -> ${snapshot.gameplayTick})`);
  if (snapshot.frameDtMs !== undefined && snapshot.frameDtMs > DEFAULT_HMR_SOAK_LIMITS.maxFrameDtMs)
    fail(`${label} frame delta is not bounded`);
}

function runtimeHealthFailure(event) {
  if (!event || typeof event !== "object") return false;
  const type = String(event.type ?? "").toLowerCase();
  return (
    type.includes("error") ||
    type.includes("rejected") ||
    type.includes("protocol") ||
    type === "build-failed" ||
    (type === "log" && (event.level === "error" || event.source === "stdout-protocol"))
  );
}

export function validateHmrRuntimeHealth(events, stderr = "") {
  if (typeof stderr !== "string") fail("native HMR stderr must be a string");
  if (stderr.trim()) fail(`native HMR emitted stderr: ${stderr.trim().slice(-1_000)}`);
  const failure = Array.isArray(events) ? events.find(runtimeHealthFailure) : undefined;
  if (failure) {
    const detail = failure.message ?? failure.diagnostic ?? failure.type ?? "unknown runtime failure";
    fail(`native HMR emitted ${failure.type ?? "failure"}: ${detail}`);
  }
  return true;
}
function validateFingerprint(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    fail(`${label} must be a 64-character bundle fingerprint`);
}

export function validateHmrSoakEvidence(report, options = {}) {
  if (!report || report.schemaVersion !== HMR_SOAK_SCHEMA_VERSION)
    fail(`unsupported evidence schema (expected ${HMR_SOAK_SCHEMA_VERSION})`);
  if (report.installedPackage?.verified !== true) fail("installed package boundary was not verified");
  if (!/^[0-9a-f]{64}$/u.test(report.installedPackage?.treeSha256 ?? ""))
    fail("installed package treeSha256 is required");
  if (report.runtimeApi?.name !== HMR_STATE_API || report.runtimeApi.available !== true)
    fail(`native runtime state API ${HMR_STATE_API} is required`);
  const cyclesRequired = options.cycles ?? report.cyclesRequired ?? DEFAULT_HMR_SOAK_CYCLES;
  integer(cyclesRequired, "cyclesRequired", { min: 1 });
  if (!Array.isArray(report.cycles) || report.cycles.length < cyclesRequired)
    fail(`expected ${cyclesRequired} completed reload cycles`);
  const limits = { ...DEFAULT_HMR_SOAK_LIMITS, ...(options.limits ?? report.limits) };
  const baseline = normalizeHmrSnapshot(report.baseline, "baseline");
  if (baseline.runtimeId === undefined) fail("baseline.runtimeId is required");
  if (!baseline.persistentInstanceIds?.length) fail("baseline.persistentInstanceIds is required");
  if (baseline.arenaInstanceId === undefined) fail("baseline.arenaInstanceId is required");
  const allSnapshots = [baseline];
  let activeFingerprint = report.initialFingerprint;
  validateFingerprint(activeFingerprint, "initialFingerprint");
  let prior = baseline;
  const acceptedFingerprints = new Set();
  for (let index = 0; index < cyclesRequired; ++index) {
    const cycle = report.cycles[index];
    if (!cycle || cycle.index !== index) fail(`cycle ${index} has a non-contiguous index`);
    if (!cycle.accepted || cycle.accepted.status !== "activated")
      fail(`cycle ${index} accepted edit was not activated`);
    validateFingerprint(cycle.accepted.fingerprint, `cycle ${index} accepted fingerprint`);
    if (cycle.accepted.fingerprint === activeFingerprint)
      fail(`cycle ${index} accepted edit did not change the active bundle`);
    if (
      cycle.accepted.activeFingerprint !== undefined &&
      cycle.accepted.activeFingerprint !== cycle.accepted.fingerprint
    )
      fail(`cycle ${index} state endpoint did not activate the accepted fingerprint`);
    acceptedFingerprints.add(cycle.accepted.fingerprint);
    const accepted = normalizeHmrSnapshot(cycle.accepted.snapshot, `cycle ${index} accepted snapshot`);
    integer(cycle.accepted.runtimeId, `cycle ${index} activation runtimeId`);
    if (accepted.runtimeId === undefined) fail(`cycle ${index} accepted snapshot.runtimeId is required`);
    if (cycle.accepted.runtimeId !== accepted.runtimeId) {
      fail(
        `cycle ${index} activation runtimeId ${cycle.accepted.runtimeId} disagrees with snapshot runtimeId ${accepted.runtimeId}`,
      );
    }
    validateBounded(accepted, baseline, limits, `cycle ${index} accepted`);
    validateResponsive(accepted, prior, `cycle ${index} accepted gameplay`);
    if (cycle.accepted.runtimeError) fail(`cycle ${index} reported a runtime error`);
    allSnapshots.push(accepted);
    prior = accepted;
    activeFingerprint = cycle.accepted.fingerprint;
  }
  if (acceptedFingerprints.size !== cyclesRequired) fail("accepted generations were not distinct");
  const transient = validateTransientEvidence(allSnapshots);
  return {
    schemaVersion: HMR_SOAK_SCHEMA_VERSION,
    cyclesRequired,
    // The runner persists this return value over the raw report. Preserve the
    // normalized identity and telemetry baseline rather than replacing it with
    // the two counts used by the console summary.
    baseline,
    activeFingerprint,
    telemetry: {
      samples: allSnapshots.length,
      maxEntityCount: Math.max(...allSnapshots.map(({ entityCount }) => entityCount)),
      maxComponentCount: Math.max(...allSnapshots.map(({ componentCount }) => componentCount)),
      maxGameplayTick: Math.max(...allSnapshots.map(({ gameplayTick }) => gameplayTick)),
      transientEvidence: transient,
    },
    limits,
  };
}

export function parseHmrStateEvent(line) {
  if (typeof line !== "string") return undefined;
  try {
    const parsed = JSON.parse(line);
    const event = parsed?.event ?? parsed;
    if (event?.type === "hmr-state" || event?.type === "hmr-soak-snapshot") return event;
    if (event?.type === "telemetry" && event.values) return { type: "telemetry", ...event.values };
  } catch {
    /* Native logs are line-oriented and not all lines are JSON. */
  }
  const match =
    /DEHERM_EVENT hmr-state phase=(baseline|accepted) cycle=(\d+) runtime_id=(\d+) entity_count=(\d+) component_instances=(\d+) gameplay_tick=(\d+)(?: frame_dt_us=(\d+))?(?: heap_bytes=(\d+))?(?: heap_peak_bytes=(\d+))?(?: callback_roots=(\d+))?(?: lua_handles=(\d+))?(?: arena_high_water_bytes=(\d+))?/u.exec(
      line,
    );
  if (!match) return undefined;
  const number = (value) => (value === undefined ? undefined : Number(value));
  return {
    type: "hmr-state",
    phase: match[1],
    cycle: Number(match[2]),
    runtimeId: Number(match[3]),
    entityCount: Number(match[4]),
    componentInstances: Number(match[5]),
    gameplayTick: Number(match[6]),
    ...(match[7] ? { frameDtMs: number(match[7]) / 1000 } : {}),
    ...(match[8] ? { heapBytes: number(match[8]) } : {}),
    ...(match[9] ? { heapPeakBytes: number(match[9]) } : {}),
    ...(match[10] ? { callbackRoots: number(match[10]) } : {}),
    ...(match[11] ? { luaHandles: number(match[11]) } : {}),
    ...(match[12] ? { arenaHighWaterBytes: number(match[12]) } : {}),
  };
}

export async function runHmrStateSoak(adapter, options = {}) {
  const cycles = options.cycles ?? DEFAULT_HMR_SOAK_CYCLES;
  for (const method of [
    "baselineSnapshot",
    "activeFingerprint",
    "applyAcceptedComponentBodyReload",
    "waitForAccepted",
    "snapshot",
    "assertClean",
    "close",
  ])
    if (typeof adapter?.[method] !== "function") fail(`native runtime adapter is missing ${method}()`);
  const cyclesOut = [];
  let result;
  let failure;
  try {
    const baseline = await adapter.baselineSnapshot();
    const initialFingerprint = await adapter.activeFingerprint();
    for (let index = 0; index < cycles; ++index) {
      await adapter.applyAcceptedComponentBodyReload(index);
      const acceptedEvent = await adapter.waitForAccepted(index);
      const acceptedSnapshot = await adapter.snapshot(`accepted-${index}`);
      cyclesOut.push({ index, accepted: { ...acceptedEvent, snapshot: acceptedSnapshot } });
    }
    const report = {
      schemaVersion: HMR_SOAK_SCHEMA_VERSION,
      installedPackage: adapter.installedPackage ?? { verified: false },
      runtimeApi: adapter.runtimeApi ?? { name: HMR_STATE_API, available: false },
      cyclesRequired: cycles,
      initialFingerprint,
      baseline,
      cycles: cyclesOut,
      limits: options.limits,
    };
    const summary = validateHmrSoakEvidence(report, options);
    result = { ...report, ...summary };
  } catch (error) {
    failure = error;
  }
  try {
    await adapter.close();
  } catch (error) {
    failure =
      failure === undefined ? error : new AggregateError([failure, error], "native HMR run and cleanup both failed");
  }
  try {
    // This runs after process exit and stream closure. It covers startup,
    // inter-edit, and shutdown diagnostics that no edit window owns.
    await adapter.assertClean();
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError(
            [failure, error],
            "native HMR run or cleanup failed and the final health sweep also failed",
          );
  }
  if (failure !== undefined) throw failure;
  return result;
}
