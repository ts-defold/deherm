import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const reportPath = new URL("packages/bindings/generated/defold-script-route-availability-profiles.json", root);

function run(args, options = {}) {
  return execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
}

function stableIds(profile) {
  return profile.availableRoutes.map(({ stableId }) => stableId);
}

test("availability profiles regenerate byte-identically from manifests and Lua registrations", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "deherm-route-profiles-"));
  try {
    run(["scripts/generate-script-route-availability-profiles.mjs", "--out-root", outputRoot]);
    const generated = await readFile(join(outputRoot, "packages/bindings/generated/defold-script-route-availability-profiles.json"), "utf8");
    assert.equal(generated, await readFile(reportPath, "utf8"));
    run(["scripts/generate-script-route-availability-profiles.mjs", "--check"]);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("the six pinned profiles are inferred from Defold manifests and cover full registered route sets", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const expected = {
    "default-legacy-bullet": [343, 343, ["core", "box2d-v2", "bullet3d"], 11],
    "v3-bullet": [419, 417, ["core", "box2d-v3", "bullet3d"], 13],
    "legacy-no-bullet": [171, 171, ["core", "box2d-v2"], 3],
    "v3-no-bullet": [247, 245, ["core", "box2d-v3"], 5],
    "bullet-only": [198, 198, ["core", "bullet3d"], 9],
    "no-physics": [26, 26, ["core"], 1]
  };
  for (const [id, [documentedCount, availableCount, features, bits]] of Object.entries(expected)) {
    const profile = report.profiles[id];
    assert.equal(profile.documentedRouteCount, documentedCount);
    assert.equal(profile.availableRouteCount, availableCount);
    assert.deepEqual(profile.features, features);
    assert.equal(profile.runtimeHandshake.capabilityBits, bits);
    assert.equal(new Set(stableIds(profile)).size, availableCount);
    assert.deepEqual(stableIds(profile), [...stableIds(profile)].sort((left, right) => left - right));
  }
  assert.deepEqual(Object.fromEntries(Object.entries(report.features).map(([id, feature]) =>
    [id, [feature.documentedRouteCount, feature.availableRouteCount]])), {
    core: [26, 26],
    "box2d-v2": [145, 145],
    "box2d-v3": [221, 219],
    bullet3d: [172, 172]
  });
  assert.deepEqual(Object.fromEntries(Object.entries(report.handleFeatures).map(([id, feature]) =>
    [id, [feature.documentedRouteCount, feature.availableRouteCount]])), {
    core: [9, 9],
    "box2d-v2": [124, 124],
    "box2d-v3": [189, 187],
    bullet3d: [139, 139]
  });
  const noPhysics = new Set(stableIds(report.profiles["no-physics"]));
  for (const profile of Object.values(report.profiles)) {
    assert([...noPhysics].every((stableId) => stableIds(profile).includes(stableId)));
  }
  const v2 = new Set(report.features["box2d-v2"].documentedRoutes.map(({ stableId }) => stableId));
  const v3 = new Set(report.features["box2d-v3"].documentedRoutes.map(({ stableId }) => stableId));
  assert.equal(new Set([...v2, ...v3]).size, 257);
  assert.deepEqual(report.features["box2d-v3"].unavailableRoutes.map(({ id }) => id), [
    "script:b2d.body.get_user_data",
    "script:b2d.body.set_user_data"
  ]);
  assert.deepEqual(Object.fromEntries(report.manifestAudit.map(({ id, features }) => [id, features])),
    Object.fromEntries(Object.entries(report.profiles).map(([id, profile]) => [id, profile.features])));
  assert(report.manifestAudit.find(({ id }) => id === "no-physics").linkedLibraries.includes("physics_null"));
  assert(report.manifestAudit.find(({ id }) => id === "v3-no-bullet").excludedLibraries.includes("BulletDynamics"));
  assert.deepEqual(report.manifestAudit.find(({ id }) => id === "bullet-only").features, ["core", "bullet3d"]);
  const v3Audit = report.registrationAudit.find(({ feature }) => feature === "box2d-v3");
  assert.equal(v3Audit.registeredFunctionCount, 233);
  assert.equal(v3Audit.registeredDocumentedRouteCount, 219);
  assert.equal(v3Audit.registrationOnlyRouteCount, 14);
  assert(v3Audit.registrationOnlyNames.every((rawName) => rawName.startsWith("b2d.shape.")));
});

test("runtime capability handshake contracts are complete generated material", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.handshakeContract.requiredFields, [
    "schema", "profileId", "defoldRevision", "capabilityBits", "routeCount", "routeSetSha256", "catalogSha256"
  ]);
  for (const [profileId, profile] of Object.entries(report.profiles)) {
    assert.deepEqual(Object.keys(profile.runtimeHandshake).sort(), [...report.handshakeContract.requiredFields].sort());
    assert.equal(profile.runtimeHandshake.schema, report.handshakeContract.schema);
    assert.equal(profile.runtimeHandshake.profileId, profileId);
    assert.equal(profile.runtimeHandshake.defoldRevision, report.defoldRevision);
    assert.equal(profile.runtimeHandshake.routeCount, profile.availableRouteCount);
    if (profileId === "no-physics") {
      assert.equal(profile.runtimeHandshake.routeSetSha256, report.features.core.availableRouteSetSha256,
        "no-physics handshake must be exactly the core route set");
    } else {
      assert.notEqual(profile.runtimeHandshake.routeSetSha256, report.features.core.availableRouteSetSha256);
    }
    assert.equal(profile.runtimeHandshake.catalogSha256, report.catalogSha256);
  }
});

test("source hash and census drift abort generation", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "deherm-route-profile-drift-"));
  try {
    const policy = await readFile(new URL("packages/bindings/overrides/script-route-availability-profiles.json", root), "utf8");
    const hashDriftPolicy = join(outputRoot, "hash-drift.json");
    await writeFile(hashDriftPolicy, policy.replace(/c898c4b8[a-f0-9]+/, "0".repeat(64)));
    assert.throws(() => run([
      "scripts/generate-script-route-availability-profiles.mjs", "--policy", hashDriftPolicy, "--out-root", outputRoot
    ]), /build evidence hash drifted/);

    const countDriftPolicy = join(outputRoot, "count-drift.json");
    await writeFile(countDriftPolicy, policy.replace('"box2d-v3": 187', '"box2d-v3": 188'));
    assert.throws(() => run([
      "scripts/generate-script-route-availability-profiles.mjs", "--policy", countDriftPolicy, "--out-root", outputRoot
    ]), /box2d-v3: expected 188 registered handle routes, found 187/);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
