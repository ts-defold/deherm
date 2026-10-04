#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { declaredDerivation, expectReviewedCount, observeReviewedSource } from "./lib/reviewed-revision.mjs";
import { MOVED, VOID, recordAudit } from "./lib/revision-audit.mjs";
import {
  createScriptValueBindingRecipeFacts,
  renderScriptValueBindingOutputs,
} from "../packages/compiler/src/script-value-binding-output-emitter.mjs";
import {
  ADDRESSED_TRANSFORM_BACKEND,
  SpecializationEvidenceDrift,
  cartesian,
  equal,
  factoryImplementedCallShapes,
  functionSource,
  operationTemplateVocabulary,
  split,
  validateOperation,
} from "../packages/compiler/src/script-value-binding-operation-templates.mjs";
import {
  guiNodeUserdataCapability,
  parseCanonicalLuaRegistrationSurface,
  registeredRouteCapability,
  structuredLuaReplayCapability,
} from "./lib/defold-lua-structural-capabilities.mjs";

const root = new URL("../", import.meta.url);
const irUrl = new URL("packages/bindings/generated/defold-script-api-ir.json", root);
const scalarDispatchUrl = new URL("packages/bindings/generated/defold-script-scalar-dispatch.json", root);
const patternsUrl = new URL("packages/bindings/generated/defold-script-binding-patterns.json", root);
const definitionUrls = [
  new URL("packages/bindings/overrides/script-defold-value-bindings.json", root),
  new URL("packages/bindings/overrides/script-defold-handle-bindings.json", root),
  new URL("packages/bindings/overrides/script-go-current-instance-bindings.json", root),
  new URL("packages/bindings/overrides/script-msg-structured-bindings.json", root),
  new URL("packages/bindings/overrides/script-factory-structured-bindings.json", root),
  new URL("packages/bindings/overrides/script-gui-structured-bindings.json", root),
];
const reportUrl = new URL("packages/bindings/generated/defold-script-value-bindings.json", root);
const headerUrl = new URL("defold/defold_hermes/include/defold_hermes/generated_script_value_bindings.hpp", root);
const sourceUrl = new URL("defold/defold_hermes/src/generated_script_value_bindings.cpp", root);
const targetSupportUrl = new URL("packages/sdk/src/generated/script/value-target-support.ts", root);
const registrationSurfaceUrl = new URL("packages/bindings/generated/defold-lua-registration-surface.json", root);

const CODECS = new Set([
  "Nil",
  "Boolean",
  "Number",
  "String",
  "Hash",
  "Url",
  "Vector3",
  "Vector4",
  "Quaternion",
  "Matrix4",
  "Table",
  "Node",
  "AddressArray",
]);
const codecForType = new Map([
  ["number", "Number"],
  ["string", "String"],
  ["hash", "Hash"],
  ["url", "Url"],
  ["vector3", "Vector3"],
  ["vector4", "Vector4"],
  ["quaternion", "Quaternion"],
  ["matrix4", "Matrix4"],
  ["nil", "Nil"],
  ["boolean", "Boolean"],
  ["table<any, any>", "Table"],
  ["table<string|hash, any>", "Table"],
  ["node", "Node"],
  ["(string|hash|url)[]", "AddressArray"],
]);

function parameterTypes(signature) {
  const match = signature.match(/^fun\((.*)\):/);
  if (!match) throw new Error(`Unsupported overload signature ${signature}`);
  if (!match[1].trim()) return [];
  return split(match[1], ",").map((parameter) => parameter.slice(parameter.indexOf(":") + 1).trim());
}

function deriveCallShapes(fn, codecOverrides = new Map()) {
  const genericConstraints = new Map(
    fn.generics.map((generic) => {
      const separator = generic.indexOf(":");
      return [generic.slice(0, separator).trim(), split(generic.slice(separator + 1))];
    }),
  );
  const primary = fn.parameters.map(({ rawType }) => rawType);
  let requiredCount = fn.parameters.length;
  while (requiredCount > 0 && fn.parameters[requiredCount - 1].optional) requiredCount -= 1;
  const primarySignatures = [];
  for (let count = requiredCount; count <= primary.length; ++count) primarySignatures.push(primary.slice(0, count));
  const signatures = [...primarySignatures, ...fn.overloads.map(parameterTypes)];
  const shapes = signatures.flatMap((parameters) =>
    cartesian(
      parameters.map((rawType) => {
        const types = genericConstraints.get(rawType) ?? split(rawType);
        return types.map((type) => {
          const codec = codecOverrides.get(type) ?? codecForType.get(type);
          if (!codec) throw new Error(`${fn.id}: unsupported value type ${type}`);
          return codec;
        });
      }),
    ),
  );
  const unique = new Map(shapes.map((shape) => [JSON.stringify(shape), shape]));
  return [...unique.values()];
}

