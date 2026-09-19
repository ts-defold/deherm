import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  describeBuildRow,
  githubOutputRecords,
  planNativeArtifactBuilds
} from "../scripts/plan-native-artifact-builds.mjs";

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
  const outputs = githubOutputRecords(plan);
  assert.equal(outputs.build_any, "false");
  for (const lane of Object.keys(plan.matrices)) assert.deepEqual(JSON.parse(outputs[`${lane}_rows`]), []);
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

test("GitHub job outputs carry numeric slots rather than secret-scanned row data", async () => {
  const plan = await planNativeArtifactBuilds();
  const outputs = githubOutputRecords(plan);

  for (const lane of Object.keys(plan.matrices)) {
    const value = outputs[`${lane}_rows`];
    assert.ok(value, `${lane} has no numeric row output`);
    assert.ok(JSON.parse(value).every(Number.isInteger), `${lane} emitted a non-integer slot`);
    assert.doesNotMatch(value, /(?:asset|target|host|runner|\.tar\.gz)/u);
  }
  assert.equal(outputs.linux_any, "true");
});

test("numeric slots resolve back to the canonical build row", async () => {
  const plan = await planNativeArtifactBuilds();

  assert.deepEqual(describeBuildRow(plan, "linux=1"), {
    slot: 1,
    runner: "ubuntu-24.04-arm",
    docker_platform: "linux/arm64",
    target: "arm64-linux",
    asset: "hermes-arm64-linux.tar.gz"
  });
  assert.deepEqual(describeBuildRow(plan, "android=0"), {
    slot: 0,
    abi: "armeabi-v7a",
    api_kind: "android_ndk_api",
    target: "armv7-android",
    asset: "hermes-armv7-android.tar.gz"
  });
  assert.deepEqual(describeBuildRow(plan, "hermes_host=4"), {
    slot: 4,
    runner: "windows-2022",
    host: "win32-x64",
    asset: "hermes-host-win32-x64.tar.gz"
  });
  assert.throws(() => describeBuildRow(plan, "android=9"), /has no slot 9/u);
});

test("pre-checkout runner slot maps agree with the planner", async () => {
  const plan = await planNativeArtifactBuilds();
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");
  const runners = (lane) => plan.matrices[lane].include
    .toSorted((left, right) => left.slot - right.slot)
    .map((row) => row.runner);

  assert.deepEqual(runners("linux"), ["ubuntu-24.04", "ubuntu-24.04-arm"]);
  assert.deepEqual(runners("hermes_host"), [
    "macos-15",
    "macos-15-intel",
    "ubuntu-22.04",
    "ubuntu-22.04-arm",
    "windows-2022"
  ]);
  assert.match(workflow, /fromJSON\('\["ubuntu-24\.04","ubuntu-24\.04-arm"\]'\)\[matrix\.row\]/u);
  assert.match(workflow, /fromJSON\('\["macos-15","macos-15-intel","ubuntu-22\.04","ubuntu-22\.04-arm","windows-2022"\]'\)\[matrix\.row\]/u);
});
