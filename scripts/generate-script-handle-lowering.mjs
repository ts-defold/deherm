import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  handleCodecBits as codecBits,
  handlePascalIdentifier as pascal,
  renderScriptHandleLoweringArtifacts,
} from "../packages/compiler/src/script-handle-lowering-output-emitter.mjs";
import { semanticHandleKinds } from "./lib/semantic-handle-kinds.mjs";
import { expectReviewedCount } from "./lib/reviewed-revision.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

export const inputPaths = Object.freeze({
  policy: "packages/bindings/overrides/script-handle-lowering-policy.json",
  projection: "packages/bindings/generated/defold-script-projection-ir.json",
  classification: "packages/bindings/generated/defold-script-borrowed-handle-classification.json",
  availability: "packages/bindings/generated/defold-script-route-availability-profiles.json",
});

export const outputPaths = Object.freeze({
  report: "packages/bindings/generated/defold-script-handle-lowering.json",
  kindHeader: "defold/defold_hermes/include/defold_hermes/generated_script_handle_kinds.hpp",
  header: "defold/defold_hermes/include/defold_hermes/generated_script_handle_lowering.hpp",
  source: "defold/defold_hermes/src/generated_script_handle_lowering.cpp",
  typescript: "packages/sdk/src/generated/script/handle-lowering.ts",
});

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Named Defold build profiles can be observationally equal for this generated
 * router in a particular engine revision. Collapse detection to one stable
 * representative and keep feature-scoped handle capture only when every
 * equivalent profile agrees that the handle kind is capturable.
 */
