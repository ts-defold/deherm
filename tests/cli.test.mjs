import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import { buildProjectBindingIr as compileProjectBindingIr, buildScriptContextCapabilities, generateExtensionTypes as renderExtensionTypes, generatedProjectCacheMatches, installNativeExtension, shouldResolvePublishedPolicy, typecheckGeneratedProject, verifyGeneratedProject, writeGeneratedProject } from "../packages/cli/src/generate.mjs";
import { materializeDmSdkUsageFile } from "../packages/cli/src/dmsdk.mjs";
import { materializeProjectNativeExtensionApis, resolveNativeExtensionClang } from "../packages/cli/src/native-extension-api.mjs";
import { writeProjectDmSdkCallSymbolIndex, writeProjectResourceSymbols, writeProjectRouteSymbolIndex } from "../packages/cli/src/resource-symbols.mjs";
import { hostDefoldPlatform } from "../packages/cli/src/toolchains.mjs";
import { PUBLIC_EXTENSION_ZIP_LIMITS, discoverProjectRoots, findProjectRoot, inspectDefoldProject, parseGameProject, resolveEngineProfiles } from "../packages/cli/src/project.mjs";
import { generateComponentProxies } from "../packages/compiler/src/component-proxy-generator.mjs";
import { dmSdkUniversalCatalogSha256, dmSdkUniversalRecipes } from "../packages/compiler/src/generated/dmsdk-universal-recipes.mjs";

// Every fixture states the Defold revision it targets. Generation resolves the
// revision from the project rather than assuming the packaged one, so a fixture
// that names none is now refused - which is the behaviour under test in
// `defold-revision.test.mjs`.
const bundledDefoldRevision = JSON.parse(
  await readFile(path.resolve("packages/bindings/generated/defold-script-api-ir.json"), "utf8")).defoldRevision;
const defoldValueLayouts = JSON.parse(
  await readFile(path.resolve("packages/bindings/generated/defold-value-layouts.json"), "utf8"));
const buildProjectBindingIr = (inventory) => compileProjectBindingIr(inventory, defoldValueLayouts);
const generateExtensionTypes = (inventory) => renderExtensionTypes(inventory, defoldValueLayouts);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "defold-hermes-cli-"));
  await mkdir(path.join(root, "camera", "src"), { recursive: true });
  await mkdir(path.join(root, "camera", "include"), { recursive: true });
  await mkdir(path.join(root, ".internal", "lib"), { recursive: true });
  await writeFile(path.join(root, "game.project"), `[project]\ntitle = Fixture\ndependencies#0 = https://token:secret@example.com/math.zip?signature=private#fragment\n\n[defold_hermes]\ndefold_sdk = ${bundledDefoldRevision}\n`);
  await writeFile(path.join(root, "camera", "ext.manifest"), `name: Camera\nplatforms:\n  arm64-osx: {}\n`);
  await writeFile(path.join(root, "camera", "include", "camera.h"), [
    "#include <stdint.h>",
    '#include "camera_types.inc"',
    "uint32_t camera_accumulate(uint32_t value, int32_t delta);",
    "typedef struct CameraPoint { float x; float y; } CameraPoint;",
    "CameraPoint camera_translate(CameraPoint point, float x, float y);",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "camera", "include", "camera_types.inc"), "#define CAMERA_FIXTURE 1\n");
  await writeFile(path.join(root, "camera", "src", "camera.cpp"), "// fixture\n");
  await writeFile(path.join(root, "camera", "camera.script_api"), `
- name: camera
  type: table
  desc: Camera access.
  members:
    - name: start
      type: function
      parameters:
        - name: facing
          type: string
      return:
        type: boolean
    - name: focus_target
      type: function
      parameters:
        - name: target
          type: string|hash|url
`);
  const archive = zipSync({
    "./math/ext.manifest": strToU8("name: XMath\n"),
    "./math/api/include/xmath.h": strToU8("#include <xmath_common.inc>\ndouble XMathDot(double left, double right, XMathMode mode);\nXMathPoint XMathTranslate(XMathPoint point);\n"),
    "./math/common/include/xmath_common.inc": strToU8("typedef enum XMathMode { XMATH_ADD = 0, XMATH_MULTIPLY = 1 } XMathMode;\ntypedef struct XMathPoint { double x; double y; } XMathPoint;\ndouble SharedHelper(double value);\n"),
    "./math/src/xmath.cpp": strToU8("// fixture\n"),
    "./math/xmath.script_api": strToU8(`
- name: xmath
  type: table
  members:
    - name: dot
      type: function
      parameters:
        - name: left
          type: number
        - name: right
          type: number
      return:
        type: number
`)
  });
  await writeFile(path.join(root, ".internal", "lib", "math.zip"), archive);
  return root;
}

test("managed native extension install is content-keyed and replaces through a staged tree", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "deherm-managed-extension-project-"));
  const source = await mkdtemp(path.join(tmpdir(), "deherm-managed-extension-source-"));
  await mkdir(path.join(source, "src"));
  await writeFile(path.join(source, "ext.manifest"), 'name: "defold_hermes"\n');
  await writeFile(path.join(source, "src", "extension.cpp"), "// v1\n");
  await writeFile(path.join(project, "game.project"), "[project]\ntitle = Managed fixture\n");

  const first = await installNativeExtension(project, { source });
  assert.equal(first.installed, true);
  const sentinelPath = path.join(project, "defold_hermes", ".deherm-managed.json");
  const firstIdentity = JSON.parse(await readFile(sentinelPath, "utf8"));
  assert.equal(firstIdentity.schemaVersion, 3);
  assert.match(firstIdentity.extensionTreeSha256, /^[a-f0-9]{64}$/);
  assert.equal((await installNativeExtension(project, { source })).installed, false);

  await writeFile(path.join(source, "src", "extension.cpp"), "// v2\n");
  assert.equal((await installNativeExtension(project, { source })).installed, true);
  const secondIdentity = JSON.parse(await readFile(sentinelPath, "utf8"));
  assert.notEqual(secondIdentity.extensionTreeSha256, firstIdentity.extensionTreeSha256);
  assert.equal(await readFile(path.join(project, "defold_hermes", "src", "extension.cpp"), "utf8"), "// v2\n");
  assert.deepEqual((await readdir(project)).filter((name) => name.includes(".deherm-stage-") || name.includes(".deherm-backup-")), []);
  assert.equal((await inspectDefoldProject({ project })).extensions.length, 0, "managed runtime must not feed its own project API inventory");
});

test("managed native extension installation never copies target artifacts from a checkout", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "deherm-managed-extension-target-project-"));
  const source = await mkdtemp(path.join(tmpdir(), "deherm-managed-extension-target-source-"));
  await mkdir(path.join(source, "include"), { recursive: true });
  await mkdir(path.join(source, "lib", "arm64-osx"), { recursive: true });
  await mkdir(path.join(source, "lib", "web"), { recursive: true });
  await writeFile(path.join(source, "ext.manifest"), 'name: "defold_hermes"\n');
  await writeFile(path.join(source, "include", "libhermesvm-config.h"), "checkout target config\n");
  await writeFile(path.join(source, "lib", "arm64-osx", "libhermes.a"), "checkout release library\n");
  await writeFile(path.join(source, "lib", "arm64-osx", "libhermes.debug.a"), "checkout debug library\n");
  await writeFile(path.join(source, "lib", "arm64-osx", ".deherm-artifact.json"), "{}\n");
  await writeFile(path.join(source, "lib", "web", "library_defold_hermes.js"), "// portable browser source\n");

  await installNativeExtension(project, { source });

  await assert.rejects(stat(path.join(project, "defold_hermes", "include", "libhermesvm-config.h")), /ENOENT/u);
  await assert.rejects(stat(path.join(project, "defold_hermes", "lib", "arm64-osx", "libhermes.a")), /ENOENT/u);
  await assert.rejects(stat(path.join(project, "defold_hermes", "lib", "arm64-osx", "libhermes.debug.a")), /ENOENT/u);
  await assert.rejects(stat(path.join(project, "defold_hermes", "lib", "arm64-osx", ".deherm-artifact.json")), /ENOENT/u);
  assert.equal(
    await readFile(path.join(project, "defold_hermes", "lib", "web", "library_defold_hermes.js"), "utf8"),
    "// portable browser source\n"
  );
});

test("managed native extension installation replaces a package workspace symlink", async (t) => {
  if (process.platform === "win32") return t.skip("directory symlink creation requires host policy on Windows");
  const project = await mkdtemp(path.join(tmpdir(), "deherm-managed-extension-link-project-"));
  const source = await mkdtemp(path.join(tmpdir(), "deherm-managed-extension-link-source-"));
  t.after(() => Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(source, { recursive: true, force: true })
  ]));
  await mkdir(path.join(source, "src"));
  await writeFile(path.join(source, "ext.manifest"), 'name: "defold_hermes"\n');
  await writeFile(path.join(source, "src", "extension.cpp"), "// package\n");
  await symlink(source, path.join(project, "defold_hermes"));

  const installed = await installNativeExtension(project, { source });
  assert.equal(installed.installed, true);
  assert.equal((await lstat(path.join(project, "defold_hermes"))).isSymbolicLink(), false);
  await writeFile(path.join(project, "defold_hermes", "src", "extension.cpp"), "// project\n");
  assert.equal(await readFile(path.join(source, "src", "extension.cpp"), "utf8"), "// package\n");
});

