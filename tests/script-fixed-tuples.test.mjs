import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { generate, loadInputs } from "../scripts/generate-script-fixed-tuples.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);
const derivedRevision = "1".repeat(40);

function withDeclaredDerivation(callback) {
  const previousRevision = process.env.DEHERM_DERIVED_REVISION;
  const previousAudit = process.env.DEHERM_REVISION_AUDIT;
  process.env.DEHERM_DERIVED_REVISION = derivedRevision;
  process.env.DEHERM_REVISION_AUDIT = tmpdir();
  try {
    return callback();
  } finally {
    if (previousRevision === undefined) delete process.env.DEHERM_DERIVED_REVISION;
    else process.env.DEHERM_DERIVED_REVISION = previousRevision;
    if (previousAudit === undefined) delete process.env.DEHERM_REVISION_AUDIT;
    else process.env.DEHERM_REVISION_AUDIT = previousAudit;
  }
}

function derivedInputs(inputs) {
  const ir = JSON.parse(inputs.irText);
  const patterns = JSON.parse(inputs.patternsText);
  const registrationSurface = JSON.parse(inputs.registrationSurfaceText);
  ir.defoldRevision = derivedRevision;
  patterns.defoldRevision = derivedRevision;
  registrationSurface.defoldRevision = derivedRevision;
  return {
    ...inputs,
    irText: JSON.stringify(ir),
    patternsText: JSON.stringify(patterns),
    registrationSurfaceText: JSON.stringify(registrationSurface),
  };
}

test("fixed tuple generator selects the exact mechanical family", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-fixed-tuples.mjs", "--check"], { cwd: root });
  const report = JSON.parse(
    await readFile(new URL("packages/bindings/generated/defold-script-fixed-tuples.json", root)),
  );
  assert.equal(report.bindingCount, 24);
  assert.deepEqual(report.bucketCounts, { "fixed-scalar-tuple": 17, "fixed-value-tuple": 7 });
  assert.deepEqual(report.tupleArityCounts, { 2: 17, 3: 4, 4: 3 });
  assert.equal(report.publicTypeScriptReachableCount, 8);
  assert.equal(report.blockedHandleProducerCount, 16);
  assert.deepEqual(report.codecVocabulary, [
    "Boolean",
    "GuiNode",
    "Hash",
    "Integer",
    "LuaUserdata",
    "Nil",
    "Number",
    "Quaternion",
    "String",
    "Url",
    "Vector3",
  ]);
  assert.equal(new Set(report.bindings.map(({ id }) => id)).size, 24);
  assert.equal(new Set(report.bindings.map(({ stableId }) => stableId)).size, 24);
  assert.equal(
    report.bindings.every(({ id, stableId }) => Number.parseInt(stableId) === stableBindingId(id)),
    true,
  );
  assert.deepEqual(
    report.bindings.map(({ stableId }) => Number.parseInt(stableId)),
    report.bindings.map(({ stableId }) => Number.parseInt(stableId)).toSorted((a, b) => a - b),
  );
  assert.equal(
    report.bindings
      .filter(({ targetSupport }) => targetSupport.publicTypeScriptFixture === "blocked-missing-handle-producer")
      .every(({ id }) => id.startsWith("script:bullet3d.")),
    true,
  );
  assert.equal(
    report.bindings
      .flatMap(({ arguments: args }) => args)
      .filter(({ codecs }) => codecs.includes("Url"))
      .every(({ implementedCodecs }) => !implementedCodecs.includes("Url")),
    true,
  );
});

test("fixed tuple positional codecs and planned probes fail closed", async () => {
  const [report, probes, source, target] = await Promise.all([
    readFile(new URL("packages/bindings/generated/defold-script-fixed-tuples.json", root), "utf8").then(JSON.parse),
    readFile(new URL("packages/bindings/generated/defold-script-fixed-tuple-probes.json", root), "utf8").then(
      JSON.parse,
    ),
    readFile(new URL("defold/defold_hermes/src/generated_script_fixed_tuples.cpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/fixed-tuple-target-support.ts", root), "utf8"),
  ]);
  assert.equal(probes.routeCount, 24);
  assert.equal(
    probes.scenarios.every(({ evidence }) => Object.values(evidence).every((status) => status === "planned")),
    true,
  );
  assert.equal(
    probes.scenarios.some(({ preserveInteriorNil }) => preserveInteriorNil),
    true,
  );
  assert.match(source, /Fixed tuple Lua result count does not match exact descriptor|result storage is exhausted/);
  assert.match(source, /std::isfinite\(value\.number\).*std::trunc\(value\.number\)/);
  assert.doesNotMatch(source, /new\s|malloc|unordered_map|std::vector/);
  for (const binding of report.bindings) assert.match(target, new RegExp(binding.id.replaceAll(".", "\\.")));
});

