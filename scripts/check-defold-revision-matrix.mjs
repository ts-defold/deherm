#!/usr/bin/env node

// Prove that one déherm compiler package survives a rolling window of immutable
// Defold revisions. This deliberately compares invariants, not API equality:
// Defold owns its API, so additions/removals/deprecations are expected input
// facts. Each lane must authenticate, materialize deterministically, match the
// independently derived tree, and compile with this package's verification
// commands.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  materializePolicySurface,
  policySurfaceRealizationIdentity,
} from "../packages/compiler/src/policy-surface-materializer.mjs";
import { verifyMaterializedSurfaceRoot } from "../packages/cli/src/defold-surface.mjs";
import {
  readRevisionWorkspaceMetadata,
  revisionProducerInputIdentity,
  revisionWorkspaceMetadataMismatch,
} from "./lib/revision-workspace-metadata.mjs";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifest = path.join(repositoryRoot, "packages", "bindings", "probes", "defold-revision-matrix.json");
const DIGEST = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function regularFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const information = await lstat(path.join(root, child));
    if (information.isSymbolicLink()) throw new Error(`${root}: generated tree contains symbolic link ${child}`);
    if (information.isDirectory()) files.push(...(await regularFiles(root, child)));
    else if (information.isFile()) files.push(child);
    else throw new Error(`${root}: generated tree contains unsupported entry ${child}`);
  }
  return files;
}

async function treeDigest(root) {
  const aggregate = createHash("sha256");
  for (const relative of await regularFiles(root)) {
    const bytes = await readFile(path.join(root, relative));
    aggregate.update(`${relative}\0${bytes.length}\0`);
    aggregate.update(bytes);
  }
  return aggregate.digest("hex");
}

export function validateRevisionMatrix(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.kind !== "deherm.defold-revision-matrix" ||
    !Array.isArray(manifest.lanes) ||
    manifest.lanes.length === 0
  ) {
    throw new Error("Invalid Defold revision matrix manifest");
  }
  const ids = new Set();
  const revisions = new Set();
  for (const lane of manifest.lanes) {
    if (
      !lane ||
      typeof lane.id !== "string" ||
      !lane.id ||
      ids.has(lane.id) ||
      typeof lane.label !== "string" ||
      !REVISION.test(lane.revision ?? "") ||
      revisions.has(lane.revision) ||
      typeof lane.workspace !== "string" ||
      !lane.workspace ||
      !["blocking", "nightly"].includes(lane.cadence)
    ) {
      throw new Error(`Invalid or duplicate Defold revision matrix lane ${JSON.stringify(lane?.id)}`);
    }
    const resolved = path.resolve(repositoryRoot, lane.workspace);
    if (
      resolved !== repositoryRoot &&
      !resolved.startsWith(`${path.join(repositoryRoot, "build", "revision-matrix")}${path.sep}`)
    ) {
      throw new Error(`${lane.id}: workspace must be the repository or live below build/revision-matrix`);
    }
    ids.add(lane.id);
    revisions.add(lane.revision);
  }
  return manifest;
}

export async function loadResolvedPolicy(workspace) {
  const generated = path.join(workspace, "packages", "bindings", "generated");
  const manifestPath = path.join(generated, "defold-api-policy.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest?.kind !== "deherm.policy.manifest" ||
    !REVISION.test(manifest.defoldRevision ?? "") ||
    !DIGEST.test(manifest.policyRoot ?? "") ||
    typeof manifest.layoutVersion !== "string"
  ) {
    throw new Error(`${manifestPath}: invalid policy manifest`);
  }
  const store = path.join(generated, "policy", manifest.layoutVersion);
  const rootBytes = await readFile(path.join(store, "policy", `${manifest.policyRoot}.json`));
  if (sha256(rootBytes) !== manifest.policyRoot) throw new Error(`${manifestPath}: policy root digest mismatch`);
  const policy = JSON.parse(rootBytes);
  if (policy.kind !== "deherm.policy.root" || policy.hash !== "sha256" || !policy.subtrees) {
    throw new Error(`${manifestPath}: invalid policy root object`);
  }
  const objects = new Map();
  for (const [namespace, digest] of Object.entries(policy.subtrees).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    if (!DIGEST.test(digest)) throw new Error(`${manifestPath}: invalid ${namespace} object digest`);
    const bytes = await readFile(path.join(store, "object", `${digest}.json`));
    if (sha256(bytes) !== digest) throw new Error(`${manifestPath}: ${namespace} object digest mismatch`);
    objects.set(namespace, { digest, bytes, value: JSON.parse(bytes) });
  }
  return {
    manifest,
    resolved: {
      revision: manifest.defoldRevision,
      entry: { policyRoot: manifest.policyRoot, generator: policy.generator, realizer: policy.realizer },
      policy,
      objects,
    },
  };
}

