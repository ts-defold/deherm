import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  generateScriptCallbackLifecycle,
  loadScriptCallbackLifecycleInputs,
} from "../scripts/generate-script-callback-lifecycle.mjs";
import { generateScriptProjectionIr, loadScriptProjectionInputs } from "../scripts/generate-script-projection-ir.mjs";
import { generateUniversalValueBindings } from "../scripts/generate-script-universal-value-bindings.mjs";
import { generateBindingLoweringPlan, loadBindingLoweringInputs } from "../scripts/generate-binding-lowering-plan.mjs";
import { generateRecordingEngine } from "../scripts/generate-script-recording-engine.mjs";
import { runScriptBrowserCallbackExactCall } from "../scripts/check-script-browser-callback-exact-call.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const declarations = [
  { member: "retain_signal", parameters: ["fun(value:number)"], returns: [] },
  { member: "make_signal", parameters: [], returns: ["fun():number"] },
  { member: "wrap_signal", parameters: ["fun(value:number)"], returns: ["fun():number"] },
  { member: "nested_result", parameters: [], returns: ["{ result:{ continuation:fun():number } }"] },
  { member: "union_result", parameters: [], returns: ["number|{ continuation:fun():number }"] },
  {
    member: "nested_input",
    parameters: ["{ nested:{ first:fun(value:number), second:fun(value:number) } }"],
    returns: [],
  },
  { member: "optional_signal", parameters: ["fun(value:number)"], optional: true, returns: [] },
];
const identity = (member) => `script:future_signals.${member}`;
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function inputsWithNewRegistrations() {
  const [projectionInputs, lifecycleInputs, planInputs, policyText, classificationText, layoutsText, constantsText] =
    await Promise.all([
      loadScriptProjectionInputs(),
      loadScriptCallbackLifecycleInputs(),
      loadBindingLoweringInputs(root),
      readFile(path.join(root, "packages/bindings/overrides/script-universal-value-bindings.json"), "utf8"),
      readFile(
        path.join(root, "packages/bindings/generated/defold-script-borrowed-handle-classification.json"),
        "utf8",
      ),
      readFile(path.join(root, "packages/bindings/generated/defold-value-layouts.json"), "utf8"),
      readFile(path.join(root, "packages/bindings/generated/defold-script-constant-lowering.json"), "utf8"),
    ]);
  const ir = JSON.parse(projectionInputs.ir);
  const patterns = JSON.parse(projectionInputs.patterns);
  const accounting = JSON.parse(projectionInputs.accounting);
  const registrationGate = JSON.parse(projectionInputs.registrationGate);
  const source = ir.functions.find(({ id }) => id === "script:collectionproxy.load");
  const pattern = patterns.bindings.find(({ id }) => id === source.id);
  const account = accounting.rows.find(({ id }) => id === source.id);
  for (const declaration of declarations) {
    const id = identity(declaration.member);
    const rawName = id.slice("script:".length);
    const parameters = declaration.parameters.map((rawType, slot) => ({
      rawName: `argument_${slot}`,
      rawType,
      optional: declaration.optional === true,
    }));
    // These model newly discovered IR and registration evidence. Source parsing
    // is upstream of this fixture; no lifecycle policy or transport recipe is added.
    ir.functions.unshift({
      ...source,
      id,
      rawName,
      modulePath: ["future_signals"],
      member: declaration.member,
      jsName: declaration.member,
      parameters,
      returns: declaration.returns,
      overloads: [],
    });
    patterns.bindings.push({
      ...pattern,
      id,
      rawName,
      parameterCodecs: parameters.map(({ rawName: name, rawType, optional }) => ({
        name,
        rawType,
        optional,
        codecs: rawType.startsWith("fun(") ? ["callback"] : ["table"],
      })),
      returnCodecs: declaration.returns.map((rawType, index) => ({ index, rawType, codecs: [] })),
    });
    accounting.rows.push({
      ...account,
      id,
      rawName,
      modulePath: "future_signals",
      member: declaration.member,
      evidence: { ...account.evidence, stableId: stableBindingId(id) },
    });
    registrationGate.routeAuthority.push({
      route: rawName,
      state: "registered",
      targetStates: registrationGate.engineTargets.map(() => "registered"),
    });
  }
  ir.counts.functions = ir.functions.length;
  patterns.classifiedFunctionCount = patterns.bindings.length;
  accounting.functionCount = ir.functions.length;
  Object.assign(projectionInputs, {
    ir: serialize(ir),
    patterns: serialize(patterns),
    accounting: serialize(accounting),
    registrationGate: serialize(registrationGate),
  });
  Object.assign(lifecycleInputs, { irText: projectionInputs.ir, patternsText: projectionInputs.patterns });
  return {
    projectionInputs,
    lifecycleInputs,
    planInputs,
    universalInputs: { policyText, apiIrText: serialize(ir), classificationText, layoutsText, constantsText },
  };
}

