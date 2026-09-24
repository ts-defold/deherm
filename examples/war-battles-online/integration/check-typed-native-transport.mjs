#!/usr/bin/env node
//
// Per-route transport evidence for the packaged arm64-macOS engine.
//
// The other two runtime gates watch what the game does. This one watches how
// each binding call got into the engine, which is a different projection and
// therefore a different record: a route that reached the engine says nothing
// about which transport carried it.
//
// The instrument is the `DEHERM_PROFILE` build switch, which the assembler
// materialises into the extension Bob uploads. With it on, every generated
// dispatcher and the JSI bridge open a span, and the extension folds the
// producer ring into a per-route census. This gate drives the same gameplay as
// the native runtime gate, shuts the engine down gracefully so the census is
// the complete fold taken after every component `final()` has run, and records
// the census for one named run.
//
// Two runs make the evidence, and each is recorded separately because each
// needs its own engine:
//
//   --run with-typed-native   the project's assembled extension is present
//   --run control             the same project with that extension removed
//
// The control is what makes the claim non-vacuous: if both runs looked the
// same, the split would be an artefact of the instrument rather than of the
// assembly. Nothing here is conformance, allocation, or benchmark evidence -
// the two runs execute different amounts of gameplay and both engines are
// Extender debug-variant builds.

