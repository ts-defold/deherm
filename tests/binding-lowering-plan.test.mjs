import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  generateBindingLoweringPlan,
  inputPaths,
  loadBindingLoweringInputs
} from "../scripts/generate-binding-lowering-plan.mjs";
import {
  renderTypescript as renderTypedNativeBridge,
  selectClaimedRoutes as selectTypedNativeRoutes
} from "../scripts/generate-typed-native-bridge.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const reportPath = join(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.json");
const inputs = await loadBindingLoweringInputs(repositoryRoot);
const generated = generateBindingLoweringPlan(inputs);

function replaceJson(text, mutate) {
  const value = JSON.parse(text);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("the canonical plan contains every API unit and all five backend dispositions", async () => {
  assert.equal(generated.schemaVersion, 2);
  assert.deepEqual(generated.coverage, {
    units: 2428,
    scriptUnits: 1067,
    scriptFunctionUnits: 926,
    scriptConstantUnits: 141,
    dmsdkUnits: 1361,
    backendRecords: 12140,
    identitySelectedPolicyRules: 0
  });
  assert.deepEqual(generated.targetOrder, [
    "typescriptSdk",
    "dynamicHermesJsi",
    "staticHermesCAbi",
    "luaStack",
    "browserWasmHost"
  ]);
  assert.equal(new Set(generated.units.map(({ identity }) => `${identity.surface}:${identity.id}`)).size, 2428);
  assert.ok(generated.units.every(({ backends }) => Object.keys(backends).join(",") === generated.targetOrder.join(",")));
  const constantPolicy = JSON.parse(await readFile(resolve(repositoryRoot, "packages/bindings/generated/defold-script-constant-lowering.json"), "utf8"));
  const constantUnits = generated.units.filter(({ sourceRef }) => sourceRef?.input === "scriptConstantLowering");
  assert.equal(constantUnits.length, constantPolicy.entries.length - constantPolicy.counts.inlined);
  for (const unit of constantUnits) {
    const entry = constantPolicy.entries[unit.sourceRef.row];
    assert.equal(unit.identity.id, `script:constant.${entry.name}`);
    assert.equal(unit.identity.stableId, entry.stableId);
  }
  const physicsConstant = generated.units.find(({ identity }) => identity.id === "script:constant.physics.SHAPE_TYPE_MESH");
  assert.equal(physicsConstant.availability.profileAvailability.kind, "runtime-profile-gated");
  assert.ok(physicsConstant.availability.profiles.includes("no-physics"));
  const cameraConstant = generated.units.find(({ identity }) => identity.id === "script:constant.camera.ORTHO_MODE_FIXED");
  assert.equal(cameraConstant, undefined, "compile-time-intrinsic constants do not need universal lowering units");
  assert.equal(generated.selectionSummary.typescriptSdk.emit, 2428);
  assert.equal(generated.evidenceBoundary.compilation, "not-claimed");
  assert.equal(generated.evidenceBoundary.runtime, "not-claimed");
  assert.match(generated.planSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), generated);
});

