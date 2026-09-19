// The projections War Battles is expected to run in, and the shared shape
// their evidence carries.
//
// Development-full, release-pruned, native and browser are not a build and its
// variants: they are projections of one IR, selected by four parameters and
// nothing else - runtime, per-route transport, reachable set, and profile. See
// `.agents/docs/decisions/release-reachability-and-native-lowering.md`. The
// consequence is the reason this file exists: **every projection carries its
// own evidence**, because every projection is a first-class artifact rather
// than a filtered copy of another. A route proven on `jsi` is not thereby
// proven on `direct-memory`, and a binary that reached the tutorial loop is not
// thereby a binary whose per-route transport anyone has looked at.
//
// So each projection below is declared once, with the four parameters that
// select it, what its evidence observed, and what it explicitly does not claim.
// Each evidence document embeds that declaration verbatim as its `projection`
// envelope, which makes the three comparable and - because the declaration
// exists whether or not the file does - makes a missing one visible instead of
// merely absent.
//
// The envelope is classification. It never carries an observation: what a run
// actually did stays in the document's own body, recorded by the harness that
// watched it.

import { createHash } from "node:crypto";

/** The four parameters that select a projection, in their canonical order. */
export const PROJECTION_PARAMETERS = Object.freeze([
  "runtime",
  "transport",
  "reachableSet",
  "profile",
]);

/** Keys every projection envelope carries, in their canonical order. */
export const PROJECTION_ENVELOPE_KEYS = Object.freeze([
  "id",
  "title",
  ...PROJECTION_PARAMETERS,
  "stage",
  "observed",
  "excluded",
]);

const declare = (declaration) => Object.freeze({
  ...declaration,
  transport: Object.freeze([...declaration.transport]),
  observed: Object.freeze([...declaration.observed]),
  excluded: Object.freeze([...declaration.excluded]),
});

export const WAR_BATTLES_PROJECTIONS = Object.freeze({
  "native-arm64-macos": declare({
    id: "native-arm64-macos",
    title: "Packaged arm64-macOS engine running the War Battles tutorial loop",
    runtime: "hermes",
    // Both tiers are linked into this one binary: the bytecode bundle crosses
    // on `jsi`, and the assembled `shermes -emit-c` unit claims the routes it
    // can soundly type. Which routes took which is a different observation and
    // a different projection.
    transport: ["jsi", "typed-native"],
    reachableSet: "complete",
    profile: "engine-detected",
    stage: "packaged-engine-runtime",
    evidence: "evidence/packaged-runtime-arm64-macos.json",
    producer: "node examples/war-battles-online/integration/check-packaged-runtime.mjs --record-evidence",
    observed: [
      "The packaged engine loaded the TypeScript bundle into Dynamic Hermes and attached its generated TypeScript components.",
      "The tutorial loop ran through real Defold APIs: camera initialisation and world bounds, GUI initialisation, player initialisation, a factory-spawned rocket, a Box2D collision, the score, and the sprite-animation completion callback.",
      "The following camera scrolled the 1920x1440 world and the player walk reached its clamped corner.",
      "A graceful `@system/exit`, addressed to this engine's own dynamically assigned service port after proving it was the sole listener, ran component `final()` and the process exited 0.",
      "No rejected engine diagnostic appeared at any point, shutdown included.",
    ],
    excluded: [
      "which transport each route crossed on - that is the `native-arm64-macos-typed-native-transport` projection, and nothing here observes it",
      "visual correctness: this gate reads an engine transcript and never inspects a window, a surface, or a pixel",
      "all Defold component contexts or lifecycle combinations",
      "the complete generated script or dmSDK surface",
      "conformance, allocation, and performance claims",
      "multiplayer transport execution",
    ],
  }),
  "browser-wasm-web": declare({
    id: "browser-wasm-web",
    title: "Packaged wasm-web bundle running the same tutorial loop in a browser",
    runtime: "browser",
    transport: ["direct-memory"],
    reachableSet: "complete",
    profile: "browser",
    stage: "packaged-engine-runtime",
    evidence: "evidence/browser-runtime-wasm-web.json",
    producer: "node examples/war-battles-online/integration/check-browser-runtime.mjs --record-evidence",
    observed: [
      "A headless-Chrome load of the bundled wasm-web artifact started the Defold Emscripten engine and installed the generated browser host and script bridge.",
      "The generated component registry installed every component, and the archived bundle fingerprint matched the source resource on disk.",
      "The same tutorial loop reached the browser: camera initialisation and world bounds, GUI initialisation, player initialisation, a factory-spawned rocket, a Box2D collision, the score, the sprite-animation completion callback, and the clamped player walk.",
      "Camera samples covering the unclamped, x-clamped and xy-clamped states.",
      "No page error and no uncaught exception.",
    ],
    excluded: [
      "Hermes: this projection runs the bundle on the browser's own JavaScript engine, so nothing here is evidence about Hermes",
      "component teardown: the page is closed rather than shut down, so no `final()` is exercised on this projection",
      "visual correctness: the gate asserts markers and CDP state, never pixels",
      "the complete generated script or dmSDK surface",
      "conformance, allocation, and performance claims",
      "Lua-owned closure results, which fail closed on this transport",
    ],
  }),
  "native-arm64-macos-typed-native-transport": declare({
    id: "native-arm64-macos-typed-native-transport",
    title: "Per-route transport selection observed inside a packaged arm64-macOS engine",
    runtime: "hermes",
    transport: ["typed-native", "jsi"],
    reachableSet: "complete",
    profile: "DEHERM_PROFILE",
    stage: "packaged-engine-runtime",
    evidence: "evidence/packaged-typed-native-transport-arm64-macos.json",
    producer: "node scripts/assemble-typed-native-extension.mjs --project examples/war-battles-online/defold --profile, then a packaged run whose census is recorded by hand",
    observed: [
      "An engine assembled with transport telemetry on reported, per route, which transport each binding crossing actually took, with the span durations its producer ring recorded.",
      "The AOT `extern_c` unit and the bytecode bundle evaluated into one Hermes runtime, and the unit installed itself over the script bridge.",
      "A control engine, produced by the same command with the assembled extension removed, registered no static unit and put every route on `jsi`, so the split is the assembly rather than the instrument.",
    ],
    excluded: [
      "the shipped build: this engine is the instrumented one, and the shipped default is telemetry off",
      "conformance: a route crossing on a transport is not a route behaving correctly on it",
      "allocation and benchmark claims: the two runs executed different amounts of gameplay and both engines are Extender debug-variant builds",
      "visual correctness",
      "the gameplay markers themselves, which the `native-arm64-macos` projection owns",
    ],
  }),
});

