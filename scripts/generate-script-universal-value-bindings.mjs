#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectUniversalRoutes, universalTargetSupport } from "./lib/script-universal-selection.mjs";
import { ROOTED_USERDATA_REPRESENTATION, semanticHandleKinds } from "./lib/semantic-handle-kinds.mjs";
import { parseValueShape } from "./generate-script-projection-ir.mjs";
import { declaredDerivation } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";
import {
  renderUniversalValueOutputs,
  renderStaticHermes,
} from "../packages/compiler/src/script-universal-value-output-emitter.mjs";
export { renderStaticHermes };

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relativePaths = Object.freeze({
  projection: "packages/bindings/generated/defold-script-projection-ir.json",
  apiIr: "packages/bindings/generated/defold-script-api-ir.json",
  callbacks: "packages/bindings/generated/defold-script-callback-lifecycle.json",
  classification: "packages/bindings/generated/defold-script-borrowed-handle-classification.json",
  policy: "packages/bindings/overrides/script-universal-value-bindings.json",
  layouts: "packages/bindings/generated/defold-value-layouts.json",
  constants: "packages/bindings/generated/defold-script-constant-lowering.json",
  report: "packages/bindings/generated/defold-script-universal-value-bindings.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_bindings.hpp",
  source: "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp",
  cHeader: "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_capi.h",
  cSource: "defold/defold_hermes/src/generated_script_universal_value_capi.cpp",
  staticFrameHeader: "defold/defold_hermes/include/defold_hermes/generated_script_universal_static_frame.h",
  staticFrameSource: "defold/defold_hermes/src/generated_script_universal_static_frame.cpp",
  typescript: "packages/sdk/src/generated/script/universal-value-bindings.ts",
  browserTargetSupport: "packages/sdk/src/generated/script/browser-target-support.ts",
  staticHermes: "packages/static-hermes/src/generated/script-universal-value.ts",
  browser: "defold/defold_hermes/lib/web/generated_script_universal_value.js",
});

function chunk(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function collectShapeKinds(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (typeof value.kind === "string") output.add(value.kind);
  if (Array.isArray(value)) {
    for (const item of value) collectShapeKinds(item, output);
  } else {
    for (const child of Object.values(value)) collectShapeKinds(child, output);
  }
  return output;
}

/**
 * Value-shape constructors whose children the pinned projection IR inlines.
 * Anything outside this set - `dynamic`, a named or referenced schema, a
 * callback, or a constructor a later Defold revision introduces - describes a
 * value whose contents this generator cannot read, so a route carrying one
 * keeps the full per-call frame. Unrecognized constructors therefore widen the
 * frame instead of silently narrowing it.
 */
const inlinedShapeKinds = new Set([
  "scalar",
  "enum",
  "defold-value",
  "handle",
  "union",
  "optional",
  "void",
  "sequence",
  "map",
  "record",
  "variadic",
]);

/** Inlined constructors that materialize as a bounded table in the call frame. */
const tableShapeKinds = new Set(["sequence", "map", "record", "variadic"]);

/**
 * Walk one half of a signature and report the constructors and exact Defold
 * value names it can reach, including inside union variants.
 */
function collectFramePhase(value, output = { kinds: new Set(), defoldValueTypes: new Set() }) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectFramePhase(item, output);
    return output;
  }
  if (typeof value.kind === "string") {
    output.kinds.add(value.kind);
    if (value.kind === "defold-value" && typeof value.name === "string") {
      output.defoldValueTypes.add(value.name);
    }
  }
  for (const child of Object.values(value)) collectFramePhase(child, output);
  return output;
}

/**
 * Size one route's per-call frame scratch to what its contract can reach.
 *
 * The frame was allocation-free before this and stays allocation-free after:
 * the cost removed is the value-initialization of scratch the route can never
 * address. Every capacity here is at least what the generated dispatcher
 * enforces for the same route, so a narrowed frame cannot reject a call the
 * descriptor accepts. Table entry capacity keeps the policy bound because the
 * IR states no per-route element count; the decision a route makes is whether
 * it can carry a table at all.
 */
