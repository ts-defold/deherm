#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { assertReviewedRevision, declaredDerivation, expectReviewedCount, loadReviewedSources, expectSameRevision } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";

const root = new URL("../", import.meta.url);
const inputUrls = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  accounting: new URL("packages/bindings/generated/defold-script-api-accounting.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  override: new URL("packages/bindings/overrides/script-borrowed-handle-classification.json", root)
};
const outputUrl = new URL("packages/bindings/generated/defold-script-borrowed-handle-classification.json", root);

const OPERATION_CLASSES = [
  "checked-handle-input-terminal",
  "checked-handle-return-capture",
  "checked-child-engine-object-invalidate",
  "checked-self-engine-object-invalidate",
  "declaration-token"
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueMap(rows, label) {
  const result = new Map();
  for (const row of rows) {
    assert(typeof row.id === "string" && row.id.length > 0, `${label} contains a row without an id`);
    assert(!result.has(row.id), `${label} contains duplicate id '${row.id}'`);
    result.set(row.id, row);
  }
  return result;
}

function sortedIds(values) {
  return [...values].sort(compareText);
}

function sameIds(left, right) {
  return JSON.stringify(sortedIds(left)) === JSON.stringify(sortedIds(right));
}

function hasHandle(codec) {
  return codec.codecs.includes("handle");
}

function isInvalidatorName(rawName) {
  return /(^|\.)(delete|destroy)(_|$)/.test(rawName);
}

/** Type member that means "this result may be absent"; it never names a handle kind. */
const ABSENT_TYPE_MEMBER = "nil";

function typeMembers(rawType) {
  return String(rawType ?? "").split("|").map((member) => member.trim()).filter(Boolean);
}

/**
 * The reviewed handle kind a route's declared result *is*, or null.
 *
 * "Is" is the whole point: every non-absent member of the single declared
 * result must resolve to the same reviewed kind. A union of scalars that
 * happens to admit a handle member (`go.get`) is not a handle result, and a
 * sequence of handles (`b2Joint[]`) is a table, not a handle.
 */
function declaredHandleResultKind(irFunction, rawTypeToKind) {
  const returns = irFunction?.returns ?? [];
  if (returns.length !== 1) return null;
  const members = typeMembers(returns[0]).filter((member) => member !== ABSENT_TYPE_MEMBER);
  if (members.length === 0) return null;
  const kinds = new Set(members.map((member) => rawTypeToKind.get(member)));
  if (kinds.size !== 1) return null;
  const [kind] = kinds;
  return kind ?? null;
}

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const key = selector(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
}

function resolveContext(binding, operationClass, contextRules) {
  const module = binding.rawName.split(".")[0];
  const exact = contextRules.find((rule) => rule.ids?.includes(binding.id));
  if (exact) return exact.requiredContext;
  const operation = contextRules.find((rule) => rule.operationClass === operationClass);
  if (operation) return operation.requiredContext;
  const moduleRule = contextRules.find((rule) => rule.module === module);
  assert(moduleRule, `${binding.id}: no reviewed context rule matches module '${module}'`);
  return moduleRule.requiredContext;
}

function kindsForCodec(codec, rawTypeToKind, bindingId) {
  if (!hasHandle(codec)) return [];
  const kinds = [...new Set(codec.rawType.split("|")
    .map((type) => rawTypeToKind.get(type))
    .filter(Boolean))].sort(compareText);
  assert(kinds.length > 0, `${bindingId}: handle codec '${codec.rawType}' has no reviewed concrete handle kind`);
  return kinds;
}

// Every citation was classified while loading: a moved hash is an audit line and
// a lost - or absent - anchor withdraws that citation for this revision. Defold
// 1.13.1 ships no `bullet3d` backend at all, so five of the eighteen cited
// sources are simply not there, which is a backend that revision does not have
// rather than a broken review. What remains here is the structural check that
// the override lists each citation once and that every citation it still claims
// was actually loaded.
function validateSourceEvidence(override, sourceTexts, withdrawnSources) {
  const listed = uniqueMap(override.sourceEvidence, "borrowed-handle source evidence");
  const evidenceById = new Map();
  for (const evidence of override.sourceEvidence) {
    if (withdrawnSources.has(evidence.source)) continue;
    assert(typeof sourceTexts.get(evidence.source) === "string", `${evidence.id}: source '${evidence.source}' was not loaded`);
    evidenceById.set(evidence.id, listed.get(evidence.id));
  }
  return evidenceById;
}

const REPRESENTATIONS = [
  "lua-rooted-userdata",
  "numeric-graphics-asset-handle",
  "declaration-only-token",
  // A raw pointer with no metatable and no generation. It is a handle kind by
  // declared type and not one by representation: nothing about it can be
  // rooted, validated, or generation-checked, so a transport must refuse it
  // rather than manufacture an identity for it.
  "lua-light-userdata"
];

/** Representations a transport can root as a generation-checked identity. */
const CAPTURABLE_REPRESENTATIONS = ["lua-rooted-userdata", "numeric-graphics-asset-handle"];

/**
 * Representation is a property of the backend that implements a kind, not of
 * the kind's name.
 *
 * `b2World` is the case that forced this: the v3 sources push a rooted
 * userdata with a metatable, and Box2D v2's `PushWorld` pushes a *light*
 * userdata with no identity at all. Declaring one representation for the kind
 * made the classification silently wrong under half the runtime profiles the
 * availability model already distinguishes. A kind therefore declares the
 * feature its stated representation was derived from, and one exception entry
 * per feature that implements it differently, each with its own pinned source.
 */
function representationsFor(kind, evidenceById) {
  const exceptions = kind.representationExceptions ?? [];
  if (exceptions.length === 0) {
    assert(kind.representationFeature === undefined,
      `${kind.id}: declares a representation feature without any representation exception`);
    return [{ feature: null, representation: kind.representation, capturable: CAPTURABLE_REPRESENTATIONS.includes(kind.representation), sourceEvidence: [...kind.sourceEvidence].sort(compareText) }];
  }
  assert(typeof kind.representationFeature === "string" && kind.representationFeature.length > 0,
    `${kind.id}: representation exceptions require the feature the stated representation holds for`);
  const seen = new Set([kind.representationFeature]);
  const rows = [{
    feature: kind.representationFeature,
    representation: kind.representation,
    capturable: CAPTURABLE_REPRESENTATIONS.includes(kind.representation),
    sourceEvidence: [...kind.sourceEvidence].sort(compareText)
  }];
  for (const exception of exceptions) {
    assert(typeof exception.feature === "string" && exception.feature.length > 0,
      `${kind.id}: representation exception has no feature`);
    assert(!seen.has(exception.feature), `${kind.id}: feature '${exception.feature}' declares two representations`);
    seen.add(exception.feature);
    assert(REPRESENTATIONS.includes(exception.representation),
      `${kind.id}: unsupported representation '${exception.representation}' for feature '${exception.feature}'`);
    assert(evidenceById.has(exception.sourceEvidence),
      `${kind.id}: representation exception cites unknown source evidence '${exception.sourceEvidence}'`);
    assert(typeof exception.reason === "string" && exception.reason.length > 0,
      `${kind.id}: representation exception for '${exception.feature}' has no reason`);
    rows.push({
      feature: exception.feature,
      representation: exception.representation,
      capturable: CAPTURABLE_REPRESENTATIONS.includes(exception.representation),
      sourceEvidence: [exception.sourceEvidence],
      reason: exception.reason
    });
  }
  return rows.sort((left, right) => compareText(left.feature, right.feature));
}

function validateHandleKinds(override, evidenceById) {
  const kindById = uniqueMap(override.handleKinds, "borrowed-handle kinds");
  const rawTypeToKind = new Map();
  const representationsByKind = new Map();
  const withdrawnKinds = new Set();
  for (const kind of override.handleKinds) {
    assert(Array.isArray(kind.rawTypes) && kind.rawTypes.length > 0, `${kind.id}: no raw handle types`);
    assert(REPRESENTATIONS.includes(kind.representation),
      `${kind.id}: unsupported representation '${kind.representation}'`);
    // A kind is known through the sources the reviewer read. If this revision
    // does not have one of them the kind's ownership, validity and invalidation
    // boundary rest on nothing, so the kind is withdrawn for this revision and
    // every route that only reaches the census through it goes with it. At the
    // reviewed revision every citation is present, so this stays fatal there.
    const cited = [...kind.sourceEvidence,
      ...(kind.representationExceptions ?? []).map(({ sourceEvidence }) => sourceEvidence)];
    const missing = cited.filter((evidenceId) => !evidenceById.has(evidenceId));
    if (missing.length) {
      assert(declaredDerivation(), `${kind.id}: unknown source evidence '${missing[0]}'`);
      recordAudit({
        input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
        id: kind.id, status: VOID, reason: "withdrawn-evidence", anchorsLost: missing
      });
      withdrawnKinds.add(kind.id);
      continue;
    }
    for (const rawType of kind.rawTypes) {
      assert(!rawTypeToKind.has(rawType), `${rawType}: assigned to multiple concrete handle kinds`);
      rawTypeToKind.set(rawType, kind.id);
    }
    for (const field of ["ownership", "validity", "invalidationBoundary"]) {
      assert(typeof kind[field] === "string" && kind[field].length > 0, `${kind.id}: missing ${field}`);
    }
    representationsByKind.set(kind.id, representationsFor(kind, evidenceById));
  }
  return { kindById, rawTypeToKind, representationsByKind, withdrawnKinds };
}

function validateExceptionalRoutes(override, borrowedById) {
  const exceptional = new Map();
  for (const operationClass of OPERATION_CLASSES.slice(1)) {
    const reviewed = override.exceptionalRoutes[operationClass];
    assert(Array.isArray(reviewed), `missing reviewed exceptions for '${operationClass}'`);
    const reviewedById = uniqueMap(reviewed, `${operationClass} exceptions`);
    for (const [id, row] of reviewedById) {
      // A reviewed exception for a route this revision does not classify as a
      // borrowed handle - every `bullet3d.*` route at Defold 1.13.1 - is
      // withdrawn and reported rather than asserted against an absent route.
      if (!borrowedById.has(id)) {
        assert(declaredDerivation(), `${id}: reviewed exception is not a borrowed-handle route`);
        recordAudit({
          input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
          id, status: VOID, reason: "absent-route", operationClass
        });
        continue;
      }
      assert(row.stableId === stableBindingId(id), `${id}: reviewed stable ID is stale`);
      assert(!exceptional.has(id), `${id}: reviewed exceptional route appears in multiple operation classes`);
      exceptional.set(id, operationClass);
    }
  }
  return exceptional;
}

export function generateBorrowedHandleClassification(inputs) {
  const ir = parse(inputs.irText, "script API IR");
  const accounting = parse(inputs.accountingText, "script API accounting");
  const patterns = parse(inputs.patternsText, "script binding patterns");
  const override = parse(inputs.overrideText, "borrowed-handle override");

  assert(override.schemaVersion === 2, "borrowed-handle override has an unsupported schema");
  expectSameRevision({
    label: "borrowed-handle classification",
    inputs: [
      { path: "packages/bindings/generated/defold-script-api-ir.json", revision: ir.defoldRevision },
      { path: "packages/bindings/generated/defold-script-api-accounting.json", revision: accounting.defoldRevision },
      { path: "packages/bindings/generated/defold-script-binding-patterns.json", revision: patterns.defoldRevision }
    ]
  });
  // The override is REVIEWED evidence rather than a derived input, so it is
  // compared against the revision being generated by the reviewed-revision rule
  // rather than lumped in with the derived inputs above. Everything that
  // follows - the cited source hashes and anchors, the expected census, the
  // mechanically discovered producers and invalidators - re-checks that review
  // against this revision's own bytes.
  assertReviewedRevision({
    input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
    reviewed: override.defoldRevision,
    derived: ir.defoldRevision,
    detail: "the reviewed borrowed-handle census, kinds and operation classes"
  });
  assert(accounting.inputEvidence?.scriptIrSha256 === sha256(inputs.irText),
    "script API accounting is stale against the pinned IR");
  assert(accounting.inputEvidence?.bindingPatternsSha256 === sha256(inputs.patternsText),
    "script API accounting is stale against binding patterns");

  const irById = uniqueMap(ir.functions, "script API IR");
  const patternById = uniqueMap(patterns.bindings, "script binding patterns");

  const withdrawnSources = inputs.withdrawnSources ?? new Set();
  const evidenceById = validateSourceEvidence(override, inputs.sourceTexts, withdrawnSources);
  const { rawTypeToKind, representationsByKind, withdrawnKinds } = validateHandleKinds(override, evidenceById);

  // Two structural reasons put a route in this census, and the second is what
  // makes a constructor visible to the handle lane at all.
  //
  //   `handle-lowering-family` - the binding pattern's lowering family is
  //     `borrowed-handle`, so the marshalling family that owns handle-shaped
  //     calls already owns this route.
  //   `declared-handle-result` - the route's single declared result *is* a
  //     reviewed borrowed handle kind, whatever family owns its arguments.
  //
  // Lowering-family selection is a single-winner precedence in which a
  // table-shaped parameter outranks a handle, so every `create_*` that takes a
  // definition record lands in the table family. Partitioning on the family
  // alone therefore left the census covering only routes whose arguments
  // happen to be handle-shaped - accessors - and hid every constructor, which
  // is the primary way a program obtains a handle in the first place. The
  // second basis is derived from the declared result type, never from the
  // member name and never from a reviewed route list.
  const censusBasisById = new Map();
  for (const binding of patterns.bindings) {
    if (binding.loweringFamily === "borrowed-handle") {
      censusBasisById.set(binding.id, "handle-lowering-family");
    } else if (declaredHandleResultKind(irById.get(binding.id), rawTypeToKind)) {
      censusBasisById.set(binding.id, "declared-handle-result");
    }
  }
  // Native value dispatch owns GUI node reads/writes with a tighter generated
  // shape. Keep the borrowed-handle classifier structural, but do not emit a
  // second competing lowering recipe for routes already specialized there.
  const borrowedAccountingRows = accounting.rows.filter(
    ({ id, evidence }) => censusBasisById.has(id) && evidence?.generator !== "native-value-dispatch",
  );
  const borrowedById = uniqueMap(borrowedAccountingRows, "borrowed-handle accounting rows");
  expectReviewedCount({
    input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
    label: "borrowed-handle route census",
    expected: override.expectedCounts.total, observed: borrowedById.size
  });

  for (const [id, accountingRow] of borrowedById) {
    const fn = irById.get(id);
    const pattern = patternById.get(id);
    assert(fn, `${id}: borrowed-handle accounting row is absent from pinned IR`);
    assert(pattern, `${id}: borrowed-handle accounting row has no binding pattern`);
    assert(fn.rawName === accountingRow.rawName && fn.source === accountingRow.source && fn.line === accountingRow.line,
      `${id}: accounting provenance differs from pinned IR`);
    assert(pattern.rawName === fn.rawName && pattern.source === fn.source && pattern.line === fn.line,
      `${id}: pattern provenance differs from pinned IR`);
  }

  const exceptional = validateExceptionalRoutes(override, borrowedById);
  const declarationIds = new Set(override.exceptionalRoutes["declaration-token"].map(({ id }) => id));
  const producerIds = new Set(override.exceptionalRoutes["checked-handle-return-capture"].map(({ id }) => id));
  const childInvalidatorIds = new Set(override.exceptionalRoutes["checked-child-engine-object-invalidate"].map(({ id }) => id));
  const selfInvalidatorIds = new Set(override.exceptionalRoutes["checked-self-engine-object-invalidate"].map(({ id }) => id));
  const invalidatorIds = new Set([...childInvalidatorIds, ...selfInvalidatorIds]);

  const mechanicallyReturnedHandles = new Set();
  const mechanicallyInvalidatingNames = new Set();
  for (const id of borrowedById.keys()) {
    const binding = patternById.get(id);
    if (binding.returnCodecs.some(hasHandle) && !declarationIds.has(id)) mechanicallyReturnedHandles.add(id);
    if (isInvalidatorName(binding.rawName)) mechanicallyInvalidatingNames.add(id);
  }
  // The reviewed classification and the mechanical discovery must agree. Where
  // they do not, a route's operation class is exactly what a review decides, so
  // at the reviewed revision the disagreement is a regression in this tree and
  // stays fatal. Deriving another revision it is a route that revision added,
  // removed or reshaped: it is withdrawn from the emitted census and reported
  // by name as queued review work, rather than emitted under a class nobody
  // reviewed.
  const withdrawnRoutes = new Set();
  const disagree = (mechanical, reviewed, message, reason) => {
    if (sameIds(mechanical, reviewed)) return;
    assert(declaredDerivation(), message);
    for (const id of [...mechanical, ...reviewed]) {
      if (mechanical.has(id) === reviewed.has(id)) continue;
      withdrawnRoutes.add(id);
      recordAudit({
        input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
        id, status: VOID, reason, mechanical: mechanical.has(id), reviewed: reviewed.has(id)
      });
    }
  };
  disagree(mechanicallyReturnedHandles, producerIds,
    "reviewed runtime handle producers differ from mechanically discovered handle returns",
    "unreviewed-handle-producer");
  disagree(mechanicallyInvalidatingNames, invalidatorIds,
    "reviewed invalidators differ from mechanically discovered delete/destroy routes",
    "unreviewed-handle-invalidator");
  // A route whose only handle types belonged to a withdrawn kind has no reviewed
  // representation at this revision either.
  for (const id of borrowedById.keys()) {
    const binding = patternById.get(id);
    const codecs = [...binding.parameterCodecs, ...binding.returnCodecs].filter(hasHandle);
    if (!codecs.length) continue;
    if (!codecs.some((codec) => codec.rawType.split("|").some((type) => rawTypeToKind.has(type)))) {
      assert(declaredDerivation(), `${id}: borrowed-handle route has no reviewed handle representation`);
      withdrawnRoutes.add(id);
      recordAudit({
        input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
        id, status: VOID, reason: "withdrawn-handle-kind"
      });
    }
  }

  const stableIdOwners = new Map();
  const rows = [];
  for (const id of sortedIds(borrowedById.keys()).filter((id) => !withdrawnRoutes.has(id))) {
    const accountingRow = borrowedById.get(id);
    const binding = patternById.get(id);
    const operationClass = exceptional.get(id) ?? "checked-handle-input-terminal";
    const stableId = stableBindingId(id);
    const stableOwner = stableIdOwners.get(stableId);
    assert(!stableOwner, `${id}: stable ID collides with '${stableOwner}'`);
    stableIdOwners.set(stableId, id);

    const inputHandleKinds = [...new Set(binding.parameterCodecs.flatMap((codec) =>
      kindsForCodec(codec, rawTypeToKind, id)))].sort(compareText);
    const returnHandleKinds = [...new Set(binding.returnCodecs.flatMap((codec) =>
      kindsForCodec(codec, rawTypeToKind, id)))].sort(compareText);
    assert(inputHandleKinds.length + returnHandleKinds.length > 0,
      `${id}: borrowed-handle route has no reviewed handle representation`);

    if (operationClass === "checked-handle-input-terminal") {
      assert(inputHandleKinds.length > 0, `${id}: terminal route has no handle input`);
      assert(returnHandleKinds.length === 0, `${id}: terminal route unexpectedly returns a handle`);
      assert(!isInvalidatorName(binding.rawName), `${id}: terminal route has invalidating semantics`);
    } else if (operationClass === "checked-handle-return-capture") {
      assert(returnHandleKinds.length > 0, `${id}: reviewed producer has no handle return`);
    } else if (operationClass === "checked-child-engine-object-invalidate" ||
      operationClass === "checked-self-engine-object-invalidate") {
      assert(inputHandleKinds.length > 0, `${id}: reviewed invalidator has no handle input`);
      assert(returnHandleKinds.length === 0, `${id}: reviewed invalidator returns a handle`);
    } else {
      assert(operationClass === "declaration-token", `${id}: unsupported operation class '${operationClass}'`);
      assert(inputHandleKinds.includes("resource-declaration") || returnHandleKinds.includes("resource-declaration"),
        `${id}: declaration route does not carry resource_data`);
    }

    rows.push({
      id,
      stableId,
      rawName: binding.rawName,
      modulePath: accountingRow.modulePath,
      member: accountingRow.member,
      source: binding.source,
      line: binding.line,
      censusBasis: censusBasisById.get(id),
      loweringFamily: binding.loweringFamily,
      operationClass,
      invalidatedIdentity: operationClass === "checked-child-engine-object-invalidate" ? "child-index" :
        operationClass === "checked-self-engine-object-invalidate" ? "self-underlying" : null,
      hostHandleEffect: operationClass === "checked-handle-return-capture" ? "capture-return" :
        operationClass === "declaration-token" ? "not-runtime" : "preserve",
      requiredContext: resolveContext(binding, operationClass, override.contextRules),
      inputHandleKinds,
      returnHandleKinds
    });
  }

  const operationClassCounts = countBy(rows, ({ operationClass }) => operationClass);
  for (const operationClass of OPERATION_CLASSES) {
    expectReviewedCount({
      input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
      label: `borrowed-handle operation class census:${operationClass}`,
      expected: override.expectedCounts[operationClass], observed: operationClassCounts[operationClass] ?? 0
    });
  }
  expectReviewedCount({
    input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
    label: "borrowed-handle operation class coverage",
    expected: override.expectedCounts.total, observed: rows.length
  });
  assert(Object.values(operationClassCounts).reduce((sum, count) => sum + count, 0) === rows.length,
    "borrowed-handle operation classes are not mutually exclusive");

  const handleKinds = [...override.handleKinds]
    .filter(({ id }) => !withdrawnKinds.has(id))
    .sort((left, right) => compareText(left.id, right.id))
    .map(({ representationExceptions, representationFeature, ...kind }) => {
      const representations = representationsByKind.get(kind.id);
      const featureScoped = representations.some(({ feature }) => feature !== null);
      return {
        ...kind,
        rawTypes: [...kind.rawTypes].sort(compareText),
        // `representation` remains the representation under which this kind is
        // a runtime identity at all; `representations` is the authority on
        // which backend feature produces which, and is the only place to read
        // it from when more than one does.
        representationIsFeatureScoped: featureScoped,
        representations,
        capturableFeatures: featureScoped
          ? representations.filter(({ capturable }) => capturable).map(({ feature }) => feature)
          : null,
        uncapturableFeatures: featureScoped
          ? representations.filter(({ capturable }) => !capturable).map(({ feature }) => feature)
          : null
      };
    });
  const inputEvidence = {
    scriptIrSha256: sha256(inputs.irText),
    scriptApiAccountingSha256: sha256(inputs.accountingText),
    bindingPatternsSha256: sha256(inputs.patternsText),
    classificationOverrideSha256: sha256(inputs.overrideText),
    defoldSources: [...override.sourceEvidence]
      .sort((left, right) => compareText(left.source, right.source))
      .map(({ id, source, sha256: hash }) => ({ id, path: `upstream/defold/${source}`, sha256: hash }))
  };
  inputEvidence.aggregateInputSha256 = sha256([
    inputEvidence.scriptIrSha256,
    inputEvidence.scriptApiAccountingSha256,
    inputEvidence.bindingPatternsSha256,
    inputEvidence.classificationOverrideSha256,
    ...inputEvidence.defoldSources.map(({ path, sha256: hash }) => `${path}\0${hash}`)
  ].join("\0"));

  return {
    schemaVersion: 2,
    defoldRevision: ir.defoldRevision,
    scope: "Every pending borrowed-handle route in the pinned script API accounting artifact, exactly once",
    coverageClaim: override.coverageClaim,
    allocationClaim: override.allocationClaim,
    inputEvidence,
    routeCount: rows.length,
    operationClassCounts,
    censusBasisCounts: countBy(rows, ({ censusBasis }) => censusBasis),
    moduleCounts: countBy(rows, ({ rawName }) => rawName.split(".")[0]),
    operationClassModuleCounts: Object.fromEntries(OPERATION_CLASSES.map((operationClass) => [
      operationClass,
      countBy(rows.filter((row) => row.operationClass === operationClass), ({ rawName }) => rawName.split(".")[0])
    ])),
    implementationOrder: override.implementationOrder,
    handleKinds,
    rows
  };
}

async function loadInputs() {
  const [irText, accountingText, patternsText, overrideText] = await Promise.all([
    readFile(inputUrls.ir, "utf8"),
    readFile(inputUrls.accounting, "utf8"),
    readFile(inputUrls.patterns, "utf8"),
    readFile(inputUrls.override, "utf8")
  ]);
  const override = parse(overrideText, "borrowed-handle override");
  // Tolerant on purpose: the whole `bullet3d` backend is cited and Defold
  // 1.13.1 ships none of it. A bare `readFile` died with ENOENT on the first of
  // those five files.
  const loaded = await loadReviewedSources({
    input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
    defoldRoot: fileURLToPath(new URL("upstream/defold", root)),
    evidence: override.sourceEvidence,
    derived: parse(irText, "script API IR").defoldRevision
  });
  return {
    irText, accountingText, patternsText, overrideText,
    sourceTexts: loaded.texts, withdrawnSources: loaded.withdrawn
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const report = generateBorrowedHandleClassification(await loadInputs());
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    const existing = await readFile(outputUrl, "utf8");
    if (existing !== serialized) throw new Error(`${outputUrl.pathname} is stale; regenerate borrowed-handle classification`);
  } else {
    await writeFile(outputUrl, serialized);
  }
  console.log(`${check ? "Verified" : "Generated"} borrowed-handle classification: ` +
    `${report.operationClassCounts["checked-handle-input-terminal"]} terminals, ` +
    `${report.operationClassCounts["checked-handle-return-capture"]} producers, ` +
    `${report.operationClassCounts["checked-child-engine-object-invalidate"]} child invalidators, ` +
    `${report.operationClassCounts["checked-self-engine-object-invalidate"]} self invalidators, ` +
    `${report.operationClassCounts["declaration-token"]} declarations, ${report.routeCount} total.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
