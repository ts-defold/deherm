import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateReleaseBuild, resolveReleaseSelection, selectedTargetArtifacts } from "../scripts/generate-release-build.mjs";

test("release selection defaults to the generated Defold project API profile", () => {
  const engineProfiles = {
    defaultProfileId: "v3-no-bullet",
    platforms: { "arm64-ios": "v3-no-bullet", "wasm-web": "bullet-only" }
  };
  assert.deepEqual(resolveReleaseSelection(engineProfiles), {
    profile: "v3-no-bullet",
    target: "dynamicHermesJsi"
  });
  assert.deepEqual(resolveReleaseSelection(engineProfiles, { platform: "wasm-web" }), {
    profile: "bullet-only",
    target: "browserWasmHost"
  });
  assert.throws(() => resolveReleaseSelection(engineProfiles, { platform: "x86_64-linux" }), /no API profile/);
});

test("release generation is keyed, idempotent, and emits the canonical dynamic family projection", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "deherm-release-build-"));
  const output = join(temporary, "release");
  try {
    const first = await generateReleaseBuild(["--output-root", output]);
    assert.equal(first.action, "generated");
    assert.equal(first.projection.generatedModules.status, "source-content-pruned");
    assert.equal(first.projection.canonicalDefoldApi.status, "family-source-emitted");
    assert.ok(first.projection.canonicalDefoldApi.generatedRoutes > 0);
    assert.equal(first.projection.evidenceBoundary.canonicalLinkPruning, "generated-glue-cmake-consumer-available");
    assert.equal(first.projection.evidenceBoundary.canonicalImplementationObjectPruning, "not-claimed-existing-family-objects-remain-coarse-grained");
    const sentinelPath = join(output, "release-build.sentinel.json");
    const before = await stat(sentinelPath);
    const second = await generateReleaseBuild(["--output-root", output, "--check"]);
    const after = await stat(sentinelPath);
    assert.equal(second.action, "current");
    assert.equal(second.cacheKey, first.cacheKey);
    assert.equal(after.mtimeMs, before.mtimeMs);
    const native = selectedTargetArtifacts("dynamicHermesJsi");
    const wasm = selectedTargetArtifacts("browserWasmHost");
    assert.ok(native.includes("defold/defold_hermes/src/generated_jsi.cpp"));
    assert.ok(!native.includes("defold/defold_hermes/lib/web/generated_modules.js"));
    assert.ok(wasm.includes("defold/defold_hermes/lib/web/generated_modules.js"));
    assert.ok(!wasm.includes("defold/defold_hermes/src/generated_jsi.cpp"));
    const header = await readFile(join(output, "defold/defold_hermes/include/defold_hermes/generated_modules.h"), "utf8");
    assert.match(header, /defold_hermes_example_math_add/);
    assert.doesNotMatch(header, /defold_hermes_example_math_multiply/);
    const canonicalManifest = JSON.parse(await readFile(join(output, "canonical/dynamicHermesJsi/manifest.json"), "utf8"));
    const canonicalRequirements = JSON.parse(await readFile(join(output, "canonical/dynamicHermesJsi/requirements.json"), "utf8"));
    assert.equal(canonicalManifest.routeCount, first.projection.canonicalDefoldApi.generatedRoutes);
    assert.equal(canonicalManifest.groupCount, first.projection.canonicalDefoldApi.generatedGroups);
    assert.equal(canonicalRequirements.status, "authority-satisfied-for-selected-script-units");
    assert.ok(canonicalManifest.groups.every((group) => group.routeCount > 0));
    const tampered = `${header.startsWith("/") ? "!" : "/"}${header.slice(1)}`;
    assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(header));
    await writeFile(join(output, "defold/defold_hermes/include/defold_hermes/generated_modules.h"), tampered);
    await assert.rejects(
      generateReleaseBuild(["--output-root", output, "--check"]),
      /does not match its sentinel/
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release generation emits exact canonical authority for Static Hermes and browser targets", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "deherm-release-blocked-targets-"));
  try {
    for (const target of ["staticHermesCAbi", "browserWasmHost"]) {
      const output = join(temporary, target);
      const result = await generateReleaseBuild(["--output-root", output, "--target", target]);
      assert.equal(result.projection.canonicalDefoldApi.status, "family-source-emitted");
      assert.ok(result.projection.canonicalDefoldApi.generatedRoutes > 0);
      const requirements = JSON.parse(await readFile(join(output, `canonical/${target}/requirements.json`), "utf8"));
      const manifest = JSON.parse(await readFile(join(output, `canonical/${target}/manifest.json`), "utf8"));
      assert.equal(requirements.status, "authority-satisfied-for-selected-script-units");
      assert.equal(manifest.routeCount, result.projection.canonicalDefoldApi.generatedRoutes);
      assert.ok(Object.keys(requirements.selectionCounts).length > 0);
      assert.equal(requirements.requiredAuthorityForAdditionalUnits.backendSelection, "emit");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release projection consumes compiler component reachability without native wrappers", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "deherm-release-components-"));
  const usagePath = join(temporary, "components.usage.json");
  const output = join(temporary, "release");
  const usage = {
    schemaVersion: 1,
    registry: "__defoldComponentsV1",
    componentOnlyBootstrap: true,
    components: [
      { componentId: "deherm.component/v1/b", source: "b.gui.ts", contextKind: "gui-scene", schemaFingerprint: "b".repeat(64) },
      { componentId: "deherm.component/v1/a", source: "a.script.ts", contextKind: "game-object", schemaFingerprint: "a".repeat(64) }
    ]
  };
  try {
    await writeFile(usagePath, `${JSON.stringify(usage)}\n`);
    const result = await generateReleaseBuild([
      "--output-root", output,
      "--component-usage", usagePath
    ]);
    assert.equal(result.projection.components.status, "compiler-registry-bundle-reachable");
    assert.deepEqual(result.projection.components.reachableComponentIds, [
      "deherm.component/v1/a", "deherm.component/v1/b"
    ]);
    assert.match(result.projection.components.evidence, /no per-component native wrapper/);
    assert.deepEqual(
      JSON.parse(await readFile(join(output, "component-reachability.json"), "utf8")),
      usage
    );
    await generateReleaseBuild([
      "--output-root", output,
      "--component-usage", usagePath,
      "--check"
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
