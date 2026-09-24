import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGate,
  hostFamilyExpectedDigests,
  staticApplicationActivationObserved,
} from "../scripts/check-war-battles-static-hermes-build-gate.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function copyLockedApplicationSources(sourceRoot, project, projectLock) {
  const lockedApplication = projectLock.buildArtifacts.artifacts["deherm/app.dehermc"];
  for (const relative of Object.keys(lockedApplication.sources.files)) {
    const destination = path.join(project, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(sourceRoot, relative)));
  }
}

test("host-family resolver derives release member digests without flat tool fallbacks", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "packages/toolchains/host-compilers.json"), "utf8"));
  const digests = hostFamilyExpectedDigests(manifest, "darwin-arm64");
  assert.deepEqual(Object.keys(digests).sort(), ["hermesc", "shermes"]);
  assert.equal(digests.shermes, manifest.hosts["darwin-arm64"].tools.shermes.sha256);
  assert.equal(digests.hermesc, manifest.hosts["darwin-arm64"].tools.hermesc.sha256);
});

test("root and example scripts name the typed-native bridge gate explicitly", async () => {
  const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const examplePackage = JSON.parse(await readFile(path.join(root, "examples/war-battles-online/package.json"), "utf8"));
  assert.equal(rootPackage.scripts["check:war-battles-static-hermes-typed-native-bridge"], "pnpm test:war-battles-static-hermes-typed-native-bridge");
  assert.match(rootPackage.scripts["gate:war-battles-static-hermes-typed-native-bridge"], /--link/);
  assert.match(examplePackage.scripts["check:typed-native-bridge"], /check:war-battles-static-hermes-typed-native-bridge/);
  assert.match(examplePackage.scripts.check, /check:typed-native-bridge/);
});

