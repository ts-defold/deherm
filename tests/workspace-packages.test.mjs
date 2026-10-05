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
    assert.equal(codeNames.has(manifest.name) || dataNames.has(manifest.name), false, `${manifest.name} is duplicated`);
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
      `${packageName} declares no raw source, so it must not publish a root export`,
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
      `${workspaceName} publishes no raw source and must not be a TypeScript path alias`,
    );
  }
  // The repository's examples intentionally exercise the revision-derived SDK
  // through the public import spelling.  That development-only alias is not an
  // internal package identity: the packed root remains the revision-neutral
  // package.ts entry point asserted below.
  assert.deepEqual(paths["@ts-defold/deherm"], ["./packages/sdk/src/index.ts"]);
});

test("the public package ships directory boundaries instead of enumerated generated files", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@ts-defold/deherm");
  assert.equal(manifest.source, "./packages/sdk/src/package.ts");
  const files = manifest.files;
  assert.equal(new Set(files).size, files.length, "package files entries must be unique");

  for (const required of [
    "bin/",
    "packages/cli/",
    "packages/compiler/",
    "packages/polyfills/",
    "packages/telemetry/",
    "packages/web-adapter/",
    "defold/defold_hermes/",
    "extensions/defold-webtransport/defold_webtransport/",
    "README.md",
  ]) {
    assert.ok(files.includes(required), `public package is missing ${required}`);
  }

  const publishedTargets = [manifest.source, manifest.types];
  for (const declaration of Object.values(manifest.exports)) {
    if (typeof declaration === "string") publishedTargets.push(declaration);
    else publishedTargets.push(...Object.values(declaration));
  }
  const included = (target) => {
    const normalized = target.replace(/^\.\//, "");
    return files.some(
      (entry) =>
        !entry.startsWith("!") && (entry === normalized || (entry.endsWith("/") && normalized.startsWith(entry))),
    );
  };
  for (const target of new Set(publishedTargets)) {
    assert.equal(included(target), true, `exported target ${target} is not covered by package files`);
  }

  assert.equal(
    files.some((entry) => !entry.startsWith("!") && entry.startsWith("packages/bindings/generated/")),
    false,
    "revision-derived bindings must not be shipped in the npm package",
  );
  for (const extensionRoot of ["defold/defold_hermes/", "extensions/defold-webtransport/defold_webtransport/"]) {
    assert.ok(files.includes(`!${extensionRoot}lib/**/*.a`), `${extensionRoot} must exclude static archives`);
    assert.ok(files.includes(`!${extensionRoot}lib/**/*.lib`), `${extensionRoot} must exclude Windows archives`);
  }
  assert.ok(files.includes("!packages/**/package.json"));
  assert.ok(files.includes("!packages/**/*.type-test.ts"));
});

test("every first-level example declares either a deherm consumer or standalone contract", async () => {
  const exampleNames = (await readdir(path.join(repositoryRoot, "examples"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(exampleNames.length > 0, "the workspace must retain at least one runnable example");

  for (const exampleName of exampleNames) {
    const exampleRoot = path.join(repositoryRoot, "examples", exampleName);
    const manifest = JSON.parse(await readFile(path.join(exampleRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, `@deherm/example-${exampleName}`);
    assert.equal(manifest.private, true);
    if (manifest.dependencies?.["@ts-defold/deherm"] === "workspace:*") {
      assert.equal(typeof manifest.source, "string", `${exampleName} has no TypeScript source entry`);
      await access(path.join(exampleRoot, manifest.source));
      assert.ok(manifest.exports && Object.hasOwn(manifest.exports, "."));
      continue;
    }

    assert.equal(manifest.dependencies?.["@ts-defold/deherm"], undefined);
    assert.equal(typeof manifest.scripts?.check, "string", `${exampleName} has no standalone verification command`);
    await access(path.join(exampleRoot, "game.project"));
  }

  const runtimeSmokeTsconfig = JSON.parse(
    await readFile(path.join(repositoryRoot, "examples", "runtime-smoke", "tsconfig.json"), "utf8"),
  );
  assert.equal(
    runtimeSmokeTsconfig.extends,
    "../../tsconfig.json",
    "the runtime smoke must inherit the repository's revision-derived public SDK aliases",
  );

  const workspace = await readFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /- "packages\/\*"/);
  assert.match(workspace, /- "examples\/\*"/);
});
