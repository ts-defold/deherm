import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { generate, loadInputs } from "../scripts/generate-script-overload-dispatch.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);
const derivedRevision = "1".repeat(40);
const digest = (text) => createHash("sha256").update(text).digest("hex");

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
  ir.defoldRevision = derivedRevision;
  const irText = JSON.stringify(ir);
  const patterns = JSON.parse(inputs.patternsText);
  patterns.defoldRevision = derivedRevision;
  patterns.sourceSha256 = digest(irText);
  const owned = JSON.parse(inputs.ownedText);
  owned.defoldRevision = derivedRevision;
  const registrationSurface = JSON.parse(inputs.registrationSurfaceText);
  registrationSurface.defoldRevision = derivedRevision;
  return {
    ...inputs,
    irText,
    patternsText: JSON.stringify(patterns),
    ownedText: JSON.stringify(owned),
    registrationSurfaceText: JSON.stringify(registrationSurface),
  };
}

test("overload-dispatch generator derives the exact disjoint classifier remainder", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-overload-dispatch.mjs", "--check"], { cwd: root });
  const report = JSON.parse(
    await readFile(new URL("packages/bindings/generated/defold-script-overload-dispatch.json", root), "utf8"),
  );
  assert.equal(report.routeCount, 20);
  assert.equal(report.generatedFamilyCandidateCount, 8);
  assert.equal(report.blockedCount, 12);
  assert.deepEqual(report.disjointCensus, {
    classifierOverloadDispatch: 23,
    alreadyOwnedDefoldValue: 3,
    selectedForThisWave: 20,
  });
  assert.deepEqual(
    report.bindings
      .filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
      .map(({ id }) => id)
      .sort(),
    [
      "script:vmath.clamp",
      "script:vmath.dot",
      "script:vmath.lerp",
      "script:vmath.matrix4",
      "script:vmath.matrix4_scale",
      "script:vmath.mul_per_elem",
      "script:vmath.slerp",
      "script:vmath.vector4",
    ],
  );
  assert.equal(
    report.bindings.some(({ id }) =>
      ["script:vmath.normalize", "script:vmath.quat", "script:vmath.vector3"].includes(id),
    ),
    false,
  );
  assert.equal(
    report.bindings.every(({ id, stableId }) => stableId === stableBindingId(id)),
    true,
  );
  assert.equal(
    report.bindings
      .filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
      .every(({ sourceCapabilities }) => sourceCapabilities.registration?.cFunction.length > 0),
    true,
  );
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:vmath.lerp").callShapes, [
    { arguments: ["Number", "Vector3", "Vector3"], resultCodec: "Vector3" },
    { arguments: ["Number", "Vector4", "Vector4"], resultCodec: "Vector4" },
    { arguments: ["Number", "Quaternion", "Quaternion"], resultCodec: "Quaternion" },
    { arguments: ["Number", "Number", "Number"], resultCodec: "Number" },
  ]);
  assert.equal(
    report.bindings
      .filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
      .every(({ targetSupport }) => targetSupport.nativeDynamicHermes === "generated-executable-shared-script-adapter"),
    true,
  );
});

test("generated overload dispatcher fails closed before a backend sees an invalid frame", async () => {
  const [header, source, target] = await Promise.all([
    readFile(
      new URL("defold/defold_hermes/include/defold_hermes/generated_script_overload_dispatch.hpp", root),
      "utf8",
    ),
    readFile(new URL("defold/defold_hermes/src/generated_script_overload_dispatch.cpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/overload-dispatch-target-support.ts", root), "utf8"),
  ]);
  assert.match(header, /kBindingCount = 8/);
  assert.match(source, /Overload-dispatch arguments do not match a reviewed call shape/);
  assert.match(source, /Overload-dispatch Lua result does not match the reviewed call shape/);
  assert.match(source, /frame->resultCount=0/);
  assert.doesNotMatch(source, /\bnew\b|malloc|realloc|std::vector|unordered_map/);
  assert.match(target, /generated-executable-shared-script-adapter/);
  assert.match(target, /blocked-box2d-world-handle-and-multi-result-codecs/);
});