function countRecord(record = {}) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, value]) => [key, typeof value === "number" ? value : Number(value?.count ?? 0)]),
  );
}

async function semanticCensus(materializedRoot) {
  const ir = path.join(materializedRoot, "ir");
  const [accounting, scriptPatterns, dmsdkPatterns] = await Promise.all([
    readFile(path.join(ir, "defold-script-api-accounting.json"), "utf8").then(JSON.parse),
    readFile(path.join(ir, "defold-script-binding-patterns.json"), "utf8").then(JSON.parse),
    readFile(path.join(ir, "defold-dmsdk-binding-patterns.json"), "utf8").then(JSON.parse),
  ]);
  return {
    scriptFunctions: accounting.functionCount,
    scriptCategories: countRecord(accounting.categoryCounts),
    scriptFamilies: Object.fromEntries(
      scriptPatterns.families
        .map(({ name, count }) => [name, count])
        .sort(([left], [right]) => compareCodeUnits(left, right)),
    ),
    scriptUnresolvedTypes: scriptPatterns.unresolvedTypeCount,
    dmsdkDeclarations: dmsdkPatterns.coverage.runtimePendingCount,
    dmsdkClassified: dmsdkPatterns.coverage.classifiedCount,
    dmsdkPrimaryFamilies: countRecord(dmsdkPatterns.primaryFamilySummary),
  };
}

async function assertMatchesDerivedWorkspace(workspace, outputRoot, descriptor) {
  for (const relative of Object.keys(descriptor.sdk)) {
    const materialized = await readFile(path.join(outputRoot, "sdk", "generated", relative));
    const derived = await readFile(path.join(workspace, "packages", "sdk", "src", "generated", relative));
    if (sha256(materialized) !== sha256(derived)) {
      throw new Error(`${relative}: policy materialization differs from the independently derived SDK`);
    }
  }
  for (const relative of Object.keys(descriptor.outputs)) {
    const materialized = await readFile(path.join(outputRoot, "repository", relative));
    const derived = await readFile(path.join(workspace, relative));
    if (sha256(materialized) !== sha256(derived)) {
      throw new Error(`${relative}: policy materialization differs from the independently derived output`);
    }
  }
}

async function executeCommand(workspace, name, command, args) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(command, args, {
      cwd: workspace,
      env: { ...process.env, FORCE_COLOR: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      script: name,
      milliseconds: Date.now() - started,
      outputTail: `${stdout}${stderr}`.trim().split(/\r?\n/u).slice(-8),
    };
  } catch (error) {
    const evidence = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(`${name} failed in ${workspace}${evidence ? `\n${evidence}` : ""}`, { cause: error });
  }
}

