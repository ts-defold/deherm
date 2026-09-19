import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { planNativeArtifactBuilds } from "../scripts/plan-native-artifact-builds.mjs";

function rows(plan) {
  return Object.values(plan.matrices).flatMap((matrix) => matrix.include);
}

test("an empty release schedules every publishable asset exactly once", async () => {
  const plan = await planNativeArtifactBuilds();
  const scheduled = rows(plan).map((row) => row.asset).sort();
  const expected = Object.values(plan.assets).flatMap((family) => family.expected).sort();

  assert.deepEqual(scheduled, expected);
  assert.equal(new Set(scheduled).size, scheduled.length, "a build asset is scheduled twice");
  assert.ok(Object.values(plan.any).every(Boolean), "every current lane has work in an empty release");
});

test("a complete release schedules no work", async () => {
  const initial = await planNativeArtifactBuilds();
  const present = Object.fromEntries(
    Object.entries(initial.assets).map(([family, value]) => [family, value.expected])
  );
  const plan = await planNativeArtifactBuilds(present);

  assert.deepEqual(rows(plan), []);
  assert.ok(Object.values(plan.any).every((value) => value === false));
  for (const family of Object.values(plan.assets)) assert.deepEqual(family.missing, []);
});

test("a partial release rebuilds only its missing matrix row", async () => {
  const initial = await planNativeArtifactBuilds();
  const missing = "hermes-arm64-android.tar.gz";
  const present = Object.fromEntries(
    Object.entries(initial.assets).map(([family, value]) => [
      family,
      value.expected.filter((asset) => asset !== missing)
    ])
  );
  const plan = await planNativeArtifactBuilds(present);

  assert.deepEqual(rows(plan).map((row) => row.asset), [missing]);
  assert.equal(plan.any.android, true);
  assert.ok(Object.entries(plan.any).every(([lane, value]) => lane === "android" || value === false));
  assert.deepEqual(plan.assets["native-artifacts"].missing, [missing]);
});

test("published fingerprint rows are immutable at the upload boundary", async () => {
  const uploader = await readFile("scripts/ci/upload-release-asset.sh", "utf8");
  assert.match(uploader, /if asset_exists; then[\s\S]*skipping upload/u);
  assert.doesNotMatch(uploader, /gh release upload[^\n]*--clobber/u);
});