import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_MARKERS, runPackagedRuntimeEvidence, sha256Artifact } from "./packaged-runtime-evidence.mjs";
import { projectionEnvelope } from "./projections.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const engine = resolve(exampleRoot, "defold/build/arm64-osx/dmengine");
const runtimeCwd = resolve(exampleRoot, "defold/build/default");
const evidencePath = resolve(exampleRoot, "evidence/packaged-typed-native-transport-arm64-macos.json");
const planPath = resolve(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.json");
const bridgePath = resolve(repositoryRoot, "packages/bindings/generated/defold-typed-native-bridge.json");
const assembledManifest = resolve(exampleRoot, "defold/defold_hermes_typed_native/manifest.json");

export const PROJECTION_ID = "native-arm64-macos-typed-native-transport";

const RUN_SLOTS = Object.freeze({
  "with-typed-native": "withAssembledTypedNativeExtension",
  control: "controlWithoutAssembledExtension",
});

const CENSUS_BEGIN =
  /^INFO:DEFOLD_HERMES: DEHERM_EVENT transport-census-begin reason=(\S+) routes=(\d+) produced=(\d+) dropped=(\d+) overflow=(\d+)$/;
const CENSUS_SPAN =
  /^INFO:DEFOLD_HERMES: DEHERM_EVENT transport-span transport=(\S+) stable_id=0x([0-9a-f]{8}) calls=(\d+) total_ns=(\d+) mean_ns=(\d+) failures=(\d+)$/;
const CENSUS_END = /^INFO:DEFOLD_HERMES: DEHERM_EVENT transport-census-end reason=(\S+)$/;
const UNIT_REGISTERED = /^INFO:DEFOLD_HERMES_TYPED_NATIVE: DEHERM_EVENT typed-native-unit-registered unit=(\S+)$/m;
const STATIC_UNITS = /^INFO:DEFOLD_HERMES: DEHERM_EVENT static-units-evaluated count=(\d+) runtime_id=\d+$/m;

/**
 * The last complete census in a transcript. `finalize` is the fold taken after
 * every component `final()` has made its last binding call, so it is the only
 * census that covers the whole run; a periodic one is a prefix of it.
 */
export function lastCensus(transcript) {
  const lines = String(transcript).replaceAll("\r", "").split("\n");
  let open = null;
  let complete = null;
  for (const line of lines) {
    const begin = CENSUS_BEGIN.exec(line);
    if (begin) {
      open = {
        reason: begin[1],
        routeCount: Number.parseInt(begin[2], 10),
        spansProduced: Number.parseInt(begin[3], 10),
        spansDropped: Number.parseInt(begin[4], 10),
        censusOverflow: Number.parseInt(begin[5], 10),
        spans: [],
      };
      continue;
    }
    if (!open) continue;
    const span = CENSUS_SPAN.exec(line);
    if (span) {
      open.spans.push({
        transport: span[1],
        stableId: Number.parseInt(span[2], 16),
        calls: Number.parseInt(span[3], 10),
        totalNanoseconds: Number.parseInt(span[4], 10),
        meanNanoseconds: Number.parseInt(span[5], 10),
        failures: Number.parseInt(span[6], 10),
      });
      continue;
    }
    const end = CENSUS_END.exec(line);
    if (end && end[1] === open.reason) {
      if (open.spans.length !== open.routeCount) {
        throw new Error(`Census claimed ${open.routeCount} route(s) but reported ${open.spans.length}`);
      }
      complete = open;
      open = null;
    }
  }
  return complete;
}

async function routeNames() {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const names = new Map();
  for (const unit of plan.units) {
    const { stableId, id } = unit.identity ?? {};
    if (Number.isSafeInteger(stableId)) names.set(stableId, id);
  }
  return names;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** The assembled extension's identity, or null when the run has none. */
async function readAssembledManifest() {
  try {
    const manifest = JSON.parse(await readFile(assembledManifest, "utf8"));
    return {
      name: manifest.extension,
      unit: manifest.unit,
      profile: manifest.profile,
      emittedCSha256: manifest.emittedCSha256,
      adaptedSourceSha256: manifest.adaptedSourceSha256,
      externCalleeCount: manifest.externCalleeCount,
      externCallSiteCount: manifest.externCallSiteCount,
      hermesArchiveModel: manifest.hermesArchiveModel,
    };
  } catch (error) {
    // The control run is recorded with the extension removed, so its absence
    // is the point rather than a problem.
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export async function recordRun(slotKey) {
  const slot = RUN_SLOTS[slotKey];
  if (!slot) throw new Error(`--run must be one of ${Object.keys(RUN_SLOTS).join(", ")}`);

  const engineMode = (await stat(engine)).mode;
  if ((engineMode & 0o111) === 0) await chmod(engine, engineMode | 0o755);

  const result = await runPackagedRuntimeEvidence({
    command: engine,
    cwd: runtimeCwd,
    requiredMarkers: REQUIRED_MARKERS,
  });

  const census = lastCensus(result.transcript);
  if (!census) {
    throw new Error(
      "The packaged engine reported no transport census, so this binary is not the instrumented one. " +
        "Re-assemble with:\n  node scripts/assemble-typed-native-extension.mjs --project examples/war-battles-online/defold --profile\n" +
        "then rebuild it through the pinned local Extender.",
    );
  }
  if (census.reason !== "finalize") {
    throw new Error(`Expected the finalize census after a graceful shutdown, got reason=${census.reason}`);
  }

  const names = await routeNames();
  const rows = census.spans
    .map((span) => ({ routeId: names.get(span.stableId) ?? null, ...span }))
    .sort((left, right) =>
      left.transport === right.transport
        ? (left.routeId ?? "") < (right.routeId ?? "")
          ? -1
          : 1
        : left.transport < right.transport
          ? -1
          : 1,
    );
  const unresolved = rows.filter((row) => row.routeId === null);
  if (unresolved.length) {
    throw new Error(
      `Census reported stable IDs the canonical plan does not name: ${unresolved.map((row) => row.stableId).join(", ")}`,
    );
  }
  const transportCounts = {};
  for (const row of rows) transportCounts[row.transport] = (transportCounts[row.transport] ?? 0) + 1;

  const unitRegistered = UNIT_REGISTERED.exec(result.transcript);
  const staticUnits = STATIC_UNITS.exec(result.transcript);
  const run = {
    reason: census.reason,
    routeCount: census.routeCount,
    spansProduced: census.spansProduced,
    spansDropped: census.spansDropped,
    censusOverflow: census.censusOverflow,
    typedNativeUnitRegistered: Boolean(unitRegistered),
    staticUnitsEvaluated: staticUnits ? Number.parseInt(staticUnits[1], 10) : 0,
    transportCounts: Object.fromEntries(
      Object.entries(transportCounts).sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
    rows,
  };

  // The identities belong to the run, not to the file: each run has its own
  // engine, and only the one recorded last is still on disk.
  run.artifacts = {};
  for (const path of [
    "examples/war-battles-online/defold/build/arm64-osx/dmengine",
    "examples/war-battles-online/defold/build/default/deherm/app.dehermc",
  ]) {
    run.artifacts[path] = (await sha256Artifact(repositoryRoot, path)).sha256;
  }
  run.assembledExtension = await readAssembledManifest();

  const expectedUnit = slotKey === "with-typed-native";
  if (run.typedNativeUnitRegistered !== expectedUnit) {
    throw new Error(
      `Run '${slotKey}' ${run.typedNativeUnitRegistered ? "registered" : "did not register"} the typed-native unit, ` +
        `which is the opposite of what this slot records. ${
          expectedUnit
            ? "Assemble the extension into the project and rebuild."
            : "Remove <project>/defold_hermes_typed_native and rebuild before recording the control."
        }`,
    );
  }
  return { slot, run };
}

async function mergeEvidence({ slot, run }) {
  let document;
  try {
    document = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    document = {};
  }
  const bridge = JSON.parse(await readFile(bridgePath, "utf8"));
  const lock = await readFile(resolve(repositoryRoot, "upstream.lock"), "utf8");
  const engineRevision = /^DEFOLD_REV=([0-9a-f]{40})$/m.exec(lock)?.[1];
  if (!engineRevision) throw new Error("upstream.lock does not pin a Defold revision");

  const runs = { ...document.runs, [slot]: run };
  const merged = {
    schemaVersion: 2,
    projection: projectionEnvelope(PROJECTION_ID),
    target: "arm64-macos",
    engineRevision,
    buildServer: "http://localhost:9010 (pinned local Extender)",
    bundleVariant: "debug",
    telemetry: {
      switch: "DEHERM_PROFILE",
      materialisedBy: "node scripts/assemble-typed-native-extension.mjs --project <dir> --profile",
      recordedBy:
        "node examples/war-battles-online/integration/check-typed-native-transport.mjs --run <with-typed-native|control>",
      spanSites: {
        "typed-native":
          "defold/defold_hermes/src/generated_script_universal_value_capi.cpp: deherm_script_universal_dispatch, reachable in this binary only from the extern_c static frame",
        jsi: "defold/defold_hermes/src/script_jsi_bridge.cpp: the JSI host function the generated SDK's callScriptApi calls",
      },
    },
    typedNativeBridge: {
      claimedRouteCount: bridge.claimedRouteCount,
      declinedRouteCount: bridge.declinedRouteCount,
      declinedRoutes: bridge.declinedRoutes,
      planTypedNativeEmit: bridge.planTypedNativeEmit,
    },
    runs,
  };
  if (
    Object.hasOwn(runs, "withAssembledTypedNativeExtension") &&
    Object.hasOwn(runs, "controlWithoutAssembledExtension")
  ) {
    merged.split = {
      typedNativeRoutes: runs.withAssembledTypedNativeExtension.rows
        .filter((row) => row.transport === "typed-native")
        .map((row) => row.routeId),
      jsiRoutesWithExtension: runs.withAssembledTypedNativeExtension.rows
        .filter((row) => row.transport === "jsi")
        .map((row) => row.routeId),
      controlIsAllJsi: Object.keys(runs.controlWithoutAssembledExtension.transportCounts).join(",") === "jsi",
    };
  }
  merged.recordSha256 = sha256(JSON.stringify({ ...merged, recordSha256: undefined }));
  await writeFile(evidencePath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const argv = process.argv.slice(2);
  const runIndex = argv.indexOf("--run");
  if (runIndex < 0 || !argv[runIndex + 1]) {
    console.error(
      `usage: check-typed-native-transport.mjs --run <${Object.keys(RUN_SLOTS).join("|")}> [--record-evidence]`,
    );
    process.exitCode = 2;
  } else {
    const recorded = await recordRun(argv[runIndex + 1]);
    console.log(
      `war-battles-typed-native-transport:${argv[runIndex + 1]}:` +
        `${Object.entries(recorded.run.transportCounts)
          .map(([name, count]) => `${name}=${count}`)
          .join(":")}` +
        `:dropped=${recorded.run.spansDropped}`,
    );
    for (const row of recorded.run.rows) {
      console.log(
        `  ${row.transport.padEnd(13)} ${row.routeId} calls=${row.calls} mean_ns=${row.meanNanoseconds} failures=${row.failures}`,
      );
    }
    if (argv.includes("--record-evidence")) {
      await mergeEvidence(recorded);
      console.log(`war-battles-typed-native-transport:evidence:${relative(repositoryRoot, evidencePath)}`);
    }
  }
}