function canonicalRegistrationCapability(surface, fn, expectedSourcePath) {
  const routeName = fn.modulePath.length ? [...fn.modulePath, fn.member].join(".") : fn.member;
  const capability = registeredRouteCapability(surface, routeName, expectedSourcePath.replace(/^engine\//, ""));
  return capability ? { symbol: capability.cFunction, capability } : null;
}

// A reviewed claim this revision no longer bears out.
//
// At the reviewed revision every one of these is a regression in this tree and
// stays fatal, with the message it always had. Deriving another revision, the
// evidence the review rested on is simply not there - `script_vmath.cpp` was
// rewritten, a registration moved - so the entry is WITHDRAWN for this revision
// and reported by name as queued review work, which is what a per-revision
// policy store is for.
function withdrawReviewed(id, reason, message) {
  if (!declaredDerivation()) throw new Error(message);
  recordAudit({
    input: "packages/bindings/overrides/defold-value-layouts.json",
    id,
    status: VOID,
    reason,
    detail: message,
  });
  return false;
}

function withdrawSpecializationDrift(id, error) {
  if (!(error instanceof SpecializationEvidenceDrift)) throw error;
  withdrawReviewed(id, "stale-specialization-evidence", error.message);
  return [];
}

// `deriveCallShapes` for a route whose documented signature this revision spells
// in a way the generator cannot read - Defold 1.13.1 documents overloads as
// `fun(n)`, with neither parameter types nor a result, where the pinned revision
// writes `fun(v: vector3): number`. Without types there are no call shapes, so
// there is nothing to emit; the route is withdrawn and reported. Outside a
// declared derivation `withdrawReviewed` rethrows the original message, so an
// ordinary generation still fails exactly as before.
function reviewedCallShapes(fn, codecOverrides = new Map()) {
  try {
    return deriveCallShapes(fn, codecOverrides);
  } catch (error) {
    withdrawReviewed(fn.id, "unreadable-signature", error.message);
    return null;
  }
}

// Whether a documented route belongs to the definition being expanded.
//
// `irSource` names the file in the reference archive the reviewer read. That
// file name is a property of how the archive is PACKAGED, not of the engine's
// API: Defold 1.13.1 ships one documentation file per C++ translation unit
// (`doc/src-script_vmath.cpp_doc.lua`) where the pinned revision ships one per
// module (`doc/vmath.lua`). Holding the reviewed file name against another
// revision withdrew every value binding in the tree over a repackaging.
//
// So when a declared derivation finds that this revision's IR has no such file
// at all, the layout moved and the scope falls back to the route identity,
// which already carries the module (`script:vmath.vector3`) and is unique in
// the IR. Every selector that uses this also matches on `modulePath`, so the
// scope is not widened. When the file IS present - every ordinary generation -
// the exact comparison runs unchanged.
function inDefinitionSource(fn, definition, layoutMoved) {
  return layoutMoved ? true : fn.source === definition.irSource;
}

function expandDefinitionBindings(definition, functions, patterns, source, surface, layoutMoved) {
  const expanded = [...(definition.bindings ?? [])];
  for (const family of definition.families ?? []) {
    const selector = family?.selector;
    if (family?.id === "gui-node-setters") {
      if (
        !selector ||
        !equal(selector.modulePath, ["gui"]) ||
        selector.memberPrefix !== "set_" ||
        selector.firstParameterType !== "node" ||
        selector.resultCount !== 0 ||
        !equal(selector.excludedIds, ["script:gui.set_text"]) ||
        selector.expectedRouteCount !== 39 ||
        !selector.typeCodecs ||
        family.operation?.template !== "gui-node-setter"
      ) {
        throw new Error("gui-node-setters family metadata is not the reviewed finite selector");
      }
      const codecOverrides = new Map(Object.entries(selector.typeCodecs));
      if ([...codecOverrides.values()].some((codec) => !CODECS.has(codec))) {
        throw new Error("gui-node-setters family contains an unsupported codec mapping");
      }
      const selected = [...functions.values()].filter(
        (fn) =>
          inDefinitionSource(fn, definition, layoutMoved) &&
          equal(fn.modulePath, selector.modulePath) &&
          !selector.excludedIds.includes(fn.id) &&
          fn.member.startsWith(selector.memberPrefix) &&
          fn.parameters[0]?.rawType === selector.firstParameterType &&
          fn.returns.length === selector.resultCount &&
          fn.parameters.every(({ rawType }) => split(rawType).every((type) => codecOverrides.has(type))),
      );
      // The reviewed count is evidence at the revision it was counted at and an
      // observation anywhere else: a revision with a different number of gui
      // node setters is the measurement this derivation exists to take.
      expectReviewedCount({
        input: "packages/bindings/overrides/script-gui-structured-bindings.json",
        label: "gui-node-setters route census",
        expected: selector.expectedRouteCount,
        observed: selected.length,
      });
      for (const fn of selected) {
        const registration = canonicalRegistrationCapability(surface, fn, definition.source);
        if (!registration) {
          withdrawReviewed(fn.id, "absent-registration", `${fn.id}: no pinned Gui_methods registration was found`);
          continue;
        }
        const callShapes = reviewedCallShapes(fn, codecOverrides);
        if (!callShapes) continue;
        expanded.push({
          id: fn.id,
          sourceSymbol: registration.symbol,
          structuralCapabilities: { registration: registration.capability },
          operation: family.operation,
          callShapes,
          implementedCallShapes: callShapes,
          resultCodec: "None",
          generatedFamily: family.id,
          familyTypeCodecs: Object.fromEntries(codecOverrides),
        });
      }
      continue;
    }
    if (family?.id === "vmath-fixed-pod") {
      const allowedTypes = ["number", "vector3", "vector4", "quaternion"];
      const excludedIds = [
        "script:vmath.length",
        "script:vmath.normalize",
        "script:vmath.quat",
        "script:vmath.quat_rotation_z",
        "script:vmath.vector3",
      ];
      if (
        !selector ||
        !equal(selector.modulePath, ["vmath"]) ||
        selector.loweringFamily !== "defold-value" ||
        !equal(selector.allowedTypes, allowedTypes) ||
        !equal(selector.excludedIds, excludedIds) ||
        selector.expectedRouteCount !== 11 ||
        !Array.isArray(selector.terminalOperations) ||
        selector.terminalOperations.length !== 11 ||
        family.operation?.template !== "vmath-fixed-pod" ||
        !equal(family.operation.parameters, {
          rejectNaNDefoldInputs: true,
          numberNarrowing: "lua-number-to-float32",
          normalization: "none",
        })
      ) {
        throw new Error("vmath-fixed-pod family metadata is not the reviewed finite selector");
      }
      const allowed = new Set(allowedTypes);
      const selected = [...functions.values()].filter((fn) => {
        const pattern = patterns.get(fn.id);
        return (
          inDefinitionSource(fn, definition, layoutMoved) &&
          equal(fn.modulePath, selector.modulePath) &&
          pattern?.loweringFamily === selector.loweringFamily &&
          !selector.excludedIds.includes(fn.id) &&
          fn.parameters.every(({ rawType }) => split(rawType).every((type) => allowed.has(type))) &&
          fn.returns.length === 1 &&
          fn.returns.every((type) => allowed.has(type))
        );
      });
      expectReviewedCount({
        input: "packages/bindings/overrides/script-defold-value-bindings.json",
        label: "vmath-fixed-pod route census",
        expected: selector.expectedRouteCount,
        observed: selected.length,
      });
      const seenOperators = new Set();
      for (const fn of selected) {
        const registration = canonicalRegistrationCapability(surface, fn, definition.source);
        if (!registration) {
          if (
            withdrawReviewed(fn.id, "absent-registration", `${fn.id}: no pinned vmath methods registration was found`)
          )
            continue;
          continue;
        }
        let body;
        try {
          body = functionSource(source, registration.symbol, fn.id);
        } catch (error) {
          withdrawSpecializationDrift(fn.id, error);
          continue;
        }
        const matches = selector.terminalOperations.filter(
          ({ sourceAnchor }) => typeof sourceAnchor === "string" && body.includes(sourceAnchor),
        );
        if (matches.length !== 1) {
          withdrawReviewed(
            fn.id,
            "stale-terminal-anchor",
            `${fn.id}: expected exactly one reviewed vmath terminal operation, found ${matches.length}`,
          );
          continue;
        }
        const terminal = matches[0];
        if (
          typeof terminal.operator !== "string" ||
          seenOperators.has(terminal.operator) ||
          !Array.isArray(terminal.implementedCallShapes) ||
          typeof terminal.resultCodec !== "string" ||
          !terminal.probe ||
          typeof terminal.probe.key !== "string" ||
          !Array.isArray(terminal.probe.arguments) ||
          !terminal.probe.expectation
        ) {
          throw new Error(`${fn.id}: invalid or duplicate reviewed vmath terminal operation`);
        }
        const callShapes = reviewedCallShapes(fn);
        if (!callShapes) continue;
        seenOperators.add(terminal.operator);
        expanded.push({
          id: fn.id,
          sourceSymbol: registration.symbol,
          sourceOperation: [terminal.sourceAnchor],
          structuralCapabilities: { registration: registration.capability },
          operation: {
            template: family.operation.template,
            parameters: { ...family.operation.parameters, operator: terminal.operator },
          },
          callShapes,
          implementedCallShapes: terminal.implementedCallShapes,
          resultCodec: terminal.resultCodec,
          generatedFamily: family.id,
          generatedProbe: terminal.probe,
        });
      }
      // One operator per selected route is structural and stays exact; how many
      // of the reviewed terminals a revision still registers is a census.
      expectReviewedCount({
        input: "packages/bindings/overrides/script-defold-value-bindings.json",
        label: "vmath-fixed-pod terminal-operation census",
        expected: selector.terminalOperations.length,
        observed: seenOperators.size,
      });
      continue;
    }
    if (family?.id === "vmath-matrix4") {
      const allowedTypes = ["number", "vector3", "vector4", "quaternion", "matrix4"];
      if (
        !selector ||
        !equal(selector.modulePath, ["vmath"]) ||
        selector.loweringFamily !== "defold-value" ||
        !equal(selector.allowedTypes, allowedTypes) ||
        !equal(
          selector.requiredIds,
          selector.terminalOperations?.map(({ id }) => id),
        ) ||
        selector.expectedRouteCount !== 14 ||
        selector.expectedCallShapeCount !== 16 ||
        !Array.isArray(selector.terminalOperations) ||
        selector.terminalOperations.length !== 14 ||
        family.operation?.template !== "vmath-matrix4" ||
        !equal(family.operation.parameters, {
          layout: "column-major-16-float32",
          storage: "generation-checked-frame-arena",
          rejectNaNDefoldInputs: true,
          numberNarrowing: "lua-number-to-float32",
          normalization: "none",
        })
      ) {
        throw new Error("vmath-matrix4 family metadata is not the reviewed finite selector");
      }
      const required = new Set(selector.requiredIds);
      const allowed = new Set(allowedTypes);
      const selected = [...functions.values()].filter(
        (fn) =>
          required.has(fn.id) &&
          inDefinitionSource(fn, definition, layoutMoved) &&
          equal(fn.modulePath, selector.modulePath) &&
          patterns.get(fn.id)?.loweringFamily === selector.loweringFamily &&
          fn.parameters.every(({ rawType }) => split(rawType).every((type) => allowed.has(type))) &&
          fn.returns.length === 1 &&
          fn.returns.every((type) => allowed.has(type)),
      );
      // Two counts, reported separately so a derivation says which one moved
      // rather than "no longer resolves the reviewed 14 routes / 16 call shapes".
      expectReviewedCount({
        input: "packages/bindings/overrides/script-defold-value-bindings.json",
        label: "vmath-matrix4 route census",
        expected: selector.expectedRouteCount,
        observed: selected.length,
      });
      expectReviewedCount({
        input: "packages/bindings/overrides/script-defold-value-bindings.json",
        label: "vmath-matrix4 call-shape census",
        expected: selector.expectedCallShapeCount,
        observed: selected.reduce((count, fn) => count + (reviewedCallShapes(fn)?.length ?? 0), 0),
      });
      const terminals = new Map(selector.terminalOperations.map((entry) => [entry.id, entry]));
      if (terminals.size !== selector.terminalOperations.length) {
        throw new Error("vmath-matrix4 terminal IDs must be unique");
      }
      for (const fn of selected) {
        const terminal = terminals.get(fn.id);
        const registration = canonicalRegistrationCapability(surface, fn, definition.source);
        if (!terminal || !registration) {
          withdrawReviewed(fn.id, "absent-registration", `${fn.id}: no reviewed Matrix4 terminal or registration`);
          continue;
        }
        let body;
        try {
          body = functionSource(source, registration.symbol, fn.id);
        } catch (error) {
          withdrawSpecializationDrift(fn.id, error);
          continue;
        }
        if (
          typeof terminal.operator !== "string" ||
          typeof terminal.sourceAnchor !== "string" ||
          !body.includes(terminal.sourceAnchor) ||
          !Array.isArray(terminal.implementedCallShapes) ||
          typeof terminal.resultCodec !== "string" ||
          !terminal.probe
        ) {
          withdrawReviewed(
            fn.id,
            "stale-terminal-anchor",
            `${fn.id}: invalid or stale reviewed Matrix4 terminal operation`,
          );
          continue;
        }
        const callShapes = reviewedCallShapes(fn);
        if (!callShapes) continue;
        expanded.push({
          id: fn.id,
          sourceSymbol: registration.symbol,
          sourceOperation: [terminal.sourceAnchor, ...(terminal.extraSourceAnchors ?? [])],
          structuralCapabilities: { registration: registration.capability },
          operation: {
            template: family.operation.template,
            parameters: { ...family.operation.parameters, operator: terminal.operator },
          },
          callShapes,
          implementedCallShapes: terminal.implementedCallShapes,
          resultCodec: terminal.resultCodec,
          generatedFamily: family.id,
          generatedProbe: terminal.probe,
        });
      }
      continue;
    }
    throw new Error(`Unknown generated value family: ${family?.id}`);
  }
  return expanded;
}

function isIrCompatibleShape(fn, shape) {
  let requiredCount = fn.parameters.length;
  while (requiredCount > 0 && fn.parameters[requiredCount - 1].optional) requiredCount -= 1;
  if (shape.length < requiredCount || shape.length > fn.parameters.length) return false;
  return shape.every((codec, index) => {
    const parameter = fn.parameters[index];
    if (codec === "Nil") return parameter.optional;
    return split(parameter.rawType).some((rawType) => codecForType.get(rawType) === codec);
  });
}

function deriveResultCodec(fn) {
  if (fn.returns.length === 0) return "None";
  if (fn.returns.length !== 1) throw new Error(`${fn.id}: value binding must return zero or one value`);
  const rawType = fn.returns[0];
  const generic = fn.generics.find((entry) => entry.slice(0, entry.indexOf(":")) === rawType);
  if (generic) {
    const types = split(generic.slice(generic.indexOf(":") + 1));
    const codecs = types.map((type) => codecForType.get(type));
    if (codecs.every((codec) => ["Vector3", "Vector4", "Quaternion"].includes(codec))) return "SameDefoldValue";
    throw new Error(`${fn.id}: unsupported generic value result ${rawType}`);
  }
  const codec = codecForType.get(rawType);
  if (!codec) throw new Error(`${fn.id}: unsupported value result ${rawType}`);
  return codec;
}

function targetSupport(binding) {
  const nativeBackend =
    binding.operation.parameters.backend === "captured-lua"
      ? "generated-captured-lua"
      : // Addressed transform shapes keep the current-instance form on the direct
        // native path and re-enter the pinned Lua route only to resolve an address.
        binding.operation.parameters.addressed === ADDRESSED_TRANSFORM_BACKEND
        ? "generated-native-pod-with-addressed-captured-lua"
        : "generated-native-pod";
  const browserPrimitive = binding.operation.template === "hash-string";
  // This family's specialized lane is a native POD/captured-Lua path, so only
  // the primitive template has a direct Emscripten C ABI. The route itself is
  // still reachable in the browser: `callScriptApi` dispatches one stable ID
  // through the generated universal direct-memory provider, which selects the
  // optimized lane only where it exists. Availability therefore belongs to the
  // universal transport, which owns its own machine-derived browser gate.
  return {
    arm64DynamicHermes: {
      status: "generated-executable",
      backend: nativeBackend,
      evidence: "native-focused-test-not-packaged-engine-proof",
    },
    html5BrowserHost: browserPrimitive
      ? { status: "generated-executable", backend: "emscripten-primitive-c-abi" }
      : {
          status: "generated-executable",
          backend: "universal-direct-memory-transport",
          reason: "specialized-native-pod-lane-is-native-only-route-executes-through-the-universal-browser-provider",
        },
  };
}

export function generate(irText, scalarDispatchText, patternsText, inputs) {
  const ir = JSON.parse(irText);
  const scalarDispatch = JSON.parse(scalarDispatchText);
  const patternsReport = JSON.parse(patternsText);
  const irSha256 = createHash("sha256").update(irText).digest("hex");
  if (
    patternsReport.schemaVersion !== 1 ||
    patternsReport.sourceSha256 !== irSha256 ||
    !Array.isArray(patternsReport.bindings)
  ) {
    throw new Error("Binding patterns are stale against pinned script IR");
  }
  const patterns = new Map();
  for (const pattern of patternsReport.bindings) {
    if (typeof pattern.id !== "string" || patterns.has(pattern.id)) {
      throw new Error(`Binding patterns contain an invalid or duplicate id: ${pattern.id}`);
    }
    patterns.set(pattern.id, pattern);
  }
  const scalarStableIds = new Map();
  for (const binding of scalarDispatch.bindings) {
    if (!Number.isInteger(binding.stableId)) throw new Error(`${binding.id}: scalar dispatch stable ID is invalid`);
    const collision = scalarStableIds.get(binding.stableId);
    if (collision) throw new Error(`Scalar stable ID collision: ${binding.id} and ${collision}`);
    scalarStableIds.set(binding.stableId, binding.id);
  }
  const functions = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const stableIds = new Map();
  const sourceEvidence = [];
  const bindings = inputs
    .flatMap(({ definitionText, sourceText, additionalSources = [], registrationSurfaceText }) => {
      const definition = JSON.parse(definitionText);
      if (
        definition.schemaVersion !== 2 ||
        !Array.isArray(definition.bindings) ||
        (definition.families != null && !Array.isArray(definition.families)) ||
        typeof definition.irSource !== "string"
      ) {
        throw new Error("Unsupported Defold value binding schema");
      }
      // OBSERVED. This generator PARSES this file - the layouts it emits are read
      // out of it - so Defold editing it is the input to the job, not a failure of
      // it. The hash is a change detector whose output is an audit line; the
      // anchors below are what scope the reviewed judgement, and losing one
      // withdraws that judgement rather than stopping.
      const sourceVerdict = observeReviewedSource({
        input: "packages/bindings/overrides/defold-value-layouts.json",
        id: definition.source,
        source: sourceText,
        evidence: { source: definition.source, sha256: definition.sourceSha256, anchors: definition.anchors ?? [] },
      });
      const sourceSha256 = sourceVerdict.observed;
      if (sourceVerdict.status === VOID) return [];
      sourceEvidence.push({ path: `upstream/defold/${definition.source}`, sha256: sourceSha256 });
      const declaredAdditional = definition.additionalSourceEvidence ?? [];
      if (!Array.isArray(declaredAdditional) || declaredAdditional.length !== additionalSources.length) {
        throw new Error(`${definition.source}: additional source evidence is incomplete`);
      }
      for (let index = 0; index < declaredAdditional.length; ++index) {
        const declared = declaredAdditional[index];
        const loaded = additionalSources[index];
        if (
          !declared ||
          typeof declared.source !== "string" ||
          typeof declared.sourceSha256 !== "string" ||
          !Array.isArray(declared.anchors) ||
          declared.anchors.some((anchor) => typeof anchor !== "string")
        ) {
          throw new Error(`${definition.source}: invalid additional source evidence`);
        }
        if (loaded.source !== declared.source)
          throw new Error(`${definition.source}: loaded the wrong additional source evidence`);
        // Same rule for the additional cited sources: observe, and withdraw the
        // whole definition if the evidence its review rested on is gone.
        const additionalVerdict = observeReviewedSource({
          input: "packages/bindings/overrides/defold-value-layouts.json",
          id: declared.source,
          source: loaded.sourceText,
          evidence: { source: declared.source, sha256: declared.sourceSha256, anchors: declared.anchors },
        });
        const sha256 = additionalVerdict.observed;
        if (additionalVerdict.status === VOID) return [];
        sourceEvidence.push({ path: `upstream/defold/${declared.source}`, sha256 });
      }
      // Does this revision's reference archive still carry the documentation file
      // the review was scoped to? See `inDefinitionSource`.
      const layoutMoved =
        declaredDerivation() !== null && ![...functions.values()].some((fn) => fn.source === definition.irSource);
      if (layoutMoved) {
        recordAudit({
          input: "packages/bindings/overrides/defold-value-layouts.json",
          id: definition.irSource,
          status: MOVED,
          reason: "documentation-layout",
        });
      }
      const surface = parseCanonicalLuaRegistrationSurface(registrationSurfaceText);
      return expandDefinitionBindings(definition, functions, patterns, sourceText, surface, layoutMoved).flatMap(
        (entry) => {
          const fn = functions.get(entry.id);
          // A reviewed route this revision does not document where the review found
          // it. At the reviewed revision that is a regression in this tree and stays
          // fatal; deriving another revision it is a route that moved or went away -
          // Defold 1.13.1 documents vmath in `doc/src-script_vmath.cpp_doc.lua`, not
          // `doc/vmath.lua` - so the reviewed entry is withdrawn and reported rather
          // than emitted against documentation that is not there.
          if (!fn || !inDefinitionSource(fn, definition, layoutMoved)) {
            if (!declaredDerivation()) throw new Error(`${entry.id}: missing pinned ${definition.irSource} IR`);
            recordAudit({
              input: "packages/bindings/overrides/defold-value-layouts.json",
              id: entry.id,
              status: VOID,
              reason: "absent-route",
              source: definition.irSource,
              observed: fn?.source ?? null,
            });
            return [];
          }
          const structurallyProvenReplay = new Set([
            "factory-spawn",
            "message-post",
            "gui-node-lookup",
            "gui-node-text-set",
          ]).has(entry.operation.template);
          if (structurallyProvenReplay) {
            const registration = canonicalRegistrationCapability(surface, fn, definition.source);
            if (!registration) {
              withdrawReviewed(
                entry.id,
                "absent-registration",
                `${entry.id}: canonical registered Lua callable is absent`,
              );
              return [];
            }
            entry.sourceSymbol = registration.symbol;
            entry.structuralCapabilities = {
              ...entry.structuralCapabilities,
              registration: registration.capability,
            };
          }
          if (entry.sourceSymbol && !entry.structuralCapabilities?.registration) {
            const registration = canonicalRegistrationCapability(surface, fn, definition.source);
            if (registration?.symbol === entry.sourceSymbol) {
              entry.structuralCapabilities = {
                ...entry.structuralCapabilities,
                registration: registration.capability,
              };
            }
          }
          let scopedSource;
          try {
            scopedSource = entry.generatedFamily
              ? sourceText
              : functionSource(sourceText, entry.sourceSymbol, entry.id);
          } catch (error) {
            return withdrawSpecializationDrift(entry.id, error);
          }
          const sourceOperations =
            entry.sourceOperation == null
              ? []
              : Array.isArray(entry.sourceOperation)
                ? entry.sourceOperation
                : [entry.sourceOperation];
          if (entry.id === "script:gui.get_node") {
            const capabilities = guiNodeUserdataCapability(surface, sourceText, fn);
            if (!capabilities) {
              withdrawReviewed(
                entry.id,
                "missing-structural-capability",
                `${entry.id}: GUI node userdata/context/type capability is incomplete`,
              );
              return [];
            }
            entry.structuralCapabilities = capabilities;
          } else if (["factory-spawn", "message-post", "gui-node-text-set"].includes(entry.operation.template)) {
            const capabilities = structuredLuaReplayCapability({
              surface,
              source: sourceText,
              routeName: fn.rawName,
              expectedSourcePath: definition.source.replace(/^engine\//, ""),
              template: entry.operation.template,
            });
            if (!capabilities) {
              withdrawReviewed(
                entry.id,
                "missing-structural-capability",
                `${entry.id}: structured Lua registration/value/effect capability is incomplete`,
              );
              return [];
            }
            entry.structuralCapabilities = { ...entry.structuralCapabilities, operation: capabilities };
          } else if (sourceOperations.some((anchor) => typeof anchor !== "string" || !scopedSource.includes(anchor))) {
            withdrawReviewed(entry.id, "stale-source-anchor", `${entry.id}: scoped source operation evidence is stale`);
            return [];
          }
          if (entry.callShapes.some((shape) => shape.some((codec) => !CODECS.has(codec))))
            throw new Error(`${entry.id}: unsupported codec`);
          const familyCodecs = new Map(Object.entries(entry.familyTypeCodecs ?? {}));
          const derived = reviewedCallShapes(fn, familyCodecs);
          if (!derived) return [];
          if (!equal(derived, entry.callShapes)) {
            withdrawReviewed(
              entry.id,
              "stale-call-shapes",
              `${entry.id}: reviewed call shapes differ from pinned IR: ${JSON.stringify(derived)}`,
            );
            return [];
          }
          const implementedCallShapes =
            entry.operation.template === "factory-spawn"
              ? factoryImplementedCallShapes(entry.callShapes)
              : (entry.implementedCallShapes ?? entry.callShapes);
          if (
            implementedCallShapes.some((shape) => shape.some((codec) => !CODECS.has(codec))) ||
            implementedCallShapes.some(
              (shape) => !derived.some((candidate) => equal(candidate, shape)) && !isIrCompatibleShape(fn, shape),
            )
          ) {
            withdrawReviewed(
              entry.id,
              "stale-call-shapes",
              `${entry.id}: implemented call shape is not present in pinned IR`,
            );
            return [];
          }
          // Same rule for the result: a documented result shape this generator cannot
          // read at this revision withdraws the route rather than stopping the chain.
          let derivedResult;
          try {
            derivedResult = deriveResultCodec(fn);
          } catch (error) {
            withdrawReviewed(entry.id, "unreadable-signature", error.message);
            return [];
          }
          if (derivedResult !== entry.resultCodec) {
            withdrawReviewed(
              entry.id,
              "stale-result-codec",
              `${entry.id}: reviewed result codec ${entry.resultCodec} differs from pinned IR ${derivedResult}`,
            );
            return [];
          }
          const id = stableBindingId(entry.id);
          const scalarOwner = scalarStableIds.get(id);
          if (scalarOwner) throw new Error(`${entry.id}: stable ID collides with scalar binding ${scalarOwner}`);
          if (stableIds.has(id)) throw new Error(`Stable ID collision: ${entry.id} and ${stableIds.get(id)}`);
          stableIds.set(id, entry.id);
          const unhandledShapePolicy = entry.unhandledShapePolicy ?? "error";
          if (unhandledShapePolicy !== "error" && unhandledShapePolicy !== "universal-fallback") {
            throw new Error(`${entry.id}: unknown unhandled-shape policy ${unhandledShapePolicy}`);
          }
          const binding = {
            ...entry,
            implementedCallShapes,
            unhandledShapePolicy,
            stableId: id,
            rawName: fn.rawName,
            jsName: fn.jsName,
            source: fn.source,
            line: fn.line,
            ownership: definition.ownership,
            targetSupport: targetSupport(entry),
          };
          try {
            validateOperation(binding, scopedSource, definition, sourceText);
          } catch (error) {
            return withdrawSpecializationDrift(entry.id, error);
          }
          return [binding];
        },
      );
    })
    .sort((left, right) => left.stableId - right.stableId);

  const shapes = bindings.flatMap(({ implementedCallShapes }) => implementedCallShapes);
  const argumentCodecs = shapes.flat();
  const inputHash = createHash("sha256")
    .update(irText)
    .update("\0")
    .update(scalarDispatchText)
    .update("\0")
    .update(patternsText);
  for (const { definitionText, sourceText, additionalSources = [], registrationSurfaceText = "" } of inputs) {
    inputHash
      .update("\0")
      .update(definitionText)
      .update("\0")
      .update(sourceText)
      .update("\0")
      .update(registrationSurfaceText);
    for (const source of additionalSources)
      inputHash.update("\0").update(source.source).update("\0").update(source.sourceText);
  }
  const inputSha256 = inputHash.digest("hex");
  const registrationSurfaceText = inputs.find(
    ({ registrationSurfaceText }) => registrationSurfaceText,
  )?.registrationSurfaceText;
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    inputSha256,
    registrationSurfaceSha256: createHash("sha256")
      .update(registrationSurfaceText ?? "")
      .digest("hex"),
    sourceEvidence,
    operationTemplateVocabulary,
    coverageClaim:
      "The listed routes have generated native dispatch and structured call-shape validation. Captured-Lua routes have focused native backend tests but remain explicitly unverified in a packaged Defold engine until their component dispatchers run the real-engine scenarios.",
    allocationClaim:
      "POD dispatch uses inline ScriptValue cells, bounded context stacks, stack-local dmVMath values, and a fixed-capacity generation-checked Matrix4 frame arena with no heap fallback. Structured calls use fixed-capacity table staging and a 256-slot generational node pool; Lua registry growth and the documented engine operations may allocate. Debug dmHashBuffer64 may allocate once to register a previously unseen short string in Defold's reverse-hash table.",
    floatPolicy:
      "Numeric constructor arguments follow Lua-number conversion, including NaN and infinity; finite values outside float32 range deterministically become signed infinity. Defold-value and Matrix4 inputs reject NaN components through pinned CheckVector3/CheckVector4/CheckQuat/CheckMatrix4 semantics, while normalize and unchanged degenerate dmVMath operations may produce NaN from otherwise valid inputs.",
    bindingCount: bindings.length,
    callShapeCount: shapes.length,
    argumentCodecCount: argumentCodecs.length,
    bindings,
  };
  const recipeFacts = createScriptValueBindingRecipeFacts(report);
  const rendered = renderScriptValueBindingOutputs(recipeFacts);
  return { report: `${JSON.stringify(report, null, 2)}\n`, ...rendered };
}

export async function loadGenerationInputs() {
  const [irText, scalarDispatchText, patternsText, registrationSurfaceText] = await Promise.all([
    readFile(irUrl, "utf8"),
    readFile(scalarDispatchUrl, "utf8"),
    readFile(patternsUrl, "utf8"),
    readFile(registrationSurfaceUrl, "utf8"),
  ]);
  const inputs = await Promise.all(
    definitionUrls.map(async (definitionUrl) => {
      const definitionText = await readFile(definitionUrl, "utf8");
      const definition = JSON.parse(definitionText);
      const sourceText = await readFile(new URL(`upstream/defold/${definition.source}`, root), "utf8");
      const additionalSources = await Promise.all(
        (definition.additionalSourceEvidence ?? []).map(async ({ source }) => ({
          source,
          sourceText: await readFile(new URL(`upstream/defold/${source}`, root), "utf8"),
        })),
      );
      return { definitionText, sourceText, additionalSources, registrationSurfaceText };
    }),
  );
  return { irText, scalarDispatchText, patternsText, inputs };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const { irText, scalarDispatchText, patternsText, inputs } = await loadGenerationInputs();
  const outputs = generate(irText, scalarDispatchText, patternsText, inputs);
  for (const [url, content] of [
    [reportUrl, outputs.report],
    [headerUrl, outputs.header],
    [sourceUrl, outputs.source],
    [targetSupportUrl, outputs.targetSupportSource],
  ]) {
    if (check) {
      if ((await readFile(url, "utf8")) !== content) throw new Error(`${url.pathname} is stale`);
    } else await writeFile(url, content);
  }
  console.log(
    `${check ? "Verified" : "Generated"} ${JSON.parse(outputs.report).bindingCount} native Defold value bindings.`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
