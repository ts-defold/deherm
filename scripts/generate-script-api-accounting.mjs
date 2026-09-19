#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { generateScriptBindingDescriptors } from "./generate-script-binding-descriptors.mjs";
import { generateScriptUrlAddressClassification } from "./generate-script-url-address-classification.mjs";
import { componentProxyConstants } from "../packages/compiler/src/component-proxy-contract.mjs";
import {
  selectUniversalRoutes,
  universalTargetSupport
} from "./lib/script-universal-selection.mjs";

import { expectSameRevision } from "./lib/reviewed-revision.mjs";

const root = new URL("../", import.meta.url);
const inputUrls = {
  inventory: new URL("packages/bindings/generated/defold-script-api-inventory.json", root),
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  descriptors: new URL("packages/bindings/generated/defold-script-binding-descriptors.json", root),
  scalar: new URL("packages/bindings/generated/defold-script-scalar-dispatch.json", root),
  value: new URL("packages/bindings/generated/defold-script-value-bindings.json", root),
  tuple: new URL("packages/bindings/generated/defold-script-fixed-tuples.json", root),
  url: new URL("packages/bindings/generated/defold-script-url-address-classification.json", root),
  valueTail: new URL("packages/bindings/generated/defold-script-value-tail-bindings.json", root),
  overload: new URL("packages/bindings/generated/defold-script-overload-dispatch.json", root),
  universalPolicy: new URL("packages/bindings/overrides/script-universal-value-bindings.json", root)
};
const valueDefinitionUrls = [
  new URL("packages/bindings/overrides/script-defold-value-bindings.json", root),
  new URL("packages/bindings/overrides/script-defold-handle-bindings.json", root),
  new URL("packages/bindings/overrides/script-go-current-instance-bindings.json", root),
  new URL("packages/bindings/overrides/script-msg-structured-bindings.json", root),
  new URL("packages/bindings/overrides/script-factory-structured-bindings.json", root),
  new URL("packages/bindings/overrides/script-gui-structured-bindings.json", root)
];
const urlOverrideUrl = new URL("packages/bindings/overrides/script-url-address-classification.json", root);
const outputUrl = new URL("packages/bindings/generated/defold-script-api-accounting.json", root);
const componentPropertyCompilerIds = new Set([
  "script:go.property",
  ...Object.values(componentProxyConstants.resourceKinds).map((kind) => `script:resource.${kind}`)
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parse(text, name) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalUrlReport(report) {
  return {
    ...report,
    rows: [...report.rows].sort((left, right) => compareText(left.id, right.id))
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateValueDefinitions(valueReport, definitionInputs, irFunctions, patternById) {
  const expected = [];
  const definitionEvidence = [];
  const sourceEvidence = [];
  for (const input of definitionInputs) {
    const definition = parse(input.definitionText, input.path);
    assert(definition.schemaVersion === 2, `${input.path} has an unsupported schema`);
    assert(Array.isArray(definition.bindings), `${input.path} has no binding rows`);
    const sourceHash = sha256(input.sourceText);
    assert(sourceHash === definition.sourceSha256, `${input.path} is stale against ${definition.source}`);
    definitionEvidence.push({
      definitionPath: input.path,
      definitionSha256: sha256(input.definitionText)
    });
    sourceEvidence.push({
      sourcePath: `upstream/defold/${definition.source}`,
      sourceSha256: sourceHash
    });
    const declaredAdditional = definition.additionalSourceEvidence ?? [];
    assert(declaredAdditional.length === input.additionalSources.length,
      `${input.path} has incomplete additional source evidence`);
    for (const declared of declaredAdditional) {
      const loaded = input.additionalSources.find(({ source }) => source === declared.source);
      assert(loaded, `${input.path} did not load ${declared.source}`);
      const additionalHash = sha256(loaded.sourceText);
      assert(additionalHash === declared.sourceSha256,
        `${input.path} is stale against ${declared.source}`);
      for (const anchor of declared.anchors ?? []) {
        assert(loaded.sourceText.includes(anchor),
          `${input.path}: additional source anchor '${anchor}' is stale`);
      }
      sourceEvidence.push({
        sourcePath: `upstream/defold/${declared.source}`,
        sourceSha256: additionalHash
      });
    }
    for (const binding of definition.bindings) {
      const sourceSymbol = new RegExp(
        `(?:static\\s+)?int\\s+${escapeRegex(binding.sourceSymbol)}\\s*\\(lua_State\\s*\\*\\s*L\\)`);
      assert(sourceSymbol.test(input.sourceText),
        `${binding.id}: reviewed source symbol '${binding.sourceSymbol}' is stale`);
      if (binding.sourceOperation) {
        const operations = Array.isArray(binding.sourceOperation)
          ? binding.sourceOperation
          : [binding.sourceOperation];
        for (const operation of operations) {
          assert(typeof operation === "string" && input.sourceText.includes(operation),
            `${binding.id}: reviewed source operation '${operation}' is stale`);
        }
      }
      expected.push(binding);
    }
    for (const family of definition.families ?? []) {
      const selector = family.selector;
      const rows = valueReport.bindings.filter(({ generatedFamily }) => generatedFamily === family.id);
      assert(rows.length === selector.expectedRouteCount,
        `${family.id}: generated route count differs from reviewed family metadata`);
      if (family.id === "vmath-fixed-pod") {
        const allowedTypes = new Set(selector.allowedTypes);
        const terminals = new Map(selector.terminalOperations.map((terminal) => [terminal.operator, terminal]));
        assert(terminals.size === selector.terminalOperations.length,
          "vmath-fixed-pod contains duplicate terminal operations");
        for (const row of rows) {
          const fn = irFunctions.find(({ id }) => id === row.id);
          const terminal = terminals.get(row.operation?.parameters?.operator);
          assert(fn && sameJson(fn.modulePath, selector.modulePath) &&
            patternById.get(row.id)?.loweringFamily === selector.loweringFamily &&
            !selector.excludedIds.includes(row.id) && fn.returns.length === 1 &&
            fn.parameters.every(({ rawType }) => rawType.split("|").every((type) => allowedTypes.has(type))) &&
            fn.returns.every((type) => allowedTypes.has(type)),
          `${row.id}: generated vmath family selector no longer matches pinned IR/classification`);
          assert(terminal && sameJson(row.implementedCallShapes, terminal.implementedCallShapes) &&
            row.resultCodec === terminal.resultCodec && sameJson(row.generatedProbe, terminal.probe),
          `${row.id}: generated vmath terminal contract is stale`);
          const expectedParameters = { ...family.operation.parameters, operator: terminal.operator };
          assert(row.operation.template === family.operation.template &&
            sameJson(row.operation.parameters, expectedParameters),
          `${row.id}: generated vmath operation is stale`);
          assert(Array.isArray(row.sourceOperation) && row.sourceOperation.includes(terminal.sourceAnchor) &&
            row.sourceOperation.every((anchor) => input.sourceText.includes(anchor)),
          `${row.id}: generated vmath source evidence is stale`);
          expected.push(row);
        }
        continue;
      }
      if (family.id === "vmath-matrix4") {
        const allowedTypes = new Set(selector.allowedTypes);
        const terminals = new Map(selector.terminalOperations.map((terminal) => [terminal.id, terminal]));
        assert(terminals.size === selector.terminalOperations.length &&
          sameJson(selector.requiredIds, selector.terminalOperations.map(({ id }) => id)),
        "vmath-matrix4 contains duplicate or reordered terminal IDs");
        assert(rows.reduce((count, row) => count + row.implementedCallShapes.length, 0) ===
          selector.expectedCallShapeCount, "vmath-matrix4 generated call-shape count is stale");
        for (const row of rows) {
          const fn = irFunctions.find(({ id }) => id === row.id);
          const terminal = terminals.get(row.id);
          assert(fn && sameJson(fn.modulePath, selector.modulePath) &&
            selector.requiredIds.includes(row.id) &&
            patternById.get(row.id)?.loweringFamily === selector.loweringFamily &&
            fn.returns.length === 1 &&
            fn.parameters.every(({ rawType }) => rawType.split("|").every((type) => allowedTypes.has(type))) &&
            fn.returns.every((type) => allowedTypes.has(type)),
          `${row.id}: generated Matrix4 selector no longer matches pinned IR/classification`);
          assert(terminal && sameJson(row.implementedCallShapes, terminal.implementedCallShapes) &&
            row.resultCodec === terminal.resultCodec && sameJson(row.generatedProbe, terminal.probe),
          `${row.id}: generated Matrix4 terminal contract is stale`);
          const expectedParameters = { ...family.operation.parameters, operator: terminal.operator };
          assert(row.operation.template === family.operation.template &&
            sameJson(row.operation.parameters, expectedParameters),
          `${row.id}: generated Matrix4 operation is stale`);
          const anchors = [terminal.sourceAnchor, ...(terminal.extraSourceAnchors ?? [])];
          assert(Array.isArray(row.sourceOperation) &&
            anchors.every((anchor) => row.sourceOperation.includes(anchor)) &&
            row.sourceOperation.every((anchor) => input.sourceText.includes(anchor)),
          `${row.id}: generated Matrix4 source evidence is stale`);
          expected.push(row);
        }
        continue;
      }
      assert(family.id === "gui-node-setters", `${input.path}: unknown generated family '${family.id}'`);
      for (const row of rows) {
        const fn = irFunctions.find(({ id }) => id === row.id);
        assert(fn && sameJson(fn.modulePath, selector.modulePath) &&
          fn.member.startsWith(selector.memberPrefix) &&
          fn.parameters[0]?.rawType === selector.firstParameterType &&
          fn.returns.length === selector.resultCount,
        `${row.id}: generated family selector no longer matches pinned IR`);
        assert(fn.parameters.every(({ rawType }) => rawType.split("|").every((type) => selector.typeCodecs[type])),
          `${row.id}: generated family contains an unreviewed type codec`);
        assert(sameJson(row.operation, family.operation), `${row.id}: generated family operation is stale`);
        assert(sameJson(row.familyTypeCodecs, selector.typeCodecs), `${row.id}: generated family codec map is stale`);
        assert(typeof row.sourceOperation === "string" && input.sourceText.includes(row.sourceOperation),
          `${row.id}: generated family registration evidence is stale`);
        expected.push(row);
      }
    }
  }

  const expectedById = uniqueMap(expected, "value definitions");
  const actualById = uniqueMap(valueReport.bindings, "value report");
  assert(valueReport.bindingCount === valueReport.bindings.length, "value report bindingCount is stale");
  assert(expectedById.size === actualById.size, "value report does not match reviewed value definitions");
  for (const [id, reviewed] of expectedById) {
    const actual = actualById.get(id);
    assert(actual, `${id}: reviewed value binding is missing from the generated value report`);
    for (const field of ["sourceSymbol", "sourceOperation", "operation", "callShapes", "implementedCallShapes", "resultCodec"]) {
      if (reviewed[field] !== undefined) {
        assert(sameJson(actual[field], reviewed[field]), `${id}: value report ${field} is stale`);
      }
    }
  }
  assert(sameJson(valueReport.sourceEvidence, sourceEvidence.map(({ sourcePath, sourceSha256 }) => ({
    path: sourcePath,
    sha256: sourceSha256
  }))), "value report source evidence is stale");
  return { definitionEvidence, sourceEvidence };
}

function pendingReason(pattern) {
  return {
    code: "lowering-family-awaits-executable-generator",
    loweringFamily: pattern.loweringFamily,
    traits: pattern.traits,
    unresolvedTypes: pattern.unresolvedTypes
  };
}

export function generateScriptApiAccounting(inputs) {
  const inventory = parse(inputs.inventoryText, "script API inventory");
  const ir = parse(inputs.irText, "script IR");
  const patterns = parse(inputs.patternsText, "binding patterns");
  const descriptors = parse(inputs.descriptorsText, "binding descriptors");
  const scalar = parse(inputs.scalarText, "scalar dispatch report");
  const value = parse(inputs.valueText, "value binding report");
  const url = parse(inputs.urlText, "URL binding report");
  const valueTail = parse(inputs.valueTailText, "value-tail binding report");
  const overload = parse(inputs.overloadText, "overload-dispatch report");
  const universalPolicy = parse(inputs.universalPolicyText, "universal-value fallback policy");

  expectSameRevision({
    label: "script API accounting",
    inputs: [
      { path: "packages/bindings/generated/defold-script-api-ir.json", revision: ir.defoldRevision },
      { path: "packages/bindings/generated/defold-script-api-inventory.json", revision: inventory.defoldRevision },
      { path: "packages/bindings/generated/defold-script-binding-patterns.json", revision: patterns.defoldRevision },
      { path: "packages/bindings/generated/defold-script-binding-descriptors.json", revision: descriptors.defoldRevision },
      { path: "packages/bindings/generated/defold-script-scalar-dispatch.json", revision: scalar.defoldRevision },
      { path: "packages/bindings/generated/defold-script-value-bindings.json", revision: value.defoldRevision },
      { path: "packages/bindings/generated/defold-script-url-address-classification.json", revision: url.defoldRevision },
      { path: "packages/bindings/generated/defold-script-value-tail-bindings.json", revision: valueTail.defoldRevision },
      { path: "packages/bindings/generated/defold-script-overload-dispatch.json", revision: overload.defoldRevision }
    ]
  });
  assert(ir.counts?.functions === ir.functions.length, "script IR function count is stale");
  const functionById = uniqueMap(ir.functions, "script IR");
  const inventoryFunctions = inventory.declarations.filter(({ kind }) => kind === "function");
  assert(inventory.countsByKind?.function === inventoryFunctions.length, "script inventory function count is stale");
  const inventoryById = uniqueMap(inventoryFunctions.map((entry) => ({ ...entry, id: `script:${entry.name}` })), "script inventory");
  assert(inventoryById.size === functionById.size, "script IR does not contain every inventoried function");
  for (const [id, inventoried] of inventoryById) {
    const fn = functionById.get(id);
    assert(fn, `${id}: inventoried function is missing from script IR`);
    assert(fn.rawName === inventoried.name, `${id}: script IR raw name differs from inventory`);
    assert(fn.source === inventoried.source, `${id}: script IR source differs from inventory`);
    assert(fn.line === inventoried.line, `${id}: script IR source line differs from inventory`);
  }

  assert(patterns.sourceSha256 === sha256(inputs.irText), "binding patterns are stale against script IR");
  assert(url.inputEvidence?.scriptIrSha256 === sha256(inputs.irText),
    "URL bindings are stale against script IR");
  assert(url.inputEvidence?.bindingPatternsSha256 === sha256(inputs.patternsText),
    "URL bindings are stale against binding patterns");
  assert(valueTail.inputEvidence?.scriptIrSha256 === sha256(inputs.irText) &&
    valueTail.inputEvidence?.bindingPatternsSha256 === sha256(inputs.patternsText) &&
    valueTail.inputEvidence?.valueBindingsSha256 === sha256(inputs.valueText) &&
    valueTail.inputEvidence?.urlBindingsSha256 === sha256(inputs.urlText),
  "value-tail bindings are stale against their generated inputs");
  assert(overload.inputEvidence?.scriptIrSha256 === sha256(inputs.irText) &&
    overload.inputEvidence?.bindingPatternsSha256 === sha256(inputs.patternsText) &&
    overload.inputEvidence?.alreadyOwnedReportSha256 === sha256(inputs.valueText),
  "overload-dispatch bindings are stale against their generated inputs");
  const expectedUrl = generateScriptUrlAddressClassification({
    irText: inputs.irText,
    patternsText: inputs.patternsText,
    overrideText: inputs.urlOverrideText,
    sourceTexts: inputs.urlSourceTexts
  });
  assert(sameJson(canonicalUrlReport(url), canonicalUrlReport(expectedUrl)),
    "URL binding report semantics are stale against pinned inputs");
  const patternById = uniqueMap(patterns.bindings, "binding patterns");
  assert(patterns.classifiedFunctionCount === patterns.bindings.length, "binding pattern count is stale");
  assert(patterns.pendingFunctionCount === patterns.bindings.length, "binding patterns do not classify every runtime-pending function");

  const regeneratedDescriptors = generateScriptBindingDescriptors(ir, patterns).artifact;
  assert(sameJson(descriptors, regeneratedDescriptors), "binding descriptors are stale against script IR or patterns");
  const descriptorIds = descriptors.cold.stableKeys;
  assert(descriptors.bindingCount === descriptorIds.length, "binding descriptor count is stale");
  assert(new Set(descriptorIds).size === descriptorIds.length, "binding descriptors contain duplicate ids");

  const pendingIrIds = ir.functions
    .filter(({ runtimeStatus }) => runtimeStatus === "requires-universal-lua-bridge")
    .map(({ id }) => id)
    .sort(compareText);
  assert(sameJson(descriptorIds, pendingIrIds), "binding descriptors omit or add runtime-pending script APIs");
  assert(sameJson([...patternById.keys()].sort(compareText), pendingIrIds),
    "binding patterns omit or add runtime-pending script APIs");

  const scalarById = uniqueMap(scalar.bindings, "scalar dispatch report");
  assert(scalar.bindingCount === scalar.bindings.length, "scalar dispatch bindingCount is stale");
  const classifiedScalarIds = patterns.bindings
    .filter(({ loweringFamily }) => loweringFamily === "scalar")
    .map(({ id }) => id)
    .sort(compareText);
  assert(sameJson([...scalarById.keys()].sort(compareText), classifiedScalarIds),
    "scalar dispatch report is stale against scalar-classified bindings");

  const valueEvidence = validateValueDefinitions(value, inputs.valueDefinitions, ir.functions, patternById);
  const valueById = uniqueMap(value.bindings, "value binding report");
  for (const id of valueById.keys()) {
    assert(patternById.has(id), `${id}: executable value route is not a runtime-pending descriptor`);
    assert(!scalarById.has(id), `${id}: appears in both scalar and value executable route reports`);
  }
  const tuple = parse(inputs.tupleText, "fixed tuple report");
  const tupleById = uniqueMap(tuple.bindings, "fixed tuple report");
  for (const id of tupleById.keys()) {
    assert(patternById.has(id), `${id}: executable tuple route is not a runtime-pending descriptor`);
    assert(!scalarById.has(id) && !valueById.has(id), `${id}: executable tuple route overlaps another generator`);
  }
  const urlById = uniqueMap(url.rows, "URL binding report");
  assert(url.routeCount === url.rows.length, "URL binding routeCount is stale");
  for (const [id, row] of urlById) {
    assert(patternById.get(id)?.loweringFamily === "defold-value",
      `${id}: generated URL route is not a defold-value descriptor`);
    assert(!scalarById.has(id) && !valueById.has(id) && !tupleById.has(id),
      `${id}: generated URL route overlaps another executable generator`);
    assert(row.routing?.status === "generated-native-dynamic" &&
      row.targetSupport?.nativeDynamicHermes?.status === "generated-executable",
    `${id}: URL route lacks generated native-dynamic disposition`);
  }
  const valueTailCandidates = valueTail.bindings.filter(({ disposition }) => disposition === "candidate");
  const valueTailById = uniqueMap(valueTailCandidates, "value-tail binding report candidates");
  assert(valueTail.routeCount === valueTail.bindings.length &&
    valueTail.candidateCount === valueTailCandidates.length && valueTail.candidateCount === 16,
  "value-tail binding census is stale");
  for (const [id, row] of valueTailById) {
    assert(patternById.get(id)?.loweringFamily === "defold-value",
      `${id}: generated value-tail route is not a defold-value descriptor`);
    assert(!scalarById.has(id) && !valueById.has(id) && !tupleById.has(id) && !urlById.has(id),
      `${id}: generated value-tail route overlaps another executable generator`);
    assert(row.backend === "captured-lua-exact-call" && valueTail.targetSupport?.nativeDynamicHermes === "generated-executable-shared-script-adapter",
      `${id}: value-tail route lacks generated native-dynamic disposition`);
    assert(row.requiredContext === "script-instance",
      `${id}: value-tail route lacks the supported game-object script context`);
  }
  const overloadCandidates = overload.bindings.filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate);
  const overloadById = uniqueMap(overloadCandidates, "overload-dispatch report candidates");
  assert(overload.routeCount === overload.bindings.length &&
    overload.generatedFamilyCandidateCount === overloadCandidates.length && overload.generatedFamilyCandidateCount === 8,
  "overload-dispatch binding census is stale");
  for (const [id, row] of overloadById) {
    assert(patternById.get(id)?.loweringFamily === "overload-dispatch",
      `${id}: generated overload route is not an overload-dispatch descriptor`);
    assert(!scalarById.has(id) && !valueById.has(id) && !tupleById.has(id) && !urlById.has(id) && !valueTailById.has(id),
      `${id}: generated overload route overlaps another executable generator`);
    assert(row.targetSupport?.nativeDynamicHermes === "generated-executable-shared-script-adapter",
      `${id}: overload route lacks generated native-dynamic disposition`);
  }

  const executableById = new Map();
  const stableIdOwners = new Map();
  for (const [generator, rows] of [
    ["scalar-lua-dispatch", scalar.bindings],
    ["native-value-dispatch", value.bindings],
    ["fixed-tuple-lua-dispatch", tuple.bindings],
    ["url-lua-dispatch", url.rows],
    ["captured-lua-value-tail-dispatch", valueTailCandidates],
    ["captured-lua-overload-dispatch", overloadCandidates]
  ]) {
    for (const row of rows) {
      const expectedStableId = stableBindingId(row.id);
      const routeStableId = typeof row.stableId === "string" ? Number.parseInt(row.stableId) : row.stableId;
      assert(routeStableId === expectedStableId, `${row.id}: stale or invalid stable ID`);
      const owner = stableIdOwners.get(routeStableId);
      assert(!owner, `stable ID collision between '${owner}' and '${row.id}'`);
      stableIdOwners.set(routeStableId, row.id);
      executableById.set(row.id, {
        generator,
        stableId: routeStableId,
        ...(generator === "native-value-dispatch" ? {
          callShapes: row.callShapes,
          implementedCallShapes: row.implementedCallShapes,
          ...(row.generatedFamily ? { generatedFamily: row.generatedFamily } : {})
        } : {}),
        ...(generator === "fixed-tuple-lua-dispatch" ? {
          resultCount: row.results.length,
          publicTypeScriptFixture: row.targetSupport.publicTypeScriptFixture
        } : {}),
        ...(generator === "url-lua-dispatch" ? {
          requiredArgumentCount: row.requiredArgumentCount,
          maximumArgumentCount: row.maximumArgumentCount,
          targetSupport: row.targetSupport
        } : {}),
        ...(generator === "captured-lua-value-tail-dispatch" ? {
          callShapes: row.callShapes,
          resultCodec: row.resultCodec,
          targetSupport: valueTail.targetSupport
        } : {}),
        ...(generator === "captured-lua-overload-dispatch" ? {
          callShapes: row.callShapes,
          targetSupport: row.targetSupport
        } : {})
      });
    }
  }

  const universal = selectUniversalRoutes(ir.functions.flatMap((fn) => {
    const pattern = patternById.get(fn.id);
    if (!pattern) return [];
    return [{
      id: fn.id,
      modulePath: fn.modulePath,
      member: fn.member,
      loweringFamily: pattern.loweringFamily,
      contextToken: componentPropertyCompilerIds.has(fn.id) ? "component-property-compiler" : "runtime-context-selected-later",
      parameters: fn.parameters,
      overloadTokens: fn.overloads,
      resultCount: fn.returns.length,
      variadic: pattern.traits.includes("variable-arguments") || pattern.traits.includes("variable-results")
    }];
  }), universalPolicy);
  for (const row of universal.selected) {
    const pattern = patternById.get(row.id);
    assert(pattern, `${row.id}: universal fallback route is not a runtime descriptor`);
    assert(pattern.loweringFamily === row.loweringFamily,
      `${row.id}: universal fallback lowering family differs from classification`);
    const expectedStableId = stableBindingId(row.id);
    assert(row.stableId === expectedStableId, `${row.id}: universal fallback has a stale stable ID`);
    if (executableById.has(row.id)) continue;
    const owner = stableIdOwners.get(row.stableId);
    assert(!owner, `stable ID collision between '${owner}' and '${row.id}'`);
    stableIdOwners.set(row.stableId, row.id);
    executableById.set(row.id, {
      generator: "universal-value-fallback",
      stableId: row.stableId,
      minimumArgumentCount: row.minimumArgumentCount,
      maximumArgumentCount: row.maximumArgumentCount,
      resultCount: row.resultCount,
      targetSupport: universalTargetSupport
    });
  }

  const descriptorStableIds = new Map(descriptorIds.map((id, index) => [id, descriptors.hot.stableId[index]]));
  for (const [id, executable] of executableById) {
    assert(descriptorStableIds.get(id) === executable.stableId,
      `${id}: executable and descriptor stable IDs differ`);
  }

  const rows = [];
  const categoryCounts = {
    "executable-stable-id": 0,
    "component-property-compiler": 0,
    "separate-module": 0,
    pending: 0
  };
  const pendingByLoweringFamily = {};
  for (const fn of [...ir.functions].sort((left, right) => compareText(left.id, right.id))) {
    const base = {
      id: fn.id,
      rawName: fn.rawName,
      modulePath: fn.modulePath.join("."),
      member: fn.member,
      source: fn.source,
      line: fn.line
    };
    const executable = executableById.get(fn.id);
    if (executable) {
      assert(fn.runtimeStatus === "requires-universal-lua-bridge",
        `${fn.id}: stable-ID route has unexpected IR runtime status '${fn.runtimeStatus}'`);
      rows.push({ ...base, category: "executable-stable-id", evidence: executable });
      categoryCounts["executable-stable-id"] += 1;
      continue;
    }
    if (componentPropertyCompilerIds.has(fn.id)) {
      assert(fn.runtimeStatus === "requires-universal-lua-bridge" && patternById.has(fn.id),
        `${fn.id}: component-property intrinsic is no longer present in the generated script surface`);
      rows.push({
        ...base,
        category: "component-property-compiler",
        evidence: {
          generator: componentProxyConstants.generator,
          lowering: "static-typescript-property-to-generated-lua-declaration",
          runtimeCall: false
        }
      });
      categoryCounts["component-property-compiler"] += 1;
      continue;
    }
    if (fn.runtimeStatus === "implemented-generated-lua-bridge") {
      assert(!patternById.has(fn.id), `${fn.id}: separate-module API also appears in pending patterns`);
      rows.push({
        ...base,
        category: "separate-module",
        evidence: { generator: "generated-lua-bridge", runtimeStatus: fn.runtimeStatus }
      });
      categoryCounts["separate-module"] += 1;
      continue;
    }
    assert(fn.runtimeStatus === "requires-universal-lua-bridge",
      `${fn.id}: unknown IR runtime status '${fn.runtimeStatus}'`);
    const pattern = patternById.get(fn.id);
    assert(pattern, `${fn.id}: pending API has no generated lowering reason`);
    const reason = pendingReason(pattern);
    rows.push({ ...base, category: "pending", reason });
    categoryCounts.pending += 1;
    pendingByLoweringFamily[reason.loweringFamily] = (pendingByLoweringFamily[reason.loweringFamily] ?? 0) + 1;
  }

  assert(rows.length === ir.functions.length, "script API accounting omitted functions");
  assert(new Set(rows.map(({ id }) => id)).size === rows.length, "script API accounting duplicates functions");
  assert(Object.values(categoryCounts).reduce((sum, count) => sum + count, 0) === ir.functions.length,
    "script API categories do not form an exact partition");

  const sourceHashes = {
    scriptInventorySha256: sha256(inputs.inventoryText),
    scriptIrSha256: sha256(inputs.irText),
    bindingPatternsSha256: sha256(inputs.patternsText),
    bindingDescriptorsSha256: sha256(inputs.descriptorsText),
    scalarDispatchSha256: sha256(inputs.scalarText),
    valueBindingsSha256: sha256(inputs.valueText),
    fixedTupleBindingsSha256: sha256(inputs.tupleText),
    urlBindingsSha256: sha256(inputs.urlText),
    valueTailBindingsSha256: sha256(inputs.valueTailText),
    overloadDispatchSha256: sha256(inputs.overloadText),
    universalValuePolicySha256: sha256(inputs.universalPolicyText),
    universalValueSelectionSha256: sha256(JSON.stringify(universal.selected))
  };
  const aggregateInputSha256 = sha256([
    ...Object.entries(sourceHashes).map(([name, hash]) => `${name}\0${hash}`),
    ...valueEvidence.definitionEvidence.flatMap((entry) => [
      `${entry.definitionPath}\0${entry.definitionSha256}`,
    ]),
    ...valueEvidence.sourceEvidence.map((entry) =>
      `${entry.sourcePath}\0${entry.sourceSha256}`
    )
  ].join("\0"));

  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "Every function in the pinned Defold script API IR, exactly once",
    coverageClaim: "Accounting only. Executable means a generated stable-ID route exists; component-property-compiler means the TypeScript AST is deterministically lowered to a Defold Lua declaration and no runtime call exists; neither category claims per-target or per-function engine conformance.",
    inputEvidence: {
      ...sourceHashes,
      valueDefinitions: valueEvidence.definitionEvidence,
      valueSources: valueEvidence.sourceEvidence,
      aggregateInputSha256
    },
    functionCount: rows.length,
    categoryCounts,
    pendingByLoweringFamily: Object.fromEntries(Object.entries(pendingByLoweringFamily).sort(([left], [right]) => compareText(left, right))),
    rows
  };
}

async function loadInputs() {
  const texts = Object.fromEntries(await Promise.all(Object.entries(inputUrls).map(async ([name, url]) =>
    [name, await readFile(url, "utf8")]
  )));
  const valueDefinitions = await Promise.all(valueDefinitionUrls.map(async (definitionUrl) => {
    const definitionText = await readFile(definitionUrl, "utf8");
    const definition = parse(definitionText, definitionUrl.pathname);
    const sourceUrl = new URL(`upstream/defold/${definition.source}`, root);
    const additionalSources = await Promise.all((definition.additionalSourceEvidence ?? []).map(async ({ source }) => ({
      source,
      sourceText: await readFile(new URL(`upstream/defold/${source}`, root), "utf8")
    })));
    return {
      path: definitionUrl.pathname.slice(root.pathname.length),
      definitionText,
      sourceText: await readFile(sourceUrl, "utf8"),
      additionalSources
    };
  }));
  const urlOverrideText = await readFile(urlOverrideUrl, "utf8");
  const urlOverride = parse(urlOverrideText, urlOverrideUrl.pathname);
  const urlSourceTexts = new Map(await Promise.all(urlOverride.sourceEvidence.map(async ({ source }) => [
    source,
    await readFile(new URL(`upstream/defold/${source}`, root), "utf8")
  ])));
  return {
    inventoryText: texts.inventory,
    irText: texts.ir,
    patternsText: texts.patterns,
    descriptorsText: texts.descriptors,
    scalarText: texts.scalar,
    valueText: texts.value,
    tupleText: texts.tuple,
    urlText: texts.url,
    valueTailText: texts.valueTail,
    overloadText: texts.overload,
    universalPolicyText: texts.universalPolicy,
    urlOverrideText,
    urlSourceTexts,
    valueDefinitions
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const report = generateScriptApiAccounting(await loadInputs());
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    const existing = await readFile(outputUrl, "utf8");
    if (existing !== serialized) throw new Error(`${outputUrl.pathname} is stale; regenerate script API accounting`);
  } else {
    await writeFile(outputUrl, serialized);
  }
  console.log(`${check ? "Verified" : "Generated"} exact script API accounting: ` +
    `${report.categoryCounts["executable-stable-id"]} stable-ID, ` +
    `${report.categoryCounts["component-property-compiler"]} component-property compiler intrinsic, ` +
    `${report.categoryCounts["separate-module"]} separate-module, ${report.categoryCounts.pending} pending, ` +
    `${report.functionCount} total.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
