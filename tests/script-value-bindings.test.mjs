import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generate, loadGenerationInputs } from "../scripts/generate-script-value-bindings.mjs";
import { generateScriptValueRealEngineProbes } from "../scripts/generate-script-value-real-engine-probes.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);

test("Defold value and handle bindings are deterministic structured descriptors", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-value-bindings.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
  const report = JSON.parse(await readFile(new URL(
    "packages/bindings/generated/defold-script-value-bindings.json", root), "utf8"));
  const nativeSource = await readFile(new URL(
    "defold/defold_hermes/src/generated_script_value_bindings.cpp", root), "utf8");
  assert.equal(report.bindingCount, 78);
  assert.equal(report.callShapeCount, 236);
  const familyBindings = report.bindings.filter(({ generatedFamily }) => generatedFamily === "gui-node-setters");
  assert.equal(familyBindings.length, 39);
  const vmathFamily = report.bindings.filter(({ generatedFamily }) => generatedFamily === "vmath-fixed-pod");
  assert.equal(vmathFamily.length, 11);
  assert.equal(vmathFamily.reduce((count, binding) => count + binding.implementedCallShapes.length, 0), 14);
  const matrixFamily = report.bindings.filter(({ generatedFamily }) => generatedFamily === "vmath-matrix4");
  assert.equal(matrixFamily.length, 14);
  assert.equal(matrixFamily.reduce((count, binding) => count + binding.implementedCallShapes.length, 0), 16);
  assert.deepEqual(report.bindings.filter(({ generatedFamily }) => !generatedFamily).map(({ id }) => id).sort(), [
    "script:factory.create",
    "script:go.delete",
    "script:go.get_position",
    "script:go.set_position",
    "script:go.set_rotation",
    "script:gui.get_node",
    "script:gui.set_text",
    "script:hash",
    "script:msg.post",
    "script:vmath.length",
    "script:vmath.normalize",
    "script:vmath.quat",
    "script:vmath.quat_rotation_z",
    "script:vmath.vector3"
  ]);
  const vector3 = report.bindings.find(({ id }) => id === "script:vmath.vector3");
  assert.deepEqual(vector3.callShapes, [[], ["Number"], ["Vector3"], ["Number", "Number", "Number"]]);
  const quaternion = report.bindings.find(({ id }) => id === "script:vmath.quat");
  assert.deepEqual(quaternion.callShapes, [[], ["Quaternion"], ["Number", "Number", "Number", "Number"]]);
  const hash = report.bindings.find(({ id }) => id === "script:hash");
  assert.deepEqual(hash.callShapes, [["String"]]);
  assert.equal(hash.resultCodec, "Hash");
  assert.deepEqual(hash.operation, {
    template: "hash-string",
    parameters: {
      algorithm: "dmHashBuffer64",
      termination: "nul-or-length",
      coercionPolicy: "documented-string-only"
    }
  });
  assert.deepEqual(report.operationTemplateVocabulary, [
    "hash-string",
    "value-constructor",
    "value-unary",
    "quaternion-axis-rotation",
    "vmath-fixed-pod",
    "vmath-matrix4",
    "current-instance-transform-get",
    "current-instance-transform-set",
    "message-post",
    "factory-spawn",
    "game-object-delete",
    "gui-node-lookup",
    "gui-node-text-set",
    "gui-node-setter"
  ]);
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:gui.set_color").implementedCallShapes,
    [["Node", "Vector3"], ["Node", "Vector4"]]);
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:gui.set_parent").implementedCallShapes,
    [["Node"], ["Node", "Node"], ["Node", "Node", "Boolean"]]);
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:gui.set_material").implementedCallShapes,
    [["Node", "String"], ["Node", "Hash"]]);
  const factory = report.bindings.find(({ id }) => id === "script:factory.create");
  assert.ok(factory.implementedCallShapes.some((shape) =>
    JSON.stringify(shape) === JSON.stringify(["String", "Vector3"])));
  assert.ok(factory.implementedCallShapes.some((shape) =>
    JSON.stringify(shape) === JSON.stringify(["String", "Vector3", "Nil", "Table"])));
  assert.ok(factory.implementedCallShapes.some((shape) =>
    JSON.stringify(shape) === JSON.stringify(["Hash", "Nil", "Nil", "Nil", "Vector3"])));
  assert.equal(familyBindings.every(({ operation }) => operation.template === "gui-node-setter"), true);
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:vmath.euler_to_quat").implementedCallShapes,
    [["Vector3"], ["Number", "Number", "Number"]]);
  assert.match(nativeSource, /constexpr bool kBindingAllowsUniversalFallback\[\]/);
  assert.match(nativeSource,
    /if \(kBindingAllowsUniversalFallback\[binding\]\) return DispatchStatus::kMissing;/);
  assert.equal(report.bindings.find(({ id }) => id === "script:go.delete").unhandledShapePolicy,
    "universal-fallback");
  assert.equal(report.bindings.find(({ id }) => id === "script:vmath.euler_to_quat").unhandledShapePolicy,
    "error");
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:vmath.length_sqr").implementedCallShapes,
    [["Vector3"], ["Vector4"], ["Quaternion"]]);
  assert.equal(vmathFamily.every(({ operation }) =>
    operation.template === "vmath-fixed-pod" && operation.parameters.normalization === "none"), true);
  assert.equal(vmathFamily.every(({ generatedProbe }) =>
    generatedProbe?.key.startsWith("vmath-fixed-pod.") && generatedProbe.expectation), true);
  assert.equal(matrixFamily.every(({ operation, generatedProbe, targetSupport }) =>
    operation.template === "vmath-matrix4" &&
    operation.parameters.layout === "column-major-16-float32" &&
    operation.parameters.storage === "generation-checked-frame-arena" &&
    generatedProbe?.state === "planned" &&
    // The Matrix4 lane has no Emscripten primitive C ABI of its own, so the
    // browser reaches these routes through the universal transport instead.
    targetSupport.html5BrowserHost.status === "generated-executable" &&
    targetSupport.html5BrowserHost.backend === "universal-direct-memory-transport"), true);
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:vmath.matrix4_compose").implementedCallShapes,
    [["Vector3", "Quaternion", "Vector3"], ["Vector4", "Quaternion", "Vector3"]]);
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:vmath.matrix4_translation").implementedCallShapes,
    [["Vector3"], ["Vector4"]]);
  assert.equal(report.sourceEvidence.some(({ path, sha256 }) =>
    path.endsWith("engine/dlib/src/dlib/hash.cpp") &&
    sha256 === "fb3577778af004b43b0585fafb5369bd18b89b0a0aa4b7eb322555ccda9a8c51"), true);
  assert.match(report.allocationClaim, /fixed-capacity table staging/i);
  assert.match(report.allocationClaim, /reverse-hash table/i);
  assert.equal(report.bindings.find(({ id }) => id === "script:hash")
    .targetSupport.html5BrowserHost.status, "generated-executable");
  // Only the primitive hash template has its own Emscripten C ABI. Every other
  // route in this family is declared executable in the browser through the
  // universal direct-memory transport, never through this family's lane.
  assert.equal(report.bindings.filter(({ id }) => id !== "script:hash").every(({ targetSupport }) =>
    targetSupport.html5BrowserHost.status === "generated-executable" &&
    targetSupport.html5BrowserHost.backend === "universal-direct-memory-transport"), true);
});