test("game.project parser preserves indexed dependency keys", () => {
  const parsed = parseGameProject("[project]\ndependencies#0 = a\ndependencies#1 = b\n");
  assert.equal(parsed.project["dependencies#0"], "a");
  assert.equal(parsed.project["dependencies#1"], "b");
  const adversarial = parseGameProject("[__proto__]\npolluted = no\n");
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(adversarial.__proto__.polluted, "no");
});

test("runtime configuration validation fails closed until the Defold project exposes the deherm resource", async () => {
  const project = await fixture();
  const invalid = await inspectDefoldProject({ project, requireDehermRuntime: true });
  assert.deepEqual(invalid.diagnostics.filter(({ path: file }) => file === "game.project").map(({ message }) => message), [
    "[project] custom_resources must include /deherm",
    "[script] shared_state must be 1",
    "[library] include_dirs must include defold_hermes",
    "[defold_hermes] app must be /deherm/app.dehermc"
  ]);
  await writeFile(path.join(project, "game.project"), [
    "[project]",
    "title = Fixture",
    "custom_resources = /assets, /deherm",
    "[script]",
    "shared_state = 1",
    "[library]",
    "include_dirs = other, defold_hermes",
    "[defold_hermes]",
    "app = /deherm/app.dehermc",
    ""
  ].join("\n"));
  const valid = await inspectDefoldProject({ project, requireDehermRuntime: true });
  assert.deepEqual(valid.diagnostics.filter(({ path: file }) => file === "game.project"), []);
});

test("dmSDK usage materialization is deterministic and checkable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-materialize-"));
  const recipe = dmSdkUniversalRecipes.find(({ symbol, declarationKind, abi }) =>
    symbol === "dmEndian::ToNetwork" && declarationKind === "function" && abi.parameters[0]?.nativeType === "uint32_t");
  assert.ok(recipe);
  const usage = path.join(root, "dmsdk-usage.json");
  const output = path.join(root, "generated", "dmsdk-provider.cpp");
  const catalog = path.resolve("packages/bindings/generated/defold-dmsdk-universal-bindings.json");
  await writeFile(path.join(root, "game.project"), "[project]\ntitle = dmSDK materializer fixture\n");
  await mkdir(path.join(root, ".deherm", "ir"), { recursive: true });
  await writeFile(
    path.join(root, ".deherm", "ir", "dmsdk-universal-bindings.json"),
    await readFile(catalog)
  );
  await writeFile(
    path.join(root, ".deherm", "ir", "dmsdk.json"),
    await readFile(path.resolve("packages/bindings/generated/defold-sdk-ir.json"))
  );
  const checkerIndex = await writeProjectDmSdkCallSymbolIndex(path.join(root, ".deherm"));
  const checkerIndexSource = await readFile(checkerIndex.file, "utf8");
  const checkerIndexSourceSha256 = createHash("sha256").update(checkerIndexSource).digest("hex");
  await writeFile(usage, `${JSON.stringify({
    schemaVersion: 1,
    catalogSha256: dmSdkUniversalCatalogSha256,
    usages: [{
      declarationId: recipe.declarationId,
      wrapper: "fixture_to_network",
      nativeSymbol: "dmEndian::ToNetwork",
      acknowledgements: { generatedAdapterBypass: { reason: "CLI fixture", evidence: "compiled materializer test" } }
    }]
  }, null, 2)}\n`);
  const generated = await materializeDmSdkUsageFile({ usage, output });
  assert.equal(generated.materializedCount, 1);
  assert.equal(generated.provider.install, "deherm_dmsdk_generated_provider_install");
  assert.equal(
    generated.verificationProvider.install,
    "deherm_dmsdk_generated_provider_install_exact_verification",
  );
  assert.match(await readFile(output, "utf8"), /fixture_to_network/);
  const verificationSource = output.replace(/\.cpp$/, ".verify.cpp");
  const verificationReport = output.replace(/\.cpp$/, ".verify.json");
  const jsiVerificationSource = output.replace(/\.cpp$/, ".verify.jsi.cpp");
  const jsiVerificationReport = output.replace(/\.cpp$/, ".verify.jsi.json");
  assert.match(await readFile(verificationSource, "utf8"), /fixture_to_network__exact_callee/);
  const verification = JSON.parse(await readFile(verificationReport, "utf8"));
  assert.equal(verification.vectorCount, 1);
  assert.equal(verification.vectors[0].nativeSymbol, "dmEndian::ToNetwork");
  assert.equal(verification.vectors[0].parameters[0].resolvedNativeType, "uint32_t");
  assert.match(verification.vectors[0].vectorSha256, /^[0-9a-f]{64}$/);
  assert.match(await readFile(jsiVerificationSource, "utf8"), /#include "dmsdk-provider\.verify\.cpp"/);
  assert.match(await readFile(jsiVerificationSource, "utf8"), /installDmSdkUniversalModule/);
  const jsiVerification = JSON.parse(await readFile(jsiVerificationReport, "utf8"));
  assert.equal(jsiVerification.transport, "dynamic-hermes-jsi");
  assert.equal(jsiVerification.vectorCount, 1);
  assert.equal(jsiVerification.executableVectorCount, 1);
  assert.deepEqual(jsiVerification.unsupported, []);
  assert.equal(jsiVerification.verificationInclude, "dmsdk-provider.verify.cpp");
  const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
  assert.equal(report.materializedCount, 1);
  assert.equal(report.declarations[0].declarationId, recipe.declarationId);
  assert.equal(report.verificationManifestSha256, verification.manifestSha256);
  assert.equal(
    report.verificationReportSha256,
    createHash("sha256").update(await readFile(verificationReport, "utf8")).digest("hex"),
  );
  assert.equal(
    report.jsiVerificationOutputSha256,
    createHash("sha256").update(await readFile(jsiVerificationSource, "utf8")).digest("hex"),
  );
  assert.equal(
    report.jsiVerificationReportSha256,
    createHash("sha256").update(await readFile(jsiVerificationReport, "utf8")).digest("hex"),
  );
  const checked = await materializeDmSdkUsageFile({ usage, output, check: true });
  assert.equal(checked.checked, true);
  await writeFile(verificationSource, "// stale exact-call twin\n");
  await assert.rejects(
    materializeDmSdkUsageFile({ usage, output, check: true }),
    /dmsdk-provider\.verify\.cpp is stale/,
  );
  await materializeDmSdkUsageFile({ usage, output });
  await writeFile(verificationReport, "{}\n");
  await assert.rejects(
    materializeDmSdkUsageFile({ usage, output, check: true }),
    /dmsdk-provider\.verify\.json is stale/,
  );
  await materializeDmSdkUsageFile({ usage, output });
  await writeFile(jsiVerificationSource, "// stale JSI exact-call runner\n");
  await assert.rejects(
    materializeDmSdkUsageFile({ usage, output, check: true }),
    /dmsdk-provider\.verify\.jsi\.cpp is stale/,
  );
  await materializeDmSdkUsageFile({ usage, output });
  await writeFile(jsiVerificationReport, "{}\n");
  await assert.rejects(
    materializeDmSdkUsageFile({ usage, output, check: true }),
    /dmsdk-provider\.verify\.jsi\.json is stale/,
  );
  await materializeDmSdkUsageFile({ usage, output });
  await writeFile(`${output}.json`, "{}\n");
  await assert.rejects(
    materializeDmSdkUsageFile({ usage, output, check: true }),
    /dmsdk-provider\.cpp\.json is stale/,
  );
  await materializeDmSdkUsageFile({ usage, output });
  await writeFile(output, "// stale\n");
  await assert.rejects(materializeDmSdkUsageFile({ usage, output, check: true }), /is stale/);
  const cliOutput = path.join(root, "generated", "dmsdk-provider-cli.cpp");
  const cli = spawnSync(process.execPath, [
    path.resolve("bin/deherm.mjs"), "materialize-dmsdk",
    "--usage", usage, "--output", cliOutput, "--project", root, "--json"
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
  assert.equal(JSON.parse(cli.stdout).materializedCount, 1);
  assert.match(await readFile(cliOutput, "utf8"), /fixture_to_network/);
  assert.match(
    await readFile(cliOutput.replace(/\.cpp$/, ".verify.cpp"), "utf8"),
    /fixture_to_network__exact_call/,
  );

  const automaticRecipe = dmSdkUniversalRecipes.find(({ symbol }) => symbol === "dmGraphics::Finalize");
  assert.ok(automaticRecipe);
  const automaticUsage = path.join(root, ".deherm", "generated", "dmsdk-usage.json");
  await mkdir(path.dirname(automaticUsage), { recursive: true });
  await writeFile(automaticUsage, `${JSON.stringify({
    schemaVersion: 1,
    catalogSha256: dmSdkUniversalCatalogSha256,
    usages: [{ declarationId: automaticRecipe.declarationId }]
  }, null, 2)}\n`);
  const automatic = await materializeDmSdkUsageFile({ project: root });
  assert.equal(automatic.materializedCount, 1);
  assert.equal(automatic.usage, automaticUsage);
  assert.equal(automatic.output, path.join(root, ".deherm", "generated", "dmsdk-reachable.cpp"));
  assert.match(await readFile(automatic.output, "utf8"), /dmGraphics::Finalize/);

  const checkerDocument = (profile, usages, overrides = {}) => ({
    schemaVersion: 1,
    generator: "@ts-defold/deherm ttsc/dmsdk-usage/v1",
    profile,
    defoldRevision: bundledDefoldRevision,
    catalogSha256: dmSdkUniversalCatalogSha256,
    symbolIndexSourceSha256: checkerIndexSourceSha256,
    surfaceRecipeCount: dmSdkUniversalRecipes.length,
    usageCount: usages.length,
    usages,
    ambiguousSites: [],
    unresolvedSites: [],
    specializationRequiredSites: [],
    ...overrides
  });
  const finalizeUsage = {
    declarationId: automaticRecipe.declarationId,
    numericId: automaticRecipe.numericId,
    symbol: automaticRecipe.symbol,
    materialization: { state: "universal-ready", requirements: [] },
    sites: [{ file: "src/game.ts", line: 1, column: 1 }]
  };
  const checkerUsage = path.join(root, "checker-usage.json");
  await writeFile(checkerUsage, `${JSON.stringify(checkerDocument("development", [finalizeUsage]))}\n`);
  await assert.rejects(
    materializeDmSdkUsageFile({ usage: checkerUsage, output: path.join(root, "generated", "development.cpp") }),
    /release-profile typecheck/,
  );
  await writeFile(checkerUsage, `${JSON.stringify(checkerDocument("release", [], {
    ambiguousSites: [{ file: "src/game.ts", line: 1, column: 1 }]
  }))}\n`);
  await assert.rejects(
    materializeDmSdkUsageFile({ usage: checkerUsage, output: path.join(root, "generated", "ambiguous.cpp") }),
    /has 1 ambiguousSites/,
  );
  await writeFile(checkerUsage, `${JSON.stringify(checkerDocument("release", [finalizeUsage]))}\n`);
  const checkerGenerated = await materializeDmSdkUsageFile({
    usage: checkerUsage,
    output: path.join(root, "generated", "checker.cpp")
  });
  assert.equal(checkerGenerated.materializedCount, 1);
  assert.equal(checkerGenerated.generatedAdapterCount, 0);

  await writeFile(checkerIndex.file, `${checkerIndexSource} `);
  await assert.rejects(
    materializeDmSdkUsageFile({ usage: checkerUsage, output: path.join(root, "generated", "stale-index.cpp") }),
    /source SHA-256 does not match the release typecheck manifest/,
  );
  await writeFile(checkerIndex.file, checkerIndexSource);
  await writeFile(checkerUsage, `${JSON.stringify(checkerDocument("release", [{
    ...finalizeUsage,
    numericId: finalizeUsage.numericId + 1
  }]))}\n`);
  await assert.rejects(
    materializeDmSdkUsageFile({ usage: checkerUsage, output: path.join(root, "generated", "wrong-usage.cpp") }),
    /does not match the authenticated symbol index/,
  );

  const adapterRecipe = dmSdkUniversalRecipes.find(({ preferredLowering }) =>
    preferredLowering?.state === "generated-adapter");
  assert.ok(adapterRecipe);
  const adapterUsage = {
    declarationId: adapterRecipe.declarationId,
    numericId: adapterRecipe.numericId,
    symbol: adapterRecipe.symbol,
    materialization: checkerIndex.index.declarations[adapterRecipe.declarationId].materialization,
    sites: [{ file: "src/game.ts", line: 2, column: 1 }]
  };
  await writeFile(checkerUsage, `${JSON.stringify(checkerDocument("release", [adapterUsage]))}\n`);
  const adapterOutput = path.join(root, "generated", "adapter.cpp");
  const adapterGenerated = await materializeDmSdkUsageFile({ usage: checkerUsage, output: adapterOutput });
  assert.equal(adapterGenerated.materializedCount, 1);
  assert.equal(adapterGenerated.universalMaterializedCount, 0);
  assert.equal(adapterGenerated.generatedAdapterCount, 1);
  assert.match(await readFile(adapterOutput, "utf8"), new RegExp(adapterRecipe.preferredLowering.adapter.dispatcher ?? adapterRecipe.preferredLowering.wrapper));
  const adapterReport = JSON.parse(await readFile(`${adapterOutput}.json`, "utf8"));
  assert.equal(adapterReport.declarations[0].family, adapterRecipe.preferredLowering.family);
  assert.match(adapterReport.declarations[0].planSha256, /^[0-9a-f]{64}$/);
});

test("project discovery resolves nearest and bounded descendant projects deterministically", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-project-discovery-"));
  const alpha = path.join(workspace, "games", "alpha");
  const beta = path.join(workspace, "games", "beta");
  await mkdir(path.join(alpha, "src", "nested"), { recursive: true });
  await mkdir(beta, { recursive: true });
  await writeFile(path.join(alpha, "game.project"), "[project]\ntitle = Alpha\n");
  await writeFile(path.join(beta, "game.project"), "[project]\ntitle = Beta\n");

  assert.equal(await findProjectRoot(path.join(alpha, "src", "nested")), alpha);
  assert.deepEqual(await discoverProjectRoots(workspace), [alpha, beta]);
  await assert.rejects(findProjectRoot(workspace), /Multiple Defold projects found/);
  assert.equal(await findProjectRoot(workspace, path.join(alpha, "game.project")), alpha);

  const single = await mkdtemp(path.join(tmpdir(), "deherm-single-project-"));
  const game = path.join(single, "nested", "game");
  await mkdir(game, { recursive: true });
  await writeFile(path.join(game, "game.project"), "[project]\ntitle = Single\n");
  assert.equal(await findProjectRoot(single), game);
});