function frameContract(signature, bounds, row) {
  const input = collectFramePhase(signature?.parameters ?? []);
  const output = collectFramePhase(signature?.returns ?? []);
  const opaque = (phase) => [...phase.kinds].some((kind) => !inlinedShapeKinds.has(kind));
  const carriesTable = (phase) => opaque(phase) || [...phase.kinds].some((kind) => tableShapeKinds.has(kind));
  const anyOpaque = opaque(input) || opaque(output);
  const reaches = (name) => anyOpaque || input.defoldValueTypes.has(name) || output.defoldValueTypes.has(name);
  return {
    argumentCapacity: row.maximumArgumentCount,
    resultCapacity: row.maximumResultCount,
    inputEntryCapacity: carriesTable(input) ? bounds.maximumEntries : 0,
    outputEntryCapacity: carriesTable(output) ? bounds.maximumEntries : 0,
    matrix4Arena: reaches("matrix4"),
    urlArena: reaches("url"),
  };
}

/** Stable key and census for the distinct frame shapes the routes need. */
function frameProfileKey(contract) {
  return [
    contract.argumentCapacity,
    contract.resultCapacity,
    contract.inputEntryCapacity,
    contract.outputEntryCapacity,
    contract.matrix4Arena ? 1 : 0,
    contract.urlArena ? 1 : 0,
  ].join("/");
}

function frameProfiles(rows) {
  const order = [];
  const index = new Map();
  for (const row of rows) {
    const key = frameProfileKey(row.frameContract);
    if (!index.has(key)) {
      index.set(key, order.length);
      order.push({ ...row.frameContract, routeCount: 0 });
    }
    ++order[index.get(key)].routeCount;
  }
  return { profiles: order, indexOf: (row) => index.get(frameProfileKey(row.frameContract)) };
}

function collectDefoldValueTypes(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectDefoldValueTypes(item, output);
    return output;
  }
  if (value.kind === "defold-value" && typeof value.name === "string") output.add(value.name);
  for (const child of Object.values(value)) collectDefoldValueTypes(child, output);
  return output;
}

// Static Hermes may carry an optional callback route only for calls whose
// callback argument is omitted.  The sound-typed bridge declines a present
// JavaScript function before acquiring a native frame, so it cannot silently
// lose callback ownership; required callbacks and callback results stay out of
// this lane until a callable-result transport exists.
function staticOptionalCallbackTransport(signature) {
  const callbacks = [];
  const walk = (shape, optional, phase) => {
    if (!shape || typeof shape !== "object") return;
    if (shape.kind === "callback") {
      callbacks.push({ phase, optional: optional || shape.optional === true });
      return;
    }
    // Nil-able values are not automatically omitted parameters.  Only the
    // declaration's optional bit grants the Static lane its omission proof.
    const childOptional = optional;
    if (shape.value) walk(shape.value, childOptional, phase);
    if (shape.element) walk(shape.element, childOptional, phase);
    if (shape.key) walk(shape.key, childOptional, phase);
    if (shape.pointee) walk(shape.pointee, childOptional, phase);
    if (shape.target) walk(shape.target, childOptional, phase);
    if (shape.result) walk(shape.result, childOptional, phase);
    for (const value of shape.values ?? []) walk(value, childOptional, phase);
    for (const value of shape.types ?? []) walk(value, childOptional, phase);
    for (const parameter of shape.parameters ?? []) {
      walk(parameter.value ?? parameter.type, childOptional || parameter.optional === true, "input");
    }
    for (const value of shape.returns ?? []) {
      walk(value.value ?? value.type ?? value, childOptional, "output");
    }
    for (const field of shape.fields ?? []) {
      walk(field.value ?? field.type, childOptional || field.optional === true, phase);
    }
  };
  walk(signature, false, "input");
  return callbacks.length > 0 && callbacks.every(({ phase, optional }) => phase === "input" && optional);
}

