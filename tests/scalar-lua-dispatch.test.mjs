import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("scalar Lua descriptors are deterministic and complete", async () => {
  execFileSync(process.execPath, ["scripts/generate-scalar-lua-dispatch.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
  const report = JSON.parse(await readFile(new URL(
    "bindings/generated/defold-script-scalar-dispatch.json", root), "utf8"));
  assert.equal(report.bindingCount, 90);
  assert.equal(report.bindings.length, 90);
  assert.equal(new Set(report.bindings.map((binding) => binding.stableId)).size, 90);
  assert.equal(report.bindings.filter((binding) => binding.executableStatus.includes("not claimed")).length, 90);
});

test("source-validated bit.tohex optionality is explicit", async () => {
  const report = JSON.parse(await readFile(new URL(
    "bindings/generated/defold-script-scalar-dispatch.json", root), "utf8"));
  const binding = report.bindings.find((entry) => entry.id === "script:bit.tohex");
  assert.ok(binding);
  assert.equal(binding.requiredArgumentCount, 1);
  assert.equal(binding.maximumArgumentCount, 2);
  assert.equal(binding.parameters[1].optional, true);
  assert.match(binding.semanticOverride.source, /bitop\.c$/);
  assert.match(binding.semanticOverride.observed, /lua_isnone/);
  assert.match(binding.semanticOverride.sourceSha256, /^[a-f0-9]{64}$/);
});

test("descriptor report keeps allocation and coverage claims bounded", async () => {
  const report = JSON.parse(await readFile(new URL(
    "bindings/generated/defold-script-scalar-dispatch.json", root), "utf8"));
  assert.match(report.coverageClaim, /only the generic codec and mock representatives/i);
  assert.match(report.allocationClaim, /Lua may allocate/i);
});