test("project inspection finds local and resolved dependency extensions", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  assert.deepEqual(inventory.summary, {
    localExtensions: 1,
    dependencyExtensions: 1,
    scriptApiFiles: 2,
    scriptModules: 2,
    publicHeaders: 2,
    extensionsRequiringNativeSchema: 2,
    extensionsWithoutApiMetadata: 0,
    dependencyArchivesWithoutManifest: 0
  });
  assert.deepEqual(inventory.dependencyArchivesWithoutManifest, []);
  assert.deepEqual(inventory.extensions.map(({ kind, name }) => [kind, name]), [
    ["local", "Camera"],
    ["dependency", "XMath"]
  ]);
  assert.deepEqual(inventory.dependencyUrls, ["https://example.com/math.zip"]);
  assert.deepEqual(inventory.engineProfiles, {
    source: "defold-default",
    manifest: null,
    manifestSha256: null,
    defaultProfileId: "default-legacy-bullet",
    platforms: {}
  });
  assert.deepEqual(inventory.extensions[0].publicHeaders, ["camera/include/camera.h"]);
  assert.deepEqual(inventory.extensions[0].sourceFiles, ["camera/src/camera.cpp"]);
  assert.deepEqual(inventory.extensions[1].publicHeaders, ["math.zip:math/api/include/xmath.h"]);
  assert.ok(inventory.extensions.every(({ publicHeaderDetails }) =>
    publicHeaderDetails.length === 1 && /^[0-9a-f]{64}$/.test(publicHeaderDetails[0].sha256)));
  assert.ok(inventory.extensions.every(({ publicIncludeTreeSha256 }) => /^[0-9a-f]{64}$/.test(publicIncludeTreeSha256)));
  assert.deepEqual(inventory.extensions.map(({ publicIncludeRoots }) => publicIncludeRoots), [["include"], ["api/include", "common/include"]]);
  assert.deepEqual(inventory.extensions.map(({ bindingStatus: status }) => status), [
    "script-api+native-schema-required",
    "script-api+native-schema-required"
  ]);
  assert.deepEqual(inventory.diagnostics, []);
});