test("fixed tuple generation reports stale sources and rejects unknown codecs", async () => {
  const inputs = await loadInputs();
  const staleSources = inputs.sources.map((source, index) =>
    index || !source.text.includes('{ "get_world_transform", CollisionObject_GetWorldTransform }')
      ? source
      : {
          ...source,
          text: source.text.replace(
            '{ "get_world_transform", CollisionObject_GetWorldTransform }',
            '{  "get_world_transform" , CollisionObject_GetWorldTransform  }',
          ),
        },
  );
  const original = generate(...Object.values(inputs));
  const preserved = generate(
    inputs.irText,
    inputs.patternsText,
    inputs.schemaOverridesText,
    inputs.registrationsText,
    inputs.registrationSurfaceText,
    staleSources,
  );
  assert.deepEqual(JSON.parse(preserved.report).bindings, JSON.parse(original.report).bindings);

  const changedRegistration = JSON.parse(inputs.registrationSurfaceText);
  const target = changedRegistration.targets["defold-engine-box2d-v3"];
  target.routes.find(({ name }) => name === "window.get_size").cFunction = "GetSizeRegistrationRemoved";
  assert.throws(
    () =>
      generate(
        inputs.irText,
        inputs.patternsText,
        inputs.schemaOverridesText,
        inputs.registrationsText,
        JSON.stringify(changedRegistration),
        inputs.sources,
      ),
    /canonical registered function does not prove global context/,
  );

  const removedRegistration = JSON.parse(inputs.registrationSurfaceText);
  removedRegistration.targets["defold-engine-box2d-v3"].routes = removedRegistration.targets[
    "defold-engine-box2d-v3"
  ].routes.filter(({ name }) => name !== "window.get_size");
  assert.throws(
    () =>
      generate(
        inputs.irText,
        inputs.patternsText,
        inputs.schemaOverridesText,
        inputs.registrationsText,
        JSON.stringify(removedRegistration),
        inputs.sources,
      ),
    /positive Lua registration is absent/,
  );

  const missingContext = inputs.sources.map((source) =>
    source.path === "engine/gui/src/gui_script.cpp"
      ? { ...source, text: source.text.replaceAll("GuiScriptInstance_Check(L)", "GuiInstanceCheckRemoved(L)") }
      : source,
  );
  assert.throws(
    () =>
      generate(
        inputs.irText,
        inputs.patternsText,
        inputs.schemaOverridesText,
        inputs.registrationsText,
        inputs.registrationSurfaceText,
        missingContext,
      ),
    /does not prove gui-script-instance context/,
  );

  const ir = JSON.parse(inputs.irText);
  ir.functions.find(({ id }) => id === "script:window.get_size").returns[0] = "mystery_owned_value";
  assert.throws(
    () =>
      generate(
        JSON.stringify(ir),
        inputs.patternsText,
        inputs.schemaOverridesText,
        inputs.registrationsText,
        inputs.registrationSurfaceText,
        inputs.sources,
      ),
    /no reviewed fixed tuple codec/,
  );
});

test("fixed tuple derivation withdraws only the affected registration or context specialization", async () => {
  const inputs = derivedInputs(await loadInputs());
  const registrationMissing = JSON.parse(inputs.registrationSurfaceText);
  registrationMissing.targets["defold-engine-box2d-v3"].routes = registrationMissing.targets[
    "defold-engine-box2d-v3"
  ].routes.filter(({ name }) => name !== "window.get_size");
  const missingOutputs = withDeclaredDerivation(() =>
    generate(
      inputs.irText,
      inputs.patternsText,
      inputs.schemaOverridesText,
      inputs.registrationsText,
      JSON.stringify(registrationMissing),
      inputs.sources,
      inputs.withdrawnSources,
    ),
  );
  const missingReport = JSON.parse(missingOutputs.report);
  assert.equal(missingReport.bindingCount, 23);
  assert.equal(
    missingReport.bindings.some(({ id }) => id === "script:window.get_size"),
    false,
  );
  assert.equal(
    missingReport.bindings.some(({ id }) => id === "script:gui.get_type"),
    true,
  );
  assert.doesNotMatch(missingOutputs.source, /script:window\.get_size/);
  assert.match(missingOutputs.source, /if\(!operation\) return DispatchStatus::kMissing/);

  const contextMissing = JSON.parse(inputs.registrationSurfaceText);
  contextMissing.targets["defold-engine-box2d-v3"].routes.find(({ name }) => name === "window.get_size").cFunction =
    "GetSizeContextRemoved";
  const contextOutputs = withDeclaredDerivation(() =>
    generate(
      inputs.irText,
      inputs.patternsText,
      inputs.schemaOverridesText,
      inputs.registrationsText,
      JSON.stringify(contextMissing),
      inputs.sources,
      inputs.withdrawnSources,
    ),
  );
  const contextReport = JSON.parse(contextOutputs.report);
  assert.equal(contextReport.bindingCount, 23);
  assert.equal(
    contextReport.bindings.some(({ id }) => id === "script:window.get_size"),
    false,
  );
  assert.equal(
    contextReport.bindings.some(({ id }) => id === "script:gui.get_type"),
    true,
  );

  const adapter = await readFile(new URL("defold/defold_hermes/src/script_scalar_lua_adapter.cpp", root), "utf8");
  assert.match(adapter, /fixed_tuple::dispatch[\s\S]*universal_value::dispatch/);
});
