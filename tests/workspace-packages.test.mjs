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
  assert.deepEqual(manifest.files, [
    "bin/",
    "packages/cli/",
    "packages/compiler/",
    "!packages/compiler/src/generated/",
    "packages/polyfills/",
    "packages/sdk/src/address.ts",
    "packages/sdk/src/component.ts",
    "packages/sdk/src/host.ts",
    "packages/sdk/src/hmr-state.ts",
    "packages/sdk/src/package.ts",
    "packages/static-hermes/src/globals.d.ts",
    "packages/static-hermes/src/typed-app.ts",
    "packages/static-hermes/src/generated/dmsdk-universal.ts",
    "packages/telemetry/",
    "packages/toolchains/host-compilers.json",
    "packages/toolchains/release-tags.json",
    "scripts/assemble-typed-native-extension.mjs",
    "packages/web-adapter/",
    "packages/bindings/policy-site.json",
    "packages/bindings/profiles.json",
    "packages/bindings/targets/",
    "defold/defold_hermes/",
    "!defold/defold_hermes/lib/**/*.a",
    "!defold/defold_hermes/lib/**/*.lib",
    "!defold/defold_hermes/lib/**/.deherm-artifact.json",
    "!defold/defold_hermes/include/libhermesvm-config.h",
    "!defold/defold_hermes/include/defold_hermes/generated*",
    "defold/defold_hermes/include/defold_hermes/generated_build_config.h",
    "defold/defold_hermes/include/defold_hermes/generated_component_proxy_capability.hpp",
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_static_frame.h",
    "!defold/defold_hermes/src/generated*",
    "defold/defold_hermes/src/generated_dmsdk_universal_static_frame.cpp",
    "!defold/defold_hermes/lib/web/generated*",
    "!packages/**/package.json",
    "!packages/**/*.type-test.ts",
    "README.md",
  ]);
});

test("every first-level example is a private workspace consumer", async () => {
  const exampleNames = (await readdir(path.join(repositoryRoot, "examples"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(exampleNames, ["runtime-smoke", "war-battles-online"]);

  for (const exampleName of exampleNames) {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "examples", exampleName, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, `@deherm/example-${exampleName}`);
    assert.equal(manifest.private, true);
    assert.equal(manifest.dependencies?.["@ts-defold/deherm"], "workspace:*");
    assert.equal(typeof manifest.source, "string");
    await access(path.join(repositoryRoot, "examples", exampleName, manifest.source));
    assert.ok(manifest.exports && Object.hasOwn(manifest.exports, "."));
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