test("dependency header discovery uses exact include segments and rejects unsafe or oversized ZIP entries", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "deherm-extension-zip-guards-"));
  await mkdir(path.join(project, ".internal", "lib"), { recursive: true });
  await writeFile(path.join(project, "game.project"), "[project]\ntitle = ZIP guards\n");
  await writeFile(path.join(project, ".internal", "lib", "false-positive.zip"), zipSync({
    "false/ext.manifest": strToU8("name: FalsePositive\n"),
    "false/myinclude/not_public.h": strToU8("void nope(void);\n")
  }));
  await writeFile(path.join(project, ".internal", "lib", "backslash.zip"), zipSync({
    "bad\\ext.manifest": strToU8("name: Bad\n")
  }));
  await writeFile(path.join(project, ".internal", "lib", "duplicate.zip"), zipSync({
    "duplicate/ext.manifest": strToU8("name: First\n"),
    "./duplicate/ext.manifest": strToU8("name: Second\n")
  }));
  await writeFile(path.join(project, ".internal", "lib", "oversized.zip"), zipSync({
    "huge/ext.manifest": strToU8("name: Huge\n"),
    "huge/include/huge.h": new Uint8Array(PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes + 1)
  }, { level: 0 }));

  const inventory = await inspectDefoldProject({ project });
  const falsePositive = inventory.extensions.find(({ name }) => name === "FalsePositive");
  assert.ok(falsePositive);
  assert.deepEqual(falsePositive.publicHeaders, []);
  assert.ok(inventory.diagnostics.some(({ path: file, message }) => file.endsWith("backslash.zip") && /Unsafe dependency archive entry/.test(message)));
  assert.ok(inventory.diagnostics.some(({ path: file, message }) => file.endsWith("duplicate.zip") && /duplicate canonical entry/.test(message)));
  assert.ok(inventory.diagnostics.some(({ path: file, message }) => file.endsWith("oversized.zip") && /exceeds/.test(message)));
});

test("project native header generation requires executable Clang and catalogs only source parse failures", async () => {
  const missingToolProject = await fixture();
  const missingToolInventory = await inspectDefoldProject({ project: missingToolProject });
  await assert.rejects(
    writeGeneratedProject(missingToolInventory, ".deherm", { clang: path.join(missingToolProject, "missing-clang") }),
    /requires an executable Clang tool/
  );
  await assert.rejects(readFile(path.join(missingToolProject, ".deherm", "manifest.json"), "utf8"), /ENOENT/);

  const parseProject = await fixture();
  await writeFile(path.join(parseProject, "camera", "include", "camera.h"), "#include <stdint.h>\nuint32_t camera_broken(\n");
  const parseInventory = await inspectDefoldProject({ project: parseProject });
  const parsed = await writeGeneratedProject(parseInventory);
  const camera = parsed.nativeExtensions.headers.find(({ extension }) => extension === "Camera");
  assert.deepEqual(camera.blockers, [{ code: "header-parse-failed", message: "Clang rejected this discovered public C header" }]);
  assert.equal(camera.blockedRouteCount, 1);
  const cameraRoot = path.join(parsed.root, "generated", "native-extensions", ...camera.output.split("/"));
  assert.deepEqual(await readdir(cameraRoot), ["extension.ir.json"]);
});

test("project native generation excludes deherm runtime implementation headers", async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), "deherm-infrastructure-headers-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const inventory = {
    projectRoot: project,
    extensions: [
      {
        name: "defold_hermes",
        manifestPath: "defold_hermes/ext.manifest",
        publicHeaders: Array.from({ length: 104 }, (_, index) => `defold_hermes/include/internal-${index}.hpp`)
      },
      {
        name: "defold_hermes_typed_native",
        manifestPath: "defold_hermes_typed_native/ext.manifest",
        publicHeaders: ["defold_hermes_typed_native/include/static_h.h"]
      }
    ]
  };
  let clangInvoked = false;
  assert.deepEqual(resolveNativeExtensionClang({
    inventory,
    execFile() {
      clangInvoked = true;
      throw new Error("the infrastructure-only project must not require Clang");
    }
  }), { required: false });
  assert.equal(clangInvoked, false);

  const outputRoot = path.join(project, ".deherm");
  const generated = await materializeProjectNativeExtensionApis({
    inventory,
    outputRoot,
    defoldRevision: "a".repeat(40),
    generationKey: "b".repeat(64)
  });
  assert.equal(generated.index.headerCount, 0);
  assert.equal(generated.index.ignoredExtensionCount, 2);
  assert.deepEqual(
    generated.index.ignoredExtensions.map(({ name, publicHeaderCount, reason }) => ({ name, publicHeaderCount, reason })),
    [
      { name: "defold_hermes", publicHeaderCount: 104, reason: "deherm-runtime-infrastructure" },
      { name: "defold_hermes_typed_native", publicHeaderCount: 1, reason: "deherm-runtime-infrastructure" }
    ]
  );
});

test("the real War Battles project excludes its managed runtime and typed-native infrastructure", async () => {
  const inventory = await inspectDefoldProject({ project: path.resolve("examples/war-battles-online/defold") });
  assert.deepEqual(inventory.extensions.map(({ name }) => name), [
    "defold_hermes_typed_native"
  ]);
  let clangInvoked = false;
  assert.deepEqual(resolveNativeExtensionClang({
    inventory,
    execFile() {
      clangInvoked = true;
      throw new Error("deherm infrastructure must not require project-header parsing");
    }
  }), { required: false });
  assert.equal(clangInvoked, false);
});

test("generation cache invalidates when published artifact or surface evidence changes", () => {
  const generationKey = "1".repeat(64);
  const generationMerkle = {
    schemaVersion: 1,
    engineRoot: "2".repeat(64),
    nativeRoot: "3".repeat(64),
    root: "4".repeat(64)
  };
  const artifacts = {
    schemaVersion: 1,
    artifacts: {
      "native-artifacts": {
        tag: "libs-current",
        fingerprint: "5".repeat(64),
        indexedBy: "bundleTarget"
      }
    }
  };
  const core = {
    toolchain: { kind: "deherm.policy.toolchain", pins: { test: "current" } },
    artifacts,
    inputs: { scriptIrSha256: "6".repeat(64) },
    surfaceLayer: "user-cache"
  };
  const record = {
    generation: { cacheKey: generationKey },
    generationMerkle,
    toolchain: core.toolchain,
    artifacts,
    inputs: core.inputs,
    defoldSurface: { layer: core.surfaceLayer }
  };
  assert.equal(generatedProjectCacheMatches({
    manifest: structuredClone(record),
    lock: structuredClone(record),
    generationKey,
    generationMerkle,
    core
  }), true);

  const staleManifest = structuredClone(record);
  staleManifest.artifacts = null;
  assert.equal(generatedProjectCacheMatches({
    manifest: staleManifest,
    lock: structuredClone(record),
    generationKey,
    generationMerkle,
    core
  }), false);

  const staleLock = structuredClone(record);
  staleLock.defoldSurface.layer = "repository-checkout";
  assert.equal(generatedProjectCacheMatches({
    manifest: structuredClone(record),
    lock: staleLock,
    generationKey,
    generationMerkle,
    core
  }), false);
});

test("public generation refreshes mutable artifacts online and reuses authenticated artifacts offline", () => {
  const surface = { blocker: null, artifacts: { kind: "deherm.policy.artifacts" } };
  assert.equal(shouldResolvePublishedPolicy(surface, {
    requirePublishedArtifacts: true,
    env: {}
  }), true);
  assert.equal(shouldResolvePublishedPolicy(surface, {
    requirePublishedArtifacts: true,
    env: { DEHERM_OFFLINE: "1" }
  }), false);
  assert.equal(shouldResolvePublishedPolicy({ blocker: null, artifacts: null }, {
    requirePublishedArtifacts: true,
    env: { DEHERM_OFFLINE: "1" }
  }), true);
  assert.equal(shouldResolvePublishedPolicy(surface, { env: {} }), false);
});

test("custom generated roots still exclude the fixed Static Hermes staging lane", async (t) => {
  const project = await fixture();
  t.after(() => rm(project, { recursive: true, force: true }));
  const inventory = await inspectDefoldProject({ project });
  await writeGeneratedProject(inventory, "generated-sdk", { force: true });
  const bundleConfig = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.bundle.json"), "utf8"));
  assert.ok(bundleConfig.exclude.includes("generated-sdk/static-hermes/**/*.ts"));
  assert.ok(bundleConfig.exclude.includes(".deherm/build/generated/typed-native/**/*.ts"));
});

test("project inspection follows symlinked extensions without duplicate traversal", async () => {
  const project = await fixture();
  const external = await mkdtemp(path.join(tmpdir(), "defold-hermes-linked-extension-"));
  await writeFile(path.join(external, "ext.manifest"), "name: LinkedPhysics\n");
  await writeFile(path.join(external, "physics.script_api"), `
- name: linked_physics
  type: table
  members:
    - name: step
      type: function
      parameters:
        - name: dt
          type: number
`);
  await symlink(external, path.join(project, "linked-physics"), "dir");

  const inventory = await inspectDefoldProject({ project });
  const linked = inventory.extensions.find(({ name }) => name === "LinkedPhysics");
  assert.ok(linked);
  assert.equal(linked.root, "linked-physics");
  assert.equal(linked.scriptApis[0].path, "linked-physics/physics.script_api");
  assert.deepEqual(inventory.diagnostics, []);
});

