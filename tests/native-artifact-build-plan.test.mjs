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

test("complete artifact publication refreshes both consumer proof and policy mappings", async () => {
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");
  const final = workflow.slice(workflow.indexOf("  summary:"));
  const completeness = final.indexOf("Verify every fingerprinted row is published");
  const endToEnd = final.indexOf("gh workflow run end-to-end.yml");
  const policy = final.indexOf("gh workflow run policy.yml");
  assert.ok(completeness >= 0);
  assert.ok(endToEnd > completeness, "consumer proof must follow release completeness");
  assert.ok(policy > completeness, "policy artifact mappings must refresh only after release completeness");
});

test("every dehermc row is authenticated and the Linux artifact is consumed before upload", async () => {
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");
  const packageSmoke = await readFile("tests/package-smoke.test.mjs", "utf8");
  const job = workflow.slice(workflow.indexOf("  go-compiler:"), workflow.indexOf("  # ── Target libraries"));
  const verify = job.indexOf("manage-host-compilers.mjs verify-file \"$HOST\" dehermc");
  const smoke = job.indexOf("DEHERM_PACKAGE_SMOKE_DEHERMC_ARCHIVE=");
  const upload = job.indexOf("upload-release-asset.sh");
  assert.ok(verify >= 0, "the producer never compares its binary with host-compilers.json");
  assert.ok(smoke > verify, "the package smoke must consume only an authenticated artifact");
  assert.ok(upload > smoke, "the consumer smoke must finish before the release asset is published");
  assert.match(job, /--test-name-pattern "packed npm artifact" tests\/package-smoke\.test\.mjs/u);
  assert.doesNotMatch(job.slice(smoke, upload), /build-dehermc\.sh/u);
  assert.doesNotMatch(packageSmoke, /build-dehermc\.sh/u,
    "a consumer smoke must not produce a substitute compiler artifact");
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

test("release publication uses authoritative platform inputs", async () => {
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");

  assert.match(workflow, /push:\s+branches: \[main\]/u);
  assert.match(workflow, /--build-arg "ANDROID_ABI=\$ABI"/u);
  assert.doesNotMatch(workflow, /ANDROID_ABI=\$ANDROID_ABI/u);
  assert.match(
    workflow,
    /windows:[\s\S]*?if: needs\.plan\.outputs\.windows_any == 'true' && needs\.plan\.outputs\.registry_credential == 'true'/u
  );
  assert.match(
    workflow,
    /windows-native:[\s\S]*?if: needs\.plan\.outputs\.windows_any == 'true' && needs\.plan\.outputs\.registry_credential != 'true'/u
  );
  assert.doesNotMatch(workflow, /windows:[\s\S]*?continue-on-error: true/u);
});

test("the Apple archive stages Hermes' configured header from the CMake build root", async () => {
  const builder = await readFile("toolchains/hermes/build-apple.sh", "utf8");
  const rootCmake = await readFile("upstream/hermes/CMakeLists.txt", "utf8");
  const libraryCmake = await readFile("upstream/hermes/lib/CMakeLists.txt", "utf8");

  assert.match(rootCmake, /add_subdirectory\(lib\)/u);
  assert.match(
    libraryCmake,
    /configure_file\(config\/libhermesvm-config\.h\.in config\/libhermesvm-config\.h\)/u
  );
  assert.match(
    builder,
    /cp "\$cross_build\/lib\/config\/libhermesvm-config\.h" "\$staging\/libhermesvm-config\.h"/u
  );
  assert.doesNotMatch(builder, /\$cross_build\/hermes\/lib\/config\/libhermesvm-config\.h/u);
});