test("generated value implementation stays POD-native and fail-closed", async () => {
  const [source, types, generator, targetSupport, arena, jsiBridge] = await Promise.all([
    readFile(new URL("defold/defold_hermes/src/generated_script_value_bindings.cpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/types.ts", root), "utf8"),
    readFile(new URL("scripts/generate-script-value-bindings.mjs", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/value-target-support.ts", root), "utf8"),
    readFile(new URL("defold/defold_hermes/include/defold_hermes/script_matrix4_arena.hpp", root), "utf8"),
    readFile(new URL("defold/defold_hermes/src/script_jsi_bridge.cpp", root), "utf8")
  ]);
  assert.match(source, /Defold value arguments do not match a generated call shape/);
  assert.match(source, /dmVMath::Normalize/);
  assert.match(source, /dmHashBuffer64/);
  assert.match(source, /matrix4Elements/);
  assert.match(source, /elements\[column \* 4 \+ row\] = value\.getElem\(column, row\)/);
  assert.match(source, /Matrix4 frame arena is exhausted/);
  assert.match(source, /input\.length \? std::memchr\(bytes, 0, input\.length\) : nullptr/);
  assert.match(source, /while \(count != 0\)[\s\S]*kStableIds\[index\] < stableId/);
  assert.doesNotMatch(source, /for \(size_t index = 0; index < kBindingCount; \+\+index\)/);
  assert.doesNotMatch(source, /lua_newuserdata|luaL_ref|new\s|malloc/);
  assert.doesNotMatch(generator, /binding\.id\s*===/);
  assert.match(types, /defoldValueBrand: unique symbol/);
  assert.match(types, /\[defoldValueBrand\]: "vector3"/);
  assert.match(types, /\[defoldValueBrand\]: "quaternion"/);
  // The specialized POD lane is native-only, but every one of its routes still
  // reaches the browser through the generated universal direct-memory provider,
  // so this family's browser gate carries no route. The browser blockers that
  // remain are machine-derived by the universal generator.
  assert.doesNotMatch(targetSupport, /is not executable in the HTML5 browser host/);
  assert.match(targetSupport, /if \(target !== "html5-browser-host"\) return;/);
  assert.match(arena, /struct alignas\(16\) ScriptMatrix4Arena/);
  assert.match(arena, /value\.data != &slot/);
  assert.match(arena, /generation != slot\.generation/);
  assert.match(arena, /for \(uint32_t index = mark; index < used; \+\+index\) bump/);
  assert.doesNotMatch(arena, /new\s|malloc|vector</);
  assert.match(jsiBridge, /array\.size\(runtime\) == 16/);
  assert.match(jsiBridge, /frame\.matrix4Arena = &slot->matrix4Arena/);
  assert.match(jsiBridge, /slot_->matrix4Arena\.rewind\(0\)/);
});

function mutateBinding(inputs, id, mutate) {
  let found = false;
  const updated = inputs.map((input) => {
    const definition = JSON.parse(input.definitionText);
    const binding = definition.bindings.find((candidate) => candidate.id === id);
    if (!binding) return input;
    found = true;
    mutate(binding);
    return { ...input, definitionText: `${JSON.stringify(definition, null, 2)}\n` };
  });
  assert.equal(found, true, `missing fixture binding ${id}`);
  return updated;
}

function mutateFamily(inputs, familyId, mutate) {
  let found = false;
  const updated = inputs.map((input) => {
    const definition = JSON.parse(input.definitionText);
    const family = definition.families?.find((candidate) => candidate.id === familyId);
    if (!family) return input;
    found = true;
    mutate(family);
    return { ...input, definitionText: `${JSON.stringify(definition, null, 2)}\n` };
  });
  assert.equal(found, true, `missing fixture family ${familyId}`);
  return updated;
}

test("value operation templates fail closed for unknown and mismatched metadata", async () => {
  const fixture = await loadGenerationInputs();
  const unknown = mutateBinding(fixture.inputs, "script:vmath.vector3", (binding) => {
    binding.operation.template = "agent-invented-native-code";
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, unknown),
    /script:vmath\.vector3: unknown operation template agent-invented-native-code/);

  const mismatched = mutateBinding(fixture.inputs, "script:vmath.vector3", (binding) => {
    binding.operation = { template: "quaternion-axis-rotation", parameters: { axis: "z" } };
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, mismatched),
    /quaternion-axis-rotation parameters require implemented call shapes/);

  const unreviewedParameters = mutateBinding(fixture.inputs, "script:vmath.vector3", (binding) => {
    binding.operation.parameters.scalarSplat = false;
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, unreviewedParameters),
    /parameters do not match reviewed value-constructor template/);

  const wrongSourceFunction = mutateBinding(fixture.inputs, "script:vmath.normalize", (binding) => {
    binding.sourceSymbol = "Length";
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, wrongSourceFunction),
    /value-unary source anchor .*Normalize/);

  const missingHashEvidence = fixture.inputs.map((input) => {
    const definition = JSON.parse(input.definitionText);
    if (!definition.bindings.some(({ id }) => id === "script:hash")) return input;
    delete definition.additionalSourceEvidence;
    return { ...input, definitionText: `${JSON.stringify(definition, null, 2)}\n`, additionalSources: [] };
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, missingHashEvidence),
    /hash-string requires pinned dmHashString64 implementation evidence/);

  const wrongMessageBound = mutateBinding(fixture.inputs, "script:msg.post", (binding) => {
    binding.operation.parameters.maxPayloadBytes = 4096;
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, wrongMessageBound),
    /parameters do not match reviewed message-post template/);

  const wrongNodePolicy = mutateBinding(fixture.inputs, "script:gui.get_node", (binding) => {
    binding.operation.parameters.handlePolicy = "raw-pointer";
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, wrongNodePolicy),
    /parameters do not match reviewed gui-node-lookup template/);

  const missingVmathChecks = fixture.inputs.map((input) => {
    const definition = JSON.parse(input.definitionText);
    if (!definition.bindings.some(({ id }) => id === "script:vmath.length")) return input;
    delete definition.additionalSourceEvidence;
    return { ...input, definitionText: `${JSON.stringify(definition, null, 2)}\n`, additionalSources: [] };
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, missingVmathChecks),
    /requires pinned Defold component validation evidence/);

  const wrongFamilyCount = mutateFamily(fixture.inputs, "gui-node-setters", (family) => {
    family.selector.expectedRouteCount = 38;
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, wrongFamilyCount),
    /gui-node-setters family metadata is not the reviewed finite selector/);

  const missingEnumCodec = mutateFamily(fixture.inputs, "gui-node-setters", (family) => {
    delete family.selector.typeCodecs["gui.PIVOT"];
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, missingEnumCodec),
    /gui-node-setters route census expected 39, found 38/);

  const wrongVmathCount = mutateFamily(fixture.inputs, "vmath-fixed-pod", (family) => {
    family.selector.expectedRouteCount = 10;
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, wrongVmathCount),
    /vmath-fixed-pod family metadata is not the reviewed finite selector/);

  const staleVmathTerminal = mutateFamily(fixture.inputs, "vmath-fixed-pod", (family) => {
    family.selector.terminalOperations.find(({ operator }) => operator === "vector3-cross").sourceAnchor =
      "dmVMath::CrossReviewedByAnAgent";
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, staleVmathTerminal),
    /script:vmath\.cross: expected exactly one reviewed vmath terminal operation, found 0/);

  const widenedEuler = mutateFamily(fixture.inputs, "vmath-fixed-pod", (family) => {
    family.selector.terminalOperations.find(({ operator }) => operator === "euler-to-quaternion")
      .implementedCallShapes.push(["Number", "Number"]);
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, widenedEuler),
    /vmath-fixed-pod parameters require implemented call shapes/);

  const reclassifiedPatterns = JSON.parse(fixture.patternsText);
  reclassifiedPatterns.bindings.find(({ id }) => id === "script:vmath.cross").loweringFamily = "scalar";
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText,
    `${JSON.stringify(reclassifiedPatterns)}\n`, fixture.inputs),
  /vmath-fixed-pod route census expected 11, found 10/);

  const wrongMatrixCount = mutateFamily(fixture.inputs, "vmath-matrix4", (family) => {
    family.selector.expectedCallShapeCount = 15;
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, wrongMatrixCount),
    /vmath-matrix4 family metadata is not the reviewed finite selector/);

  const staleMatrixTerminal = mutateFamily(fixture.inputs, "vmath-matrix4", (family) => {
    family.selector.terminalOperations.find(({ id }) => id === "script:vmath.inv").sourceAnchor =
      "dmVMath::InverseReviewedByAnAgent";
  });
  assert.throws(() => generate(fixture.irText, fixture.scalarDispatchText, fixture.patternsText, staleMatrixTerminal),
    /script:vmath\.inv: invalid or stale reviewed Matrix4 terminal operation/);
});

