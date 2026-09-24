#!/usr/bin/env node
// Generator-owned compile/link/application gate for the War Battles reachable
// Static Hermes projection.  This file intentionally does not edit generated
// runtime or generator sources: it derives a temporary unit from the release
// usage manifest and authenticated typed-native bridge, then records every
// stage boundary in a machine-readable report.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultProject = path.join(repositoryRoot, "examples/war-battles-online/defold");
const typedNativeUnitName = "deherm_typed_native";
const defaultPaths = Object.freeze({
  project: defaultProject,
  manifest: path.join(defaultProject, ".deherm/manifest.json"),
  usage: path.join(defaultProject, ".deherm/generated/defold-api-usage.json"),
  loweringPlan: path.join(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.json"),
  bridge: path.join(repositoryRoot, "packages/bindings/generated/defold-typed-native-bridge.json"),
  universalSource: path.join(defaultProject, ".deherm/static-hermes/generated/script-universal-value.ts"),
  typedNativeSource: path.join(defaultProject, ".deherm/static-hermes/generated/script-typed-native-bridge.ts"),
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
    else if (arg === "--usage") options.usage = value();
    else if (arg === "--bridge") options.bridge = value();
    else if (arg === "--typed-native-source") options.typedNativeSource = value();
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
  options.output ??= path.join(repositoryRoot, "build/gates/war-battles-static-hermes");
  return options;
}

function usageText() {
  return [
    "Usage: node scripts/check-war-battles-static-hermes-build-gate.mjs [options]",
    "",
    "  --shermes <file>                  compiler override (digest is still checked)",
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

function resolveStaticRoutes(usage, loweringPlan) {
  if (usage.schemaVersion !== 1 || usage.profile !== "release") {
    throw new Error("Static Hermes gate requires schemaVersion 1 release usage");
  }
  if (usage.dynamicAccess === true || usage.declaredDynamicAccess === true) {
    throw new Error("Static Hermes gate refuses release usage with dynamic API access");
  }
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

function runShermes(shermes, input, output) {
  const result = spawnSync(shermes, [
    "-typed", "-strict", "-O", "-emit-c",
    `-exported-unit=${typedNativeUnitName}`,
    input, "-o", output
  ], { cwd: repositoryRoot, encoding: "utf8" });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
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

async function stageTypedNativeProject({ project, emittedC, bobJar, buildServer, target = "arm64-macos" }) {
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
    timeout: 10 * 60 * 1000
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

function stage(name, status, details = {}) {
  return { name, status, ...details };
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
      generation: "release usage plus lowering plan plus typed-native bridge provenance",
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
  try {
    loaded.manifest = await readJson(options.manifest);
    loaded.usage = await readJson(options.usage);
    loaded.loweringPlan = await readJson(options.loweringPlan);
    loaded.bridge = await readJson(options.bridge);
    loaded.universalSource = await readFile(options.universalSource, "utf8");
    loaded.typedNativeSource = await readFile(options.typedNativeSource, "utf8");
    loaded.upstreamLock = await readFile(defaultPaths.upstreamLock, "utf8");
    loaded.hostCompilers = await readJson(defaultPaths.hostCompilers);
    const revision = resolveDefoldRevision(loaded.upstreamLock);
    if (loaded.manifest.defoldRevision !== revision || loaded.usage.defoldRevision !== revision ||
        loaded.loweringPlan.defoldRevision !== revision || loaded.bridge.defoldRevision !== revision) {
      throw new Error("release usage, bridge, lowering plan, and project manifest do not share pinned Defold revision");
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
      usage: options.usage,
      loweringPlan: options.loweringPlan,
      bridge: options.bridge,
      universalSource: options.universalSource,
      typedNativeSource: options.typedNativeSource,
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
    emittedCPath = emittedC;
    const selectedIds = report.reachability.staticReachableRouteIds.map((id) =>
      loaded.usage.routes.find((route) => route.id === id).stableId);
    const derivedBridge = rewriteBridgeClaims(loaded.typedNativeSource, selectedIds);
    const unitSource = `${loaded.universalSource.replace(/^export \{.*\};$/m, "")}\n${derivedBridge}\n`;
    await writeFile(derivedSource, unitSource);
    const result = runShermes(tool.selected, path.relative(repositoryRoot, derivedSource), emittedC);
    if (result.status === 0 && existsSync(emittedC)) {
      const emitted = await readFile(emittedC);
      report.stages.push(stage("compile", pinned ? "passed" : "observed-unpinned", {
        command: [relativeToRepo(tool.selected), "-typed", "-strict", "-O", "-emit-c", relativeToRepo(derivedSource), "-o", relativeToRepo(emittedC)],
        derivedSourceSha256: sha256(unitSource),
        emittedCSha256: sha256(emitted),
        emittedCBytes: emitted.byteLength,
        exportedUnit: typedNativeUnitName,
        directStaticFrameCallCount: (emitted.toString().match(/\bdeherm_script_static_[a-z_0-9]*\(/g) ?? []).length
      }));
      report.evidenceBoundary.compilation = pinned ? "observed: pinned shermes emitted the derived reachable unit" : "observed only with an unpinned diagnostic compiler";
    } else {
      report.stages.push(stage("compile", "blocked", { status: result.status, stdout: result.stdout, stderr: result.stderr }));
      report.blockers.push(blocker("shermes-compile-failed", "Pinned/diagnostic shermes failed to emit the reachable Static Hermes unit", { exitStatus: result.status, stderr: result.stderr }));
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
  } else if (!emittedCPath || !existsSync(emittedCPath)) {
    report.blockers.push(blocker("link-input-missing", "Link was requested but the reachable Static Hermes C unit was not emitted"));
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
          const staged = await stageTypedNativeProject({ project: options.project, emittedC: emittedCPath, bobJar: defaultPaths.bob, buildServer: options.buildServer });
          linkDetails.stagedProject = { root: displayPath(staged.stagedRoot), extensionSourceSha256: staged.extensionSourceSha256, emittedCSha256: staged.emittedCSha256, nativeArtifact: staged.nativeArtifact };
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
            report.stages.push(stage("link", "passed", linkDetails));
            report.evidenceBoundary.linkage = "observed: Bob/Extender linked the staged derived unit into Defold";
            if (options.run) {
              // Extender's zip preserves a non-executable mode for dmengine;
              // make the staged copy runnable without touching the authored
              // project or claiming that the bundle itself was repackaged.
              await chmod(executable, 0o755);
              const appResult = runApplication(executable, staged.stagedRoot);
              const appPassed = appResult.status === 0 || appResult.timedOut;
              report.stages.push(stage("application", appPassed ? "observed" : "blocked", { requested: true, executable: linkDetails.output, result: appResult }));
              if (!appPassed) report.blockers.push(blocker("application-run-failed", "The linked Defold executable failed during headless launch", { exitStatus: appResult.status, error: appResult.error, stderr: appResult.stderr, stdout: appResult.stdout }));
              else report.evidenceBoundary.runtime = "observed: linked Defold executable launched under the gate";
            } else {
              report.blockers.push(blocker("application-not-requested", "Defold application execution was not requested"));
              report.stages.push(stage("application", "blocked", { requested: false, executable: linkDetails.output }));
            }
          }
          if (!options.keep) await rm(staged.stagedRoot, { recursive: true, force: true });
        }
      } else {
        const staged = await stageTypedNativeProject({ project: options.project, emittedC: emittedCPath, bobJar: defaultPaths.bob, buildServer: options.buildServer });
        linkDetails.stagedProject = { root: displayPath(staged.stagedRoot), extensionSourceSha256: staged.extensionSourceSha256, emittedCSha256: staged.emittedCSha256, nativeArtifact: staged.nativeArtifact };
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
          report.stages.push(stage("link", "passed", linkDetails));
          report.evidenceBoundary.linkage = "observed: Bob/Extender linked the staged derived unit into Defold";
          report.blockers.push(blocker("application-not-requested", "Defold application execution was not requested"));
          report.stages.push(stage("application", "blocked", { requested: false, executable: linkDetails.output }));
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