test("War Battles Static Hermes gate derives a closed release route set", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-"));
  try {
    const report = await buildGate({
      output,
      shermes: path.join(root, "build/native/bin/shermes"),
      allowUnpinnedToolchain: true,
      typedNativeSource: path.join(root, "packages/static-hermes/src/generated/script-typed-native-bridge.ts")
    });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, "deherm.war-battles.static-hermes-build-gate");
    assert.equal(report.reachability.profile, "release");
    assert.equal(report.reachability.dynamicAccess, false);
    assert.ok(report.reachability.staticReachableRouteCount > 0);
    assert.ok(report.reachability.blockedReachableRouteCount >= 0);
    assert.equal(report.stages.find(({ name }) => name === "compile").status, "observed-unpinned");
    assert.ok(report.stages.find(({ name }) => name === "compile").emittedCBytes > 0);
    assert.equal(report.stages.find(({ name }) => name === "compile").exportedUnit, "deherm_typed_native");
    assert.equal(report.stages.find(({ name }) => name === "compile").staticApplication.exportedUnit, "deherm_static_application");
    assert.ok(report.stages.find(({ name }) => name === "compile").staticApplication.emittedCBytes > 0);
    assert.equal(report.stages.find(({ name }) => name === "compile").staticApplication.hasDefoldRuntimeEntrypoint, true);
    assert.match(
      await readFile(path.join(output, "derived-unit.c"), "utf8"),
      /#define CREATE_THIS_UNIT sh_export_deherm_typed_native\b/,
      "compiled unit must export the symbol consumed by the staged extension"
    );
    assert.match(
      await readFile(path.join(output, "static-application.c"), "utf8"),
      /#define CREATE_THIS_UNIT sh_export_deherm_static_application\b/,
      "compiled application unit must export the symbol consumed by the staged application extension"
    );
    assert.ok(report.blockers.some(({ code }) => code === "shermes-unpinned-diagnostic"));
    assert.ok(report.blockers.some(({ code }) => code === "link-not-requested"));
    assert.match(report.evidenceBoundary.runtime, /not-claimed/);
    const persisted = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.deepEqual(persisted, report);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("default toolchain policy fails closed before unpinned emission", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-"));
  try {
    const report = await buildGate({ output, shermes: path.join(output, "missing-shermes") });
    assert.equal(report.status, "blocked");
    assert.ok(report.blockers.length > 0);
    assert.equal(report.stages.find(({ name }) => name === "compile")?.status, "blocked");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Static application evidence requires the activation marker", () => {
  assert.equal(staticApplicationActivationObserved({ stdout: "engine booted", stderr: "" }), false);
  assert.equal(staticApplicationActivationObserved({
    stdout: "INFO:DEFOLD_HERMES: DEHERM_EVENT static-application-activated auxiliary_count=1 fingerprint=abc123",
    stderr: ""
  }), true);
  assert.equal(staticApplicationActivationObserved({
    stdout: "INFO:DEFOLD_HERMES: DEHERM_EVENT static-application-activated auxiliary_count=1 fingerprint=abc123",
    stderr: ""
  }, "abc123"), true);
  assert.equal(staticApplicationActivationObserved({
    stdout: "INFO:DEFOLD_HERMES: DEHERM_EVENT static-application-activated auxiliary_count=1 fingerprint=stale",
    stderr: ""
  }, "abc123"), false);
});

test("Static product gate rejects an application bundle outside the project lock", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-bundle-drift-"));
  try {
    const applicationBundle = path.join(output, "app.dehermc");
    const source = await readFile(path.join(root, "examples/war-battles-online/defold/deherm/app.dehermc"));
    await writeFile(applicationBundle, Buffer.concat([source, Buffer.from("\n// stale replacement\n")]));
    const report = await buildGate({ applicationBundle, output: path.join(output, "gate") });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers[0]?.message ?? "", /bundle digest does not match project lock/u);
    assert.deepEqual(report.stages, [{ name: "provenance", status: "blocked" }]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Static product gate rejects a lock and bundle that are stale against current application sources", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-source-lock-drift-"));
  const project = path.join(output, "project");
  const sourceRoot = path.join(root, "examples/war-battles-online/defold");
  try {
    const projectLock = JSON.parse(await readFile(path.join(sourceRoot, "deherm.lock"), "utf8"));
    await copyLockedApplicationSources(sourceRoot, project, projectLock);
    await writeFile(path.join(project, "deherm.lock"), `${JSON.stringify(projectLock, null, 2)}\n`);
    await writeFile(path.join(project, "src/generated-war-battles/world.ts"), "// stale imported source\n");
    const report = await buildGate({
      project,
      applicationBundle: path.join(sourceRoot, "deherm/app.dehermc"),
      output: path.join(output, "gate"),
    });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers[0]?.message ?? "", /application source is stale: src\/generated-war-battles\/world\.ts/u);
    assert.deepEqual(report.stages, [{ name: "provenance", status: "blocked" }]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Static product gate rejects a truncated application source inventory", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-truncated-sources-"));
  const sourceRoot = path.join(root, "examples/war-battles-online/defold");
  try {
    const projectLock = JSON.parse(await readFile(path.join(sourceRoot, "deherm.lock"), "utf8"));
    const sources = projectLock.buildArtifacts.artifacts["deherm/app.dehermc"].sources;
    delete sources.files["src/generated-war-battles/world.ts"];
    sources.fileCount -= 1;
    const projectLockPath = path.join(output, "deherm.lock");
    await writeFile(projectLockPath, `${JSON.stringify(projectLock, null, 2)}\n`);
    const report = await buildGate({
      project: sourceRoot,
      projectLock: projectLockPath,
      output: path.join(output, "gate"),
    });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers[0]?.message ?? "", /application source digest is inconsistent/u);
    assert.deepEqual(report.stages, [{ name: "provenance", status: "blocked" }]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Static product gate rejects an authored source tree newer than its locked application", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-source-drift-"));
  const project = path.join(output, "project");
  try {
    const projection = JSON.parse(await readFile(path.join(
      root, "examples/war-battles-online/evidence/static-hermes-reachable-arm64-macos.json"), "utf8"));
    const sourceRoot = path.join(root, "examples/war-battles-online/defold");
    const projectLock = JSON.parse(await readFile(path.join(sourceRoot, "deherm.lock"), "utf8"));
    await copyLockedApplicationSources(sourceRoot, project, projectLock);
    for (const relative of projection.source.authoredFiles) {
      const destination = path.join(project, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(sourceRoot, relative)));
    }
    assert.ok(projection.source.authoredFiles.includes("main/arena.script.ts"));
    await writeFile(path.join(project, "main/arena.script.ts"), "// source drift\n");
    const report = await buildGate({
      project,
      output: path.join(output, "gate"),
      applicationBundle: path.join(sourceRoot, "deherm/app.dehermc"),
      projectLock: path.join(sourceRoot, "deherm.lock"),
    });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers[0]?.message ?? "", /project lock application source is stale: main\/arena\.script\.ts/u);
    assert.deepEqual(report.stages, [{ name: "provenance", status: "blocked" }]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Static product gate rejects a lowering-plan override outside the checked projection", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-plan-drift-"));
  try {
    const source = path.join(root, "packages/bindings/generated/defold-binding-lowering-plan.json");
    const plan = JSON.parse(await readFile(source, "utf8"));
    plan.units[0].identity.stableId ^= 1;
    const loweringPlan = path.join(output, "lowering-plan.json");
    await writeFile(loweringPlan, `${JSON.stringify(plan, null, 2)}\n`);
    const report = await buildGate({ loweringPlan, output: path.join(output, "gate") });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers[0]?.message ?? "", /different canonical lowering plan/u);
    assert.deepEqual(report.stages, [{ name: "provenance", status: "blocked" }]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Static product gate rejects a self-consistent replacement projection", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-projection-drift-"));
  try {
    const source = path.join(root, "examples/war-battles-online/evidence/static-hermes-reachable-arm64-macos.json");
    const projection = JSON.parse(await readFile(source, "utf8"));
    projection.evidenceBoundary.gameplay = "forged";
    const { recordSha256: _discarded, ...body } = projection;
    projection.recordSha256 = sha256(JSON.stringify(body));
    const replacement = path.join(output, "projection.json");
    await writeFile(replacement, `${JSON.stringify(projection, null, 2)}\n`);
    const report = await buildGate({ projection: replacement, output: path.join(output, "gate") });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers[0]?.message ?? "", /not an independently reconstructed release projection/u);
    assert.deepEqual(report.stages, [{ name: "provenance", status: "blocked" }]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("link stage stages a temporary extension and consumes Bob output", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-gate-fake-link-"));
  const authoredUnit = path.join(root, "examples/war-battles-online/defold/defold_hermes_typed_native/src/deherm_typed_native_unit.cpp");
  const authoredBytes = await readFile(authoredUnit);
  const fakeJava = path.join(output, "fake-java");
  await writeFile(fakeJava, `#!/bin/sh
if [ "$1" = "-version" ]; then exit 0; fi
output=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output" ]; then output="$argument"; fi
  previous="$argument"
done
mkdir -p "$output/arm64-osx"
printf 'fake linked dmengine' > "$output/arm64-osx/dmengine"
exit 0
`);
  await chmod(fakeJava, 0o755);
  try {
    const report = await buildGate({
      output,
      shermes: path.join(root, "build/native/bin/shermes"),
      allowUnpinnedToolchain: true,
      typedNativeSource: path.join(root, "packages/static-hermes/src/generated/script-typed-native-bridge.ts"),
      link: true,
      java: fakeJava,
      buildServer: "https://fake.invalid"
    });
    assert.equal(report.stages.find(({ name }) => name === "link").status, "observed-unpinned");
    assert.match(report.evidenceBoundary.linkage, /unpinned diagnostic compiler/u);
    assert.match(report.stages.find(({ name }) => name === "link").command.join(" "), /fake-java/);
    assert.ok(report.stages.find(({ name }) => name === "link").output.sha256);
    assert.equal(report.stages.find(({ name }) => name === "link").stagedProject.nativeArtifact.target, "arm64-osx");
    assert.ok(report.stages.find(({ name }) => name === "link").stagedProject.emittedApplicationCSha256);
    assert.ok(report.stages.find(({ name }) => name === "link").stagedProject.applicationExtensionSourceSha256);
    assert.equal(report.blockers.some(({ code }) => code === "application-not-requested"), false);
    assert.equal(report.stages.find(({ name }) => name === "application").status, "not-requested");
    assert.deepEqual(await readFile(authoredUnit), authoredBytes, "link staging mutated the authored project");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