function parseArguments(argv) {
  const options = { check: false, outputRoot: repositoryRoot };
  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--output-root") options.outputRoot = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function readInputs(root = repositoryRoot) {
  const [projectionText, apiIrText, callbacksText, classificationText, policyText, layoutsText, constantsText] =
    await Promise.all([
      readFile(path.join(root, relativePaths.projection), "utf8"),
      readFile(path.join(root, relativePaths.apiIr), "utf8"),
      readFile(path.join(root, relativePaths.callbacks), "utf8"),
      readFile(path.join(root, relativePaths.classification), "utf8"),
      readFile(path.join(root, relativePaths.policy), "utf8"),
      readFile(path.join(root, relativePaths.layouts), "utf8"),
      readFile(path.join(root, relativePaths.constants), "utf8"),
    ]);
  return { projectionText, apiIrText, callbacksText, classificationText, policyText, layoutsText, constantsText };
}

/**
 * The rooted semantic handle kind a route's declared result *is*, or null.
 *
 * Read from the borrowed-handle classification the projection already folded
 * into the row, never from the member name: the classification decides what a
 * handle kind is, and it admits a constructor on the strength of its declared
 * result type rather than on the shape of its arguments.
 */
function declaredRootedResultKind(row, rootedKinds) {
  if ((row.signature?.returns ?? []).length !== 1) return null;
  const ownership = row.effects?.ownership ?? {};
  if (ownership.hostHandleEffect !== "capture-return") return null;
  const returnKinds = ownership.returnKinds ?? [];
  if (returnKinds.length !== 1) return null;
  const [kind] = returnKinds;
  return rootedKinds.has(kind) ? kind : null;
}

const RESULT_SHAPE_KIND = Object.freeze({
  opaque: 0,
  tuple: 1,
  scalar: 2,
  handle: 3,
  optional: 4,
  union: 5,
  sequence: 6,
  map: 7,
  record: 8,
});

function buildResultShapeTables(rows, apiIr, semanticKinds) {
  const apiTypes = new Map((apiIr.types ?? []).map((type) => [type.name, type]));
  const semanticByRawType = new Map();
  for (const kind of semanticKinds) {
    if (kind.representation !== ROOTED_USERDATA_REPRESENTATION) continue;
    for (const rawType of kind.rawTypes ?? []) semanticByRawType.set(rawType, kind);
  }
  const nodes = [{ kind: RESULT_SHAPE_KIND.opaque, semanticKind: 0, firstChild: 0, childCount: 0 }];
  const edges = [];

  function makeNode(kind, semanticKind = 0, children = []) {
    const firstChild = edges.length;
    for (const child of children) edges.push({ child: child.node, key: child.key ?? null });
    const node = nodes.length;
    nodes.push({ kind: RESULT_SHAPE_KIND[kind], semanticKind, firstChild, childCount: children.length });
    return { node, containsHandle: kind === "handle" || children.some(({ containsHandle }) => containsHandle) };
  }

  function resolve(shape, stack = []) {
    if (!shape || typeof shape !== "object") return { node: 0, containsHandle: false };
    if (["handle", "named", "enum"].includes(shape.kind)) {
      const rawType = shape.name;
      const semanticKind = semanticByRawType.get(rawType);
      if (semanticKind) return makeNode("handle", semanticKind.numericId);
      const definition = apiTypes.get(rawType);
      if (definition?.fields?.length && !stack.includes(rawType)) {
        return resolveRecord(definition, [...stack, rawType]);
      }
      return makeNode("opaque");
    }
    if (shape.kind === "scalar") return makeNode("scalar");
    if (shape.kind === "record-ref") {
      const definition = apiTypes.get(shape.name);
      if (definition?.fields?.length && !stack.includes(shape.name)) {
        return resolveRecord(definition, [...stack, shape.name]);
      }
      return makeNode("opaque");
    }
    if (shape.kind === "record") {
      const fields = (shape.fields ?? []).map(({ name, value }) => ({ key: name, ...resolve(value, stack) }));
      return makeNode("record", 0, fields);
    }
    if (shape.kind === "sequence") return makeNode("sequence", 0, [{ ...resolve(shape.element, stack) }]);
    if (shape.kind === "map") return makeNode("map", 0, [resolve(shape.key, stack), resolve(shape.value, stack)]);
    if (shape.kind === "optional") return makeNode("optional", 0, [resolve(shape.value, stack)]);
    if (shape.kind === "union")
      return makeNode(
        "union",
        0,
        (shape.variants ?? []).map((variant) => resolve(variant, stack)),
      );
    return makeNode("opaque");
  }

  function resolveRecord(definition, stack) {
    const fields = definition.fields.map((field) => {
      const knownHandle = semanticByRawType.has(field.rawType.trim());
      let parsed;
      try {
        parsed = parseValueShape(field.rawType, knownHandle ? ["handle"] : []);
      } catch {
        parsed = { kind: "opaque" };
      }
      return { key: field.rawName, ...resolve(parsed, stack) };
    });
    return makeNode("record", 0, fields);
  }

  const roots = new Map();
  for (const row of rows) {
    const returns = row.signature?.returns ?? [];
    const children = returns.map(({ value }) => resolve(value));
    const tuple = makeNode("tuple", 0, children);
    roots.set(row.id, tuple.node);
  }
  return { nodes, edges, roots };
}