async function compileExactCallTwins(workspace, revision, output) {
  await mkdir(output, { recursive: true });
  const cxx = process.env.CXX || "clang++";
  const cc = process.env.CC || "clang";
  const include = path.join(workspace, "defold", "defold_hermes", "include");
  const sdk = path.join(workspace, "upstream", "extender", "server", "app", "sdk", revision, "defoldsdk");
  const includeArgs = [
    `-I${include}`,
    "-isystem",
    path.join(sdk, "sdk", "include"),
    "-isystem",
    path.join(sdk, "include"),
    "-isystem",
    path.join(sdk, "ext", "include"),
    '-DDLIB_LOG_DOMAIN="deherm"',
  ];
  const report = JSON.parse(
    await readFile(
      path.join(workspace, "packages", "bindings", "generated", "defold-dmsdk-universal-bindings.json"),
      "utf8",
    ),
  );
  const count = report.coverage?.declarations;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${revision}: invalid universal declaration count`);

  const cHarness = path.join(output, "universal-c11.c");
  const cObject = path.join(output, "universal-c11.o");
  const cExecutable = path.join(output, "universal-c11");
  await writeFile(
    cHarness,
    `#include <defold_hermes/generated_dmsdk_universal.h>\nint main(void){DehermDmSdkUniversalValue result={0};return deherm_dmsdk_universal_count()==${count}u&&deherm_dmsdk_universal_dispatch(${count}u,0,0,&result)==DEHERM_DMSDK_UNIVERSAL_UNKNOWN_ID?0:1;}\n`,
  );
  await executeCommand(workspace, "compile universal C11 caller", cc, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    `-I${include}`,
    "-c",
    cHarness,
    "-o",
    cObject,
  ]);
  await executeCommand(workspace, "link universal C ABI", cxx, [
    "-std=c++17",
    `-I${include}`,
    "defold/defold_hermes/src/generated_dmsdk_universal.cpp",
    cObject,
    "-o",
    cExecutable,
  ]);
  await executeCommand(workspace, "execute universal C ABI", cExecutable, []);

  const readyPlan = JSON.parse(
    await readFile(
      path.join(workspace, "packages", "bindings", "generated", "defold-dmsdk-universal-ready-exact-plan.json"),
      "utf8",
    ),
  );
  const driver = readyPlan.verification?.driver?.function;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(driver ?? "")) throw new Error(`${revision}: invalid exact-call driver`);
  const readyHarness = path.join(output, "universal-ready.cpp");
  const readyProvider = path.join(output, "universal-ready-provider.o");
  const readyExecutable = path.join(output, "universal-ready");
  await writeFile(readyHarness, `extern "C" int ${driver}(void);\nint main(){return ${driver}();}\n`);
  await executeCommand(workspace, "compile universal-ready production calls", cxx, [
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    ...includeArgs,
    "-c",
    "tests/fixtures/generated_dmsdk_universal_ready_provider.cpp",
    "-o",
    readyProvider,
  ]);
  await executeCommand(workspace, "link universal-ready exact-call twin", cxx, [
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    ...includeArgs,
    "defold/defold_hermes/src/generated_dmsdk_universal.cpp",
    "tests/fixtures/generated_dmsdk_universal_ready_verification.cpp",
    readyHarness,
    "-o",
    readyExecutable,
  ]);
  await executeCommand(workspace, "execute universal-ready exact-call twin", readyExecutable, []);
  await executeCommand(workspace, "compile specialized dmSDK exact-call twin", cxx, [
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    ...includeArgs,
    "-c",
    "tests/fixtures/generated_dmsdk_adapter_exact_verification.cpp",
    "-o",
    path.join(output, "dmsdk-adapter-exact.o"),
  ]);
  await executeCommand(workspace, "compile Lua exact-call twin", cxx, [
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    ...includeArgs,
    `-I${path.join(workspace, "tests", "fixtures")}`,
    `-I${path.join(workspace, "upstream", "defold", "engine", "lua", "src")}`,
    "-c",
    "tests/fixtures/generated_script_recording_lua_adapter.cpp",
    "-o",
    path.join(output, "script-lua-exact.o"),
  ]);
  return {
    script: "compile:generated-exact-call-twins",
    universalReadyVectors: readyPlan.universalReadyCount,
    specializedDmSdkVectors: JSON.parse(
      await readFile(
        path.join(workspace, "packages", "bindings", "generated", "defold-dmsdk-generated-adapter-exact-plan.json"),
        "utf8",
      ),
    ).generatedAdapterCount,
  };
}

async function executeChecks(workspace, revision, output) {
  const binary = (name) =>
    path.join(repositoryRoot, "node_modules", ".bin", `${name}${process.platform === "win32" ? ".cmd" : ""}`);
  const typesStarted = Date.now();
  const tsc = await executeCommand(workspace, "compile generated TypeScript SDK", binary("tsc"), [
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "preserve",
    "--moduleResolution",
    "bundler",
    "--lib",
    "ES2022,DOM",
    "packages/sdk/src/index.ts",
  ]);
  const types = {
    script: "compile:generated-typescript-sdk",
    milliseconds: Date.now() - typesStarted,
    outputTail: tsc.outputTail,
  };
  const exactStarted = Date.now();
  const exact = await compileExactCallTwins(workspace, revision, output);
  exact.milliseconds = Date.now() - exactStarted;
  return [types, exact];
}