test("extension script APIs produce deterministic TypeScript declarations", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  const types = generateExtensionTypes(inventory);
  assert.match(types, /from "\.\/sdk\/address\.js"/);
  assert.match(types, /export interface CameraExtension/);
  assert.match(types, /start\(facing: string\): boolean/);
  assert.match(types, /focusTarget\(target: DefoldAddressLiteral \| DefoldRelativeAddress \| DefoldHash \| DefoldUrl\): void/);
  assert.match(types, /export interface XmathExtension/);
  assert.match(types, /dot\(left: number, right: number\): number/);

  const ir = buildProjectBindingIr(inventory);
  assert.equal(ir.modules[0].id, "script:camera");
  assert.equal(ir.modules[0].members[0].id, "script:camera.start");
  assert.equal(ir.modules[0].members[0].lowering.dynamicHermes, "lua-compatibility");
  assert.equal(ir.modules[0].members[1].rawName, "focus_target");
  assert.equal(ir.modules[0].members[1].jsName, "focusTarget");

  const output = await writeGeneratedProject(inventory);
  await generateComponentProxies({ projectRoot: project, outputRoot: project });
  await writeProjectResourceSymbols(project, output.root);
  await writeProjectRouteSymbolIndex(output.root);
  await writeProjectDmSdkCallSymbolIndex(output.root);
  const saved = await readFile(path.join(output.root, "extensions.d.ts"), "utf8");
  assert.equal(saved, types);
  assert.deepEqual(JSON.parse(await readFile(path.join(output.root, "bindings.ir.json"), "utf8")), ir);
  const nativeIndex = JSON.parse(await readFile(path.join(output.root, "generated", "native-extensions", "index.json"), "utf8"));
  assert.equal(nativeIndex.headerCount, 2);
  assert.equal(nativeIndex.generatedRouteCount, 2);
  assert.equal(nativeIndex.blockedRouteCount, 2);
  assert.equal(nativeIndex.keyedOutput, `${output.defoldRevision}/${output.generationKey}`);
  assert.match(nativeIndex.treeSha256, /^[0-9a-f]{64}$/);
  const cameraNative = nativeIndex.headers.find(({ extension }) => extension === "Camera");
  assert.ok(cameraNative);
  const cameraNativeRoot = path.join(output.root, "generated", "native-extensions", ...cameraNative.output.split("/"));
  assert.match(await readFile(path.join(cameraNativeRoot, "camera_glue.cpp"), "utf8"), /camera_accumulate/);
  assert.match(await readFile(path.join(cameraNativeRoot, "camera_glue.verify.cpp"), "utf8"), new RegExp(`deherm_ext_${cameraNative.generatedNamespace}_exact_dispatch`));
  assert.match(await readFile(path.join(cameraNativeRoot, "camera_glue.verify.json"), "utf8"), /compileTimeResolution/);
  const xmathNative = nativeIndex.headers.find(({ extension }) => extension === "XMath");
  const xmathNativeRoot = path.join(output.root, "generated", "native-extensions", ...xmathNative.output.split("/"));
  const xmathIr = JSON.parse(await readFile(path.join(xmathNativeRoot, "extension.ir.json"), "utf8"));
  assert.equal(xmathIr.symbolPrefix, null);
  assert.deepEqual(xmathIr.routes.map(({ symbol, memberName, disposition }) => [symbol, memberName, disposition]), [
    ["XMathDot", "XMathDot", "generated-c-abi"],
    ["XMathTranslate", "XMathTranslate", "cataloged-needs-layout"]
  ]);
  assert.deepEqual(xmathIr.enums.map(({ name }) => name), ["XMathMode"]);
  assert.deepEqual(xmathIr.records.map(({ name }) => name), ["XMathPoint"]);
  assert.equal(xmathIr.routes[0].parameters[2].type.kind, "enum");
  assert.match(xmathIr.routes[1].blockers[0], /record:XMathPoint/);
  assert.doesNotMatch(await readFile(path.join(xmathNativeRoot, "xmath.ts"), "utf8"), /SharedHelper/);
  const camera = await readFile(path.join(output.root, "sdk", "modules", "camera.ts"), "utf8");
  assert.match(camera, /export const camera: CameraExtension/);
  assert.match(camera, /callExtension\("camera", "start", \[facing\]\)/);
  assert.match(camera, /focusTarget\(target: DefoldAddressLiteral \| DefoldRelativeAddress \| DefoldHash \| DefoldUrl\)/);
  const index = await readFile(path.join(output.root, "sdk", "index.ts"), "utf8");
  assert.match(index, /export \* from "\.\/generated\/script\/index\.js"/);
  assert.match(index, /export \* from "\.\/generated\/dmsdk\/index\.js"/);
  assert.match(index, /export \* from "\.\/generated\/dmsdk\/scalar\.js"/);
  assert.match(index, /export \{ camera \} from "\.\/modules\/camera\.js"/);
  const manifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  assert.equal(manifest.generation.nativeExtensionClang.required, true);
  assert.match(manifest.generation.nativeExtensionClang.versionSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.generation.nativeExtensionGeneratorSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.defoldRevision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.coverage.script.functions, 926);
  assert.equal(manifest.coverage.script.typeSurfaceUnresolved, 0);
  assert.equal(manifest.coverage.script.universalRecipes, 915);
  assert.equal(manifest.coverage.script.universalExclusions, 8);
  assert.deepEqual(manifest.coverage.script.accounting, {
    "executable-stable-id": 915,
    "component-property-compiler": 8,
    "separate-module": 3,
    pending: 0
  });
  // Dynamic Hermes roots Lua-owned closure results, so it alone reaches 913 by
  // promoting socket.newtry/socket.protect. Browser and raw Lua-stack transport
  // keep those two routes blocked below.
  assert.deepEqual(manifest.coverage.script.targetMatrix.dynamicHermesJsi, {
    emit: 913,
    "omit-profile": 2,
    "compile-time-intrinsic": 8,
    "separate-module": 3
  });
  assert.deepEqual(manifest.coverage.script.targetMatrix.browserWasmHost, {
    emit: 911,
    "omit-profile": 2,
    "blocked-capability": 2,
    "compile-time-intrinsic": 8,
    "separate-module": 3
  });
  assert.deepEqual(manifest.coverage.script.runtimeLanes, {
    generatedScalarDispatch: 90,
    universalStableId: 915
  });
  assert.equal(manifest.coverage.dmsdk.declarations, 2141);
  assert.equal(manifest.coverage.dmsdk.typeSurfaceUnresolved, 0);
  assert.equal(manifest.coverage.dmsdk.runtimeDeclarations, 1361);
  assert.equal(manifest.coverage.dmsdk.universalRecipes, 1361);
  assert.equal(manifest.coverage.dmsdk.silentlyOmitted, 0);
  assert.deepEqual(manifest.coverage.dmsdk.runtimeLanes, {
    generatedScalarThunks: 26,
    preferredSpecialized: 81,
    usageMaterializedFallback: 1280,
    projectMaterialized: 0
  });
  // The conformance target is the HOST this run would execute on, not a label
  // copied out of the dmSDK IR - the IR no longer carries one, because its parse
  // is deliberately not any platform.
  assert.equal(manifest.platform, hostDefoldPlatform());
  assert.equal(manifest.coverage.dmsdk.diagnosticHeaders, 32);
  assert.match(await readFile(path.join(output.root, "sdk", "generated", "script", "types.ts"), "utf8"), /export interface MsgApi/);
  assert.match(await readFile(path.join(output.root, "sdk", "generated", "dmsdk", "types.ts"), "utf8"), /export interface DmSdkCalls/);
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "script-scalar-dispatch.json"), "utf8")).bindingCount, 90);
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "script-api-accounting.json"), "utf8")).categoryCounts.pending, 0);
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "script-universal-value-bindings.json"), "utf8")).candidateCount, 915);
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "dmsdk-universal-bindings.json"), "utf8")).coverage.recipes, 1361);
  const profiles = JSON.parse(await readFile(path.join(output.root, "ir", "script-route-profiles.json"), "utf8"));
  const loweringPlan = JSON.parse(await readFile(path.join(output.root, "ir", "binding-lowering-plan.json"), "utf8"));
  assert.ok(profiles.profiles["default-legacy-bullet"]);
  assert.ok(profiles.profiles["v3-bullet"]);
  assert.equal(manifest.engineProfiles.source, "defold-default");
  assert.equal(manifest.engineProfiles.defaultProfileId, "default-legacy-bullet");
  assert.equal(manifest.engineProfiles.catalogSha256, profiles.catalogSha256);
  assert.equal(manifest.engineProfiles.handshakeSchema, "deherm.script-route-capabilities/v1");
  assert.deepEqual(manifest.loweringPlan, {
    sha256: loweringPlan.planSha256,
    units: 2287,
    backendRecords: 11435
  });
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "dmsdk-scalar-thunks.json"), "utf8")).coverage.generated, 26);
  const lock = JSON.parse(await readFile(path.join(project, "deherm.lock"), "utf8"));
  assert.equal(lock.defoldRevision, manifest.defoldRevision);
  assert.equal(lock.platform, manifest.platform);
  assert.deepEqual(lock.inputs, manifest.inputs);
  assert.deepEqual(lock.generatedOutputs, manifest.generatedOutputs);
  assert.deepEqual(lock.engineProfiles, manifest.engineProfiles);
  const verified = await verifyGeneratedProject(project);
  assert.equal(verified.checkedFiles, 28);
  assert.equal(verified.planSha256, loweringPlan.planSha256);
  const verifiedCli = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "verify-generated", "--project", project, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(verifiedCli.status, 0, `${verifiedCli.stdout}\n${verifiedCli.stderr}`);
  assert.equal(JSON.parse(verifiedCli.stdout).planSha256, loweringPlan.planSha256);

  const cameraGlue = path.join(cameraNativeRoot, "camera_glue.cpp");
  await writeFile(cameraGlue, `${await readFile(cameraGlue, "utf8")} `);
  await assert.rejects(verifyGeneratedProject(project), /native-extension tree does not match its output sentinel/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });
  const staleNativeRoot = path.join(output.root, "generated", "native-extensions", "stale-revision");
  await mkdir(staleNativeRoot, { recursive: true });
  await assert.rejects(verifyGeneratedProject(project), /owner root contains stale or unsupported files/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  const dispatchPath = path.join(output.root, "ir", "script-scalar-dispatch.json");
  await writeFile(dispatchPath, `${await readFile(dispatchPath, "utf8")} `);
  await assert.rejects(verifyGeneratedProject(project), /does not match generated manifest/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  const forgedManifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  const forgedLock = JSON.parse(await readFile(path.join(project, "deherm.lock"), "utf8"));
  forgedManifest.inputs.scriptDispatchSha256 = "0".repeat(64);
  forgedLock.inputs.scriptDispatchSha256 = "0".repeat(64);
  await writeFile(path.join(output.root, "manifest.json"), `${JSON.stringify(forgedManifest, null, 2)}\n`);
  await writeFile(path.join(project, "deherm.lock"), `${JSON.stringify(forgedLock, null, 2)}\n`);
  await assert.rejects(verifyGeneratedProject(project), /do not match this installed deherm package/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  const escaped = await mkdtemp(path.join(tmpdir(), "deherm-escaped-ir-"));
  const escapedDispatch = path.join(escaped, "script-scalar-dispatch.json");
  await writeFile(escapedDispatch, await readFile(dispatchPath));
  await unlink(dispatchPath);
  await symlink(escapedDispatch, dispatchPath);
  await assert.rejects(verifyGeneratedProject(project), /must be a regular file, not a symlink/);
  await unlink(dispatchPath);
  await writeGeneratedProject(inventory, ".deherm", { force: true });
  await rm(escaped, { recursive: true, force: true });

  await writeFile(path.join(output.root, "sdk", "modules", "stale.ts"), "export {};\n");
  await writeFile(path.join(output.root, "sdk", "generated", "stale.ts"), "export {};\n");
  await writeFile(path.join(output.root, "sdk", "contexts", "stale.ts"), "export {};\n");
  await writeGeneratedProject(inventory, ".deherm", { force: true });
  await assert.rejects(readFile(path.join(output.root, "sdk", "modules", "stale.ts"), "utf8"));
  await assert.rejects(readFile(path.join(output.root, "sdk", "generated", "stale.ts"), "utf8"));
  await assert.rejects(readFile(path.join(output.root, "sdk", "contexts", "stale.ts"), "utf8"));

  const guiContextPath = path.join(output.root, "sdk", "contexts", "gui.ts");
  await writeFile(guiContextPath, `${await readFile(guiContextPath, "utf8")} `);
  await assert.rejects(verifyGeneratedProject(project), /sdk\/contexts\/gui\.ts does not match generated output sentinel/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });
  const guiConfigPath = path.join(project, "tsconfig.deherm.gui.json");
  await writeFile(guiConfigPath, `${await readFile(guiConfigPath, "utf8")} `);
  await assert.rejects(verifyGeneratedProject(project), /tsconfig\.deherm\.gui\.json does not match generated output sentinel/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });
  const generatedAddressPath = path.join(output.root, "sdk", "address.ts");
  await writeFile(generatedAddressPath, `${await readFile(generatedAddressPath, "utf8")} `);
  await assert.rejects(verifyGeneratedProject(project), /Generated SDK tree does not match its output sentinel/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  const config = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.json"), "utf8"));
  assert.deepEqual(config.references.map(({ path: reference }) => reference), [
    "./tsconfig.deherm.shared.json",
    "./tsconfig.deherm.game-object.json",
    "./tsconfig.deherm.gui.json",
    "./tsconfig.deherm.render.json"
  ]);
  const baseConfig = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.base.json"), "utf8"));
  assert.equal(baseConfig.compilerOptions.plugins[0].transform, "@ts-defold/deherm/ttsc");
  assert.equal(baseConfig.compilerOptions.plugins[0].enabled, true);
  const guiConfig = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.gui.json"), "utf8"));
  assert.deepEqual(guiConfig.include, ["**/*.ts", ".deherm/**/*.ts"]);
  assert.deepEqual(guiConfig.exclude, ["**/*.script.ts", "**/*.render.ts", "node_modules/**", ".internal/**", "build/**", "dist/**", ".deherm/generated/components/registry.ts", ".deherm/static-hermes/**/*.ts", ".deherm/build/generated/typed-native/**/*.ts"]);
  assert.deepEqual(guiConfig.compilerOptions.paths["@deherm/project"], ["./.deherm/sdk/contexts/gui.ts"]);
  const bundleConfig = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.bundle.json"), "utf8"));
  assert.deepEqual(bundleConfig.compilerOptions.paths["@deherm/project"], ["./.deherm/sdk/index.ts"]);
  assert.deepEqual(bundleConfig.exclude, ["node_modules/**", ".internal/**", "build/**", "dist/**", ".deherm/static-hermes/**/*.ts", ".deherm/build/generated/typed-native/**/*.ts"]);
  const releaseConfig = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.release.json"), "utf8"));
  assert.equal(releaseConfig.compilerOptions.plugins[0].profile, "release");
  assert.equal(releaseConfig.compilerOptions.plugins[0].dmsdkSymbols,
    "./.deherm/generated/dmsdk-call-symbol-index.json");
  assert.equal(releaseConfig.compilerOptions.plugins[0].dmsdkUsage,
    "./.deherm/generated/dmsdk-usage.json");
  assert.deepEqual(releaseConfig.compilerOptions.paths["@deherm/project"], ["./.deherm/sdk/index.ts"]);
  assert.ok(releaseConfig.exclude.includes(".deherm/build/generated/typed-native/**/*.ts"));
  const installedScope = path.join(project, "node_modules", "@ts-defold");
  await mkdir(installedScope, { recursive: true });
  await symlink(path.resolve("."), path.join(installedScope, "deherm"), process.platform === "win32" ? "junction" : "dir");
  const releaseCheck = await typecheckGeneratedProject(project, { release: true });
  assert.equal(releaseCheck.profile, "release");
  assert.equal(releaseCheck.passed, true, `${releaseCheck.stdout}\n${releaseCheck.stderr}`);
  const releaseUsage = JSON.parse(await readFile(
    path.join(project, ".deherm", "generated", "dmsdk-usage.json"), "utf8"));
  assert.equal(releaseUsage.profile, "release");
  assert.deepEqual(releaseUsage.ambiguousSites, []);
  assert.deepEqual(releaseUsage.unresolvedSites, []);
  assert.deepEqual(releaseUsage.specializationRequiredSites, []);
  const contextManifest = JSON.parse(await readFile(path.join(output.root, "script-contexts.json"), "utf8"));
  assert.equal(contextManifest.source, "defold-binding-lowering-plan.contract.context");
  assert.equal(contextManifest.routeCount, 926);
  assert.ok(contextManifest.unknownContextTokens.includes("script-instance"));
  assert.ok(contextManifest.unknownContextTokens.includes("captured-script-instance"));
  assert.equal(contextManifest.unresolvedPolicy.routeCount, contextManifest.routeContextCounts.unresolved);
  assert.equal(contextManifest.contexts.gui.suffix, ".gui.ts");
  assert.equal(contextManifest.contexts.render.suffix, ".render.ts");
  assert.ok(contextManifest.contexts.gui.namespaces.includes("gui"));
  assert.ok(!contextManifest.contexts.shared.namespaces.includes("gui"));
  assert.ok(contextManifest.contexts.render.namespaces.includes("render"));
  assert.ok(!contextManifest.contexts["game-object"].namespaces.includes("render"));
  assert.match(await readFile(path.join(output.root, "sdk", "contexts", "game-object.ts"), "utf8"), /projectExtensions = \{/);
  assert.deepEqual(JSON.parse(await readFile(path.join(project, ".vscode", "extensions.json"), "utf8")), {
    recommendations: ["samchon.ttsc"]
  });

  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const checked = spawnSync(process.execPath, [tsc, "--build", path.join(project, "tsconfig.deherm.json"), "--pretty", "false"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test("project binding identities survive normalized-name collisions and reserved parameters", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  inventory.extensions[0].scriptApis[0].declarations.push(
    {
      name: "my_ext",
      type: "table",
      members: [{
        name: "invoke",
        type: "function",
        parameters: [
          { name: "function", type: "function" },
          { name: "default", type: "number" },
          { name: "var", type: "string" }
        ]
      }]
    },
    { name: "myExt", type: "table", members: [{ name: "ping", type: "function" }] },
    { name: "project_extensions", type: "table", members: [{ name: "ping", type: "function" }] }
  );

  const ir = buildProjectBindingIr(inventory);
  const colliding = ir.modules.filter(({ runtimeName }) => runtimeName === "my_ext" || runtimeName === "myExt");
  assert.equal(colliding.length, 2);
  assert.equal(new Set(colliding.map(({ jsName }) => jsName)).size, 2);
  assert.equal(new Set(colliding.map(({ typeName }) => typeName)).size, 2);
  assert.ok(colliding.every(({ jsName }) => /^myExt_[a-f0-9]{8}$/.test(jsName)));
  assert.deepEqual(
    colliding.find(({ runtimeName }) => runtimeName === "my_ext").members[0].parameters.map(({ jsName }) => jsName),
    ["callback", "defaultValue", "value"]
  );
  const reserved = ir.modules.find(({ runtimeName }) => runtimeName === "project_extensions");
  assert.match(reserved.jsName, /^projectExtensions_[a-f0-9]{8}$/);

  const output = await writeGeneratedProject(inventory);
  const index = await readFile(path.join(output.root, "sdk", "index.ts"), "utf8");
  for (const module of colliding) {
    assert.match(index, new RegExp(`export \\{ ${module.jsName} \\} from "\\./modules/${module.fileName}\\.js"`));
    await readFile(path.join(output.root, "sdk", "modules", `${module.fileName}.ts`), "utf8");
  }
  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const checked = spawnSync(process.execPath, [tsc, "--build", path.join(project, "tsconfig.deherm.json"), "--pretty", "false", "--force"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test("project generation uses an input key and does not rewrite current outputs", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  const first = await writeGeneratedProject(inventory);
  assert.equal(first.cached, false);
  const manifestPath = path.join(first.root, "manifest.json");
  const before = await stat(manifestPath);
  const second = await writeGeneratedProject(inventory);
  const after = await stat(manifestPath);
  assert.equal(second.cached, true);
  assert.equal(second.generationKey, first.generationKey);
  assert.equal(after.mtimeMs, before.mtimeMs);

  await unlink(path.join(first.root, "generated", "native-extensions", "index.json"));
  const repaired = await writeGeneratedProject(inventory);
  assert.equal(repaired.cached, false, "a missing native-extension sentinel must bypass the fast cache path");

  await writeFile(path.join(project, "camera", "include", "camera_types.inc"), "#define CAMERA_FIXTURE 2\n");
  await assert.rejects(
    writeGeneratedProject(inventory, ".deherm", { force: true }),
    /Public include tree changed after project discovery/
  );
  await readFile(path.join(first.root, "generated", "native-extensions", "index.json"), "utf8");
  assert.deepEqual((await readdir(path.join(first.root, "generated"))).filter((name) => name.startsWith(".native-extensions-stage-")), []);
  const changedInventory = await inspectDefoldProject({ project });
  const changed = await writeGeneratedProject(changedInventory);
  assert.equal(changed.cached, false);
  assert.notEqual(changed.generationKey, first.generationKey);
});

test("script context projection requires an exact route-id bijection and records unknown tokens as unresolved", async () => {
  const scriptIr = JSON.parse(await readFile(path.resolve("packages/bindings/generated/defold-script-api-ir.json"), "utf8"));
  const loweringPlan = JSON.parse(await readFile(path.resolve("packages/bindings/generated/defold-binding-lowering-plan.json"), "utf8"));
  const scriptUnits = loweringPlan.units.filter(({ identity }) => identity.surface === "script");
  assert.throws(() => buildScriptContextCapabilities(scriptIr, { ...loweringPlan, schemaVersion: 1 }), /schema v2/);
  const duplicated = structuredClone(loweringPlan);
  const first = scriptUnits[0].identity.id;
  const omitted = scriptUnits.at(-1).identity.id;
  duplicated.units.find(({ identity }) => identity.surface === "script" && identity.id === omitted).identity.id = first;
  delete duplicated.planSha256;
  duplicated.planSha256 = createHash("sha256").update(JSON.stringify(duplicated)).digest("hex");
  assert.throws(() => buildScriptContextCapabilities(scriptIr, duplicated), /duplicate route id|exactly match/i);

  const unknown = structuredClone(loweringPlan);
  unknown.units.find(({ identity }) => identity.surface === "script").contract.context = "future-context-token";
  delete unknown.planSha256;
  unknown.planSha256 = createHash("sha256").update(JSON.stringify(unknown)).digest("hex");
  const projected = buildScriptContextCapabilities(scriptIr, unknown);
  assert.ok(projected.unknownContextTokens.includes("future-context-token"));
  assert.ok(projected.routeContextCounts.unresolved > 0);
});

test("suffix projects type-check legal APIs and reject APIs from other Defold contexts", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  await writeGeneratedProject(inventory);
  const sourceRoot = path.join(project, "src");
  await mkdir(sourceRoot, { recursive: true });
  const componentRoot = path.join(project, "components", "ui");
  await mkdir(componentRoot, { recursive: true });
  const sources = {
    "utility.ts": "export const sharedValue = true;\n",
    "shared.ts": 'import { vmath } from "@deherm/project"; void vmath;\n',
    "player.script.ts": 'import { go, vmath } from "@deherm/project"; import { sharedValue } from "./utility.js"; void go; void vmath; void sharedValue;\n',
    "hud.gui.ts": 'import { go, gui, vmath } from "@deherm/project"; import { sharedValue } from "./utility.js"; void go.PLAYBACK_ONCE_FORWARD; void gui; void vmath; void sharedValue;\n',
    "legacy.gui_script.ts": 'import { gui } from "@deherm/project"; void gui;\n',
    "main.render.ts": 'import { render, vmath } from "@deherm/project"; void render; void vmath;\n'
  };
  for (const [name, source] of Object.entries(sources)) await writeFile(path.join(sourceRoot, name), source);
  await writeFile(path.join(componentRoot, "menu.gui.ts"), 'import { gui } from "@deherm/project"; void gui;\n');
  await writeFile(path.join(project, "bootstrap.script.ts"), 'import { go } from "@deherm/project"; void go;\n');

  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const compile = (...arguments_) => spawnSync(process.execPath, [tsc, ...arguments_, "--pretty", "false"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const legal = compile("--build", path.join(project, "tsconfig.deherm.json"), "--force");
  assert.equal(legal.status, 0, `${legal.stdout}\n${legal.stderr}`);
  const cliTypecheck = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(cliTypecheck.status, 0, `${cliTypecheck.stdout}\n${cliTypecheck.stderr}`);
  assert.equal(JSON.parse(cliTypecheck.stdout).passed, true);

  const negativeCases = [
    ["player.script.ts", 'import { gui } from "@deherm/project"; void gui;\n', "tsconfig.deherm.game-object.json", "gui"],
    ["hud.gui.ts", 'import { render } from "@deherm/project"; void render;\n', "tsconfig.deherm.gui.json", "render"],
    ["main.render.ts", 'import { gui } from "@deherm/project"; void gui;\n', "tsconfig.deherm.render.json", "gui"],
    ["shared.ts", 'import { gui } from "@deherm/project"; void gui;\n', "tsconfig.deherm.shared.json", "gui"],
    ["shared.ts", 'import { gui } from "@deherm/project/generated/script/modules"; void gui;\n', "tsconfig.deherm.shared.json", "@deherm/project/generated"],
    ["shared.ts", 'import { gui } from "@deherm/project/contexts/gui"; void gui;\n', "tsconfig.deherm.shared.json", "@deherm/project/contexts"]
  ];
  for (const [name, invalidSource, config, symbol] of negativeCases) {
    const target = path.join(sourceRoot, name);
    const original = sources[name];
    await writeFile(target, invalidSource);
    const rejected = compile("--project", path.join(project, config), "--noEmit");
    assert.notEqual(rejected.status, 0, `${name} unexpectedly accepted ${symbol}`);
    assert.match(rejected.stdout + rejected.stderr, symbol.startsWith("@") ? /cannot find module/i : new RegExp(`no exported member '${symbol}'`, "i"));
    if (name === "player.script.ts") {
      const releaseRejected = await typecheckGeneratedProject(project, { release: true });
      assert.equal(releaseRejected.passed, false, "release checking must retain suffix-context API restrictions");
      assert.equal(releaseRejected.phase, "context-typecheck");
      assert.match(releaseRejected.stdout + releaseRejected.stderr, /no exported member 'gui'/i);
    }
    await writeFile(target, original);
  }

  const boundaryCases = [
    ["shared.ts", 'import { gui } from "../.deherm/sdk/contexts/gui.js"; void gui;\n', /bypasses '@deherm\/project'/],
    ["shared.ts", 'import { gui } from "../.deherm/sdk/contexts/../contexts/gui.js"; void gui;\n', /bypasses '@deherm\/project'/],
    ["shared.ts", 'import { gui } from "../.deherm/sdk/generated/script/modules.js"; void gui;\n', /bypasses '@deherm\/project'/],
    ["shared.ts", 'import { gui } from "@deherm/project/contexts/gui"; void gui;\n', /private deep import/],
    ["shared.ts", 'import { gui } from "@ts-defold/deherm"; void gui;\n', /bypasses the context-filtered/],
    ["hud.gui.ts", 'import { playerOnly } from "./player.script.js"; void playerOnly;\n', /gui source cannot import game-object source/]
  ];
  await writeFile(path.join(sourceRoot, "player.script.ts"), "export const playerOnly = true;\n");
  for (const [name, invalidSource, message] of boundaryCases) {
    const target = path.join(sourceRoot, name);
    const original = await readFile(target, "utf8");
    await writeFile(target, invalidSource);
    const rejected = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(rejected.status, 1, `${name} unexpectedly crossed the authored context boundary`);
    const diagnostic = JSON.parse(rejected.stdout);
    assert.equal(diagnostic.passed, false);
    assert.match(diagnostic.stderr, message);
    await writeFile(target, original);
  }

  await writeFile(path.join(sourceRoot, "barrel.ts"), 'export { gui } from "@ts-defold/deherm";\n');
  await writeFile(path.join(sourceRoot, "shared.ts"), 'import { gui } from "./barrel.js"; void gui;\n');
  const reexportRejected = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(reexportRejected.status, 1, "shared barrel unexpectedly re-exported the package-root SDK");
  assert.match(JSON.parse(reexportRejected.stdout).stderr, /barrel\.ts:1:.*bypasses the context-filtered/);
  await writeFile(path.join(sourceRoot, "barrel.ts"), "export const barrel = true;\n");
  await writeFile(path.join(sourceRoot, "shared.ts"), sources["shared.ts"]);

  const outsideGui = path.join(componentRoot, "menu.gui.ts");
  await writeFile(outsideGui, 'import { render } from "@deherm/project"; void render;\n');
  const outsideRejected = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(outsideRejected.status, 1, "GUI resource outside src unexpectedly used render APIs");
  assert.match(JSON.parse(outsideRejected.stdout).stdout, /no exported member 'render'/i);
  await writeFile(outsideGui, 'import { gui } from "@deherm/project"; void gui;\n');

  const contextEntry = path.join(project, ".deherm", "sdk", "contexts", "gui.ts");
  await writeFile(contextEntry, `${await readFile(contextEntry, "utf8")} `);
  const staleRejected = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(staleRejected.status, 1);
  assert.match(staleRejected.stderr, /does not match generated output sentinel/);
  await writeGeneratedProject(inventory, ".deherm", { force: true });

  await writeFile(path.join(sourceRoot, "hud.gui.ts"), 'import { playerOnly } from "./player.script.js"; void playerOnly;\n');
  const crossContext = compile("--project", path.join(project, "tsconfig.deherm.gui.json"), "--noEmit");
  assert.notEqual(crossContext.status, 0, "GUI project unexpectedly accepted a game-object script import");
  assert.match(crossContext.stdout + crossContext.stderr, /not listed within the file list of project|must list all files/i);
});

test("generation migrates only the exact legacy generated root tsconfig", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "tsconfig.json"), `${JSON.stringify({ extends: "./tsconfig.deherm.json" }, null, 2)}\n`);
  const inventory = await inspectDefoldProject({ project });
  const migrated = await writeGeneratedProject(inventory);
  assert.equal(migrated.created.tsconfig, false);
  assert.equal(migrated.migrated.tsconfig, true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(project, "tsconfig.json"), "utf8")),
    JSON.parse(await readFile(path.join(project, "tsconfig.deherm.json"), "utf8"))
  );

  await writeFile(path.join(project, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: false }, include: ["custom/**/*.ts"] }, null, 2)}\n`);
  const preserved = await writeGeneratedProject(inventory);
  assert.equal(preserved.migrated.tsconfig, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(project, "tsconfig.json"), "utf8")), {
    compilerOptions: { strict: false },
    include: ["custom/**/*.ts"]
  });
});

test("typecheck command fails cleanly before generation", async () => {
  const project = await fixture();
  const result = spawnSync(process.execPath, [path.resolve("bin/deherm.mjs"), "typecheck", "--project", project], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run 'deherm generate' first/);
});

test("project generation rejects output outside the project", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  await assert.rejects(
    writeGeneratedProject(inventory, "../outside"),
    /subdirectory of the Defold project/
  );
});

test("project inspection derives per-platform engine profiles from Defold's app manifest", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = /game.appmanifest\n[defold_hermes]\ndefold_sdk = ${bundledDefoldRevision}\n`);
  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeLibs: [physics, box2d_defold, script_box2d_defold]
      libs: [physics_2d, box2d, script_box2d, physics_3d]
  wasm-web:
    context:
      excludeLibs: [physics, box2d, box2d_defold, script_box2d, script_box2d_defold]
      excludeSymbols: [ScriptBox2DExt]
      libs: [physics_3d]
  x86_64-linux:
    context:
      excludeLibs: [physics, LinearMath, BulletDynamics, BulletCollision]
      libs: [physics_2d_defold]
`);

  const inventory = await inspectDefoldProject({ project });
  assert.equal(inventory.engineProfiles.source, "app-manifest");
  assert.equal(inventory.engineProfiles.manifest, "game.appmanifest");
  assert.match(inventory.engineProfiles.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(inventory.engineProfiles.defaultProfileId, "default-legacy-bullet");
  assert.deepEqual(inventory.engineProfiles.platforms, {
    "arm64-ios": "v3-bullet",
    "wasm-web": "bullet-only",
    "x86_64-linux": "legacy-no-bullet"
  });

  const output = await writeGeneratedProject(inventory);
  const manifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.engineProfiles.platforms, inventory.engineProfiles.platforms);
});

test("project inspection rejects contradictory app-manifest physics selections", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = /game.appmanifest\n`);
  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeLibs: []
      libs: [physics_2d_defold, physics_2d, script_box2d]
`);
  await assert.rejects(inspectDefoldProject({ project }), /both legacy Box2D and Box2D v3/);
});

test("a uniform app manifest becomes the project default API profile", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = /game.appmanifest\n`);
  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeLibs: [physics, LinearMath, BulletDynamics, BulletCollision, script_box2d_defold]
      libs: [physics_2d, box2d, script_box2d]
