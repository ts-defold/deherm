import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGate, hostFamilyExpectedDigests } from "../scripts/check-war-battles-static-hermes-build-gate.mjs";

const root = path.resolve(import.meta.dirname, "..");

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
    // Keep the emission test hermetic while the working tree's generator wave
    // may be changing the lowering plan. Routes absent from the authenticated
    // bridge are represented as blocked in this test-only plan, as the real
    // gate must do rather than silently broadening the bridge.
    const bridge = JSON.parse(await readFile(path.join(root, "packages/bindings/generated/defold-typed-native-bridge.json"), "utf8"));
    const claimed = new Set(bridge.claimedRoutes.map(({ id }) => id));
    const plan = JSON.parse(await readFile(path.join(root, "packages/bindings/generated/defold-binding-lowering-plan.json"), "utf8"));
    for (const unit of plan.units ?? []) {
      if (unit.identity?.surface !== "script" || claimed.has(unit.identity.id)) continue;
      if (unit.backends?.staticHermesCAbi?.selection === "emit") {
        unit.backends.staticHermesCAbi.selection = "blocked-capability";
        unit.backends.staticHermesCAbi.blockerSet = 0;
      }
    }
    const fixturePlan = path.join(output, "lowering-plan.fixture.json");
    await writeFile(fixturePlan, `${JSON.stringify(plan)}\n`);
    const report = await buildGate({
      output,
      shermes: path.join(root, "build/native/bin/shermes"),
      allowUnpinnedToolchain: true,
      // The checked-in product copy is intentionally stale while another
      // generator wave is in flight; compile the bridge bytes authenticated by
      // defold-typed-native-bridge.json for this focused emission test.
      typedNativeSource: path.join(root, "packages/static-hermes/src/generated/script-typed-native-bridge.ts"),
      loweringPlan: fixturePlan
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
    assert.match(
      await readFile(path.join(output, "derived-unit.c"), "utf8"),
      /#define CREATE_THIS_UNIT sh_export_deherm_typed_native\b/,
      "compiled unit must export the symbol consumed by the staged extension"
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
    assert.equal(report.stages.find(({ name }) => name === "link").status, "passed");
    assert.equal(report.evidenceBoundary.linkage, "observed: Bob/Extender linked the staged derived unit into Defold");
    assert.match(report.stages.find(({ name }) => name === "link").command.join(" "), /fake-java/);
    assert.ok(report.stages.find(({ name }) => name === "link").output.sha256);
    assert.equal(report.stages.find(({ name }) => name === "link").stagedProject.nativeArtifact.target, "arm64-osx");
    assert.ok(report.blockers.some(({ code }) => code === "application-not-requested"));
    assert.deepEqual(await readFile(authoredUnit), authoredBytes, "link staging mutated the authored project");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
