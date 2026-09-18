import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("every internal workspace package maps to canonical raw source", async () => {
  const packageNames = (await readdir(path.join(repositoryRoot, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(packageNames, [
    "abi",
    "bindings",
    "cli",
    "compiler",
    "polyfills",
    "sdk",
    "static-hermes",
    "telemetry",
    "web-adapter"
  ]);

  for (const packageName of packageNames) {
    const packageRoot = path.join(repositoryRoot, "packages", packageName);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.private, true, `${packageName} must remain internal to the unified npm artifact`);
    assert.match(manifest.name, /^@ts-defold\/deherm-internal-/);
    assert.equal(typeof manifest.source, "string", `${packageName} has no raw source mapping`);
    await access(path.join(packageRoot, manifest.source));
    assert.ok(manifest.exports && Object.hasOwn(manifest.exports, "."), `${packageName} has no root export`);
    if (manifest.types) await access(path.join(packageRoot, manifest.types));
  }
});

test("the public package ships directory boundaries instead of enumerated generated files", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.source, "./packages/sdk/src/index.ts");
  assert.deepEqual(manifest.files, [
    "bin/",
    "packages/",
    "!packages/**/*.type-test.ts",
    "README.md"
  ]);
});