test("generated implementation lanes join by exact identity and universal fallbacks compose with one specialized lane", () => {
  const handleReport = JSON.parse(inputs.scriptHandleLowering);
  const cstringReport = JSON.parse(inputs.dmsdkCStringValue);
  const implementations = generated.units.flatMap((unit) => {
    assert.ok(
      unit.implementationSet >= 0 && unit.implementationSet < generated.tables.implementationSets.length,
      unit.identity.id
    );
    return generated.tables.implementationSets[unit.implementationSet].map((implementation) => ({
      unit,
      implementation
    }));
  });
  assert.equal(
    implementations.filter(({ implementation }) => implementation.lane === "script-handle-lowering").length,
    handleReport.routes.length
  );
  assert.equal(
    implementations.filter(({ implementation }) => implementation.lane === "dmsdk-cstring-value").length,
    cstringReport.declarations.length
  );
  const urlReport = JSON.parse(inputs.scriptUrlAddress);
  assert.equal(
    implementations.filter(({ implementation }) => implementation.lane === "script-url-dispatch").length,
    urlReport.rows.length
  );

  const handle = generated.units.find(({ identity }) => identity.id === "script:b2d.body.apply_force");
  const handleImplementation = generated.tables.implementationSets[handle.implementationSet][0];
  assert.equal(handle.backends.dynamicHermesJsi.selection, "emit");
  assert.equal(handleImplementation.disposition, "generated-private-runtime");
  assert.equal(handleImplementation.targets.nativeDynamicHermes, "captured-lua-router-harness-proven-jsi-unverified");
  assert.equal(handleImplementation.evidence.defoldEngineBehavior, "unverified");

  const cstringId = "dmsdk:dmBuffer::GetResultString@upstream/defold/engine/dlib/src/dmsdk/dlib/buffer.h:373:100";
  const cstring = generated.units.find(({ identity }) => identity.id === cstringId);
  const cstringImplementation = generated.tables.implementationSets[cstring.implementationSet][0];
  assert.equal(cstringImplementation.disposition, "generated-private-staging");
  assert.equal(cstringImplementation.semanticState, "explicit-string-contract-private-unlinked");
  assert.equal(cstringImplementation.targets.nativeStaticHermes, "staged-private-c-abi-uncompiled-unlinked");
  assert.equal(cstringImplementation.evidence.runtime, "unclaimed-by-canonical-plan");

  assert.equal(Object.keys(generated.implementationLanes).length, 27);
  for (const { source } of Object.values(generated.implementationLanes)) {
    const input = Object.entries(inputPaths).find(([, path]) => path === source)?.[0];
    assert.ok(input, `implementation lane source is not a declared plan input: ${source}`);
    assert.match(generated.inputHashes[input], /^[a-f0-9]{64}$/);
  }
  assert.ok(generated.units.every((unit) => {
    const set = generated.tables.implementationSets[unit.implementationSet];
    return set.length >= 1 && set.length <= 2 &&
      set.filter(({ lane }) => !["script-universal-value", "dmsdk-universal"].includes(lane)).length <= 1;
  }));

  const dynamic = generated.units.find(({ identity }) => identity.id === "script:bit.band");
  const dynamicImplementation = generated.tables.implementationSets[dynamic.implementationSet][0];
  assert.equal(dynamicImplementation.lane, "script-dynamic-values");
  assert.equal(dynamicImplementation.reportState.generatedFamilyExecutableCandidate, true);
  assert.equal(dynamicImplementation.targetClaims.nativeDynamicHermes, "candidate-awaits-shared-router-integration");
  assert.equal(dynamic.backends.dynamicHermesJsi.selection, "emit");

  const digestId = "dmsdk:dmCrypt::HashMd5@upstream/defold/engine/dlib/src/dmsdk/dlib/crypt.h:108:160";
  const digest = generated.units.find(({ identity }) => identity.id === digestId);
  const digestImplementation = generated.tables.implementationSets[digest.implementationSet][0];
  assert.equal(digestImplementation.lane, "dmsdk-fixed-digests");
  assert.equal(digestImplementation.evidenceClaims.compiled, "packaged-sdk-object-test");
  assert.equal(digestImplementation.evidenceClaims.runtime, "packaged-sdk-host-behavior-test");
  assert.equal(digest.backends.dynamicHermesJsi.selection, "blocked-semantic");

  const universal = generated.units.find(({ identity }) => identity.id === "script:physics.raycast");
  const universalImplementation = generated.tables.implementationSets[universal.implementationSet][0];
  assert.equal(universalImplementation.lane, "script-universal-value");
  assert.equal(universal.backends.dynamicHermesJsi.selection, "emit");
  assert.equal(universal.backends.luaStack.selection, "emit");
  assert.equal(universal.backends.staticHermesCAbi.selection, "emit");
  assert.equal(universal.backends.browserWasmHost.selection, "emit");

  const retainedCallback = generated.units.find(({ identity }) => identity.id === "script:http.request");
  assert.equal(retainedCallback.backends.dynamicHermesJsi.selection, "emit");
  assert.equal(retainedCallback.backends.luaStack.selection, "emit");
  assert.equal(retainedCallback.backends.browserWasmHost.selection, "emit");
  for (const id of ["script:socket.newtry", "script:socket.protect"]) {
    const closureResult = generated.units.find(({ identity }) => identity.id === id);
    assert.equal(closureResult.backends.dynamicHermesJsi.selection, "emit", `${id}/dynamicHermesJsi`);
    for (const target of ["staticHermesCAbi", "luaStack", "browserWasmHost"]) {
      assert.equal(closureResult.backends[target].selection, "blocked-capability", `${id}/${target}`);
      assert.deepEqual(
        generated.tables.blockerSets[closureResult.backends[target].blockerSet],
        target === "staticHermesCAbi"
          ? ["higher-order-lua-closure-result-transport-unavailable", "shape-kind:callback"]
          : ["higher-order-lua-closure-result-transport-unavailable"],
        `${id}/${target}`);
    }
  }

  const borrowedId = "dmsdk:dmBuffer::IsBufferValid@upstream/defold/engine/dlib/src/dmsdk/dlib/buffer.h:227:93";
  const borrowed = generated.units.find(({ identity }) => identity.id === borrowedId);
  const borrowedImplementation = generated.tables.implementationSets[borrowed.implementationSet][0];
  assert.equal(borrowedImplementation.lane, "dmsdk-borrowed-handle");
  assert.equal(borrowedImplementation.disposition, "generated-provider-boundary");
  assert.equal(borrowed.backends.dynamicHermesJsi.selection, "blocked-semantic");
});