function derive(inputs) {
  const callbacks = generateScriptCallbackLifecycle(inputs.lifecycleInputs);
  const projection = generateScriptProjectionIr({ ...inputs.projectionInputs, callbacks: serialize(callbacks) });
  const universal = generateUniversalValueBindings({
    ...inputs.universalInputs,
    projectionText: serialize(projection),
    callbacksText: serialize(callbacks),
  });
  const planInputs = {
    ...inputs.planInputs,
    scriptProjection: serialize(projection),
    scriptCallbackLifecycle: serialize(callbacks),
    scriptUniversalValue: serialize(universal.report),
  };
  const loweringPlan = generateBindingLoweringPlan(planInputs);
  const recordingInputs = {
    projection,
    universal: universal.report,
    handleLowering: JSON.parse(planInputs.scriptHandleLowering),
    valueLayouts: JSON.parse(planInputs.defoldValueLayouts),
    tableRecords: JSON.parse(planInputs.scriptTableRecords),
    valueBindings: JSON.parse(planInputs.scriptValueBindings),
    overloadDispatch: JSON.parse(planInputs.scriptOverloadDispatch),
    loweringPlan,
    inputHashes: {
      projection: sha256(planInputs.scriptProjection),
      universal: sha256(planInputs.scriptUniversalValue),
      handleLowering: sha256(planInputs.scriptHandleLowering),
      valueLayouts: sha256(planInputs.defoldValueLayouts),
    },
  };
  return { callbacks, projection, universal, loweringPlan, recording: generateRecordingEngine(recordingInputs) };
}