async function inspectRevisionWorkspace(lane, workspace, producerInput, packageVersion) {
  const manifestPath = path.join(workspace, "packages", "bindings", "generated", "defold-api-policy.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return {
      current: false,
      reason: error instanceof SyntaxError ? "policy manifest is invalid" : "policy manifest is missing",
    };
  }
  if (manifest?.defoldRevision !== lane.revision) {
    return { current: false, reason: `policy manifest names revision ${manifest?.defoldRevision ?? "missing"}` };
  }
  if (!DIGEST.test(manifest?.policyRoot ?? "")) return { current: false, reason: "policy manifest root is invalid" };
  const metadata = await readRevisionWorkspaceMetadata(workspace);
  const reason = revisionWorkspaceMetadataMismatch(metadata, {
    revision: lane.revision,
    producerInput,
    packageVersion,
    policyRoot: manifest.policyRoot,
  });
  return { current: reason === null, reason, manifest, metadata };
}

async function runLaneDerivation(lane, workspace) {
  await run(
    process.execPath,
    ["scripts/derive-revision.mjs", "--revision", lane.revision, "--workspace", workspace, "--carry-reviews"],
    { cwd: repositoryRoot, env: process.env, maxBuffer: 128 * 1024 * 1024 },
  );
}

export async function ensureRevisionWorkspace(lane, workspace, options) {
  const {
    deriveMissing,
    producerInput,
    packageVersion,
    workspaceBoundary = path.join(repositoryRoot, "build", "revision-matrix"),
    derive = runLaneDerivation,
  } = options;
  const state = await inspectRevisionWorkspace(lane, workspace, producerInput, packageVersion);
  if (state.current) return { derived: false, reason: null };
  if (!deriveMissing) {
    throw new Error(`${lane.id}: stale revision workspace (${state.reason}); rerun with --derive-missing`);
  }
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedBoundary = path.resolve(workspaceBoundary);
  if (resolvedWorkspace === resolvedBoundary || !resolvedWorkspace.startsWith(`${resolvedBoundary}${path.sep}`)) {
    throw new Error(`${lane.id}: refusing to replace stale workspace outside ${resolvedBoundary}`);
  }
  await rm(resolvedWorkspace, { recursive: true, force: true });
  await mkdir(path.dirname(resolvedWorkspace), { recursive: true });
  await derive(lane, resolvedWorkspace);
  const refreshed = await inspectRevisionWorkspace(lane, resolvedWorkspace, producerInput, packageVersion);
  if (!refreshed.current) {
    throw new Error(`${lane.id}: fresh derivation produced a stale workspace (${refreshed.reason})`);
  }
  return { derived: true, reason: state.reason };
}

