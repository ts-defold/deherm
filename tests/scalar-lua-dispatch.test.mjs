import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);

test("scalar Lua descriptors are deterministic and complete", async () => {
  execFileSync(process.execPath, ["scripts/generate-scalar-lua-dispatch.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
  const report = JSON.parse(await readFile(new URL(
    "packages/bindings/generated/defold-script-scalar-dispatch.json", root), "utf8"));
  assert.equal(report.bindingCount, 90);
  assert.equal(report.bindings.length, 90);
  assert.equal(new Set(report.bindings.map((binding) => binding.stableId)).size, 90);
  assert.equal(report.bindings.filter((binding) => binding.executableStatus.includes("runtime dispatch enabled")).length, 90);
  assert.equal(report.bindings.filter((binding) => binding.executableStatus.includes("conformance not claimed")).length, 90);
});

test("source-validated bit.tohex optionality is explicit", async () => {
  const report = JSON.parse(await readFile(new URL(
    "packages/bindings/generated/defold-script-scalar-dispatch.json", root), "utf8"));
  const binding = report.bindings.find((entry) => entry.id === "script:bit.tohex");
  assert.ok(binding);
  assert.equal(binding.requiredArgumentCount, 1);
  assert.equal(binding.maximumArgumentCount, 2);
  assert.equal(binding.parameters[1].optional, true);
  assert.match(binding.semanticOverride.source, /bitop\.c$/);
  assert.match(binding.semanticOverride.observed, /lua_isnone/);
  assert.match(binding.semanticOverride.sourceSha256, /^[a-f0-9]{64}$/);
});

test("scalar lookup follows source-registered names without changing documented identity", async () => {
  const report = JSON.parse(await readFile(new URL(
    "packages/bindings/generated/defold-script-scalar-dispatch.json", root), "utf8"));
  const binding = report.bindings.find((entry) => entry.id === "script:sys.set_render_enable");
  assert.ok(binding);
  assert.equal(binding.rawName, "sys.set_render_enable");
  assert.equal(binding.modulePath, "sys");
  assert.equal(binding.member, "set_render_enabled");
});

test("descriptor report keeps allocation and coverage claims bounded", async () => {
  const report = JSON.parse(await readFile(new URL(
    "packages/bindings/generated/defold-script-scalar-dispatch.json", root), "utf8"));
  assert.match(report.coverageClaim, /runtime dispatch is installed for all 90/i);
  assert.match(report.coverageClaim, /real-engine conformance is not claimed/i);
  assert.match(report.allocationClaim, /Lua may allocate/i);
});

test("real-engine probes are deterministic and descriptor validated", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-real-engine-probes.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
  const [dispatch, probes, generated] = await Promise.all([
    readFile(new URL("packages/bindings/generated/defold-script-scalar-dispatch.json", root), "utf8").then(JSON.parse),
    readFile(new URL("packages/bindings/generated/defold-script-real-engine-probes.json", root), "utf8").then(JSON.parse),
    readFile(new URL("examples/runtime-smoke/src/generated/script-real-engine-probes.ts", root), "utf8")
  ]);
  const dispatchById = new Map(dispatch.bindings.map((binding) => [binding.id, binding]));
  assert.equal(probes.probeCount, 14);
  assert.equal(probes.uniqueBindingCount, 12);
  assert.deepEqual(probes.argumentCodecs, ["Boolean", "Number", "String"]);
  assert.deepEqual(probes.resultCodecs, ["Boolean", "Integer", "None", "Number", "String"]);
  assert.equal(probes.nullableResultProbeCount, 1);
  assert.equal(probes.optionalOmissionProbeCount, 2);
  assert.match(probes.coverageClaim, /no claim is made for unselected bindings or other targets/i);
  for (const probe of probes.probes) {
    const descriptor = dispatchById.get(probe.id);
    assert.ok(descriptor, probe.id);
    assert.equal(probe.stableId, descriptor.stableId);
    assert.ok(probe.arguments.length >= descriptor.requiredArgumentCount);
    assert.ok(probe.arguments.length <= descriptor.maximumArgumentCount);
    assert.match(probe.expectedMarkerPrefix, new RegExp(`script-api:${probe.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:$`));
  }
  assert.match(generated, /bit\.tohex\(33\)/);
  assert.match(generated, /sys\.getConfigString\("deherm_conformance\.missing"\)/);
  assert.match(generated, /profiler\.scopeBegin\("deherm-script-api-proof"\)/);
  assert.doesNotMatch(generated, /__defoldScriptBridgeV1|callScriptApi\(/);
});

test("all generated TypeScript script wrappers use the descriptor stable-ID scheme", async () => {
  const [ir, modules] = await Promise.all([
    readFile(new URL("../packages/bindings/generated/defold-script-api-ir.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../packages/sdk/src/generated/script/modules.ts", import.meta.url), "utf8")
  ]);
  const emitted = [...modules.matchAll(/callScriptApi\((0x[0-9a-f]+), args\)/gi)]
    .map((match) => Number(match[1]));
  assert.equal(emitted.length, 926);
  assert.equal(new Set(emitted).size, 926);
  assert.deepEqual(
    [...emitted].sort((left, right) => left - right),
    ir.functions.map(({ id }) => stableBindingId(id)).sort((left, right) => left - right)
  );
  assert.doesNotMatch(modules, /callScriptApi\(0x[0-9a-f]+u,/i);
});
