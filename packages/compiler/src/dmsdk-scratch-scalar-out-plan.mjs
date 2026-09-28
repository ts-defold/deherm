import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  DMSDK_CPP_SOURCE_SEMANTIC_ADMISSION,
  validateDmSdkCppOwnershipEffectReport,
} from "./dmsdk-cpp-ownership-effect-frontend.mjs";
import { DMSDK_UNIVERSAL_FALLBACK_PATTERN, selectDmSdkPattern } from "./dmsdk-pattern-selector.mjs";
import { scratchScalarOutPattern } from "./dmsdk-pattern-catalog.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SOURCE_KEYS = Object.freeze(["ir", "shapes", "projection", "policy", "effectFacts"]);

export const DMSDK_SCRATCH_SCALAR_OUT_PLAN_KIND = "deherm.dmsdk-scratch-scalar-out-plan";

// This is the package-owned recipe.  It deliberately does not contain Defold
// names, IDs, headers, or a list of routes. New routes require complete
// revision-owned source facts; the explicit compatibility admission preserves
// an already generated route only while the revision-owned ABI tranche and
// the same structural recipe still agree.
export const DMSDK_SCRATCH_SCALAR_OUT_ELIGIBILITY = Object.freeze({
  schemaVersion: 2,
  patternId: "pointer.scratch-scalar-out-provider-boundary",
  requiredFacts: Object.freeze({
    ownership: "borrowed-handle-or-scalar-no-transfer",
    memory: "exact-one-scalar-no-alias-no-span",
    write: "success-path-output-defined",
    completion: "synchronous-noescape",
  }),
  compatibilityAdmission: Object.freeze({
    source: "revision-derived ABI tranche",
    tranche: "scratch-out-parameters",
    constraint: "the same structural pattern must still match",
    purpose: "preserve an already generated and runtime-tested provider route while source-effect recovery catches up",
  }),
  unknownPolicy: "universal-fallback",
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assert(object(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${label} has unsupported schema keys`);
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

function sourceOrdinal(id) {
  const match = String(id).match(/:(\d+)$/u);
  assert(match, `${id}: scratch candidate has no source ordinal`);
  return Number(match[1]);
}

function patternFacts(shape, projected) {
  return {
    id: shape.id,
    kind: shape.kind,
    result: shape.result,
    parameters: shape.parameters,
    families: shape.families,
    semanticTokens: projected?.semanticTokensNeeded ?? [],
  };
}

function validatePolicy(policy) {
  exactKeys(policy, ["schemaVersion", "family", "selection", "storageContract", "targetPolicy"], "scratch policy");
  assert(
    policy.schemaVersion === 1 && policy.family === "scratch-out-parameters",
    "scratch policy identity is invalid",
  );
  exactKeys(
    policy.selection,
    [
      "resultRolePrefixes",
      "valueRolePrefixes",
      "pointerRolePrefixes",
      "pointerDirections",
      "requiresWritablePointer",
      "rejectedFamilies",
    ],
    "scratch selection",
  );
  assert(policy.selection.requiresWritablePointer === true, "scratch policy must require a writable pointer");
  assert(Array.isArray(policy.selection.resultRolePrefixes), "scratch result roles are invalid");
  assert(Array.isArray(policy.selection.valueRolePrefixes), "scratch value roles are invalid");
  assert(Array.isArray(policy.selection.pointerRolePrefixes), "scratch pointer roles are invalid");
  assert(Array.isArray(policy.selection.pointerDirections), "scratch pointer directions are invalid");
  assert(Array.isArray(policy.selection.rejectedFamilies), "scratch rejected families are invalid");
}

function validateInputs({ ir, shapes, projection, policy, effectFacts, texts }) {
  for (const key of SOURCE_KEYS) {
    assert(typeof texts?.[key] === "string", `scratch plan is missing exact ${key} source text`);
    assert(
      isDeepStrictEqual(JSON.parse(texts[key]), { ir, shapes, projection, policy, effectFacts }[key]),
      `scratch plan ${key} object differs from source text`,
    );
  }
  assert(ir?.schemaVersion === 1 && Array.isArray(ir.declarations), "scratch plan has invalid dmSDK IR");
  assert(shapes?.schemaVersion === 1 && Array.isArray(shapes.rows), "scratch plan has invalid ABI shapes");
  assert(projection?.schemaVersion === 1 && Array.isArray(projection.rows), "scratch plan has invalid projection IR");
  validateDmSdkCppOwnershipEffectReport(effectFacts);
  assert(
    isDeepStrictEqual(effectFacts.semanticAdmission, DMSDK_CPP_SOURCE_SEMANTIC_ADMISSION),
    "scratch plan requires revision-authoritative source semantics",
  );
  assert(
    ir.defoldRevision === shapes.defoldRevision && ir.defoldRevision === projection.defoldRevision,
    "scratch plan inputs use different Defold revisions",
  );
  assert(shapes.sourceHashes?.ir === sha256(texts.ir), "scratch shapes do not authenticate the IR");
  assert(projection.sources?.hashes?.ir === sha256(texts.ir), "scratch projection does not authenticate the IR");
  for (const [label, rows, key] of [
    ["IR", ir.declarations, "id"],
    ["shapes", shapes.rows, "id"],
    ["projection", projection.rows, "id"],
  ]) {
    assert(new Set(rows.map((row) => row[key])).size === rows.length, `scratch ${label} has duplicate declaration IDs`);
  }
  validatePolicy(policy);
}

function factsFor(shape, projected, effectFacts) {
  const extracted = effectFacts.functions.find(({ declarationId }) => declarationId === shape.id)?.fact;
  // The projection is intentionally not treated as proof: values such as
  // `borrowed-or-transferred-requires-token` and
  // `unspecified-requires-token` are unresolved, not safe defaults. The
  // authenticated C++ effect artifact is the only source that can promote a
  // structural candidate into this lane.
  if (!object(extracted)) {
    return { ownership: "unknown", memory: "unknown", write: "unknown", completion: "unknown", source: "none" };
  }
  const completeEffect = Array.isArray(extracted.diagnostics) && extracted.diagnostics.length === 0;
  const pointerParameters = shape.parameters
    .map((parameter, index) => ({ parameter, index }))
    .filter(({ parameter }) => parameter.role.startsWith("pointer:"));
  const effectParameters = new Map((extracted.parameters ?? []).map((parameter) => [parameter.index, parameter]));
  const pointerFacts = pointerParameters.map(({ index }) => effectParameters.get(index));
  const facts = {
    ownership:
      completeEffect &&
      extracted.ownershipEffect === "none" &&
      extracted.resultProvenance === "plain-value" &&
      (extracted.parameters ?? []).every(
        ({ ownershipEffect }) => ownershipEffect === "none" || ownershipEffect === "borrowed",
      )
        ? "borrowed-handle-or-scalar-no-transfer"
        : "unknown",
    memory:
      completeEffect &&
      pointerFacts.length > 0 &&
      pointerFacts.every(
        (fact) =>
          object(fact) && ["exact-one-read", "exact-one-write", "exact-one-readwrite"].includes(fact.memoryEffect),
      )
        ? "exact-one-scalar-no-alias-no-span"
        : "unknown",
    write:
      completeEffect &&
      pointerFacts.length > 0 &&
      pointerFacts.every(
        (fact) => object(fact) && ["always", "boolean-true", "finite-result-domain"].includes(fact.writePredicate),
      )
        ? "success-path-output-defined"
        : "unknown",
    completion:
      completeEffect && extracted.completion === "synchronous" && extracted.escape === "noescape"
        ? "synchronous-noescape"
        : "unknown",
    source: "cpp-ownership-effect-facts",
  };
  void projected;
  return facts;
}

function blockersFor(facts) {
  return Object.entries(facts)
    .filter(([key]) => key !== "source" && facts[key] === "unknown")
    .map(([key]) => `${key}-facts-unavailable`)
    .sort(compareCodeUnits);
}

export function buildDmSdkScratchScalarOutPlan({ ir, shapes, projection, policy, effectFacts, texts }) {
  validateInputs({ ir, shapes, projection, policy, effectFacts, texts });
  const declarations = new Map(ir.declarations.map((row) => [row.id, row]));
  const projections = new Map(projection.rows.map((row) => [row.id, row]));
  const registry = [scratchScalarOutPattern(policy.selection), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const structural = shapes.rows
    .filter((shape) => !selectDmSdkPattern(patternFacts(shape, projections.get(shape.id)), registry).fallback)
    .map((shape) => ({
      shape,
      declaration: declarations.get(shape.id),
      projected: projections.get(shape.id),
      sourceOrdinal: sourceOrdinal(shape.id),
    }))
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal || compareCodeUnits(left.shape.id, right.shape.id));
  let order = 0;
  const decisions = structural.map(({ shape, declaration, projected, sourceOrdinal: ordinal }) => {
    assert(declaration && projected, `${shape.id}: scratch candidate missing source row`);
    const facts = factsFor(shape, projected, effectFacts);
    const evidenceGaps = blockersFor(facts);
    const sourceDerived = evidenceGaps.length === 0;
    const defoldContractTrusted = !sourceDerived && shape.tranche === policy.family;
    const admission = sourceDerived
      ? "source-derived"
      : defoldContractTrusted
        ? "defold-contract-trusted"
        : "universal-fallback";
    const selected = admission !== "universal-fallback";
    const blockers = selected ? [] : evidenceGaps;
    return {
      declarationId: shape.id,
      sourceOrdinal: ordinal,
      order: selected ? order++ : null,
      patternId: selected ? DMSDK_SCRATCH_SCALAR_OUT_ELIGIBILITY.patternId : DMSDK_UNIVERSAL_FALLBACK_PATTERN.id,
      family: selected ? "scratch-scalar-out" : DMSDK_UNIVERSAL_FALLBACK_PATTERN.family,
      emitter: selected
        ? "scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs"
        : DMSDK_UNIVERSAL_FALLBACK_PATTERN.emitter,
      fallback: !selected,
      admission,
      facts,
      evidenceGaps,
      blockers,
      universalFallback: { state: "universal-fallback", preserved: true, blockers: evidenceGaps },
    };
  });
  return {
    schemaVersion: 3,
    kind: DMSDK_SCRATCH_SCALAR_OUT_PLAN_KIND,
    defoldRevision: ir.defoldRevision,
    sources: {
      ir: "packages/bindings/generated/defold-sdk-ir.json",
      shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
      projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
      policy: "packages/bindings/overrides/dmsdk-scratch-scalar-out-bindings.json",
      effectFacts: "packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json",
    },
    sourceHashes: Object.fromEntries(SOURCE_KEYS.map((key) => [key, sha256(texts[key])])),
    eligibility: DMSDK_SCRATCH_SCALAR_OUT_ELIGIBILITY,
    patternRegistry: registry,
    coverage: {
      structurallyRelevant: decisions.length,
      selected: decisions.filter(({ fallback }) => !fallback).length,
      sourceDerived: decisions.filter(({ admission }) => admission === "source-derived").length,
      defoldContractTrusted: decisions.filter(({ admission }) => admission === "defold-contract-trusted").length,
      universalFallback: decisions.filter(({ fallback }) => fallback).length,
      blockerCounts: Object.fromEntries(
        ["ownership", "memory", "write", "completion"].map((key) => [
          key,
          decisions.filter(({ facts }) => facts[key] === "unknown").length,
        ]),
      ),
    },
    decisions,
  };
}

export function indexDmSdkScratchScalarOutPlan(plan, inputs = undefined) {
  exactKeys(
    plan,
    [
      "schemaVersion",
      "kind",
      "defoldRevision",
      "sources",
      "sourceHashes",
      "eligibility",
      "patternRegistry",
      "coverage",
      "decisions",
    ],
    "scratch plan",
  );
  assert(plan.schemaVersion === 3 && plan.kind === DMSDK_SCRATCH_SCALAR_OUT_PLAN_KIND, "invalid scratch plan identity");
  assert(
    isDeepStrictEqual(plan.eligibility, DMSDK_SCRATCH_SCALAR_OUT_ELIGIBILITY),
    "scratch eligibility recipe differs",
  );
  exactKeys(plan.sources, SOURCE_KEYS, "scratch plan sources");
  exactKeys(plan.sourceHashes, SOURCE_KEYS, "scratch plan source hashes");
  for (const key of SOURCE_KEYS)
    assert(
      typeof plan.sourceHashes[key] === "string" && /^[a-f0-9]{64}$/u.test(plan.sourceHashes[key]),
      `scratch ${key} source hash invalid`,
    );
  assert(Array.isArray(plan.decisions) && Array.isArray(plan.patternRegistry), "scratch plan rows missing");
  const ids = new Set();
  let selectedOrder = 0;
  let previousOrdinal = -1;
  for (const decision of plan.decisions) {
    exactKeys(
      decision,
      [
        "declarationId",
        "sourceOrdinal",
        "order",
        "patternId",
        "family",
        "emitter",
        "fallback",
        "admission",
        "facts",
        "evidenceGaps",
        "blockers",
        "universalFallback",
      ],
      `${decision.declarationId}: scratch decision`,
    );
    assert(!ids.has(decision.declarationId), `${decision.declarationId}: duplicate scratch decision`);
    ids.add(decision.declarationId);
    assert(decision.sourceOrdinal >= previousOrdinal, `${decision.declarationId}: scratch decisions are not ordered`);
    previousOrdinal = decision.sourceOrdinal;
    exactKeys(
      decision.facts,
      ["ownership", "memory", "write", "completion", "source"],
      `${decision.declarationId}: scratch facts`,
    );
    assert(
      ["source-derived", "defold-contract-trusted", "universal-fallback"].includes(decision.admission),
      `${decision.declarationId}: scratch admission is invalid`,
    );
    assert(
      isDeepStrictEqual(decision.evidenceGaps, sortedUnique(decision.evidenceGaps)),
      `${decision.declarationId}: scratch evidence gaps unsorted`,
    );
    assert(
      isDeepStrictEqual(decision.blockers, sortedUnique(decision.blockers)),
      `${decision.declarationId}: scratch blockers unsorted`,
    );
    const selected = decision.admission !== "universal-fallback";
    assert(
      (decision.admission === "source-derived") === (decision.evidenceGaps.length === 0),
      `${decision.declarationId}: scratch source admission differs from evidence gaps`,
    );
    assert(
      decision.blockers.length === (selected ? 0 : decision.evidenceGaps.length),
      `${decision.declarationId}: scratch blockers differ from admission`,
    );
    assert(decision.fallback === !selected, `${decision.declarationId}: scratch fallback differs from blockers`);
    assert(
      decision.patternId ===
        (selected ? DMSDK_SCRATCH_SCALAR_OUT_ELIGIBILITY.patternId : DMSDK_UNIVERSAL_FALLBACK_PATTERN.id),
      `${decision.declarationId}: scratch pattern differs from fallback disposition`,
    );
    assert(
      decision.family === (selected ? "scratch-scalar-out" : DMSDK_UNIVERSAL_FALLBACK_PATTERN.family),
      `${decision.declarationId}: scratch family differs from fallback disposition`,
    );
    assert(decision.order === (selected ? selectedOrder++ : null), `${decision.declarationId}: scratch order differs`);
    assert(
      isDeepStrictEqual(decision.universalFallback.blockers, decision.evidenceGaps),
      `${decision.declarationId}: fallback evidence differs`,
    );
    assert(
      decision.universalFallback.preserved === true,
      `${decision.declarationId}: universal fallback not preserved`,
    );
  }
  exactKeys(
    plan.coverage,
    [
      "structurallyRelevant",
      "selected",
      "sourceDerived",
      "defoldContractTrusted",
      "universalFallback",
      "blockerCounts",
    ],
    "scratch coverage",
  );
  assert(plan.coverage.structurallyRelevant === plan.decisions.length, "scratch structural coverage differs");
  assert(plan.coverage.selected === selectedOrder, "scratch selected coverage differs");
  assert(
    plan.coverage.sourceDerived === plan.decisions.filter(({ admission }) => admission === "source-derived").length,
    "scratch source-derived coverage differs",
  );
  assert(
    plan.coverage.defoldContractTrusted ===
      plan.decisions.filter(({ admission }) => admission === "defold-contract-trusted").length,
    "scratch Defold-contract coverage differs",
  );
  assert(
    plan.coverage.universalFallback === plan.decisions.length - selectedOrder,
    "scratch fallback coverage differs",
  );
  if (inputs !== undefined)
    assert(
      isDeepStrictEqual(plan, buildDmSdkScratchScalarOutPlan(inputs)),
      "scratch plan differs from strict source re-derivation",
    );
  return new Map(plan.decisions.map((decision) => [decision.declarationId, decision]));
}