export function generateUniversalValueBindings(inputs) {
  const projection = JSON.parse(inputs.projectionText);
  const apiIr = JSON.parse(inputs.apiIrText);
  const callbacks = JSON.parse(inputs.callbacksText);
  const classification = JSON.parse(inputs.classificationText);
  const policy = JSON.parse(inputs.policyText);
  const layouts = JSON.parse(inputs.layoutsText);
  const constantReport = JSON.parse(inputs.constantsText);
  assert(
    classification.defoldRevision === projection.defoldRevision,
    "borrowed-handle classification does not match the script projection",
  );
  const semanticKinds = semanticHandleKinds(classification);
  const semanticKindIds = new Map(semanticKinds.map(({ id, numericId }) => [id, numericId]));
  const rootedKinds = new Set(
    semanticKinds.filter(({ representation }) => representation === ROOTED_USERDATA_REPRESENTATION).map(({ id }) => id),
  );
  const resultShapeTables = buildResultShapeTables(projection.rows, apiIr, semanticKinds);
  assert(projection.schemaVersion === 1, "unsupported script projection schema");
  assert(
    layouts.schemaVersion === 1 && layouts.defoldRevision === projection.defoldRevision,
    "Defold value layout report does not match the script projection",
  );
  assert(
    callbacks.schemaVersion === 1 && callbacks.defoldRevision === projection.defoldRevision,
    "callback lifecycle input does not match the script projection",
  );
  const callbackById = new Map(callbacks.routes.map((route) => [route.id, route]));
  const { selected: selectedBase, excluded } = selectUniversalRoutes(
    projection.rows.map((row) => {
      const variadicToken = row.effects.variadic.token;
      assert(variadicToken === "runtime-arity" || variadicToken === "fixed-arity", `${row.id}: unknown variadic token`);
      return {
        id: row.id,
        stableId: row.stableId,
        modulePath: row.modulePath,
        member: row.member,
        runtimeModulePath: row.runtimeModulePath,
        runtimeMember: row.runtimeMember,
        loweringFamily: row.loweringFamily,
        contextToken: row.context.token,
        parameters: row.signature.parameters,
        overloadTokens: row.signature.overloadTokens,
        returns: row.signature.returns,
        variadic: variadicToken === "runtime-arity",
        shapeKinds: collectShapeKinds(row.signature),
        defoldValueTypes: collectDefoldValueTypes(row.signature),
        recursive: row.effects.recursive,
      };
    }),
    policy,
  );
  const signatureById = new Map(projection.rows.map((row) => [row.id, row.signature]));
  const resultSemanticKindById = new Map(
    projection.rows.map((row) => [row.id, declaredRootedResultKind(row, rootedKinds)]),
  );
  const selectedRoutes = selectedBase.map((row) => {
    const signature = signatureById.get(row.id);
    assert(signature, `${row.id}: universal selection lost its projected signature`);
    const callback = callbackById.get(row.id);
    const resultSemanticKind = resultSemanticKindById.get(row.id) ?? null;
    const sized = {
      ...row,
      resultSemanticKind,
      resultSemanticKindId: resultSemanticKind === null ? 0 : semanticKindIds.get(resultSemanticKind),
      resultShapeRoot: resultShapeTables.roots.get(row.id) ?? 0,
      frameContract: frameContract(signature, policy.bounds, row),
    };
    assert(
      sized.resultSemanticKindId !== undefined,
      `${row.id}: declared result handle kind '${resultSemanticKind}' has no dense semantic identity`,
    );
    if (!callback && row.shapeKinds.includes("callback")) {
      assert(declaredDerivation(), `${row.id}: universal callback route has no reviewed lifecycle entry`);
      recordAudit({
        input: relativePaths.callbacks,
        id: row.id,
        status: VOID,
        reason: "unreviewed-callback-lifecycle",
        detail: "The API and universal descriptor are emitted, but the browser callback transport stays fail-closed.",
      });
      return {
        ...sized,
        browserCallback: {
          registryEligible: false,
          reviewedLifecycle: false,
          lifetime: null,
          owner: null,
          threadAffinity: null,
          machineBlock: "unreviewed-callback-lifecycle-for-revision",
        },
      };
    }
    return callback
      ? {
          ...sized,
          browserCallback: {
            registryEligible: callback.registryEligible,
            lifetime: callback.lifetime,
            owner: callback.owner,
            threadAffinity: callback.threadAffinity,
            machineBlock: callback.machineBlock ?? null,
          },
        }
      : sized;
  });
  const selectedConstants = constantReport.entries
    .filter((entry) => entry.state === "runtime-backed" || entry.state === "profile-unavailable")
    .map((entry) => {
      const segments = entry.name.split(".");
      const member = segments.pop();
      return {
        id: `script:constant.${entry.name}`,
        stableId: entry.stableId,
        modulePath: segments,
        member,
        loweringFamily: "script-constant",
        minimumArgumentCount: 0,
        maximumArgumentCount: 0,
        minimumResultCount: 1,
        maximumResultCount: 1,
        resultCount: 1,
        resultSemanticKind: null,
        resultSemanticKindId: 0,
        resultShapeRoot: 0,
        frameContract: {
          argumentCapacity: 0,
          resultCapacity: 1,
          inputEntryCapacity: 0,
          outputEntryCapacity: 0,
          matrix4Arena: false,
          urlArena: false,
        },
        shapeKinds: [],
        defoldValueTypes: [],
        recursive: { token: "constant" },
        constant: true,
      };
    });
  const selected = [...selectedRoutes, ...selectedConstants].sort(
    (left, right) => left.stableId - right.stableId || compare(left.id, right.id),
  );
  assert(
    new Set(selected.map(({ stableId }) => stableId)).size === selected.length,
    "script function and constant stable IDs collide",
  );
  assert(
    selected.filter(({ shapeKinds, id }) => shapeKinds.includes("callback") && callbackById.has(id)).length ===
      callbacks.routeCount,
    "universal callback census differs from the lifecycle ledger",
  );
  const browserCallbackRoutes = selected.filter(({ browserCallback }) => browserCallback?.registryEligible);
  const blockedBrowserCallbackRoutes = selected.filter(
    ({ browserCallback }) => browserCallback && !browserCallback.registryEligible,
  );
  const reviewedBlockedBrowserCallbackRoutes = blockedBrowserCallbackRoutes.filter(
    ({ browserCallback }) => browserCallback.reviewedLifecycle !== false,
  );
  assert(
    browserCallbackRoutes.length === callbacks.registryEligibleRouteCount &&
      reviewedBlockedBrowserCallbackRoutes.length === callbacks.higherOrderClosureRouteCount,
    "universal browser callback partition differs from the lifecycle ledger",
  );
  const frameProfileCensus = frameProfiles(selected).profiles.map((profile) => ({
    ...profile,
    bytes:
      profile.argumentCapacity * 48 +
      profile.resultCapacity * 48 +
      (profile.inputEntryCapacity + profile.outputEntryCapacity) * 96 +
      (profile.matrix4Arena ? 1296 : 0) +
      (profile.urlArena ? 1296 : 0),
  }));
  const rendered = renderUniversalValueOutputs({
    rows: selected,
    policy,
    layouts,
    resultShapeTables,
    blockedBrowserCallbackRoutes,
    chunkRows: chunk,
    createFrameProfiles: frameProfiles,
  });
  const {
    header,
    source,
    cHeader,
    cSource,
    staticFrameHeader,
    staticFrameSource,
    typescript,
    staticHermes,
    browser,
    browserTargetSupport,
  } = rendered;
  // The sound-typed transport copies every Defold value type the pinned layout
  // report models transparently. Engine-owned values and Lua closures stay out
  // until the retained-handle and closure transports land.
  const transparentValueTypes = new Set(Object.keys(layouts.transparent));
  const staticHermesEligible = selected.filter(
    ({ id, shapeKinds, defoldValueTypes }) =>
      (!shapeKinds.includes("callback") || staticOptionalCallbackTransport(signatureById.get(id))) &&
      !shapeKinds.includes("handle") &&
      defoldValueTypes.every((name) => transparentValueTypes.has(name)),
  );
  const artifacts = [
    relativePaths.header,
    relativePaths.source,
    relativePaths.cHeader,
    relativePaths.cSource,
    relativePaths.staticFrameHeader,
    relativePaths.staticFrameSource,
    relativePaths.typescript,
    relativePaths.browserTargetSupport,
    relativePaths.staticHermes,
    relativePaths.browser,
  ];
  const artifactHashes = Object.fromEntries([
    [relativePaths.header, sha256(header)],
    [relativePaths.source, sha256(source)],
    [relativePaths.cHeader, sha256(cHeader)],
    [relativePaths.cSource, sha256(cSource)],
    [relativePaths.staticFrameHeader, sha256(staticFrameHeader)],
    [relativePaths.staticFrameSource, sha256(staticFrameSource)],
    [relativePaths.typescript, sha256(typescript)],
    [relativePaths.browserTargetSupport, sha256(browserTargetSupport)],
    [relativePaths.staticHermes, sha256(staticHermes)],
    [relativePaths.browser, sha256(browser)],
  ]);
  const report = {
    schemaVersion: 1,
    defoldRevision: projection.defoldRevision,
    scope:
      "Every callable script route selected mechanically by one bounded universal value-graph fallback; browser callbacks are promoted only when the generated lifecycle ledger marks them registry-eligible, and optimized lanes remain preferred at runtime.",
    evidenceBoundary:
      "The shared recursive Lua backend, fixed-layout C ABI, sound-typed Static Hermes frame marshaller, direct-memory browser provider, and browser callback trampoline are generated and independently harness-tested. Static Hermes runtime execution proves the shape subset that carries no retained Lua handle, whose Defold value types all have a pinned transparent layout, and whose callback inputs are optional and declined to the JSI lane when present; packaged Defold and packaged browser execution remain unverified.",
    selection: policy.selection,
    bounds: policy.bounds,
    tablePolicy: policy.tablePolicy,
    candidateCount: selected.length,
    excludedCount: excluded.length,
    // Per-call frame scratch is sized to each route's contract rather than to
    // the family maximum. Byte figures are the generated array footprints on a
    // 64-bit target and exist so the cost of a dispatch is auditable from the
    // report, not only from a profiler.
    frameProfiles: {
      rule: "input-and-output-value-shapes-walked-per-phase-unreadable-constructors-keep-the-full-frame",
      distinct: frameProfileCensus.length,
      profiles: frameProfileCensus,
    },
    targetSupport: universalTargetSupport,
    targetEvidence: {
      nativeDynamicHermes: {
        compile: "proven",
        harnessRuntime: "proven",
        registryEligibleCallbackRoutes: browserCallbackRoutes.length,
        rootedHigherOrderClosureRoutes: blockedBrowserCallbackRoutes.map(({ id }) => id),
        luaClosureResultRooting:
          "real-hermes-lua-harness-proven-with-varargs-multi-result-error-finalizer-and-teardown",
        packagedDefold: "unverified",
      },
      nativeStaticHermes: {
        cAbiCompileLinkRuntime: "proven",
        staticCompiler: "proven",
        staticHermesRuntime: "proven-representative-recursive-value-graph-with-transparent-defold-value-records",
        emittedRouteCount: staticHermesEligible.length,
        emittedShapeRule:
          "optional-input-callbacks-decline-to-jsi-no-lua-handle-and-every-defold-value-type-transparent",
        transparentValueTypes: [...transparentValueTypes].sort(compare),
        opaqueValueTypes: Object.keys(layouts.opaque).sort(compare),
        defoldValueLayoutSource: relativePaths.layouts,
        retainedLuaHandleHarness: "native-frame-proven-not-route-promoted",
        framePool: {
          reentrancyMacro: "DEHERM_SCRIPT_STATIC_FRAME_REENTRANCY",
          defaultDepth: 4,
          stringBytesMacro: "DEHERM_SCRIPT_STATIC_FRAME_STRING_BYTES",
          defaultInputStringBytesPerFrame: 16384,
          defaultOutputStringBytesPerFrame: 16384,
          exactNativeFootprint: "reported-by-runtime-harness-not-portably-derived",
        },
        packagedDefold: "unverified",
      },
      html5BrowserHost: {
        providerSyntax: "proven",
        directMemoryHarness: "proven",
        callbackRegistryNativeHarness: "proven",
        registryEligibleCallbackRoutes: browserCallbackRoutes.length,
        blockedHigherOrderClosureRoutes: blockedBrowserCallbackRoutes.map(({ id }) => id),
        packagedBrowserEngine: "unverified",
      },
    },
    inputHashes: {
      projection: sha256(inputs.projectionText),
      apiIr: sha256(inputs.apiIrText),
      callbacks: sha256(inputs.callbacksText),
      classification: sha256(inputs.classificationText),
      policy: sha256(inputs.policyText),
      layouts: sha256(inputs.layoutsText),
      constants: sha256(inputs.constantsText),
    },
    resultShapeMetadata: {
      schemaVersion: 1,
      kinds: Object.fromEntries(Object.entries(RESULT_SHAPE_KIND).map(([name, value]) => [name, value])),
      nodes: resultShapeTables.nodes,
      edges: resultShapeTables.edges,
    },
    outputFacts: {
      browserBlockedCallbacks: blockedBrowserCallbackRoutes.map(({ id, stableId, browserCallback }) => ({
        id,
        stableId,
        browserCallback: { machineBlock: browserCallback.machineBlock },
      })),
    },
    artifacts,
    artifactHashes,
    bindings: selected,
    excluded,
  };
  return {
    report,
    header,
    source,
    cHeader,
    cSource,
    staticFrameHeader,
    staticFrameSource,
    typescript,
    browserTargetSupport,
    staticHermes,
    browser,
  };
}