test("value generation rejects numeric stable-ID overlap with scalar dispatch", async () => {
  const fixture = await loadGenerationInputs();
  const scalar = JSON.parse(fixture.scalarDispatchText);
  scalar.bindings[0].stableId = stableBindingId("script:hash");
  assert.throws(() => generate(fixture.irText, `${JSON.stringify(scalar)}\n`, fixture.patternsText, fixture.inputs),
    /script:hash: stable ID collides with scalar binding/);
});

test("every generated value binding has a deterministic packaged-engine probe disposition", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-value-real-engine-probes.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
  const [report, bindings] = await Promise.all([
    readFile(new URL("packages/bindings/generated/defold-script-value-real-engine-probes.json", root), "utf8").then(JSON.parse),
    readFile(new URL("packages/bindings/generated/defold-script-value-bindings.json", root), "utf8").then(JSON.parse)
  ]);
  assert.equal(report.target, "arm64-macos-dynamic-hermes");
  assert.equal(report.uniqueBindingCount, bindings.bindingCount);
  // One binding may carry several probes: every implemented call shape of an
  // addressed route is probed separately, so dispositions exceed bindings.
  assert.equal(report.routeDispositionCount, report.probeCount + report.plannedFamilyProbeCount);
  assert.equal(new Set([...report.probes, ...report.plannedProbes].map(({ id }) => id)).size,
    bindings.bindingCount);
  assert.equal(report.probeCount, 49);
  assert.equal(report.generatedProbeCount, 25);
  assert.equal(report.instrumentedProbeCount, 30);
  assert.equal(report.explicitPlannedProbeCount, 19);
  assert.equal(report.plannedFamilyProbeCount, 39);
  assert.equal(report.plannedProbeCount, 58);
  assert.equal(report.probes.every(({ expectedMarker }) => expectedMarker.endsWith(":ok")), true);
  const source = await readFile(new URL(
    "examples/runtime-smoke/src/generated/script-value-real-engine-probes.ts", root), "utf8");
  assert.match(source, /Math\.abs\(result_3\.x - 0\.6\) <= 0\.000001/);
  assert.match(source, /vmath\.quatRotationZ\(3\.141592653589793\)/);
  assert.match(source, /defold\.hash\("my_hash"\)/);
  assert.match(source, /BigInt\("0xa2bc06d97f580aab"\)/);
  assert.match(source, /go\.setPosition\(vmath\.vector3\(13, 21, 34\)\)/);
  assert.match(source, /go\.setRotation\(vmath\.quat\(0, 0, 0\.7071067811865476, 0\.7071067811865476\)\)/);
  assert.doesNotMatch(source, /msg\.post\("\."\, "deherm_probe_message"\)/);
  assert.doesNotMatch(source, /factory\.create\("#probe_factory"\)/);
  assert.doesNotMatch(source, /gui\.setText\(gui\.getNode\("status"\), "DEHERM_PROBE_TEXT"\)/);
  assert.equal(report.probes.filter(({ state }) => state === "planned").every(({ reason }) => reason.length > 0), true);
  assert.equal(report.plannedProbes.every(({ state, expectedMarker }) =>
    state === "planned-only" && expectedMarker === undefined), true);
  assert.deepEqual(report.plannedProbes.find(({ id }) => id === "script:gui.set_parent").implementedCallShapes,
    [["Node"], ["Node", "Node"], ["Node", "Node", "Boolean"]]);
  assert.deepEqual(report.probes.find(({ id }) => id === "script:vmath.euler_to_quat").callShape,
    ["Vector3"]);
  assert.match(source, /vmath\.eulerToQuat\(vmath\.vector3\(0, 0, 90\)\)/);
  assert.match(source, /vmath\.project\(vmath\.vector3\(1, 1, 0\), vmath\.vector3\(2, 0, 0\)\)/);
});