test("typed-native bridge exactly realizes the canonical script selection, including bounded variadics", () => {
  const universal = JSON.parse(inputs.scriptUniversalValue);
  const selection = selectTypedNativeRoutes(generated, universal);
  const planned = generated.units.filter((unit) =>
    unit.identity.surface === "script" && unit.backends.staticHermesCAbi.selection === "emit");
  assert.equal(planned.filter(({ sourceState }) => sourceState.loweringFamily !== "script-constant").length, 325);
  assert.equal(planned.filter(({ sourceState }) => sourceState.loweringFamily === "script-constant").length, 141);
  assert.equal(planned.length, 466);
  assert.equal(selection.claimed.length, planned.length);
  assert.deepEqual(selection.declined, []);
  assert.equal(selection.maximumArgumentCount, universal.bounds.maximumArguments);
  assert.deepEqual(
    selection.claimed.filter(({ arity }) => arity === "bounded-variadic").map(({ id }) => id).sort(),
    ["script:bit.band", "script:bit.bor", "script:bit.bxor", "script:pprint", "script:socket.skip"]
  );
  const source = renderTypedNativeBridge(selection);
  for (const route of selection.claimed.filter(({ arity }) => arity === "bounded-variadic")) {
    assert.match(source, new RegExp(`\\b${route.stableId}\\b`), `${route.id} is absent from the generated route table`);
  }
  assert.match(source, /count > __DEHERM_TYPED_NATIVE_MAX_ARGUMENTS/);

  const drifted = structuredClone(universal);
  drifted.bindings.find(({ id }) => id === "script:bit.band").maximumArgumentCount -= 1;
  assert.throws(() => selectTypedNativeRoutes(generated, drifted),
    /script:bit\.band: variadic bound differs from the universal frame capacity/);
});

test("implementation lane joins fail closed on identity and census drift", () => {
  const handleIdentity = structuredClone(inputs);
  handleIdentity.scriptHandleLowering = replaceJson(handleIdentity.scriptHandleLowering, (value) => {
    value.routes[0].stableId += 1;
  });
  assert.throws(() => generateBindingLoweringPlan(handleIdentity), /script-handle-lowering: identity drift/);

  const cstringIdentity = structuredClone(inputs);
  cstringIdentity.dmsdkCStringValue = replaceJson(cstringIdentity.dmsdkCStringValue, (value) => {
    value.declarations[0].projectionId = "dmsdk-projection:forged";
  });
  assert.throws(() => generateBindingLoweringPlan(cstringIdentity), /dmsdk-cstring-value: identity drift/);

  const census = structuredClone(inputs);
  census.scriptHandleLowering = replaceJson(census.scriptHandleLowering, (value) => value.routes.pop());
  assert.throws(() => generateBindingLoweringPlan(census), /route census drifted/);

  const genericIdentity = structuredClone(inputs);
  genericIdentity.scriptFixedTuples = replaceJson(genericIdentity.scriptFixedTuples, (value) => {
    value.bindings[0].stableId = "0xffffffff";
  });
  assert.throws(() => generateBindingLoweringPlan(genericIdentity), /script-fixed-tuples: stable identity drift/);

  const genericCensus = structuredClone(inputs);
  genericCensus.scriptDynamicValues = replaceJson(genericCensus.scriptDynamicValues, (value) => value.bindings.pop());
  assert.throws(() => generateBindingLoweringPlan(genericCensus), /script-dynamic-values: report census drifted/);

  const missingRevision = structuredClone(inputs);
  missingRevision.dmsdkNamedScalars = replaceJson(missingRevision.dmsdkNamedScalars, (value) => {
    delete value.defoldRevision;
  });
  assert.throws(() => generateBindingLoweringPlan(missingRevision), /dmsdk-named-scalars: Defold revision drifted/);

  const dmsdkCensus = structuredClone(inputs);
  dmsdkCensus.dmsdkScalarThunks = replaceJson(dmsdkCensus.dmsdkScalarThunks, (value) => {
    value.coverage.reviewed -= 1;
  });
  assert.throws(() => generateBindingLoweringPlan(dmsdkCensus), /dmsdk-scalar-thunks: report census drifted/);

  const overlap = structuredClone(inputs);
  const scalar = JSON.parse(overlap.scriptScalarDispatch).bindings[0];
  overlap.scriptUrlAddress = replaceJson(overlap.scriptUrlAddress, (value) => {
    value.rows[0].id = scalar.id;
    value.rows[0].stableId = scalar.stableId;
  });
  assert.throws(() => generateBindingLoweringPlan(overlap), /implementation lane overlap/);

  const forgedEvidence = structuredClone(inputs);
  forgedEvidence.dmsdkFixedDigests = replaceJson(forgedEvidence.dmsdkFixedDigests, (value) => {
    value.declarations[0].stages.runtime = "packaged-engine-verified";
  });
  assert.throws(() => generateBindingLoweringPlan(forgedEvidence), /unsupported evidence status 'packaged-engine-verified'/);

  const forgedTarget = structuredClone(inputs);
  forgedTarget.scriptDynamicValues = replaceJson(forgedTarget.scriptDynamicValues, (value) => {
    value.bindings[0].targetSupport.nativeDynamicHermes = "packaged-engine-verified";
  });
  assert.throws(() => generateBindingLoweringPlan(forgedTarget), /unsupported target status 'packaged-engine-verified'/);
});

