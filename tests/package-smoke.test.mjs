import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { parseArguments } from "../packages/cli/src/cli.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function stageCurrentHostDehermc(root) {
  const host = `${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "dehermc.exe" : "dehermc";
  const manifest = JSON.parse(await readFile(path.join(
    repositoryRoot, "packages", "toolchains", "host-compilers.json"
  ), "utf8"));
  const record = manifest.hosts?.[host]?.tools?.dehermc;
  assert.equal(record?.status, "vendored", `${host} dehermc is not pinned`);
  const built = path.join(root, "built-dehermc");
  const ttscPackage = require.resolve("ttsc/package.json");
  const ttscRequire = createRequire(ttscPackage);
  const bundledGoRoot = path.dirname(ttscRequire.resolve(`@ttsc/${host}/package.json`));
  const bundledGo = path.join(
    bundledGoRoot,
    "bin", "go", "bin",
    process.platform === "win32" ? "go.exe" : "go"
  );
  run("bash", [
    path.join(repositoryRoot, "toolchains", "go", "build-dehermc.sh"),
    host,
    built
  ], {
    env: {
      ...process.env,
      GOCACHE: path.join(root, "go-cache"),
      PATH: `${path.dirname(bundledGo)}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });
  const source = path.join(built, executable);
  const bytes = await readFile(source);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256,
    "locally reproduced dehermc does not match the packaged digest");
  const tags = JSON.parse(await readFile(path.join(
    repositoryRoot, "packages", "toolchains", "release-tags.json"
  ), "utf8"));
  const cacheRoot = path.join(root, "tool-cache");
  const destination = path.join(cacheRoot, tags.families.dehermc.tag, host, executable);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
  return { cacheRoot, destination, sha256: record.sha256 };
}

test("command-specific target parsing keeps dev endpoints separate from conformance targets", () => {
  assert.equal(parseArguments([]).command, "ui");
  const creation = parseArguments(["create", "my-game", "--name", "My Game"]);
  assert.deepEqual(
    { command: creation.command, directory: creation.directory, name: creation.name },
    { command: "create", directory: "my-game", name: "My Game" }
  );

  const development = parseArguments([
    "dev",
    "--target", "http://127.0.0.1:8001",
    "--target", "http://127.0.0.1:8002"
  ]);
  assert.deepEqual(development.targets, ["http://127.0.0.1:8001", "http://127.0.0.1:8002"]);
  assert.equal(development.target, undefined);
  if (!process.stdin.isTTY || !process.stdout.isTTY) assert.equal(development.headless, true);

  const conformance = parseArguments(["conformance", "generate", "--target", "js-web"]);
  assert.equal(conformance.target, "js-web");
  assert.deepEqual(conformance.targets, []);
  assert.equal(parseArguments(["materialize-dmsdk", "--check"]).check, true);
  assert.equal(parseArguments(["typecheck", "--release"]).release, true);
  assert.equal(parseArguments(["dev", "--no-bytecode"]).bytecode, false);
  assert.throws(() => parseArguments(["generate", "--check"]), /Unknown option: --check/);
});

