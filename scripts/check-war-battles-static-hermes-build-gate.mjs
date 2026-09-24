#!/usr/bin/env node
// Generator-owned compile/link/application gate for the War Battles reachable
// Static Hermes projection. This file intentionally does not edit generated
// runtime or project sources: it derives temporary typed-native and application
// units from authenticated release inputs, stages them in a disposable project,
// and records every stage boundary in a machine-readable report.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWarBattlesStaticHermesProjection } from "./generate-war-battles-static-hermes-projection.mjs";
import { sourceBindingDigest } from "../packages/compiler/src/bundle-freshness.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultProject = path.join(repositoryRoot, "examples/war-battles-online/defold");
const typedNativeUnitName = "deherm_typed_native";
const defaultPaths = Object.freeze({
  project: defaultProject,
  manifest: path.join(defaultProject, ".deherm/manifest.json"),
  projection: path.join(repositoryRoot, "examples/war-battles-online/evidence/static-hermes-reachable-arm64-macos.json"),
  loweringPlan: path.join(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.json"),
  bridge: path.join(repositoryRoot, "packages/bindings/generated/defold-typed-native-bridge.json"),
  universalSource: path.join(defaultProject, ".deherm/static-hermes/generated/script-universal-value.ts"),
  typedNativeSource: path.join(defaultProject, ".deherm/static-hermes/generated/script-typed-native-bridge.ts"),
  applicationBundle: path.join(defaultProject, "deherm/app.dehermc"),
  projectLock: path.join(defaultProject, "deherm.lock"),
  upstreamLock: path.join(repositoryRoot, "upstream.lock"),
  hostCompilers: path.join(repositoryRoot, "packages/toolchains/host-compilers.json"),
  bob: path.join(repositoryRoot, "build/tooling/bob.jar")
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const relativeToRepo = (file) => path.relative(repositoryRoot, file).split(path.sep).join("/");
const displayPath = (file) => {
  const relative = relativeToRepo(file);
  return relative.startsWith("../") ? path.resolve(file) : relative;
};

function blocker(code, message, details = {}) {
  return { code, message, ...details };
}

function gateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function verifyLockedApplicationSources(project, lockedApplication) {
  const files = lockedApplication?.sources?.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("project lock application record has no source digest table");
  }
  const entries = Object.entries(files);
  if (entries.length === 0) throw new Error("project lock application source digest table is empty");
  if (entries.length !== lockedApplication.sources.fileCount) {
    throw new Error(`project lock application source count is inconsistent: expected ${lockedApplication.sources.fileCount}, found ${entries.length}`);
  }
  const actualDigest = sourceBindingDigest({ build: lockedApplication.build ?? null, files });
  if (actualDigest !== lockedApplication.sources.digest) {
    throw new Error(`project lock application source digest is inconsistent: expected ${lockedApplication.sources.digest}, got ${actualDigest}`);
  }
  const projectRoot = path.resolve(project);
  for (const [relative, expected] of entries) {
    const absolute = path.resolve(projectRoot, relative);
    if (absolute === projectRoot || !absolute.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`project lock application source escapes the project: ${relative}`);
    }
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch {
      throw new Error(`project lock application source is missing: ${relative}`);
    }
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new Error(`project lock application source is stale: ${relative}; expected ${expected}, got ${actual}`);
    }
  }
}