/** The envelope a projection's evidence document must carry, verbatim. */
export function projectionEnvelope(id) {
  const declaration = WAR_BATTLES_PROJECTIONS[id];
  if (!declaration) throw new Error(`unknown War Battles projection: ${id}`);
  const envelope = {};
  for (const key of PROJECTION_ENVELOPE_KEYS) envelope[key] = structuredClone(declaration[key]);
  return envelope;
}

/**
 * A digest over the four selection parameters alone. Two documents with the
 * same key describe the same projection, so a record that silently drifts into
 * another projection's identity is visible as a collision rather than as prose.
 */
export function projectionKey(id) {
  const declaration = WAR_BATTLES_PROJECTIONS[id];
  if (!declaration) throw new Error(`unknown War Battles projection: ${id}`);
  return createHash("sha256")
    .update(JSON.stringify(PROJECTION_PARAMETERS.map((parameter) => declaration[parameter])))
    .digest("hex");
}

/** Throws unless `document` carries this projection's envelope unchanged. */
export function assertProjectionEnvelope(id, document, { source = "evidence document" } = {}) {
  const expected = projectionEnvelope(id);
  const actual = document?.projection;
  if (!actual || typeof actual !== "object") {
    throw new Error(`${source} carries no projection envelope; expected the declaration of '${id}'`);
  }
  const actualKeys = Object.keys(actual);
  if (JSON.stringify(actualKeys) !== JSON.stringify([...PROJECTION_ENVELOPE_KEYS])) {
    throw new Error(
      `${source} projection envelope keys are ${JSON.stringify(actualKeys)}; ` +
      `expected ${JSON.stringify([...PROJECTION_ENVELOPE_KEYS])}`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${source} projection envelope does not match the declaration of '${id}' in ` +
      "examples/war-battles-online/integration/projections.mjs");
  }
  return expected;
}