test("packed npm artifact loads its CLI and one-shot dev compiler", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-package-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "npm-cache");
  const packed = JSON.parse(run("npm", [
    "pack",
    "--json",
    "--cache", cache,
    "--pack-destination", root
  ]).stdout)[0];
  const packedFiles = new Set(packed.files.map(({ path: relative }) => relative));
  assert.equal(packedFiles.has("packages/generator/src/policy/generate-api-policy.mjs"), false,
    "repo-only policy derivation must not ship in the consumer package");
  assert.equal(packedFiles.has("packages/compiler/src/generated/dmsdk-universal-recipes.mjs"), false,
    "the package must not ship a pinned Defold dmSDK catalog as realization authority");
  for (const relative of [
    "packages/compiler/src/dmsdk-universal-static-frame.mjs",
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_static_frame.h",
    "defold/defold_hermes/src/generated_dmsdk_universal_static_frame.cpp",
    "packages/static-hermes/src/generated/dmsdk-universal.ts"
  ]) {
    assert.equal(packedFiles.has(relative), true, `packed npm artifact is missing ${relative}`);
  }
  for (const relative of packedFiles) {
    assert.equal(relative.startsWith("packages/bindings/generated/"), false, `${relative} leaked a fixed policy/binding surface`);
    assert.equal(relative.startsWith("packages/sdk/src/generated/"), false, `${relative} leaked a fixed SDK surface`);
    assert.equal(relative.startsWith("packages/abi/src/generated/"), false, `${relative} leaked a fixed ABI surface`);
    assert.equal(/\.(?:a|lib)$/u.test(relative), false, `${relative} leaked a target archive into the npm package`);
  }
  assert.equal(packedFiles.has("defold/defold_hermes/include/libhermesvm-config.h"), false,
    "the npm package leaked a target-specific Hermes config header");
  assert.equal(packedFiles.has("scripts/assemble-typed-native-extension.mjs"), true,
    "the installed CLI must carry its revision-neutral Static Hermes assembler");
  const archive = path.join(root, packed.filename);
  const installRoot = path.join(root, "install");
  await mkdir(installRoot, { recursive: true });
  run("tar", ["-xzf", archive, "-C", installRoot]);

  const packageRoot = path.join(installRoot, "package");
  await symlink(path.join(repositoryRoot, "node_modules"), path.join(installRoot, "node_modules"), "dir");
  await readFile(path.join(packageRoot, "packages", "compiler", "src", "binding-identity.mjs"), "utf8");
  await readFile(path.join(packageRoot, "packages", "compiler", "src", "component-proxy-generator.mjs"), "utf8");
  await assert.rejects(
    readFile(path.join(packageRoot, "packages", "bindings", "generated", "defold-script-real-engine-probes.json"), "utf8"),
    (error) => error?.code === "ENOENT"
  );
  const staticFrame = await import(pathToFileURL(path.join(
    packageRoot, "packages", "compiler", "src", "dmsdk-universal-static-frame.mjs"
  )));
  const emittedStaticFrame = staticFrame.emitDmSdkUniversalStaticFrame();
  assert.equal(emittedStaticFrame.argumentCapacity, 32);
  assert.equal(await readFile(path.join(
    packageRoot, "defold", "defold_hermes", "include", "defold_hermes", "generated_dmsdk_universal_static_frame.h"
  ), "utf8"), emittedStaticFrame.header);
  assert.equal(await readFile(path.join(
    packageRoot, "defold", "defold_hermes", "src", "generated_dmsdk_universal_static_frame.cpp"
  ), "utf8"), emittedStaticFrame.source);
  assert.equal(await readFile(path.join(
    packageRoot, "packages", "static-hermes", "src", "generated", "dmsdk-universal.ts"
  ), "utf8"), emittedStaticFrame.staticHermes);

  // The packed package contains the realizer but no policy. Feed it an external
  // content-addressed policy fixture, exactly as the publication site does.
  const shippedIndex = JSON.parse(await readFile(path.join(repositoryRoot, "packages", "bindings", "generated", "defold-policy-index.json"), "utf8"));
  const entry = shippedIndex.entries[0];
  const store = path.join(repositoryRoot, "packages", "bindings", "generated", "policy", shippedIndex.base.layoutVersion);
  const policy = JSON.parse(await readFile(path.join(store, "policy", `${entry.policyRoot}.json`), "utf8"));
  const objects = new Map(await Promise.all(Object.entries(policy.subtrees).map(async ([namespace, digest]) => [namespace, {
    digest,
    value: JSON.parse(await readFile(path.join(store, "object", `${digest}.json`), "utf8"))
  }])));
  const { materializePolicySurface } = await import(pathToFileURL(path.join(
    packageRoot,
    "packages", "compiler", "src", "policy-surface-materializer.mjs"
  )));
  const dehermCacheHome = path.join(root, "deherm-cache");
  const packedSurfaceRoot = path.join(dehermCacheHome, "surfaces", entry.defoldRevision);
  const materialized = await materializePolicySurface({
    revision: entry.defoldRevision,
    entry,
    policy,
    objects
  }, { outputRoot: packedSurfaceRoot });
  assert.equal(Object.keys(materialized.descriptor.sdk).length, 28);
  assert.equal(Object.keys(materialized.descriptor.outputs).length, 114);
  await readFile(path.join(packedSurfaceRoot, "sdk", "generated", "script", "types.ts"), "utf8");
  await readFile(path.join(
    packedSurfaceRoot,
    "repository", "defold", "defold_hermes", "src", "generated_scalar_lua_descriptors.cpp"
  ), "utf8");

  // The installed compiler must materialize the production and exact-call
  // dmSDK twins from policy-derived IR without reaching back into this checkout.
  const packedCatalog = path.join(packedSurfaceRoot, "ir", "defold-dmsdk-universal-bindings.json");
  const packedCatalogDocument = JSON.parse(await readFile(packedCatalog, "utf8"));
  assert.equal(
    staticFrame.assertDmSdkUniversalStaticFrameCapacity(packedCatalogDocument),
    packedCatalogDocument.abi.maxArguments
  );
  const packedRecipe = packedCatalogDocument.recipes.find(({ symbol, declarationKind, abi }) =>
    symbol === "dmEndian::ToNetwork" && declarationKind === "function" &&
    abi.parameters[0]?.nativeType === "uint32_t");
  assert.ok(packedRecipe);
  const packedUsage = path.join(root, "packed-dmsdk-usage.json");
  const packedProvider = path.join(root, "packed-dmsdk-provider.cpp");
  await writeFile(packedUsage, `${JSON.stringify({
    schemaVersion: 1,
    catalogSha256: packedCatalogDocument.sourceHashes.catalog,
    usages: [{
      declarationId: packedRecipe.declarationId,
      wrapper: "packed_to_network",
      acknowledgements: {
        generatedAdapterBypass: {
          reason: "packed npm smoke",
          evidence: "the installed CLI emits and checks the exact-call twin"
        }
      }
    }]
  }, null, 2)}\n`);
  const packedMaterialization = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "materialize-dmsdk",
    "--usage", packedUsage,
    "--catalog", packedCatalog,
    "--output", packedProvider,
    "--json"
  ], { cwd: root });
  assert.equal(JSON.parse(packedMaterialization.stdout).materializedCount, 1);
  await readFile(packedProvider, "utf8");
  await readFile(`${packedProvider}.json`, "utf8");
  await readFile(packedProvider.replace(/\.cpp$/, ".verify.cpp"), "utf8");
  await readFile(packedProvider.replace(/\.cpp$/, ".verify.json"), "utf8");
  run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "materialize-dmsdk",
    "--usage", packedUsage,
    "--catalog", packedCatalog,
    "--output", packedProvider,
    "--check"
  ], { cwd: root });

  const help = run(process.execPath, [path.join(packageRoot, "bin", "deherm.mjs"), "--help"]);
  assert.match(help.stdout, /deherm <command>/);

  const conformanceRoot = path.join(root, "conformance");
  const conformance = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "conformance", "generate",
    "--defold-sdk", entry.defoldRevision,
    "--output", conformanceRoot,
    "--surface", "script",
    "--target", "js-web",
    "--shard", "0/32",
    "--json"
  ], { cwd: root, env: { ...process.env, DEHERM_CACHE_HOME: dehermCacheHome } });
  const conformanceSummary = JSON.parse(conformance.stdout);
  assert.ok(conformanceSummary.selectedCaseCount > 0);
  const conformancePlan = path.join(conformanceRoot, "plan.json");
  await readFile(conformancePlan, "utf8");
  const conformanceObservation = path.join(conformanceRoot, "compile-observation.json");
  const compiledConformance = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "conformance", "compile",
    "--plan", conformancePlan,
    "--output", conformanceObservation,
    "--json"
  ], { cwd: root, env: { ...process.env, DEHERM_CACHE_HOME: dehermCacheHome } });
  assert.equal(JSON.parse(compiledConformance.stdout).passed, true);
  await readFile(conformanceObservation, "utf8");

  const consumer = path.join(root, "consumer");
  const installedPackage = path.join(consumer, "node_modules", "@ts-defold", "deherm");
  await mkdir(path.dirname(installedPackage), { recursive: true });
  await symlink(packageRoot, installedPackage, "dir");
  await writeFile(path.join(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true
    },
    include: ["package-api.ts"]
  }, null, 2)}\n`);
  await writeFile(path.join(consumer, "package-api.ts"), [
    'import { hashLiteral, type DefoldHash } from "@ts-defold/deherm";',
    'const id: DefoldHash = hashLiteral("#packed-component");',
    'void id;',
    ""
  ].join("\n"));
  run(process.execPath, [
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "--project", path.join(consumer, "tsconfig.json"),
    "--pretty", "false"
  ], { cwd: consumer });

  const project = path.join(root, "project");
  const dehermc = await stageCurrentHostDehermc(root);
  const forbiddenGoCompiler = path.join(root, "user-side-go-build-must-not-run");
  const created = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "create", project,
    "--name", "Packed smoke test",
    "--defold-sdk", entry.defoldRevision,
    "--json"
  ], { cwd: root, env: { ...process.env, DEHERM_CACHE_HOME: dehermCacheHome } });
  // Generated projects enable the `@ts-defold/deherm/ttsc` transform, which the
  // TypeScript plugin loader resolves from the project itself. Reproduce the
  // layout a real `npm install` produces so the transform actually loads.
  await mkdir(path.join(project, "node_modules", "@ts-defold"), { recursive: true });
  await symlink(packageRoot, path.join(project, "node_modules", "@ts-defold", "deherm"), "dir");
  await symlink(
    path.join(repositoryRoot, "node_modules", "typescript"),
    path.join(project, "node_modules", "typescript"),
    "dir"
  );
  assert.equal(JSON.parse(created.stdout).projectRoot, project);
  assert.match(await readFile(path.join(project, "game.project"), "utf8"), /title = Packed smoke test/);
  assert.match(await readFile(path.join(project, "src", "main.script.ts"), "utf8"), /defineComponent/);
  assert.equal(await readFile(path.join(project, "input", "game.input_binding"), "utf8"), "");

  run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "assemble-typed-native",
    "--project", project,
    "--target", "wasm-web",
    "--reconcile"
  ], { cwd: project, env: { ...process.env, DEHERM_CACHE_HOME: dehermCacheHome } });

  const verified = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "verify-generated",
    "--project", project,
    "--json"
  ], { cwd: project, env: { ...process.env, DEHERM_CACHE_HOME: dehermCacheHome } });
  assert.ok(JSON.parse(verified.stdout).checkedFiles > 0);
  assert.equal(JSON.parse(verified.stdout).componentCount, 1);

  const checked = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "typecheck",
    "--project", project,
    "--json"
  ], { cwd: project, env: { ...process.env, DEHERM_CACHE_HOME: dehermCacheHome } });
  assert.equal(JSON.parse(checked.stdout).passed, true);

  const releaseChecked = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "typecheck",
    "--release",
    "--project", project,
    "--json"
  ], { cwd: project, env: {
    ...process.env,
    DEHERM_CACHE_HOME: dehermCacheHome,
    DEHERM_OFFLINE: "1",
    DEHERM_TOOL_CACHE: dehermc.cacheRoot,
    // ttsc gives this explicit path priority over every bundled/system Go
    // compiler. It deliberately does not exist: either installed compiler path
    // reaching buildSourcePlugin would make this smoke test fail.
    TTSC_GO_BINARY: forbiddenGoCompiler
  } });
  const releaseResult = JSON.parse(releaseChecked.stdout);
  assert.equal(releaseResult.profile, "release");
  assert.equal(releaseResult.passed, true);
  assert.equal(releaseResult.compiler, dehermc.destination);
  assert.equal(releaseResult.compilerSha256, dehermc.sha256);
  const packedReleaseUsage = JSON.parse(await readFile(
    path.join(project, ".deherm", "generated", "dmsdk-usage.json"), "utf8"));
  assert.equal(packedReleaseUsage.profile, "release");
  assert.deepEqual(packedReleaseUsage.specializationRequiredSites, []);

  const development = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "dev",
    "--project", project,
    "--once",
    "--headless",
    "--no-bytecode"
  ], { cwd: project, env: {
    ...process.env,
    DEHERM_CACHE_HOME: dehermCacheHome,
    DEHERM_OFFLINE: "1",
    DEHERM_TOOL_CACHE: dehermc.cacheRoot,
    TTSC_GO_BINARY: forbiddenGoCompiler
  } });
  assert.match(development.stdout, /\[deherm\] build-succeeded generation=1/);
  await readFile(path.join(project, ".deherm", "dev", "app.dehermc"), "utf8");
});