function parseArgs(argv) {
  const options = {
    ...defaultPaths,
    shermes: null,
    output: null,
    allowUnpinnedToolchain: false,
    link: false,
    run: false,
    keep: false,
    java: null,
    buildServer: process.env.DEFOLD_HERMES_BUILD_SERVER ?? "http://localhost:9010"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} requires a value`);
      return path.resolve(next);
    };
    if (arg === "--project") options.project = value();
    else if (arg === "--projection") options.projection = value();
    else if (arg === "--bridge") options.bridge = value();
    else if (arg === "--typed-native-source") options.typedNativeSource = value();
    else if (arg === "--application-bundle") options.applicationBundle = value();
    else if (arg === "--project-lock") options.projectLock = value();
    else if (arg === "--universal-source") options.universalSource = value();
    else if (arg === "--lowering-plan") options.loweringPlan = value();
    else if (arg === "--manifest") options.manifest = value();
    else if (arg === "--shermes") options.shermes = value();
    else if (arg === "--output") options.output = value();
    else if (arg === "--allow-unpinned-toolchain") options.allowUnpinnedToolchain = true;
    else if (arg === "--link") options.link = true;
    else if (arg === "--run") options.run = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--java") options.java = value();
    else if (arg === "--build-server") options.buildServer = argv[++index];
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!argv.includes("--application-bundle")) {
    options.applicationBundle = path.join(options.project, "deherm/app.dehermc");
  }
  if (!argv.includes("--project-lock")) options.projectLock = path.join(options.project, "deherm.lock");
  options.output ??= path.join(repositoryRoot, "build/gates/war-battles-static-hermes");
  return options;
}

function usageText() {
  return [
    "Usage: node scripts/check-war-battles-static-hermes-build-gate.mjs [options]",
    "",
    "  --projection <file>               checked release-reachability projection",
    "  --shermes <file>                  compiler override (digest is still checked)",
    "  --application-bundle <file>       authored/generated app bundle to AOT compile",
    "  --project-lock <file>              project lock authenticating the app bundle",
    "  --allow-unpinned-toolchain        emit diagnostically with an unpinned compiler",
    "  --link                            attempt the local Bob/Extender link gate",
    "  --run                             attempt the packaged application after link",
    "  --java <file>                     explicit JDK java executable",
    "  --build-server <url>              Bob/Extender endpoint (default localhost:9010)",
    "  --output <dir>                    gate evidence directory",
    "  --keep                            retain temporary derived source and C output"
  ].join("\n");
}

function resolveDefoldRevision(upstreamLock) {
  const match = /^DEFOLD_REV=([0-9a-f]{40})$/m.exec(upstreamLock);
  if (!match) throw new Error("upstream.lock does not pin a 40-character Defold revision");
  return match[1];
}

function releaseUsageFromProjection(projection, canonicalLoweringPlan, canonicalLoweringPlanSha256) {
  if (projection?.schemaVersion !== 1 || projection?.projection?.id !== "native-arm64-macos-static-hermes-reachable") {
    throw new Error("Static Hermes gate requires the checked War Battles release projection");
  }
  const { recordSha256, ...body } = projection;
  if (recordSha256 !== sha256(canonical(body))) {
    throw new Error("Static Hermes release projection digest is stale");
  }
  const reachability = projection.reachability;
  if (reachability?.profile !== "release" || reachability.dynamicAccess !== false) {
    throw new Error("Static Hermes release projection is not closed release reachability");
  }
  if (projection.source?.loweringPlanSha256 !== canonicalLoweringPlanSha256) {
    throw new Error("Static Hermes release projection was derived from a different canonical lowering plan");
  }
  const routeIds = reachability.reachableRouteIds;
  if (!Array.isArray(routeIds) || routeIds.length !== reachability.reachableRouteCount ||
      new Set(routeIds).size !== routeIds.length) {
    throw new Error("Static Hermes release projection has an invalid reachable-route inventory");
  }
  const units = new Map((canonicalLoweringPlan.units ?? [])
    .filter((unit) => unit.identity?.surface === "script")
    .map((unit) => [unit.identity.id, unit]));
  const routes = routeIds.map((id) => {
    const unit = units.get(id);
    if (!unit) throw new Error(`${id}: release projection route is absent from the canonical lowering plan`);
    return { id, stableId: unit.identity.stableId };
  });
  return {
    schemaVersion: 1,
    profile: "release",
    defoldRevision: projection.engineRevision,
    dynamicAccess: false,
    declaredDynamicAccess: false,
    routes
  };
}

async function verifyProjectionAuthoredSources(projection, projectRoot) {
  const files = projection.source?.authoredFiles;
  const expected = projection.source?.authoredSourceTreeSha256;
  if (!Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length ||
      !/^[0-9a-f]{64}$/u.test(expected ?? "")) {
    throw new Error("Static Hermes release projection has no bounded authored-source identity");
  }
  const sorted = [...files].sort();
  if (canonical(sorted) !== canonical(files)) {
    throw new Error("Static Hermes release projection authored sources are not canonical");
  }
  const root = path.resolve(projectRoot);
  const hash = createHash("sha256");
  for (const relative of files) {
    const target = path.resolve(root, relative);
    const confined = path.relative(root, target);
    if (!confined || confined === ".." || confined.startsWith(`..${path.sep}`) || path.isAbsolute(confined)) {
      throw new Error(`Static Hermes release projection has an unsafe authored source path: ${relative}`);
    }
    const bytes = await readFile(target);
    const name = Buffer.from(relative);
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32LE(name.byteLength, 0);
    header.writeUInt32LE(bytes.byteLength, 4);
    hash.update(header).update(name).update(bytes);
  }
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error("Static Hermes release projection does not describe the current authored TypeScript sources");
  }
}

function resolveStaticRoutes(usage, loweringPlan) {
  const units = new Map((loweringPlan.units ?? [])
    .filter((unit) => unit.identity?.surface === "script")
    .map((unit) => [unit.identity.id, unit]));
  const reachable = [...usage.routes].map(({ id, stableId }) => ({ id, stableId }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const selected = [];
  const blocked = [];
  for (const route of reachable) {
    const unit = units.get(route.id);
    if (!unit) throw new Error(`${route.id}: release usage route is absent from lowering plan`);
    if (unit.identity.stableId !== route.stableId) {
      throw new Error(`${route.id}: release usage stable id disagrees with lowering plan`);
    }
    const backend = unit.backends?.staticHermesCAbi;
    if (backend?.selection === "emit") selected.push(route);
    else blocked.push({
      ...route,
      selection: backend?.selection ?? null,
      blockers: loweringPlan.tables?.blockerSets?.[backend?.blockerSet] ?? []
    });
  }
  return { reachable, selected, blocked };
}

function bridgeBodyAndClaims(bridge) {
  assert.equal(bridge.schemaVersion, 1, "unsupported typed-native bridge schema");
  assert.equal(bridge.transport, "typed-native", "typed-native bridge transport is not typed-native");
  const { reportSha256, ...body } = bridge;
  if (reportSha256 !== sha256(canonical(body))) {
    throw new Error("typed-native bridge reportSha256 is stale");
  }
  return {
    body,
    claims: new Map((bridge.claimedRoutes ?? []).map(({ id, stableId }) => [id, stableId]))
  };
}

export function hostFamilyExpectedDigests(hostCompilers, host) {
  const familyRecord = hostCompilers.hosts?.[host]?.tools ?? {};
  return Object.fromEntries(Object.entries(familyRecord)
    .filter(([tool, toolRecord]) => (tool === "hermesc" || tool === "shermes") && toolRecord.file && toolRecord.sha256)
    .map(([, toolRecord]) => [path.basename(toolRecord.file), toolRecord.sha256]));
}

async function expectedShermes(options, hostCompilers) {
  const host = `${process.platform}-${process.arch}`;
  const record = hostCompilers.hosts?.[host]?.tools?.shermes;
  if (options.shermes) return { host, record: record ?? null, selected: options.shermes, candidates: [options.shermes], resolver: { mode: "explicit" } };
  if (!record) return { host, record: null, selected: null, candidates: [], resolver: { mode: "ensure-host-family", status: "unknown-host" } };
  const { ensureHostFamily } = await import("../packages/cli/src/ensure-host-tool.mjs");
  const expectedDigests = hostFamilyExpectedDigests(hostCompilers, host);
  try {
    const ensured = await ensureHostFamily("hermes-host", host, { expectedDigests });
    const selected = path.join(ensured.destination, path.basename(record.file));
    return {
      host,
      record,
      selected,
      candidates: [selected],
      resolver: { mode: "ensure-host-family", family: "hermes-host", destination: ensured.destination, tag: ensured.tag, cached: ensured.cached, members: ensured.members }
    };
  } catch (error) {
    return {
      host,
      record,
      selected: null,
      candidates: [],
      resolver: { mode: "ensure-host-family", family: "hermes-host", status: "failed", error: error.message }
    };
  }
}

function rewriteBridgeClaims(source, selectedIds) {
  const marker = "const __dehermTypedNativeRoutes: Array<number> = [";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("typed-native bridge source has no authenticated route claim table");
  const end = source.indexOf("];", start + marker.length);
  if (end < 0) throw new Error("typed-native bridge route claim table is unterminated");
  const replacement = `${marker}\n  ${[...selectedIds].sort((left, right) => left - right).join(", ")}\n];`;
  return `${source.slice(0, start)}${replacement}${source.slice(end + 2)}`;
}

function runShermes(shermes, input, output, { typed = true, unitName = typedNativeUnitName } = {}) {
  const result = spawnSync(shermes, [
    ...(typed ? ["-typed", "-strict"] : []), "-O", "-emit-c",
    `-exported-unit=${unitName}`,
    input, "-o", output
  ], { cwd: repositoryRoot, encoding: "utf8" });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

// The generated application unit is also emitted as C, but Extender compiles
// extension sources through its merged C++ context. Keep this adaptation local
// to the disposable gate staging path: it changes only C/C++ spelling, never
// application logic, and fails closed if the emitter shape changes.
function adaptStaticApplicationCToCxx(source) {
  // The downloadable native archive is the asserts-off Hermes model and
  // exports `_sh_model_*_rel`. Bob's debug variant does not define NDEBUG for
  // extension translation units, so declare the archive model before
  // `static_h.h` chooses its link-time guard symbol. This is the same bounded
  // adaptation used by the generated typed-native unit.
  let adapted = `#ifndef NDEBUG\n#define NDEBUG 1\n#endif\n\n${source}`;
  const tentative = [...adapted.matchAll(/^static (?:const )?[A-Za-z_][\w:]* [A-Za-z_]\w*\[\];$/gm)].map(({ 0: declaration }) => declaration);
  if (tentative.length === 0) throw new Error("Static application unit has no tentative array declaration; emitter shape changed");
  for (const declaration of tentative) {
    const head = `${declaration.slice(0, -1)} = {`;
    const start = adapted.indexOf(head);
    if (start < 0) throw new Error(`Static application unit has no definition for ${declaration}`);
    const end = adapted.indexOf("\n};\n", start);
    if (end < 0) throw new Error(`Static application unit has an unterminated definition for ${declaration}`);
    const definition = adapted.slice(start, end + 4);
    adapted = `${adapted.slice(0, start)}${adapted.slice(start + definition.length)}`;
    adapted = adapted.replace(`${declaration}\n`, `${definition}\n`);
  }
  const allocations = adapted.match(/^(\s*)(struct \w+) \*(\w+) = (calloc|malloc)\(/gm) ?? [];
  if (allocations.length === 0) throw new Error("Static application unit has no allocation to adapt; emitter shape changed");
  return adapted.replace(/^(\s*)(struct \w+) \*(\w+) = (calloc|malloc)\(/gm, "$1$2 *$3 = ($2 *)$4(");
}

function javaCandidates(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.DEHERM_JAVA) candidates.push(process.env.DEHERM_JAVA);
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, "bin/java"));
  // Keep repository/toolchain-managed locations ahead of PATH. A repository
  // may carry a hermetic JDK without changing the host's default Java.
  for (const root of [
    path.join(repositoryRoot, "toolchains/java"),
    path.join(repositoryRoot, "toolchains/jdk"),
    path.join(repositoryRoot, ".deherm/toolchains/java"),
    path.join(repositoryRoot, ".deherm/toolchains/jdk")
  ]) candidates.push(path.join(root, "bin/java"));
  // macOS ships a dead /usr/bin/java shim when no JDK is registered. Prefer
  // the standard Homebrew installations before consulting PATH.
  candidates.push(
    "/opt/homebrew/opt/openjdk@25/bin/java",
    "/opt/homebrew/opt/openjdk/bin/java",
    "/usr/local/opt/openjdk@25/bin/java",
    "/usr/local/opt/openjdk/bin/java"
  );
  const which = spawnSync("sh", ["-lc", "command -v java"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) candidates.push(which.stdout.trim());
  return [...new Set(candidates)];
}