export async function verifyLane(lane, options) {
  const workspace = path.resolve(repositoryRoot, lane.workspace);
  const packageVersion =
    options.packageVersion ?? JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")).version;
  if (workspace !== repositoryRoot) {
    const producerInput = options.producerInput ?? (await revisionProducerInputIdentity(repositoryRoot));
    await ensureRevisionWorkspace(lane, workspace, {
      deriveMissing: options.deriveMissing,
      producerInput,
      packageVersion,
    });
  }
  const started = Date.now();
  const { manifest, resolved } = await loadResolvedPolicy(workspace);
  if (manifest.defoldRevision !== lane.revision) {
    throw new Error(`${lane.id}: workspace contains ${manifest.defoldRevision}, expected ${lane.revision}`);
  }
  const realization = policySurfaceRealizationIdentity({ entry: resolved.entry, packageVersion });
  const temporary = await mkdtemp(path.join(options.temporaryRoot, `.${lane.id}-`));
  try {
    const firstRoot = path.join(temporary, "forward");
    const reverseRoot = path.join(temporary, "reverse");
    const first = await materializePolicySurface(resolved, {
      revision: lane.revision,
      outputRoot: firstRoot,
      outputBoundary: temporary,
      realization,
    });
    const repeated = await materializePolicySurface(resolved, {
      revision: lane.revision,
      outputRoot: firstRoot,
      outputBoundary: temporary,
      realization,
    });
    if (repeated.written.length !== 0) throw new Error(`${lane.id}: identical second materialization rewrote files`);
    const reversed = { ...resolved, objects: new Map([...resolved.objects].reverse()) };
    const second = await materializePolicySurface(reversed, {
      revision: lane.revision,
      outputRoot: reverseRoot,
      outputBoundary: temporary,
      realization,
    });
    const [forwardDigest, reverseDigest, verified] = await Promise.all([
      treeDigest(firstRoot),
      treeDigest(reverseRoot),
      verifyMaterializedSurfaceRoot(firstRoot, lane.revision, realization),
    ]);
    if (forwardDigest !== reverseDigest || JSON.stringify(first.descriptor) !== JSON.stringify(second.descriptor)) {
      throw new Error(`${lane.id}: materialization depends on authenticated object enumeration order`);
    }
    if (!verified.ok) throw new Error(`${lane.id}: materialized surface failed verification: ${verified.error}`);
    await assertMatchesDerivedWorkspace(workspace, firstRoot, first.descriptor);
    const checks = options.compile
      ? await executeChecks(workspace, lane.revision, path.join(temporary, "compile"))
      : [];
    return {
      id: lane.id,
      label: lane.label,
      revision: lane.revision,
      cadence: lane.cadence,
      policyRoot: manifest.policyRoot,
      policyObjectCount: resolved.objects.size,
      realizationId: realization.realizationId,
      surfaceTreeSha256: forwardDigest,
      sdkTreeSha256: first.descriptor.sdkTreeSha256,
      outputTreeSha256: first.descriptor.outputTreeSha256,
      census: await semanticCensus(firstRoot),
      checks,
      milliseconds: Date.now() - started,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function markdownReport(report) {
  const lines = [
    "# Defold revision compatibility matrix",
    "",
    `One @ts-defold/deherm ${report.packageVersion} compiler verified ${report.results.length} immutable Defold revisions.`,
    "API census and lowering-family differences are reported facts; equality across revisions is not required.",
    "",
    "| Lane | Revision | Script API | dmSDK | Policy root | Surface tree | Result |",
    "| --- | --- | ---: | ---: | --- | --- | --- |",
  ];
  for (const result of report.results)
    lines.push(
      `| ${result.label} | \`${result.revision.slice(0, 12)}\` | ${result.census.scriptFunctions} | ${result.census.dmsdkDeclarations} | \`${result.policyRoot.slice(0, 12)}\` | \`${result.surfaceTreeSha256.slice(0, 12)}\` | verified |`,
    );
  lines.push("", "## Semantic lowering distributions", "");
  for (const result of report.results) {
    lines.push(
      `### ${result.label}`,
      "",
      `- Script: ${JSON.stringify(result.census.scriptFamilies)}`,
      `- dmSDK: ${JSON.stringify(result.census.dmsdkPrimaryFamilies)}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const valueAfter = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const manifestPath = path.resolve(valueAfter("--manifest") ?? defaultManifest);
  const manifest = validateRevisionMatrix(JSON.parse(await readFile(manifestPath, "utf8")));
  const selected = valueAfter("--lanes")?.split(",").filter(Boolean) ?? manifest.lanes.map(({ id }) => id);
  const unknown = selected.filter((id) => !manifest.lanes.some((lane) => lane.id === id));
  if (unknown.length > 0) throw new Error(`Unknown matrix lanes: ${unknown.join(", ")}`);
  const temporaryRoot = path.join(repositoryRoot, "build", "revision-matrix", "materialization");
  await mkdir(temporaryRoot, { recursive: true });
  const packageVersion = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")).version;
  const producerInput = selected.some((id) => manifest.lanes.find((lane) => lane.id === id)?.workspace !== ".")
    ? await revisionProducerInputIdentity(repositoryRoot)
    : null;
  const results = [];
  for (const lane of manifest.lanes.filter(({ id }) => selected.includes(id))) {
    process.stdout.write(`revision-matrix:${lane.id}: verifying ${lane.revision}\n`);
    results.push(
      await verifyLane(lane, {
        temporaryRoot,
        deriveMissing: argv.includes("--derive-missing"),
        compile: !argv.includes("--skip-compile"),
        producerInput,
        packageVersion,
      }),
    );
    process.stdout.write(`revision-matrix:${lane.id}: verified\n`);
  }
  const report = {
    schemaVersion: 1,
    kind: "deherm.defold-revision-matrix-report",
    packageVersion,
    generatedAt: new Date().toISOString(),
    results,
  };
  const reportRoot = path.join(repositoryRoot, "build", "revision-matrix");
  await Promise.all([
    writeFile(path.join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(reportRoot, "report.md"), markdownReport(report)),
  ]);
  console.log(markdownReport(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