test("value probes reject unimplemented overloads and marker aliases", async () => {
  const [probeText, bindingsText] = await Promise.all([
    readFile(new URL("packages/bindings/probes/defold-script-value-real-engine-probes.json", root), "utf8"),
    readFile(new URL("packages/bindings/generated/defold-script-value-bindings.json", root), "utf8")
  ]);
  const addressed = JSON.parse(probeText);
  // One trailing address is an implemented shape; two are not.
  addressed.probes.find(({ id }) => id === "script:go.set_position")
    .arguments.push("other_go", "another_go");
  assert.throws(
    () => generateScriptValueRealEngineProbes(`${JSON.stringify(addressed)}\n`, bindingsText),
    /do not match an implemented call shape/
  );

  const aliased = JSON.parse(probeText);
  aliased.probes.find(({ id }) => id === "script:go.set_position").expectation.marker =
    "DEBUG:SCRIPT: script-value:go.set_rotation.current:ok";
  assert.throws(
    () => generateScriptValueRealEngineProbes(`${JSON.stringify(aliased)}\n`, bindingsText),
    /marker must be derived from the probe key/
  );

  const missingFamilyRecipe = JSON.parse(probeText);
  missingFamilyRecipe.plannedFamilyRecipes = [];
  assert.throws(
    () => generateScriptValueRealEngineProbes(`${JSON.stringify(missingFamilyRecipe)}\n`, bindingsText),
    /Every generated value binding requires a real-engine probe/
  );

  const mismatchedFamilyContext = JSON.parse(probeText);
  mismatchedFamilyContext.plannedFamilyRecipes[0].context = "active-script-instance";
  assert.throws(
    () => generateScriptValueRealEngineProbes(`${JSON.stringify(mismatchedFamilyContext)}\n`, bindingsText),
    /planned family context active-script-instance does not match generated route context/
  );

  const invalidGeneratedFixture = JSON.parse(bindingsText);
  invalidGeneratedFixture.bindings.find(({ id }) => id === "script:vmath.cross")
    .generatedProbe.arguments = [{ codec: "Quaternion", components: [0, 0, 0, 1] }];
  assert.throws(
    () => generateScriptValueRealEngineProbes(probeText, `${JSON.stringify(invalidGeneratedFixture)}\n`),
    /argument codecs \["Quaternion"\] do not match an implemented call shape/
  );

  const changedInstrumentedSemantics = JSON.parse(probeText);
  changedInstrumentedSemantics.probes.find(({ id }) => id === "script:vmath.length")
    .expectation.value = 6;
  assert.throws(
    () => generateScriptValueRealEngineProbes(
      `${JSON.stringify(changedInstrumentedSemantics)}\n`, bindingsText),
    /instrumented probe-set semantics sha256 expected/
  );
});