function findJava(explicit) {
  for (const candidate of javaCandidates(explicit)) {
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["-version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function localServer(url) {
  return /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(url);
}

async function stageTypedNativeProject({ project, emittedC, emittedApplicationC, bobJar, buildServer, target = "arm64-macos" }) {
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), "deherm-static-hermes-link-"));
  await cp(project, stagedRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(project, source);
      return relative === "" || (!relative.startsWith(`build${path.sep}`) &&
        !relative.startsWith(`.internal${path.sep}`));
    }
  });
  const extension = path.join(stagedRoot, "defold_hermes_typed_native");
  const templatePath = path.join(extension, "src/deherm_typed_native_unit.cpp");
  const template = await readFile(templatePath, "utf8");
  const marker = '#include "hermes/VM/static_h.h"';
  const markerIndex = template.indexOf(marker);
  if (markerIndex < 0) throw new Error("typed-native extension template has no static_h prefix");
  const prefix = template.slice(0, markerIndex);
  const { adaptEmittedCToCxx } = await import("./assemble-typed-native-extension.mjs");
  const emitted = await readFile(emittedC, "utf8");
  const adapted = `${prefix}${adaptEmittedCToCxx(emitted, "deherm_typed_native_prelude.h")}`;
  await writeFile(templatePath, adapted);
  const applicationExtension = path.join(stagedRoot, "defold_hermes_static_application");
  const applicationSourceDirectory = path.join(applicationExtension, "src");
  await mkdir(applicationSourceDirectory, { recursive: true });
  await writeFile(path.join(applicationExtension, "ext.manifest"), `# Materialised by the Static Hermes product gate. Do not edit.\n# This temporary extension carries the authored app bundle after shermes -emit-c.\nname: "defold_hermes_static_application"\n`);
  const applicationEmitted = await readFile(emittedApplicationC, "utf8");
  const adaptedApplicationC = adaptStaticApplicationCToCxx(applicationEmitted);
  const adaptedApplication = adaptedApplicationC
    .replace("SHUnit *CREATE_THIS_UNIT(void) {", "extern \"C\" SHUnit *CREATE_THIS_UNIT(void) {");
  if (adaptedApplication === adaptedApplicationC) {
    throw new Error("Static application unit has no exported creator definition to give C linkage");
  }
  await writeFile(path.join(applicationSourceDirectory, "deherm_static_application_unit.cpp"), adaptedApplication);
  await writeFile(path.join(applicationSourceDirectory, "deherm_static_application_extension.cpp"), `// Temporary gate-owned registration shell; the authored project is never mutated.\n#define LIB_NAME "defold_hermes_static_application"\n#ifndef DLIB_LOG_DOMAIN\n#define DLIB_LOG_DOMAIN LIB_NAME\n#endif\n\n#include <dmsdk/dlib/log.h>\n#include <dmsdk/extension/extension.hpp>\n#include <defold_hermes/static_unit_registry.h>\n\nextern "C" SHUnit* sh_export_deherm_static_application(void);\n\nnamespace {\ndmExtension::Result AppInitializeStaticApplication(dmExtension::AppParams*) {\n  if (!deherm_register_static_application(sh_export_deherm_static_application)) {\n    dmLogError("deherm static application could not be registered; the application slot is occupied");\n    return dmExtension::RESULT_INIT_ERROR;\n  }\n  dmLogInfo("DEHERM_EVENT static-application-registered unit=sh_export_deherm_static_application");\n  return dmExtension::RESULT_OK;\n}\ndmExtension::Result AppFinalizeStaticApplication(dmExtension::AppParams*) { return dmExtension::RESULT_OK; }\ndmExtension::Result InitializeStaticApplication(dmExtension::Params*) { return dmExtension::RESULT_OK; }\ndmExtension::Result FinalizeStaticApplication(dmExtension::Params*) { return dmExtension::RESULT_OK; }\n}\n\nnamespace deherm_static_application_registration {\nDM_DECLARE_EXTENSION(\n    defold_hermes_static_application,\n    LIB_NAME,\n    AppInitializeStaticApplication,\n    AppFinalizeStaticApplication,\n    InitializeStaticApplication,\n    0,\n    0,\n    FinalizeStaticApplication)\n}  // namespace deherm_static_application_registration\n`);
  // Bob's Extender link consumes the target Hermes archive from the extension
  // project.  The authored example intentionally does not carry a host
  // install, so populate only the temporary copy through the same locked
  // installer used by the CLI.  Seed that installer's cache from the checked
  // in build cache and authenticate its receipt locally; no project or cache
  // outside the staging directory is mutated by the gate.
  const { ensureProjectNativeArtifact, resolveDefoldPlatform } = await import("../packages/cli/src/toolchains.mjs");
  const resolvedTarget = await resolveDefoldPlatform(stagedRoot, target);
  const lock = JSON.parse(await readFile(path.join(stagedRoot, "deherm.lock"), "utf8"));
  const family = lock.artifacts?.artifacts?.["native-artifacts"];
  const asset = family?.assets?.[resolvedTarget.extenderTarget];
  const members = (family?.contents?.[resolvedTarget.extenderTarget] ?? [])
    .filter((member) => member === "libhermes.a" || member === "libhermes.debug.a" || member === "libhermesvm-config.h");
  if (!family?.tag || !asset || members.length === 0) {
    throw gateError("native-artifact-unavailable", `staged project has no locked Hermes artifact mapping for ${resolvedTarget.extenderTarget}`);
  }
  const sourceArtifact = path.join(repositoryRoot, "build/native-artifact-downloads", family.tag, `hermes-${resolvedTarget.extenderTarget}`);
  const cacheRoot = path.join(stagedRoot, ".deherm-gate-native-artifact-cache");
  const cacheTarget = path.join(cacheRoot, family.tag, resolvedTarget.extenderTarget);
  await mkdir(cacheTarget, { recursive: true });
  const hashes = {};
  for (const member of members) {
    const source = path.join(sourceArtifact, member);
    if (!existsSync(source)) throw gateError("native-artifact-unavailable", `locked Hermes cache is missing ${source}`);
    await cp(source, path.join(cacheTarget, member));
    hashes[member] = sha256(await readFile(source));
  }
  const archive = path.join(path.dirname(sourceArtifact), asset);
  if (!existsSync(archive)) throw gateError("native-artifact-unavailable", `locked Hermes cache is missing ${archive}`);
  await cp(archive, path.join(cacheTarget, asset));
  await writeFile(path.join(cacheTarget, ".deherm-target-cache.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "deherm.target-artifact-cache",
    target: resolvedTarget.extenderTarget,
    tag: family.tag,
    fingerprint: family.fingerprint,
    asset,
    assetSha256: sha256(await readFile(archive)),
    members,
    hashes
  }, null, 2)}\n`);
  let nativeArtifact;
  try {
    nativeArtifact = await ensureProjectNativeArtifact(stagedRoot, resolvedTarget.extenderTarget, {
      variant: "debug",
      offline: true,
      cacheRoot
    });
  } catch (error) {
    if (!error.code) error.code = "native-artifact-unavailable";
    throw error;
  }
  const installed = {};
  for (const relative of [
    `defold_hermes/lib/${resolvedTarget.extenderTarget}/libhermes.a`,
    "defold_hermes/include/libhermesvm-config.h",
    "defold_hermes/include/defold_hermes/generated_runtime_variant.h"
  ]) {
    const file = path.join(stagedRoot, relative);
    installed[relative] = { sha256: sha256(await readFile(file)), bytes: (await readFile(file)).byteLength };
  }
  const bobOutput = path.join(stagedRoot, "build/gate-bob");
  const bundleOutput = path.join(stagedRoot, "build/gate-bundle");
  // Bob's Extender response is unpacked under build/<extender-target>, while
  // --output is the archive/resource graph directory.
  const engineOutput = path.join(stagedRoot, "build", resolvedTarget.extenderTarget);
  const bobOutputRelative = "build/gate-bob";
  const bundleOutputRelative = "build/gate-bundle";
  const command = [
    "-jar", bobJar,
    "--root", stagedRoot,
    "--output", bobOutputRelative,
    "--bundle-output", bundleOutputRelative,
    "--platform", target,
    "--architectures", target,
    "--variant", "debug",
    "--build-server", buildServer,
    "--archive",
    "resolve", "build"
  ];
  return {
    stagedRoot,
    extensionSource: templatePath,
    extensionSourceSha256: sha256(adapted),
    emittedCSha256: sha256(emitted),
    applicationExtensionSourceSha256: sha256(await readFile(path.join(applicationSourceDirectory, "deherm_static_application_extension.cpp"))),
    emittedApplicationCSha256: sha256(adaptedApplication),
    emittedApplicationCBytes: Buffer.byteLength(adaptedApplication),
    nativeArtifact: {
      target: resolvedTarget.extenderTarget,
      variant: nativeArtifact.variant,
      tag: nativeArtifact.tag,
      fingerprint: nativeArtifact.fingerprint,
      cache: displayPath(cacheTarget),
      installed
    },
    bobOutput,
    bundleOutput,
    engineOutput,
    command
  };
}

function runBob(java, command, cwd) {
  const result = spawnSync(java, command, {
    cwd,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    // Static Hermes application units can make clang emit hundreds of
    // compatibility warnings.  The default 1 MiB child-process buffer turns
    // that otherwise successful build into ENOBUFS before Bob can report its
    // real exit status.
    maxBuffer: 32 * 1024 * 1024
  });
  const bounded = (value) => {
    const text = value ?? "";
    const limit = 128 * 1024;
    if (Buffer.byteLength(text) <= limit) return { text, truncatedBytes: 0 };
    const edge = 64 * 1024;
    const head = text.slice(0, edge);
    const tail = text.slice(-edge);
    return {
      text: `${head}\n... deherm omitted ${Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail)} process-output byte(s) ...\n${tail}`,
      truncatedBytes: Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail)
    };
  };
  const stdout = bounded(result.stdout);
  const stderr = bounded(result.stderr);
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncatedBytes: stdout.truncatedBytes,
    stderrTruncatedBytes: stderr.truncatedBytes
  };
}

function runApplication(executable, cwd) {
  const result = spawnSync(executable, [], {
    cwd,
    encoding: "utf8",
    timeout: 15 * 1000,
    env: { ...process.env, DEHERM_HEADLESS: "1" }
  });
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function staticApplicationActivationObserved(result, expectedFingerprint = null) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!expectedFingerprint) return /DEHERM_EVENT static-application-activated\b/u.test(output);
  return new RegExp(`DEHERM_EVENT static-application-activated\\b[^\\n]*\\bfingerprint=${expectedFingerprint}\\b`, "u").test(output);
}

function stage(name, status, details = {}) {
  return { name, status, ...details };
}

async function recordApplication(report, { options, executable, linkDetails, runtimeCwd, diagnosticToolchain, expectedApplicationFingerprint }) {
  if (!options.run) {
    report.stages.push(stage("application", "not-requested", { requested: false, executable: linkDetails.output }));
    return;
  }
  // Extender's zip preserves a non-executable mode for dmengine; make the
  // staged copy runnable without touching the authored project.
  await chmod(executable, 0o755);
  // Bob writes the resource archives beside `game.projectc` under its output
  // directory. Running from the staged project root starts an engine with no
  // bootstrap resources, which can prove extension registration but can never
  // attach a script instance or activate the Static Hermes application.
  const result = runApplication(executable, runtimeCwd);
  const activationObserved = staticApplicationActivationObserved(result, expectedApplicationFingerprint);
  const completedOrStillRunning = result.status === 0 || result.timedOut;
  const observed = activationObserved && completedOrStillRunning;
  report.stages.push(stage("application", observed
    ? diagnosticToolchain ? "observed-unpinned" : "observed"
    : "blocked", {
    requested: true,
    executable: linkDetails.output,
    activationObserved,
      runtimeCwd: displayPath(runtimeCwd),
      result
  }));
  if (!observed) {
    report.blockers.push(blocker(
      "application-activation-unobserved",
      "The linked Defold executable did not report Static Hermes application activation",
      { exitStatus: result.status, timedOut: result.timedOut, error: result.error, stderr: result.stderr, stdout: result.stdout }
    ));
    return;
  }
  report.evidenceBoundary.runtime = diagnosticToolchain
    ? "observed only with an unpinned diagnostic compiler: linked Defold executable reported Static Hermes activation"
    : "observed: linked Defold executable reported Static Hermes activation";
}

export async function buildGate(rawOptions = {}) {
  const options = {
    ...defaultPaths,
    allowUnpinnedToolchain: false,
    link: false,
    run: false,
    keep: false,
    java: null,
    buildServer: process.env.DEFOLD_HERMES_BUILD_SERVER ?? "http://localhost:9010",
    ...rawOptions
  };
  options.project ??= defaultProject;
  if (!Object.hasOwn(rawOptions, "applicationBundle")) {
    options.applicationBundle = path.join(options.project, "deherm/app.dehermc");
  }
  if (!Object.hasOwn(rawOptions, "projectLock")) options.projectLock = path.join(options.project, "deherm.lock");
  options.output ??= path.join(repositoryRoot, "build/gates/war-battles-static-hermes");
  const report = {
    schemaVersion: 1,
    kind: "deherm.war-battles.static-hermes-build-gate",
    generator: "scripts/check-war-battles-static-hermes-build-gate.mjs",
    target: "arm64-macos",
    status: "blocked",
    inputs: {},
    reachability: null,
    toolchain: null,
    stages: [],
    blockers: [],
    evidenceBoundary: {
      generation: "release usage plus lowering plan plus typed-native bridge plus authored app-bundle provenance",
      compilation: "not-claimed until this gate emits C with a pinned shermes",
      linkage: "not-claimed until Bob/Extender links the derived unit",
      runtime: "not-claimed until the linked Defold application runs",
      gameplay: "not-claimed; gameplay belongs to a separate observed projection"
    }
  };
  const output = path.resolve(options.output);
  await mkdir(output, { recursive: true });
  const loaded = {};
  let emittedCPath = null;
  let emittedApplicationCPath = null;
  try {
    loaded.manifest = await readJson(options.manifest);
    loaded.projectionBytes = await readFile(options.projection);
    loaded.projection = JSON.parse(loaded.projectionBytes);
    loaded.reconstructedProjection = await buildWarBattlesStaticHermesProjection();
    if (canonical(loaded.projection) !== canonical(loaded.reconstructedProjection)) {
      throw new Error("Static Hermes gate projection is not an independently reconstructed release projection");
    }
    loaded.loweringPlan = await readJson(options.loweringPlan);
    loaded.loweringPlanBytes = await readFile(options.loweringPlan);
    loaded.bridge = await readJson(options.bridge);
    loaded.universalSource = await readFile(options.universalSource, "utf8");
    loaded.typedNativeSource = await readFile(options.typedNativeSource, "utf8");
    loaded.applicationBundle = await readFile(options.applicationBundle);
    loaded.projectLock = await readJson(options.projectLock);
    loaded.upstreamLock = await readFile(defaultPaths.upstreamLock, "utf8");
    loaded.hostCompilers = await readJson(defaultPaths.hostCompilers);
    const revision = resolveDefoldRevision(loaded.upstreamLock);
    const lockedApplication = loaded.projectLock?.buildArtifacts?.artifacts?.["deherm/app.dehermc"];
    const lockedApplicationSha256 = lockedApplication?.outputs?.["deherm/app.dehermc"];
    const applicationSha256 = sha256(loaded.applicationBundle);
    const applicationText = loaded.applicationBundle.toString("utf8");
    const embeddedFingerprint = /globalThis\.__DEFOLD_HERMES_BUILD_FINGERPRINT__\s*=\s*"([0-9a-f]{64})"/u.exec(applicationText)?.[1] ?? null;
    if (!lockedApplicationSha256 || !lockedApplication?.fingerprint) {
      throw new Error("project lock does not authenticate deherm/app.dehermc");
    }
    if (applicationSha256 !== lockedApplicationSha256) {
      throw new Error(`Static Hermes application bundle digest does not match project lock: expected ${lockedApplicationSha256}, got ${applicationSha256}`);
    }
    if (embeddedFingerprint !== lockedApplication.fingerprint) {
      throw new Error(`Static Hermes application fingerprint does not match project lock: expected ${lockedApplication.fingerprint}, got ${embeddedFingerprint ?? "missing"}`);
    }
    if (loaded.projectLock.defoldRevision !== revision) {
      throw new Error("project lock and upstream.lock do not share pinned Defold revision");
    }
    await verifyLockedApplicationSources(options.project, lockedApplication);
    loaded.applicationFingerprint = embeddedFingerprint;
    loaded.usage = releaseUsageFromProjection(
      loaded.projection,
      loaded.loweringPlan,
      sha256(loaded.loweringPlanBytes)
    );
    await verifyProjectionAuthoredSources(loaded.projection, options.project);
    if (loaded.manifest.defoldRevision !== revision || loaded.usage.defoldRevision !== revision ||
        loaded.loweringPlan.defoldRevision !== revision || loaded.bridge.defoldRevision !== revision) {
      throw new Error("release projection, bridge, lowering plan, and project manifest do not share pinned Defold revision");
    }
    const reachability = resolveStaticRoutes(loaded.usage, loaded.loweringPlan);
    const bridge = bridgeBodyAndClaims(loaded.bridge);
    const typedNativeSourceSha256 = sha256(loaded.typedNativeSource);
    if (loaded.bridge.generatedSha256?.typescript &&
        loaded.bridge.generatedSha256.typescript !== typedNativeSourceSha256) {
      throw new Error(
        `typed-native bridge source is stale: report expects ${loaded.bridge.generatedSha256.typescript}, ` +
        `project source is ${typedNativeSourceSha256}`
      );
    }
    if (loaded.projection.source?.typedNativeBridgeSha256 !== sha256(await readFile(options.bridge))) {
      throw new Error("Static Hermes release projection was derived from a different typed-native bridge");
    }
    if (loaded.projection.source?.typedNativeSourceSha256 !== typedNativeSourceSha256) {
      throw new Error("Static Hermes release projection was derived from a different typed-native source");
    }
    for (const route of reachability.selected) {
      if (bridge.claims.get(route.id) !== route.stableId) {
        throw new Error(`${route.id}: selected Static Hermes route is absent or mismatched in typed-native bridge`);
      }
    }
    report.reachability = {
      profile: loaded.usage.profile,
      dynamicAccess: loaded.usage.dynamicAccess,
      reachableRouteCount: reachability.reachable.length,
      reachableRouteIds: reachability.reachable.map(({ id }) => id),
      staticReachableRouteCount: reachability.selected.length,
      staticReachableRouteIds: reachability.selected.map(({ id }) => id),
      blockedReachableRouteCount: reachability.blocked.length,
      blockedReachableRoutes: reachability.blocked
    };
    const sourceFiles = {
      manifest: options.manifest,
      projection: options.projection,
      loweringPlan: options.loweringPlan,
      bridge: options.bridge,
      universalSource: options.universalSource,
      typedNativeSource: options.typedNativeSource,
      applicationBundle: options.applicationBundle,
      projectLock: options.projectLock,
      upstreamLock: defaultPaths.upstreamLock
    };
    for (const [name, file] of Object.entries(sourceFiles)) {
      const value = name.endsWith("Source") ? loaded[name] : await readFile(file);
      report.inputs[name] = { path: relativeToRepo(file), sha256: sha256(value) };
    }
    report.stages.push(stage("provenance", "passed", {
      defoldRevision: revision,
      typedNativeBridgeClaimedRouteCount: loaded.bridge.claimedRouteCount,
      selectedRouteCount: reachability.selected.length
    }));
  } catch (error) {
    report.stages.push(stage("provenance", "blocked"));
    report.blockers.push(blocker("input-provenance-invalid", error.message));
    await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const tool = await expectedShermes(options, loaded.hostCompilers);
  let toolSha = null;
  if (tool.selected && existsSync(tool.selected)) toolSha = sha256(await readFile(tool.selected));
  const expectedSha = tool.record?.sha256 ?? null;
  const pinned = Boolean(toolSha && expectedSha && toolSha === expectedSha);
  const diagnosticToolchain = !pinned;
  report.toolchain = {
    host: tool.host,
    shermes: {
      path: tool.selected ? relativeToRepo(tool.selected) : null,
      expectedSha256: expectedSha,
      actualSha256: toolSha,
      pinned,
      status: pinned ? "verified" : tool.selected ? "unverified" : "missing"
    },
    resolver: tool.resolver,
    bob: {
      path: relativeToRepo(defaultPaths.bob),
      expectedSha256: loaded.manifest.toolchain?.bob?.sha256 ?? null,
      actualSha256: existsSync(defaultPaths.bob) ? sha256(await readFile(defaultPaths.bob)) : null,
      present: existsSync(defaultPaths.bob)
    },
    pins: loaded.manifest.toolchain?.pins ?? {}
  };
  if (!tool.selected) report.blockers.push(blocker("shermes-missing", `No shermes binary found for ${tool.host}`, { candidates: tool.candidates.map(relativeToRepo), resolver: tool.resolver }));
  else if (!pinned && !options.allowUnpinnedToolchain) report.blockers.push(blocker("shermes-digest-mismatch", "Selected shermes does not match the host-compilers.json digest", { expectedSha256: expectedSha, actualSha256: toolSha, path: relativeToRepo(tool.selected) }));
  else if (!pinned) report.blockers.push(blocker("shermes-unpinned-diagnostic", "Compilation used an explicitly allowed unpinned shermes; no release gate may promote this evidence", { expectedSha256: expectedSha, actualSha256: toolSha }));

  if (tool.selected && (pinned || options.allowUnpinnedToolchain)) {
    const derivedSource = path.join(output, "derived-unit.ts");
    const emittedC = path.join(output, "derived-unit.c");
    const emittedApplicationC = path.join(output, "static-application.c");
    emittedCPath = emittedC;
    emittedApplicationCPath = emittedApplicationC;
    const selectedIds = report.reachability.staticReachableRouteIds.map((id) =>
      loaded.usage.routes.find((route) => route.id === id).stableId);
    const derivedBridge = rewriteBridgeClaims(loaded.typedNativeSource, selectedIds);
    const unitSource = `${loaded.universalSource.replace(/^export \{.*\};$/m, "")}\n${derivedBridge}\n`;
    await writeFile(derivedSource, unitSource);
    const typedResult = runShermes(tool.selected, path.relative(repositoryRoot, derivedSource), emittedC);
    const applicationResult = runShermes(tool.selected, options.applicationBundle, emittedApplicationC, {
      typed: false,
      unitName: "deherm_static_application"
    });
    if (typedResult.status === 0 && existsSync(emittedC) && applicationResult.status === 0 && existsSync(emittedApplicationC)) {
      const emitted = await readFile(emittedC);
      const emittedApplication = await readFile(emittedApplicationC);
      report.stages.push(stage("compile", pinned ? "passed" : "observed-unpinned", {
        typedNative: {
          command: [relativeToRepo(tool.selected), "-typed", "-strict", "-O", "-emit-c", relativeToRepo(derivedSource), "-o", relativeToRepo(emittedC)],
          derivedSourceSha256: sha256(unitSource),
          emittedCSha256: sha256(emitted),
          emittedCBytes: emitted.byteLength,
          exportedUnit: typedNativeUnitName,
          directStaticFrameCallCount: (emitted.toString().match(/\bdeherm_script_static_[a-z_0-9]*\(/g) ?? []).length
        },
        staticApplication: {
          command: [relativeToRepo(tool.selected), "-O", "-emit-c", relativeToRepo(options.applicationBundle), "-o", relativeToRepo(emittedApplicationC)],
          applicationBundleSha256: sha256(loaded.applicationBundle),
          emittedCSha256: sha256(emittedApplication),
          emittedCBytes: emittedApplication.byteLength,
          exportedUnit: "deherm_static_application",
          hasDefoldRuntimeEntrypoint: /__defold(?:App|Components)V1/u.test(emittedApplication.toString())
        },
        // Keep the original typed-native fields as compatibility aliases for
        // consumers that only understand the reachable-unit gate schema.
        command: [relativeToRepo(tool.selected), "-typed", "-strict", "-O", "-emit-c", relativeToRepo(derivedSource), "-o", relativeToRepo(emittedC)],
        derivedSourceSha256: sha256(unitSource),
        emittedCSha256: sha256(emitted),
        emittedCBytes: emitted.byteLength,
        exportedUnit: typedNativeUnitName,
        directStaticFrameCallCount: (emitted.toString().match(/\bdeherm_script_static_[a-z_0-9]*\(/g) ?? []).length
      }));
      report.evidenceBoundary.compilation = pinned
        ? "observed: pinned shermes emitted both the reachable typed-native unit and authored Static Hermes application unit"
        : "observed only with an unpinned diagnostic compiler: shermes emitted both the reachable typed-native unit and authored Static Hermes application unit";
    } else {
      emittedCPath = null;
      emittedApplicationCPath = null;
      report.stages.push(stage("compile", "blocked", {
        typedNative: { status: typedResult.status, stdout: typedResult.stdout, stderr: typedResult.stderr },
        staticApplication: { status: applicationResult.status, stdout: applicationResult.stdout, stderr: applicationResult.stderr }
      }));
      report.blockers.push(blocker("shermes-compile-failed", "Pinned/diagnostic shermes failed to emit both the reachable Static Hermes unit and authored application unit", {
        typedNativeExitStatus: typedResult.status,
        typedNativeStderr: typedResult.stderr,
        staticApplicationExitStatus: applicationResult.status,
        staticApplicationStderr: applicationResult.stderr
      }));
    }
    if (!options.keep) await rm(derivedSource, { force: true });
  } else {
    report.stages.push(stage("compile", "blocked", { reason: "verified shermes unavailable" }));
    report.blockers.push(blocker("compile-not-run", "Compile stage was not run because shermes provenance is not verified"));
  }

  if (!options.link) {
    report.blockers.push(blocker("link-not-requested", "Bob/Extender linkage was not requested; emitted C is not a linked Defold artifact"));
    report.stages.push(stage("link", "blocked", { requested: false, output: null }));
    report.blockers.push(blocker("application-not-requested", "Defold application execution was not requested"));
    report.stages.push(stage("application", "blocked", { requested: options.run, executable: null }));
  } else if (!emittedCPath || !existsSync(emittedCPath) || !emittedApplicationCPath || !existsSync(emittedApplicationCPath)) {
    report.blockers.push(blocker("link-input-missing", "Link was requested but both typed-native and Static Hermes application C units were not emitted"));
    report.stages.push(stage("link", "blocked", { requested: true, output: null }));
    report.blockers.push(blocker("application-not-run", "Application execution requires a linked Defold bundle"));
    report.stages.push(stage("application", "blocked", { requested: options.run, executable: null }));
  } else {
    const java = findJava(options.java);
    const bobPresent = existsSync(defaultPaths.bob);
    const bobSha = bobPresent ? sha256(await readFile(defaultPaths.bob)) : null;
    const bobExpected = loaded.manifest.toolchain?.bob?.sha256 ?? null;
    const bobPinned = Boolean(bobSha && bobExpected && bobSha === bobExpected);
    const linkDetails = {
      requested: true,
      buildServer: options.buildServer,
      bob: { path: relativeToRepo(defaultPaths.bob), present: bobPresent, expectedSha256: bobExpected, actualSha256: bobSha, pinned: bobPinned },
      java: { path: java ? displayPath(java) : null, present: Boolean(java), status: null },
      stagedProject: null,
      command: null,
      result: null,
      output: null
    };
    if (!bobPresent) {
      report.blockers.push(blocker("bob-missing", `Pinned Bob is missing at ${relativeToRepo(defaultPaths.bob)}`));
      report.stages.push(stage("link", "blocked", linkDetails));
    } else if (!bobPinned) {
      report.blockers.push(blocker("bob-digest-mismatch", "Bob does not match the project manifest digest", { expectedSha256: bobExpected, actualSha256: bobSha }));
      report.stages.push(stage("link", "blocked", linkDetails));
    } else if (!java) {
      report.blockers.push(blocker("jdk-missing", "A runnable JDK is required for Bob/Extender linkage", { candidates: javaCandidates(options.java).map(displayPath) }));
      report.stages.push(stage("link", "blocked", linkDetails));
    } else {
      const javaVersion = spawnSync(java, ["-version"], { encoding: "utf8" });
      linkDetails.java.status = javaVersion.status;
      linkDetails.java.version = `${javaVersion.stdout ?? ""}${javaVersion.stderr ?? ""}`.trim();
      if (javaVersion.status !== 0) {
        report.blockers.push(blocker("jdk-unrunnable", "The selected Java executable could not run", { path: java, stderr: javaVersion.stderr }));
        report.stages.push(stage("link", "blocked", linkDetails));
      } else if (localServer(options.buildServer)) {
        const health = spawnSync("curl", ["--silent", "--fail", "--max-time", "2", `${options.buildServer}/actuator/health`], { encoding: "utf8" });
        if (health.status !== 0) {
          report.blockers.push(blocker("extender-unavailable", `Local Extender is not healthy at ${options.buildServer}`, { healthExitStatus: health.status, healthStderr: health.stderr ?? "" }));
          report.stages.push(stage("link", "blocked", { ...linkDetails, extenderHealth: { status: health.status, stdout: health.stdout, stderr: health.stderr } }));
        } else {
          const staged = await stageTypedNativeProject({ project: options.project, emittedC: emittedCPath, emittedApplicationC: emittedApplicationCPath, bobJar: defaultPaths.bob, buildServer: options.buildServer });
          linkDetails.stagedProject = { root: displayPath(staged.stagedRoot), extensionSourceSha256: staged.extensionSourceSha256, emittedCSha256: staged.emittedCSha256, applicationExtensionSourceSha256: staged.applicationExtensionSourceSha256, emittedApplicationCSha256: staged.emittedApplicationCSha256, emittedApplicationCBytes: staged.emittedApplicationCBytes, nativeArtifact: staged.nativeArtifact };
          linkDetails.command = [java, ...staged.command];
          const result = runBob(java, staged.command, staged.stagedRoot);
          linkDetails.result = result;
          const executable = [path.join(staged.engineOutput, "dmengine"), path.join(staged.bobOutput, "arm64-osx", "dmengine")]
            .find((candidate) => existsSync(candidate));
          const linked = result.status === 0 && Boolean(executable);
          if (!linked) {
            report.blockers.push(blocker("defold-link-failed", "Bob/Extender did not produce a linked Defold engine", { exitStatus: result.status, stderr: result.stderr, stdout: result.stdout }));
            report.stages.push(stage("link", "blocked", linkDetails));
          } else {
            const executableBytes = await readFile(executable);
            linkDetails.output = { executable: displayPath(executable), sha256: sha256(executableBytes), bytes: executableBytes.byteLength };
            report.stages.push(stage("link", diagnosticToolchain ? "observed-unpinned" : "passed", linkDetails));
            report.evidenceBoundary.linkage = diagnosticToolchain
              ? "observed only with an unpinned diagnostic compiler: Bob/Extender linked the staged typed-native and Static Hermes application units into Defold"
              : "observed: Bob/Extender linked the staged typed-native and Static Hermes application units into Defold";
            await recordApplication(report, {
              options, executable, linkDetails, runtimeCwd: staged.bobOutput, diagnosticToolchain,
              expectedApplicationFingerprint: loaded.applicationFingerprint
            });
          }
          if (!options.keep) await rm(staged.stagedRoot, { recursive: true, force: true });
        }
      } else {
        const staged = await stageTypedNativeProject({ project: options.project, emittedC: emittedCPath, emittedApplicationC: emittedApplicationCPath, bobJar: defaultPaths.bob, buildServer: options.buildServer });
        linkDetails.stagedProject = { root: displayPath(staged.stagedRoot), extensionSourceSha256: staged.extensionSourceSha256, emittedCSha256: staged.emittedCSha256, applicationExtensionSourceSha256: staged.applicationExtensionSourceSha256, emittedApplicationCSha256: staged.emittedApplicationCSha256, emittedApplicationCBytes: staged.emittedApplicationCBytes, nativeArtifact: staged.nativeArtifact };
        linkDetails.command = [java, ...staged.command];
        const result = runBob(java, staged.command, staged.stagedRoot);
        linkDetails.result = result;
        const executable = [path.join(staged.engineOutput, "dmengine"), path.join(staged.bobOutput, "arm64-osx", "dmengine")]
          .find((candidate) => existsSync(candidate));
        const linked = result.status === 0 && Boolean(executable);
        if (!linked) {
          report.blockers.push(blocker("defold-link-failed", "Bob/Extender did not produce a linked Defold engine", { exitStatus: result.status, stderr: result.stderr, stdout: result.stdout }));
          report.stages.push(stage("link", "blocked", linkDetails));
        } else {
          const executableBytes = await readFile(executable);
          linkDetails.output = { executable: displayPath(executable), sha256: sha256(executableBytes), bytes: executableBytes.byteLength };
          report.stages.push(stage("link", diagnosticToolchain ? "observed-unpinned" : "passed", linkDetails));
          report.evidenceBoundary.linkage = diagnosticToolchain
            ? "observed only with an unpinned diagnostic compiler: Bob/Extender linked the staged typed-native and Static Hermes application units into Defold"
            : "observed: Bob/Extender linked the staged typed-native and Static Hermes application units into Defold";
          await recordApplication(report, {
            options, executable, linkDetails, runtimeCwd: staged.bobOutput, diagnosticToolchain,
            expectedApplicationFingerprint: loaded.applicationFingerprint
          });
        }
        if (!options.keep) await rm(staged.stagedRoot, { recursive: true, force: true });
      }
    }
  }
  report.status = report.blockers.length === 0 ? "passed" : "blocked";
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usageText());
  } else {
    try {
      const result = await buildGate(options);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "passed" ? 0 : 3;
    } catch (error) {
      console.error(JSON.stringify({
        schemaVersion: 1,
        kind: "deherm.war-battles.static-hermes-build-gate",
        status: "blocked",
        blockers: [blocker(error.code ?? "gate-error", error.message)]
      }, null, 2));
      process.exitCode = 3;
    }
  }
}