`);
  const inventory = await inspectDefoldProject({ project });
  assert.equal(inventory.engineProfiles.platforms["arm64-ios"], "v3-no-bullet");
  assert.equal(inventory.engineProfiles.defaultProfileId, "v3-no-bullet");
});

test("project profile resolution respects extension-symbol removal and rejects partial Box2D replacement", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = /game.appmanifest\n`);
  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeSymbols: [ScriptBullet3DExt]
      excludeLibs: []
      libs: []
`);
  let inventory = await inspectDefoldProject({ project });
  assert.equal(inventory.engineProfiles.platforms["arm64-ios"], "legacy-no-bullet");

  await writeFile(path.join(project, "game.appmanifest"), `
platforms:
  arm64-ios:
    context:
      excludeLibs: [script_box2d_defold]
      libs: []
`);
  await assert.rejects(inspectDefoldProject({ project }), /without selecting Box2D v3/);
});

test("project inspection rejects app manifests outside the project", async () => {
  const project = await fixture();
  await writeFile(path.join(project, "game.project"), `[project]\ntitle = Fixture\n[native_extension]\napp_manifest = ../outside.appmanifest\n`);
  await assert.rejects(inspectDefoldProject({ project }), /inside the Defold project/);
});

test("project profile resolution agrees with all six pinned Defold app-manifest choices", async () => {
  const root = path.resolve("upstream/defold/editor/test/resources/test_project/app_manifest");
  const fixtures = {
    "default.appmanifest": "default-legacy-bullet",
    "physics_box2dv3_3d.appmanifest": "v3-bullet",
    "exclude_physics_3d.appmanifest": "legacy-no-bullet",
    "physics_2d_box2dv3.appmanifest": "v3-no-bullet",
    "exclude_physics_2d.appmanifest": "bullet-only",
    "exclude_physics.appmanifest": "no-physics"
  };
  for (const [manifest, expected] of Object.entries(fixtures)) {
    const resolved = await resolveEngineProfiles(root, { native_extension: { app_manifest: manifest } });
    assert.ok(Object.keys(resolved.platforms).length > 0, `${manifest} has no resolved platforms`);
    assert.deepEqual(new Set(Object.values(resolved.platforms)), new Set([expected]), manifest);
  }
});