export function assignRuntimeProfileEquivalence(runtimeProfiles, handleKinds) {
  const bySurface = new Map();
  for (const profile of runtimeProfiles) {
    const group = bySurface.get(profile.registrationSurfaceSha256) ?? [];
    group.push(profile);
    bySurface.set(profile.registrationSurfaceSha256, group);
  }
  const groups = [...bySurface.entries()]
    .map(([registrationSurfaceSha256, profiles]) => ({
      registrationSurfaceSha256,
      profiles: profiles.sort((left, right) => compareCodeUnits(left.id, right.id)),
    }))
    .sort((left, right) => compareCodeUnits(left.profiles[0].id, right.profiles[0].id));
  const collapsed = [];
  for (const group of groups) {
    const equivalentProfileIds = group.profiles.map(({ id }) => id);
    const equivalentProfileMask = group.profiles.reduce((mask, profile) => mask | profile.mask, 0);
    const canonicalProfileId = equivalentProfileIds[0];
    for (const profile of group.profiles) {
      profile.equivalentProfileIds = equivalentProfileIds;
      profile.equivalentProfileMask = equivalentProfileMask;
      profile.detectionCanonicalProfileId = canonicalProfileId;
      profile.detectionCanonicalProfileIndex = group.profiles[0].index;
    }
    if (group.profiles.length === 1) continue;
    const conservativelyUnavailableHandleKinds = [];
    for (const kind of handleKinds) {
      const availableInAll = group.profiles.every(({ mask }) => (kind.capturableProfileMask & mask) !== 0);
      if (availableInAll) continue;
      kind.capturableProfileMask &= ~equivalentProfileMask;
      kind.capturableProfiles = kind.capturableProfiles.filter((id) => !equivalentProfileIds.includes(id));
      conservativelyUnavailableHandleKinds.push(kind.id);
    }
    collapsed.push({
      registrationSurfaceSha256: group.registrationSurfaceSha256,
      canonicalProfileId,
      equivalentProfileIds,
      equivalentProfileMask,
      conservativelyUnavailableHandleKinds: conservativelyUnavailableHandleKinds.sort(compareCodeUnits),
      proof: "identical-exact-function-presence-vector",
      alert: "named-runtime-profiles-observationally-equivalent",
    });
  }
  return collapsed;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function indexRows(rows, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (!row?.id) throw new Error(`${label} contains a row without an id`);
    if (result.has(row.id)) throw new Error(`${label} contains duplicate route ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

function countBy(rows, select) {
  const counts = {};
  for (const row of rows) {
    const key = select(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareCodeUnits(left, right)));
}

// A reviewed count map. Fatal in an ordinary generation, reported in a declared
// derivation of another revision - see `expectReviewedCount`, which this defers
// to per key so the report names WHICH bucket moved rather than dumping two
// objects.
function compareCounts(actual, expected, label) {
  const sorted = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => compareCodeUnits(a, b)));
  if (JSON.stringify(actual) === JSON.stringify(sorted)) return;
  for (const key of [...new Set([...Object.keys(sorted), ...Object.keys(actual)])].sort(compareCodeUnits)) {
    expectReviewedCount({
      input: "packages/bindings/overrides/script-handle-lowering-policy.json",
      label: `${label}:${key}`,
      expected: sorted[key] ?? 0,
      observed: actual[key] ?? 0,
    });
  }
}

function walkShape(shape, visit) {
  visit(shape);
  if (shape.kind === "optional") walkShape(shape.value, visit);
  else if (shape.kind === "union") shape.variants.forEach((variant) => walkShape(variant, visit));
  else if (shape.kind === "sequence") walkShape(shape.element, visit);
  else if (shape.kind === "map") {
    walkShape(shape.key, visit);
    walkShape(shape.value, visit);
  } else if (shape.kind === "record") shape.fields.forEach(({ value }) => walkShape(value, visit));
  else if (shape.kind === "callback") {
    for (const parameter of shape.parameters ?? []) walkShape(parameter.value, visit);
    for (const result of shape.returns ?? []) walkShape(result, visit);
  } else if (shape.kind === "variadic") walkShape(shape.value, visit);
}

function exactShapeMask(shape, semanticKind) {
  if (shape.kind === "optional") return codecBits.nil | exactShapeMask(shape.value, semanticKind);
  if (shape.kind === "union")
    return shape.variants.reduce((mask, variant) => {
      const identityVariant =
        variant.kind === "handle" ||
        (variant.kind === "defold-value" &&
          ["node", "buffer_data", "buffer_stream", "constant_buffer", "render_target", "texture"].includes(
            variant.name,
          ));
      return mask | exactShapeMask(variant, identityVariant ? semanticKind : null);
    }, 0);
  if (semanticKind) return codecBits.handle;
  if (shape.kind === "enum") return codecBits.integer;
  if (shape.kind === "handle") return codecBits.handle;
  if (shape.kind === "scalar") {
    if (codecBits[shape.name] !== undefined) return codecBits[shape.name];
  }
  if (shape.kind === "defold-value") {
    const aliases = {
      "gui.PROP": "hash",
      node: "handle",
      buffer_data: "handle",
      buffer_stream: "handle",
      constant_buffer: "handle",
      render_target: "handle",
      texture: "handle",
    };
    const name = aliases[shape.name] ?? shape.name;
    if (codecBits[name] !== undefined) return codecBits[name];
  }
  throw new Error(`unsupported exact handle codec ${JSON.stringify(shape)}`);
}

function shapeKinds(shape) {
  const result = new Set();
  walkShape(shape, ({ kind }) => result.add(kind));
  return result;
}

function algebraicallySelected(row, classification, policy) {
  const selection = policy.selection;
  if (row.loweringFamily !== selection.loweringFamily) return false;
  if (!classification || selection.excludedOperationClasses.includes(classification.operationClass)) return false;
  if (
    row.signature.parameters.length > selection.maximumArguments ||
    row.signature.returns.length > selection.maximumResults
  )
    return false;
  if (selection.requiresFixedArity && row.effects.variadic.token !== "fixed-arity") return false;
  if (selection.requiresAcyclicValues && row.effects.recursive.token !== "acyclic-value-shape") return false;
  const allowed = new Set(selection.allowedValueConstructors);
  return [...row.signature.parameters, ...row.signature.returns].every(({ value }) =>
    [...shapeKinds(value)].every((kind) => allowed.has(kind)),
  );
}

function rawTypeTokens(rawType) {
  return String(rawType).match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
}

function semanticKindsForValue(value, rawType, rawTypeToKind) {
  const kinds = new Set();
  for (const token of rawTypeTokens(rawType)) {
    const kind = rawTypeToKind.get(token);
    if (kind) kinds.add(kind);
  }
  if (kinds.size > 1)
    throw new Error(`value ${rawType} maps to multiple semantic handle kinds: ${[...kinds].join(", ")}`);
  const [semanticKind = null] = kinds;
  const mask = exactShapeMask(value, semanticKind);
  return { mask, semanticKind };
}

function targetDisposition(row, target, policy) {
  if (row.availability.runtimeAvailable === false) return "profile-symbol-unavailable";
  const contextPolicy = policy.contexts[row.context.token];
  if (!contextPolicy) throw new Error(`unreviewed handle context ${row.context.token}`);
  if (contextPolicy.startsWith("blocked-")) return contextPolicy.slice("blocked-".length);
  return policy.targetBackends[target];
}

function nativeAdapterHarnessDisposition(row, policy) {
  if (row.availability.runtimeAvailable === false) return "profile-symbol-unavailable";
  const disposition = policy.nativeAdapterHarnessContexts?.[row.context.token];
  if (!disposition) throw new Error(`unreviewed native-adapter harness context ${row.context.token}`);
  return disposition;
}

// Telemetry contract shapes. Cost has to be attributable per contract, not only
// per route, so every route interns the exact codec signature it crosses with.
// The token is derived from the same generated codecs the transport uses, so it
// cannot drift from the call it describes.
const codecBitNames = Object.freeze(
  Object.entries(codecBits)
    .sort(([, left], [, right]) => left - right)
    .map(([name, bit]) => [bit, name]),
);

function codecShapeToken(codec) {
  if (codec.semanticKind) return `handle:${codec.semanticKind}`;
  const names = codecBitNames.filter(([bit]) => (codec.mask & bit) !== 0).map(([, name]) => name);
  return names.length ? names.join("|") : "none";
}

function contractShapeToken(arguments_, results) {
  const left = arguments_.map(codecShapeToken).join(",");
  const right = results.map(codecShapeToken).join(",");
  return `(${left})->(${right})`;
}

export function generateScriptHandleLowering(textInputs) {
  const parsed = Object.fromEntries(Object.entries(textInputs).map(([name, text]) => [name, parseJson(text, name)]));
  const { policy, projection, classification, availability } = parsed;
  if (
    projection.defoldRevision !== classification.defoldRevision ||
    projection.defoldRevision !== availability.defoldRevision
  ) {
    throw new Error("handle lowering inputs do not share one pinned Defold revision");
  }
  for (const row of projection.rows) {
    if (row.availability.catalogSha256 && row.availability.catalogSha256 !== availability.catalogSha256) {
      throw new Error(`${row.id} references a stale availability catalog`);
    }
  }
  const classificationById = indexRows(classification.rows, "borrowed-handle classification");
  const selected = projection.rows
    .filter((row) => algebraicallySelected(row, classificationById.get(row.id), policy))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  expectReviewedCount({
    input: "packages/bindings/overrides/script-handle-lowering-policy.json",
    label: "algebraic handle route census",
    expected: policy.selection.expectedRouteCount,
    observed: selected.length,
  });

  const handleKinds = semanticHandleKinds(classification).map((kind) => ({ ...kind, enumName: pascal(kind.id) }));
  const kindById = Object.fromEntries(handleKinds.map((kind) => [kind.id, kind]));
  const rawTypeToKind = new Map();
  for (const kind of handleKinds)
    for (const rawType of kind.rawTypes) {
      if (rawTypeToKind.has(rawType)) throw new Error(`semantic handle raw type ${rawType} is ambiguous`);
      rawTypeToKind.set(rawType, kind.id);
    }

  const runtimeProfiles = Object.entries(availability.profiles ?? {})
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([id, profile], index) => {
      const handshake = profile.runtimeHandshake;
      const sourceRouteSetSha256 = sha256(
        JSON.stringify((profile.availableRoutes ?? []).map(({ stableId }) => stableId)),
      );
      if (
        !handshake ||
        handshake.profileId !== id ||
        handshake.schema !== availability.handshakeContract?.schema ||
        handshake.defoldRevision !== projection.defoldRevision ||
        handshake.catalogSha256 !== availability.catalogSha256 ||
        handshake.routeCount !== profile.availableRouteCount ||
        handshake.routeSetSha256 !== sourceRouteSetSha256
      ) {
        throw new Error(`runtime profile ${id} has a stale or incomplete capability handshake`);
      }
      if (index >= 8) throw new Error("handle router supports at most eight runtime profiles");
      return {
        index,
        mask: 1 << index,
        id,
        schema: handshake.schema,
        defoldRevision: handshake.defoldRevision,
        capabilityBits: handshake.capabilityBits,
        sourceRouteCount: handshake.routeCount,
        routeSetSha256: handshake.routeSetSha256,
        catalogSha256: handshake.catalogSha256,
        adapterExecutableRouteCount: 0,
      };
    });
  if (runtimeProfiles.length !== 6)
    throw new Error(`expected six pinned runtime profiles, got ${runtimeProfiles.length}`);
  const runtimeProfileById = new Map(runtimeProfiles.map((profile) => [profile.id, profile]));
  const availableRouteIdsByProfile = new Map(
    Object.entries(availability.profiles).map(([id, profile]) => [
      id,
      new Set((profile.availableRoutes ?? []).map(({ id: routeId }) => routeId)),
    ]),
  );

  // Which runtime profiles root a handle kind as a generation-checked
  // identity. A kind whose representation is the same in every backend is
  // capturable everywhere; one the classification scopes per feature -
  // `box2d-world`, which Box2D v2 pushes as a light userdata - is capturable
  // only in the profiles that select a feature implementing it as a rooted
  // userdata. Without this the router discovers the difference at the Lua
  // stack, and can only describe it as the shape of the value it found.
  for (const kind of handleKinds) {
    if (!kind.representationIsFeatureScoped) {
      kind.capturableProfiles = runtimeProfiles.map(({ id }) => id);
      kind.capturableProfileMask = runtimeProfiles.reduce((mask, { mask: bit }) => mask | bit, 0);
      continue;
    }
    const capturable = new Set(kind.capturableFeatures ?? []);
    const uncapturable = new Set(kind.uncapturableFeatures ?? []);
    const profiles = runtimeProfiles.filter(({ id }) => {
      const features = availability.profiles[id]?.features ?? [];
      return (
        features.some((feature) => capturable.has(feature)) && !features.some((feature) => uncapturable.has(feature))
      );
    });
    kind.capturableProfiles = profiles.map(({ id }) => id);
    kind.capturableProfileMask = profiles.reduce((mask, { mask: bit }) => mask | bit, 0);
  }

  const argumentCodecs = [];
  const resultCodecs = [];
  const routes = selected.map((row, index) => {
    const classified = classificationById.get(row.id);
    const argumentOffset = argumentCodecs.length;
    const arguments_ = row.signature.parameters.map(({ value, sourceType, optional }) => {
      const codec = semanticKindsForValue(value, sourceType, rawTypeToKind);
      return { ...codec, mask: codec.mask | (optional ? codecBits.nil : 0) };
    });
    const requiredArgumentCount = row.signature.parameters.reduce(
      (count, parameter, index) => (parameter.optional ? count : index + 1),
      0,
    );
    const results = row.signature.returns.map(({ value, sourceType }) =>
      semanticKindsForValue(value, sourceType, rawTypeToKind),
    );
    argumentCodecs.push(...arguments_);
    resultCodecs.push(...results);
    const discoveredInputKinds = [
      ...new Set(arguments_.map(({ semanticKind }) => semanticKind).filter(Boolean)),
    ].sort();
    const discoveredReturnKinds = [...new Set(results.map(({ semanticKind }) => semanticKind).filter(Boolean))].sort();
    if (JSON.stringify(discoveredInputKinds) !== JSON.stringify([...classified.inputHandleKinds].sort())) {
      throw new Error(`${row.id} input semantic handle kinds drifted`);
    }
    if (JSON.stringify(discoveredReturnKinds) !== JSON.stringify([...classified.returnHandleKinds].sort())) {
      throw new Error(`${row.id} return semantic handle kinds drifted`);
    }
    const expectedInvalidation = {
      "checked-handle-input-terminal": null,
      "checked-handle-return-capture": null,
      "checked-self-engine-object-invalidate": "self-underlying",
      "checked-child-engine-object-invalidate": "child-index",
    }[classified.operationClass];
    if (expectedInvalidation === undefined || (classified.invalidatedIdentity ?? null) !== expectedInvalidation) {
      throw new Error(`${row.id} operation-class invalidation semantics drifted`);
    }
    if (expectedInvalidation && classified.hostHandleEffect !== "preserve") {
      throw new Error(`${row.id} invalidator must preserve the host wrapper`);
    }
    const targets = {
      nativeDynamicHermes: targetDisposition(row, "nativeDynamicHermes", policy),
      nativeStaticHermes: targetDisposition(row, "nativeStaticHermes", policy),
      html5BrowserHost: targetDisposition(row, "html5BrowserHost", policy),
    };
    const harnessDisposition = nativeAdapterHarnessDisposition(row, policy);
    const blocked = harnessDisposition !== "router-candidate";
    const registrationProfileIds = [
      ...(row.availability.runtimeProfiles ??
        (row.availability.runtimeAvailable !== false && row.availability.token === "core"
          ? runtimeProfiles.map(({ id }) => id)
          : [])),
    ].sort();
    let registrationMask = 0;
    for (const profileId of registrationProfileIds) {
      const profile = runtimeProfileById.get(profileId);
      if (!profile) throw new Error(`${row.id} references unknown runtime profile ${profileId}`);
      if (row.availability.token !== "core" && !availableRouteIdsByProfile.get(profileId)?.has(row.id)) {
        throw new Error(`${row.id} runtime profile ${profileId} disagrees with the source-derived route set`);
      }
      registrationMask |= profile.mask;
    }
    const semanticKinds = [...new Set([...discoveredInputKinds, ...discoveredReturnKinds])];
    const runtimeProfileIds = registrationProfileIds.filter((profileId) => {
      const profile = runtimeProfileById.get(profileId);
      return semanticKinds.every((kind) => (kindById[kind].capturableProfileMask & profile.mask) !== 0);
    });
    let runtimeMask = 0;
    for (const profileId of runtimeProfileIds) {
      const profile = runtimeProfileById.get(profileId);
      runtimeMask |= profile.mask;
    }
    for (const profile of runtimeProfiles) {
      const catalogAvailable = availableRouteIdsByProfile.get(profile.id)?.has(row.id) === true;
      const capturable = semanticKinds.every((kind) => (kindById[kind].capturableProfileMask & profile.mask) !== 0);
      if (
        row.availability.token !== "core" &&
        (catalogAvailable && capturable) !== runtimeProfileIds.includes(profile.id)
      ) {
        throw new Error(`${row.id} source-derived runtime profile membership drifted for ${profile.id}`);
      }
    }
    return {
      index,
      id: row.id,
      stableId: row.stableId,
      contractShape: contractShapeToken(arguments_, results),
      modulePath: row.modulePath,
      member: row.member,
      operationClass: classified.operationClass,
      context: classified.requiredContext,
      inputKinds: discoveredInputKinds,
      returnKinds: discoveredReturnKinds,
      hostHandleEffect: classified.hostHandleEffect,
      operationEffect: policy.operationClasses[classified.operationClass],
      invalidation: classified.invalidatedIdentity ?? "none",
      ownership: {
        projectionToken: row.effects.ownership.token,
        hostWrapper: "generation-checked-lua-registry-root",
        underlying: "semantic-handle-kind-policy",
      },
      lifetime: {
        projectionToken: row.effects.lifetime.token,
        loweringToken: "semantic-handle-kind-policy",
      },
      callback: row.effects.callback,
      variadic: row.effects.variadic,
      recursive: row.effects.recursive,
      profiles: {
        token: row.availability.token,
        catalogSha256: row.availability.catalogSha256 ?? null,
        documentedFeatures: row.availability.documentedFeatures ?? row.availability.allOf ?? [],
        runtimeFeatures: row.availability.runtimeFeatures ?? row.availability.allOf ?? [],
        documented: row.availability.documentedProfiles ?? [],
        registration: registrationProfileIds,
        registrationMask,
        runtime: runtimeProfileIds,
        runtimeAvailable: row.availability.runtimeAvailable !== false,
        runtimeMask,
      },
      argumentOffset,
      requiredArgumentCount,
      argumentCount: arguments_.length,
      resultOffset: resultCodecs.length - results.length,
      resultCount: results.length,
      targets,
      generation: {
        descriptor: "emitted",
        router: blocked ? "blocked" : "emitted",
      },
      evidence: {
        nativeAdapterHarness: blocked ? "blocked-disposition-covered" : "covered-by-all-route-descriptor-loop",
        defoldEngineBehavior: "unverified",
        nativeDynamicHermesJsi: "unverified",
        nativeStaticHermes: "unverified",
        html5BrowserHost: "unverified",
        allocationPerRoute: "unverified",
      },
    };
  });

  const contractShapes = [...new Set(routes.map(({ contractShape }) => contractShape))].sort(compareCodeUnits);
  const contractShapeIndexByToken = new Map(contractShapes.map((token, index) => [token, index]));
  for (const route of routes) route.contractShapeIndex = contractShapeIndexByToken.get(route.contractShape);
  if (contractShapes.length > 0xffff) throw new Error("telemetry contract shape ids exceed the packed field");

  const operationClassCounts = countBy(routes, ({ operationClass }) => operationClass);
  const contextCounts = countBy(routes, ({ context }) => context);
  compareCounts(operationClassCounts, policy.expected.operationClassCounts, "handle operation classes");
  compareCounts(contextCounts, policy.expected.contextCounts, "handle contexts");
  const blocked = routes.filter(({ generation }) => generation.router === "blocked").length;
  const routerCandidates = routes.length - blocked;
  const runtimeUnavailable = routes.filter(({ profiles }) => !profiles.runtimeAvailable).length;
  for (const [label, expected, observed] of [
    ["handle lowering blocked", policy.expected.blockedCount, blocked],
    ["handle lowering router candidates", policy.expected.routerCandidateCount, routerCandidates],
    ["handle lowering runtime-unavailable", policy.expected.runtimeUnavailableCount, runtimeUnavailable],
  ])
    expectReviewedCount({
      input: "packages/bindings/overrides/script-handle-lowering-policy.json",
      label,
      expected,
      observed,
    });
  for (const profile of runtimeProfiles) {
    profile.adapterExecutableRouteCount = routes.filter(
      (route) => route.generation.router === "emitted" && (route.profiles.runtimeMask & profile.mask) !== 0,
    ).length;
    const surface = routes
      .filter((route) => route.generation.router === "emitted")
      .map((route) => ((route.profiles.runtimeMask & profile.mask) !== 0 ? "1" : "0"))
      .join("");
    profile.adapterSurfaceSha256 = sha256(surface);
    const registrationSurface = routes
      .filter((route) => route.generation.router === "emitted")
      .map((route) => ((route.profiles.registrationMask & profile.mask) !== 0 ? "1" : "0"))
      .join("");
    profile.registrationSurfaceSha256 = sha256(registrationSurface);
  }
  const runtimeProfileEquivalence = assignRuntimeProfileEquivalence(runtimeProfiles, handleKinds);
  const executableSymbols = routes
    .filter((route) => route.generation.router === "emitted")
    .map((route) => `${route.modulePath.join(".")}.${route.member}`);
  if (new Set(executableSymbols).size !== executableSymbols.length) {
    throw new Error("runtime profile detection requires unique executable Lua symbols");
  }

  const report = {
    schemaVersion: 2,
    defoldRevision: projection.defoldRevision,
    scope:
      "Algebra-selected borrowed-handle captured-Lua router. Generated dispositions describe code paths; per-route evidence remains separate and no Defold-engine semantic behavior is inferred from adapter tests.",
    selection: policy.selection,
    inputEvidence: {
      paths: inputPaths,
      hashes: Object.fromEntries(Object.entries(textInputs).map(([name, text]) => [name, sha256(text)])),
      availabilityCatalogSha256: availability.catalogSha256,
    },
    coverage: {
      selectedRoutes: routes.length,
      descriptorRowsEmitted: routes.length,
      routerCandidates,
      blocked,
      adapterExecutableRoutes: routerCandidates,
      nativeAdapterHarnessRoutes: routerCandidates,
      defoldEngineVerifiedRoutes: 0,
      nativeDynamicHermesJsiVerifiedRoutes: 0,
      nativeStaticHermesExecutableRoutes: 0,
      html5BrowserExecutableRoutes: 0,
      runtimeUnavailable,
      adapterExecutableRoutesByProfile: Object.fromEntries(
        runtimeProfiles.map((profile) => [profile.id, profile.adapterExecutableRouteCount]),
      ),
    },
    operationClassCounts,
    contextCounts,
    attachmentProviders: {
      "*.ts": { proxyExtension: null, context: "runtime-global", state: "context-free" },
      "*.script.ts": { proxyExtension: ".script", context: "game-object-instance", state: "generated-proxy-provider" },
      "*.gui.ts": { proxyExtension: ".gui_script", context: "gui-scene", state: "provider-required-unimplemented" },
      "*.render.ts": {
        proxyExtension: ".render_script",
        context: "render-script-instance-and-graphics-context",
        state: "provider-required-unimplemented",
      },
    },
    nativeAdapterHarnessContexts: {
      gameObject: "captured-and-selected",
      gui: "captured-and-selected-test-fixture-only",
      render: "captured-and-selected-test-fixture-only",
    },
    runtimeProfileDetection: {
      authority: "generated-lua-registration-surface",
      strategy: "exact-function-presence-vector",
      routeCount: routerCandidates,
      lookup: "protected-raw-table-traversal-no-metamethods",
      initialization: "lazy-first-bootstrap-attach",
      nativeLuaHarness: "six-exact-profiles-and-negative-vectors-covered",
      packagedDefoldEngine: "unverified",
      nativeDynamicHermesJsi: "unverified",
      nativeStaticHermes: "unverified",
      html5BrowserHost: "unverified",
    },
    operationEffects: policy.operationClasses,
    handleKindCount: handleKinds.length,
    handleKinds,
    kindById,
    contractShapeCount: contractShapes.length,
    contractShapes,
    argumentCodecCount: argumentCodecs.length,
    resultCodecCount: resultCodecs.length,
    argumentCodecs,
    resultCodecs,
    runtimeProfiles,
    runtimeProfileEquivalence,
    routes,
  };
  report.semanticPolicyHoles = {
    projectionLifetimePolicyUnresolved: routes.filter(({ lifetime }) =>
      lifetime.projectionToken.endsWith("-unresolved"),
    ).length,
    executableAdapterUnimplemented: 0,
    guiAttachmentUnavailable: routes.filter(({ context }) => context === "gui-scene").length,
    renderAttachmentUnavailable: routes.filter(
      ({ context }) => context === "render-script-instance-and-graphics-context",
    ).length,
    profileSymbolUnavailable: runtimeUnavailable,
  };
  report.generated = {
    report: `${JSON.stringify({ routeCount: routes.length, hash: sha256(JSON.stringify(routes)) })}`,
    artifacts: Object.values(outputPaths),
  };
  return report;
}

export async function loadInputs(root = repositoryRoot) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(inputPaths).map(async ([name, path]) => [name, await readFile(resolve(root, path), "utf8")]),
    ),
  );
}

export function renderArtifacts(report) {
  const jsonReport = structuredClone(report);
  delete jsonReport.kindById;
  return {
    report: `${JSON.stringify(jsonReport, null, 2)}\n`,
    ...renderScriptHandleLoweringArtifacts(report),
  };
}

export async function run(argv = process.argv.slice(2), root = repositoryRoot) {
  const check = argv.includes("--check");
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const report = generateScriptHandleLowering(await loadInputs(root));
  const artifacts = renderArtifacts(report);
  for (const [name, content] of Object.entries(artifacts)) {
    const path = resolve(root, outputPaths[name]);
    if (check) {
      if ((await readFile(path, "utf8")) !== content) throw new Error(`${outputPaths[name]} is stale`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  process.stdout.write(
    `${check ? "Verified" : "Generated"} ${report.coverage.descriptorRowsEmitted} handle descriptors: ${report.coverage.adapterExecutableRoutes} adapter-executable/harness-covered, ${report.coverage.blocked} blocked; JSI/engine/Static/browser runtime evidence remains unverified.\n`,
  );
  if (report.runtimeProfileEquivalence.length > 0) {
    process.stderr.write(
      `warning: ${report.runtimeProfileEquivalence.length} runtime profile equivalence class(es) share an identical exact-function-presence vector; deterministic conservative representatives emitted: ${report.runtimeProfileEquivalence.map(({ equivalentProfileIds }) => equivalentProfileIds.join("=")).join(", ")}\n`,
    );
  }
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