test("overload-dispatch registration capability is formatting-independent and rejects registration drift", async () => {
  const inputs = await loadInputs();
  const original = generate(inputs);
  const irrelevant = JSON.parse(inputs.registrationSurfaceText);
  irrelevant.targets["defold-engine-box2d-v3"].routes.find(({ name }) => name === "vmath.dot").documentedName = {
    name: "vmath.dot",
    line: 1,
    matchesRegistration: true,
    irrelevantSpelling: "{  vmath.dot  }",
  };
  const preserved = generate({ ...inputs, registrationSurfaceText: JSON.stringify(irrelevant) });
  assert.deepEqual(JSON.parse(preserved.report).bindings, JSON.parse(original.report).bindings);

  const changedRegistration = JSON.parse(inputs.registrationSurfaceText);
  changedRegistration.targets["defold-engine-box2d-v3"].routes.find(({ name }) => name === "vmath.dot").cFunction =
    "DotRemoved";
  const changed = generate({ ...inputs, registrationSurfaceText: JSON.stringify(changedRegistration) });
  assert.notDeepEqual(
    JSON.parse(changed.report).bindings.find(({ id }) => id === "script:vmath.dot").sourceCapabilities,
    JSON.parse(original.report).bindings.find(({ id }) => id === "script:vmath.dot").sourceCapabilities,
  );

  const ambiguous = JSON.parse(inputs.registrationSurfaceText);
  const ambiguousTarget = ambiguous.targets["defold-engine-box2d-v3"];
  ambiguousTarget.routes.push(structuredClone(ambiguousTarget.routes.find(({ name }) => name === "vmath.dot")));
  assert.throws(
    () => generate({ ...inputs, registrationSurfaceText: JSON.stringify(ambiguous) }),
    /positive Lua registration is absent or ambiguous/,
  );

  const policy = JSON.parse(inputs.overrideText);
  delete policy.routes["script:vmath.dot"];
  assert.throws(
    () => generate({ ...inputs, overrideText: JSON.stringify(policy) }),
    /policy coverage drifted|missing reviewed policy/,
  );
  const owned = JSON.parse(inputs.ownedText);
  owned.bindings = owned.bindings.filter(({ id }) => id !== "script:vmath.quat");
  assert.throws(
    () => generate({ ...inputs, ownedText: JSON.stringify(owned) }),
    /binding array\/count drifted|already-owned route is absent/,
  );
});

test("overload-dispatch derivation withdraws only the affected registration specialization", async () => {
  const inputs = derivedInputs(await loadInputs());
  const ambiguous = JSON.parse(inputs.registrationSurfaceText);
  const target = ambiguous.targets["defold-engine-box2d-v3"];
  target.routes.push(structuredClone(target.routes.find(({ name }) => name === "vmath.dot")));
  const outputs = withDeclaredDerivation(() =>
    generate({ ...inputs, registrationSurfaceText: JSON.stringify(ambiguous) }),
  );
  const report = JSON.parse(outputs.report);
  assert.equal(report.routeCount, 19);
  assert.equal(report.generatedFamilyCandidateCount, 7);
  assert.equal(
    report.bindings.some(({ id }) => id === "script:vmath.dot"),
    false,
  );
  assert.equal(
    report.bindings.some(({ id }) => id === "script:vmath.lerp"),
    true,
  );
  assert.doesNotMatch(outputs.source, /script:vmath\.dot/);
  assert.match(outputs.source, /if\(!operation\)return DispatchStatus::kMissing/);

  const adapter = await readFile(new URL("defold/defold_hermes/src/script_scalar_lua_adapter.cpp", root), "utf8");
  assert.match(adapter, /overload_dispatch::dispatch[\s\S]*universal_value::dispatch/);
});

test("overload-dispatch rejects already-owned report provenance and identity drift", async () => {
  const inputs = await loadInputs();
  const revision = JSON.parse(inputs.ownedText);
  revision.defoldRevision = "0".repeat(40);
  assert.throws(
    () => generate({ ...inputs, ownedText: JSON.stringify(revision) }),
    /already-owned report uses a different Defold revision/,
  );

  const count = JSON.parse(inputs.ownedText);
  count.bindingCount = 77;
  assert.throws(
    () => generate({ ...inputs, ownedText: JSON.stringify(count) }),
    /already-owned value-binding census expected 78/,
  );

  const duplicate = JSON.parse(inputs.ownedText);
  duplicate.bindings[1] = structuredClone(duplicate.bindings[0]);
  assert.throws(
    () => generate({ ...inputs, ownedText: JSON.stringify(duplicate) }),
    /duplicate already-owned binding id/,
  );

  const duplicateStable = JSON.parse(inputs.ownedText);
  duplicateStable.bindings[1].stableId = duplicateStable.bindings[0].stableId;
  assert.throws(
    () => generate({ ...inputs, ownedText: JSON.stringify(duplicateStable) }),
    /duplicate already-owned binding stable ID/,
  );

  const stableId = JSON.parse(inputs.ownedText);
  stableId.bindings[0].stableId ^= 1;
  assert.throws(
    () => generate({ ...inputs, ownedText: JSON.stringify(stableId) }),
    /already-owned binding stable ID drifted/,
  );
});

test("overload-dispatch rejects classifier duplicate and count drift", async () => {
  const inputs = await loadInputs();
  const duplicate = JSON.parse(inputs.patternsText);
  duplicate.bindings[1] = structuredClone(duplicate.bindings[0]);
  assert.throws(() => generate({ ...inputs, patternsText: JSON.stringify(duplicate) }), /duplicate binding-pattern id/);

  const count = JSON.parse(inputs.patternsText);
  count.classifiedFunctionCount -= 1;
  assert.throws(
    () => generate({ ...inputs, patternsText: JSON.stringify(count) }),
    /binding-pattern classifier count drifted/,
  );
});
