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

  // A workspace package is classified structurally, never by name. Declaring
  // `source` makes it a code package that the raw-source TypeScript graph must
  // resolve; omitting it makes it a data package that may only publish files.
  const codeNames = new Set();
  const dataNames = new Set();
  for (const packageName of packageNames) {
    const packageRoot = path.join(repositoryRoot, "packages", packageName);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.private, true, `${packageName} must remain internal to the unified npm artifact`);
    assert.equal(manifest.name, `@deherm/${packageName}`);
    assert.equal(
      codeNames.has(manifest.name) || dataNames.has(manifest.name),
      false,
      `${manifest.name} is duplicated`
    );
    assert.ok(manifest.exports, `${packageName} declares no exports`);

    if (typeof manifest.source === "string") {
      codeNames.add(manifest.name);
      await access(path.join(packageRoot, manifest.source));
      assert.ok(Object.hasOwn(manifest.exports, "."), `${packageName} has no root export`);
      if (manifest.types) await access(path.join(packageRoot, manifest.types));
      continue;
    }

    dataNames.add(manifest.name);
    assert.equal(
      Object.hasOwn(manifest.exports, "."),
      false,
      `${packageName} declares no raw source, so it must not publish a root export`
    );
    const subpaths = Object.entries(manifest.exports);
    assert.ok(subpaths.length > 0, `${packageName} declares no exported data files`);
    for (const [subpath, target] of subpaths) {
      assert.equal(typeof target, "string", `${packageName} export ${subpath} must be a single file`);
      assert.ok(target.endsWith(".json"), `${packageName} export ${subpath} must be declarative data`);
      await access(path.join(packageRoot, target));
    }
  }

  assert.ok(codeNames.size > 0, "the workspace must contain at least one code package");

  const rootTsconfig = JSON.parse(await readFile(path.join(repositoryRoot, "tsconfig.json"), "utf8"));
  const paths = rootTsconfig.compilerOptions?.paths ?? {};
  for (const workspaceName of codeNames) {
    assert.ok(Object.hasOwn(paths, workspaceName), `${workspaceName} has no raw-source TypeScript path mapping`);
  }
  for (const workspaceName of dataNames) {
    assert.equal(
      Object.hasOwn(paths, workspaceName),
      false,
      `${workspaceName} publishes no raw source and must not be a TypeScript path alias`
    );
  }
  assert.equal(Object.hasOwn(paths, "@ts-defold/deherm"), false, "the public package name must not be an internal workspace alias");
});

test("the public package ships directory boundaries instead of enumerated generated files", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@ts-defold/deherm");
  assert.equal(manifest.source, "./packages/sdk/src/index.ts");
  assert.deepEqual(manifest.files, [
    "bin/",
    "packages/",
    "defold/defold_hermes/",
    "!packages/**/*.type-test.ts",
    "README.md"
  ]);
});

test("every first-level example is a private workspace consumer", async () => {
  const exampleNames = (await readdir(path.join(repositoryRoot, "examples"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(exampleNames, ["runtime-smoke", "war-battles-online"]);

  for (const exampleName of exampleNames) {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "examples", exampleName, "package.json"), "utf8"));
    assert.equal(manifest.name, `@deherm/example-${exampleName}`);
    assert.equal(manifest.private, true);
    assert.equal(manifest.dependencies?.["@ts-defold/deherm"], "workspace:*");
    assert.equal(typeof manifest.source, "string");
    await access(path.join(repositoryRoot, "examples", exampleName, manifest.source));
    assert.ok(manifest.exports && Object.hasOwn(manifest.exports, "."));
  }

  const workspace = await readFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /- "packages\/\*"/);
  assert.match(workspace, /- "examples\/\*"/);
});