test("runtime emit selections never escape unresolved semantics or target capability checks", () => {
  for (const unit of generated.units) {
    assert.ok(unit.contractDetails >= 0 && unit.contractDetails < generated.tables.contracts.length, unit.identity.id);
    for (const target of generated.targetOrder.filter((name) => generated.targetCapabilities[name].runtime)) {
      const backend = unit.backends[target];
      assert.ok(backend.marshallingProgram >= 0 && backend.marshallingProgram < generated.tables.marshallingPrograms.length, `${unit.identity.id}/${target}`);
      assert.ok(backend.blockerSet >= 0 && backend.blockerSet < generated.tables.blockerSets.length, `${unit.identity.id}/${target}`);
      assert.ok(backend.unresolvedTokenSet >= 0 && backend.unresolvedTokenSet < generated.tables.unresolvedTokenSets.length, `${unit.identity.id}/${target}`);
      if (backend.selection === "emit") {
        assert.deepEqual(generated.tables.unresolvedTokenSets[backend.unresolvedTokenSet], [], `${unit.identity.id}/${target}`);
        assert.deepEqual(generated.tables.blockerSets[backend.blockerSet], [], `${unit.identity.id}/${target}`);
        assert.ok(unit.abi.symbol || unit.abi.plannedSymbol, `${unit.identity.id}/${target}`);
      }
    }
  }
});

test("marshalling is an interned data-oriented opcode algebra rather than route code", () => {
  assert.ok(generated.tables.contracts.length < generated.coverage.units);
  assert.ok(generated.tables.marshallingPrograms.length < generated.coverage.units);
  assert.ok(generated.tables.blockerSets.length < 200);
  assert.ok(generated.tables.unresolvedTokenSets.length < generated.coverage.units / 4);
  const allowed = new Set([
    "validate-scalar", "pass-dynamic", "validate-named", "validate-enum", "decode-defold-value",
    "resolve-handle", "decode-record-ref", "decode-record", "decode-sequence", "decode-map", "select-union",
    "check-optional", "register-callback", "decode-variadic", "reject-unknown", "no-value", "copy-utf8",
    "borrow-fixed-array", "borrow-pointer", "borrow-reference", "decode-template-record", "instantiate-template",
    "resolve-type-parameter", "resolve-opaque", "call-cached-lua", "call-native-symbol", "restore-scratch"
  ]);
  for (const program of generated.tables.marshallingPrograms) {
    for (const instruction of program) {
      const opcode = instruction.op.startsWith("encode-") ? instruction.op.slice("encode-".length) : instruction.op;
      assert.ok(allowed.has(opcode), instruction.op);
    }
  }

  const route = generated.units.find(({ identity }) => identity.id === "script:b2d.body.apply_force");
  const program = generated.tables.marshallingPrograms[route.backends.dynamicHermesJsi.marshallingProgram];
  assert.deepEqual(program.map(({ op }) => op), [
    "resolve-handle",
    "decode-defold-value",
    "decode-defold-value",
    "call-cached-lua",
    "restore-scratch"
  ]);
  assert.equal(route.backends.dynamicHermesJsi.selection, "emit");
});