async function writeOrCheck(root, relative, content, check) {
  const destination = path.join(root, relative);
  if (check) {
    assert((await readFile(destination, "utf8")) === content, `${relative} is stale`);
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

export async function runUniversalValueGenerator(options = {}) {
  const sourceRoot = options.sourceRoot ?? repositoryRoot;
  const outputRoot = options.outputRoot ?? repositoryRoot;
  const generated = generateUniversalValueBindings(await readInputs(sourceRoot));
  await writeOrCheck(outputRoot, relativePaths.header, generated.header, options.check);
  await writeOrCheck(outputRoot, relativePaths.source, generated.source, options.check);
  await writeOrCheck(outputRoot, relativePaths.cHeader, generated.cHeader, options.check);
  await writeOrCheck(outputRoot, relativePaths.cSource, generated.cSource, options.check);
  await writeOrCheck(outputRoot, relativePaths.staticFrameHeader, generated.staticFrameHeader, options.check);
  await writeOrCheck(outputRoot, relativePaths.staticFrameSource, generated.staticFrameSource, options.check);
  await writeOrCheck(outputRoot, relativePaths.typescript, generated.typescript, options.check);
  await writeOrCheck(outputRoot, relativePaths.browserTargetSupport, generated.browserTargetSupport, options.check);
  await writeOrCheck(outputRoot, relativePaths.staticHermes, generated.staticHermes, options.check);
  await writeOrCheck(outputRoot, relativePaths.browser, generated.browser, options.check);
  await writeOrCheck(outputRoot, relativePaths.report, `${JSON.stringify(generated.report, null, 2)}\n`, options.check);
  return generated.report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runUniversalValueGenerator(parseArguments(process.argv.slice(2)))
    .then((report) => console.log(`Generated ${report.candidateCount} universal-value script descriptors.`))
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}
