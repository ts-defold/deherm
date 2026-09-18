import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const generator = path.join(root, "scripts/generate-static-hermes-vmath.mjs");
const descriptorPath = path.join(root, "bindings/generated/defold-script-value-bindings.json");
const outputFiles = [
  "bindings/generated/defold-static-hermes-vmath.json",
  "defold/defold_hermes/include/defold_hermes/generated_static_hermes_vmath.h",
  "defold/defold_hermes/src/generated_static_hermes_vmath.cpp",
  "packages/static-hermes/src/generated/script-vmath.ts"
];

function run(arguments_) {
  return spawnSync(process.execPath, [generator, ...arguments_], {
    cwd: root,
    encoding: "utf8"
  });
}

test("Static Hermes vmath bridge is current and covers only sound scalar results", async () => {
  const result = run(["--check"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(path.join(root, outputFiles[0]), "utf8"));
  const [descriptorRaw, overrideRaw] = await Promise.all([
    readFile(descriptorPath, "utf8"),
    readFile(path.join(root, "bindings/overrides/static-hermes-vmath.json"), "utf8")
  ]);
  assert.equal(report.descriptorSha256, createHash("sha256").update(descriptorRaw).digest("hex"));
  assert.equal(report.overrideSha256, createHash("sha256").update(overrideRaw).digest("hex"));
  assert.deepEqual(report.coverage, {
    descriptorBindings: 78,
    scopedVmathBindings: 30,
    includedBindings: 3,
    includedCallShapes: 7,
    structuredResultExclusions: 27,
    outOfScopeBindings: 48
  });
  assert.deepEqual(
    report.included.map(({ id }) => id),
    ["script:vmath.length", "script:vmath.project", "script:vmath.length_sqr"]
  );
  assert.equal(new Set(report.included.map(({ stableId }) => stableId)).size, 3);
  assert.equal(report.exclusions.length, 75);
});

test("Static Hermes vmath generation is deterministic", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-static-vmath-"));
  try {
    const result = run(["--output-root", temporary]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const relative of outputFiles) {
      const [expected, actual] = await Promise.all([
        readFile(path.join(root, relative), "utf8"),
        readFile(path.join(temporary, relative), "utf8")
      ]);
      assert.equal(actual, expected, `${relative} was not generated deterministically`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Static Hermes vmath generation rejects descriptor drift before emitting", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-static-vmath-drift-"));
  try {
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.bindings.find(({ id }) => id === "script:vmath.length").stableId ^= 1;
    const changedDescriptor = path.join(temporary, "descriptor.json");
    await writeFile(changedDescriptor, `${JSON.stringify(descriptor, null, 2)}\n`);
    const result = run([
      "--descriptor", changedDescriptor,
      "--output-root", path.join(temporary, "output")
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /descriptor-sha256-drift/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("generated bridge keeps float32 lanes and stack-only ScriptCallFrame glue", async () => {
  const [typescript, source] = await Promise.all([
    readFile(path.join(root, outputFiles[3]), "utf8"),
    readFile(path.join(root, outputFiles[2]), "utf8")
  ]);
  assert.match(typescript, /arg0X: c_f32/);
  assert.match(typescript, /\): c_f64/);
  assert.equal((typescript.match(/if \(result !== result\)/g) ?? []).length, 7);
  assert.match(typescript, /throw "deherm Static Hermes dispatch failed: script:vmath\.project\(Vector3,Vector3\)"/);
  assert.match(source, /ScriptValue arguments\[2\]\{\}/);
  assert.match(source, /ScriptCallFrame frame\{\}/);
  assert.match(source, /value_binding::dispatch\(&frame, nullptr, 0\)/);
  assert.doesNotMatch(source, /\b(?:new|malloc|calloc|realloc|free)\b/);
});