test("interned contracts preserve every dmSDK composite effect record", () => {
  const projection = JSON.parse(inputs.dmsdkProjection);
  for (const unit of generated.units.filter(({ identity }) => identity.surface === "dmsdk")) {
    const source = projection.rows[unit.sourceRef.row];
    const contract = generated.tables.contracts[unit.contractDetails];
    assert.deepEqual(contract.context, source.effects.context, `${unit.identity.id} context`);
    assert.deepEqual(contract.ownership, source.effects.ownership, `${unit.identity.id} ownership`);
    assert.deepEqual(contract.lifetime, source.effects.lifetime, `${unit.identity.id} lifetime`);
    assert.deepEqual(contract.thread, source.effects.thread, `${unit.identity.id} thread`);
    assert.deepEqual(contract.callback, source.effects.callbacks, `${unit.identity.id} callbacks`);
  }
});

test("semantic policies are algebraic, reject identity selectors, overlap, and absent tokens", () => {
  const identity = structuredClone(inputs);
  identity.semanticPolicies = replaceJson(identity.semanticPolicies, (value) => value.rules.push({
    id: "forbidden-route-rule",
    selector: { id: "script:b2d.body.apply_force" },
    resolves: { "lowering:borrowed-handle": "generated-handle-codec" }
  }));
  assert.throws(() => generateBindingLoweringPlan(identity), /identity selector 'id'/);

  const zero = structuredClone(inputs);
  zero.semanticPolicies = replaceJson(zero.semanticPolicies, (value) => value.rules.push({
    id: "zero-match",
    selector: { surface: "script", semanticTokensAll: ["not-a-real-token"] },
    resolves: { "not-a-real-token": "impossible" }
  }));
  assert.throws(() => generateBindingLoweringPlan(zero), /matches zero units/);

  const overlap = structuredClone(inputs);
  overlap.semanticPolicies = replaceJson(overlap.semanticPolicies, (value) => value.rules.push(
    {
      id: "first-context",
      selector: { surface: "script", semanticTokensAll: ["context-policy"] },
      resolves: { "context-policy": "global-script-context" }
    },
    {
      id: "second-context",
      selector: { surface: "script", semanticTokensAll: ["context-policy"] },
      resolves: { "context-policy": "different-context" }
    }
  ));
  assert.throws(() => generateBindingLoweringPlan(overlap), /semantic policies overlap/);
});

test("the plan regenerates byte-identically and rejects projection census drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-lowering-plan-"));
  try {
    const output = join(directory, "plan.json");
    execFileSync(process.execPath, ["scripts/generate-binding-lowering-plan.mjs", "--output", output], { cwd: repositoryRoot, stdio: "pipe" });
    assert.equal(await readFile(output, "utf8"), await readFile(reportPath, "utf8"));
    execFileSync(process.execPath, ["scripts/generate-binding-lowering-plan.mjs", "--output", output, "--check"], { cwd: repositoryRoot, stdio: "pipe" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const drift = structuredClone(inputs);
  drift.scriptProjection = replaceJson(drift.scriptProjection, (value) => value.rows.pop());
  assert.throws(() => generateBindingLoweringPlan(drift), /Script projection census drifted/);
  assert.deepEqual(Object.keys(generated.inputHashes), Object.keys(inputPaths));
});

test("canonical ordering is byte-identical across host locales", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-lowering-locale-"));
  try {
    const cOutput = join(directory, "c.json");
    const czechOutput = join(directory, "czech.json");
    execFileSync(process.execPath, ["scripts/generate-binding-lowering-plan.mjs", "--output", cOutput], {
      cwd: repositoryRoot,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: "pipe"
    });
    execFileSync(process.execPath, ["scripts/generate-binding-lowering-plan.mjs", "--output", czechOutput], {
      cwd: repositoryRoot,
      env: { ...process.env, LC_ALL: "cs_CZ.UTF-8", LANG: "cs_CZ.UTF-8" },
      stdio: "pipe"
    });
    assert.equal(await readFile(cOutput, "utf8"), await readFile(czechOutput, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