function declaredDerivation(t, revision) {
  const previous = { derived: process.env.DEHERM_DERIVED_REVISION, audit: process.env.DEHERM_REVISION_AUDIT };
  process.env.DEHERM_DERIVED_REVISION = revision;
  process.env.DEHERM_REVISION_AUDIT = "/dev/null";
  t.after(() => {
    for (const [key, value] of [
      ["DEHERM_DERIVED_REVISION", previous.derived],
      ["DEHERM_REVISION_AUDIT", previous.audit],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("new callback inputs fall back without reviewed lifecycle while callable results remain target restricted", async (t) => {
  const inputs = await inputsWithNewRegistrations();
  assert.throws(() => generateScriptCallbackLifecycle(inputs.lifecycleInputs), /census|missing reviewed lifecycle/);
  declaredDerivation(t, JSON.parse(inputs.projectionInputs.ir).defoldRevision);
  const generated = derive(inputs);
  const baselineCallbacks = JSON.parse(inputs.projectionInputs.callbacks);
  assert.deepEqual(
    generated.callbacks.routes.map(({ id }) => id),
    baselineCallbacks.routes.map(({ id }) => id),
    "unreviewed discovered APIs must not fabricate reviewed lifecycle rows",
  );
  assert.equal(generated.callbacks.routeCount, baselineCallbacks.routeCount);
  assert.equal(generated.callbacks.registryEligibleRouteCount, baselineCallbacks.registryEligibleRouteCount);
  const originalPlan = generateBindingLoweringPlan(inputs.planInputs);
  const unitsById = new Map(generated.loweringPlan.units.map((unit) => [unit.identity.id, unit]));
  for (const original of originalPlan.units) {
    const unit = unitsById.get(original.identity.id);
    for (const target of originalPlan.targetOrder) {
      assert.equal(
        unit.backends[target].selection,
        original.backends[target].selection,
        `${unit.identity.id}/${target}`,
      );
    }
    assert.deepEqual(
      generated.loweringPlan.tables.implementationSets[unit.implementationSet].map(({ lane }) => lane),
      originalPlan.tables.implementationSets[original.implementationSet].map(({ lane }) => lane),
      unit.identity.id,
    );
  }
  for (const declaration of declarations) {
    const id = identity(declaration.member);
    const projected = generated.projection.rows.find((row) => row.id === id);
    assert.equal(projected.registration.token, "registration-source-observed", id);
    assert.equal(projected.effects.callback.token, "callback-policy-unresolved", id);
    const binding = generated.universal.report.bindings.find((row) => row.id === id);
    const callableResult = declaration.returns.length !== 0;
    assert.deepEqual(binding.browserCallback, {
      registryEligible: !callableResult,
      reviewedLifecycle: false,
      lifetime: null,
      owner: null,
      threadAffinity: null,
      machineBlock: callableResult ? "blocked-higher-order-lua-closure" : null,
    });
    const unit = generated.loweringPlan.units.find(({ identity }) => identity.id === id);
    assert.equal(unit.backends.dynamicHermesJsi.selection, "emit", id);
    assert.equal(unit.backends.browserWasmHost.selection, callableResult ? "blocked-capability" : "emit", id);
    if (declaration.optional) assert.equal(unit.backends.staticHermesCAbi.selection, "emit", id);
    else assert.notEqual(unit.backends.staticHermesCAbi.selection, "emit", id);
    if (callableResult) {
      assert.ok(
        generated.loweringPlan.tables.blockerSets[unit.backends.browserWasmHost.blockerSet].includes(
          "higher-order-lua-closure-result-transport-unavailable",
        ),
        id,
      );
    }
  }
  const nested = generated.recording.report.routes.find(({ id }) => id === identity("nested_input"));
  assert.deepEqual(nested.exactVector.laneOverride.callbackSlots, [0, 0]);
  assert.deepEqual(nested.exactVector.laneOverride.callbackPaths, [
    [0, 0, 0],
    [0, 0, 1],
  ]);
  assert.deepEqual(nested.exactVector.laneOverride.lifecycle, { lifetime: null, owner: null, threadAffinity: null });

  // Withdraw actual reviewed source evidence through its owner, then regenerate
  // every consumer. Generic support must survive the loss of specialization.
  const reviewed = generated.callbacks.routes.find(({ registryEligible }) => registryEligible);
  assert.ok(reviewed, "the selected surface needs one reviewed input route for the withdrawal probe");
  const evidence = reviewed.evidence[0];
  const source = inputs.lifecycleInputs.sourceTexts.get(evidence.path);
  inputs.lifecycleInputs.sourceTexts.set(evidence.path, source.replace(evidence.anchors[0], "withdrawn source anchor"));
  const withdrawn = derive(inputs);
  assert.equal(
    withdrawn.callbacks.routes.some(({ id }) => id === reviewed.id),
    false,
  );
  const fallback = withdrawn.universal.report.bindings.find(({ id }) => id === reviewed.id);
  assert.equal(fallback.browserCallback.registryEligible, true);
  assert.equal(fallback.browserCallback.reviewedLifecycle, false);
  assert.equal(fallback.browserCallback.lifetime, null);
  const unit = withdrawn.loweringPlan.units.find(({ identity }) => identity.id === reviewed.id);
  assert.equal(unit.backends.browserWasmHost.selection, "emit");

  const mixed = {
    ...inputs.universalInputs,
    projectionText: serialize(withdrawn.projection),
    callbacksText: serialize({ ...withdrawn.callbacks, defoldRevision: "0".repeat(40) }),
  };
  assert.throws(() => generateUniversalValueBindings(mixed), /callback lifecycle input does not match/);
});

test(
  "unseen nested callback inputs execute repeatedly and release through the real browser/Wasm bridge",
  {
    skip: process.env.DEHERM_TEST_CALLBACK_FALLBACK_BROWSER !== "1" && "run the focused callback fallback browser gate",
  },
  async (t) => {
    const inputs = await inputsWithNewRegistrations();
    declaredDerivation(t, JSON.parse(inputs.projectionInputs.ir).defoldRevision);
    const generated = derive(inputs);
    const directory = await mkdtemp(path.join(tmpdir(), "deherm-callback-fallback-browser-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const save = async (relative, content) => {
      const destination = path.join(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, typeof content === "string" ? content : serialize(content));
    };
    const universalPaths = {
      header: "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_bindings.hpp",
      source: "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp",
      cHeader: "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_capi.h",
      cSource: "defold/defold_hermes/src/generated_script_universal_value_capi.cpp",
      browser: "defold/defold_hermes/lib/web/generated_script_universal_value.js",
    };
    await Promise.all([
      ...Object.entries(universalPaths).map(([key, relative]) => save(relative, generated.universal[key])),
      ...Object.entries(generated.recording.report.artifacts)
        .filter(([key]) => key !== "report")
        .map(([key, relative]) => save(relative, generated.recording[key])),
      save("packages/bindings/generated/defold-script-recording-engine.json", generated.recording.report),
    ]);
    const result = await runScriptBrowserCallbackExactCall({ sourceRoot: directory, environment: process.env });
    assert.equal(result.realWasmModule, true);
    assert.equal(result.mockMemory, false);
    assert.equal(result.callbackCount, generated.recording.report.summary.browserCallbackExact.callbackCount);
    assert.ok(result.transcript.some((line) => line.includes("DEHERM_SCRIPT_BROWSER_EXACT_OK")));
    assert.ok(
      result.transcript.includes(
        "DEHERM_SCRIPT_BROWSER_NESTED_CALLBACK_OK route=future_signals.nested_input callbacks=2 invocations=4 releases=2 reentries=4",
      ),
    );
  },
);
