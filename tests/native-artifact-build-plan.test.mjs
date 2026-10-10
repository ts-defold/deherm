import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertNativeArtifactPlanCoverage,
  describeBuildRow,
  githubOutputRecords,
  planNativeArtifactBuilds,
} from "../scripts/plan-native-artifact-builds.mjs";
import { assertReleaseTagsCurrent, buildReleaseTags } from "../scripts/generate-release-tags.mjs";

function rows(plan) {
  return Object.values(plan.matrices).flatMap((matrix) => matrix.include);
}

test("an empty release schedules every publishable asset exactly once", async () => {
  const plan = await planNativeArtifactBuilds();
  const scheduled = rows(plan)
    .map((row) => row.asset)
    .sort();
  const expected = Object.values(plan.assets)
    .flatMap((family) => family.expected)
    .filter((asset) => !asset.endsWith(".integrity.json"))
    .sort();

  assert.deepEqual(scheduled, expected);
  assert.equal(new Set(scheduled).size, scheduled.length, "a build asset is scheduled twice");
  assert.ok(Object.values(plan.any).every(Boolean), "every current lane has work in an empty release");
});

test("a complete release schedules no work", async () => {
  const initial = await planNativeArtifactBuilds();
  const present = Object.fromEntries(Object.entries(initial.assets).map(([family, value]) => [family, value.expected]));
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
      value.expected.filter((asset) => asset !== missing),
    ]),
  );
  const plan = await planNativeArtifactBuilds(present);

  assert.deepEqual(
    rows(plan).map((row) => row.asset),
    [missing],
  );
  assert.equal(plan.any.android, true);
  assert.ok(Object.entries(plan.any).every(([lane, value]) => lane === "android" || value === false));
  assert.deepEqual(plan.assets["native-artifacts"].missing, [missing]);
});

test("a row whose archive exists without its publisher integrity document is rebuilt", async () => {
  const initial = await planNativeArtifactBuilds();
  const sidecar = "hermes-arm64-android.tar.gz.integrity.json";
  const present = Object.fromEntries(
    Object.entries(initial.assets).map(([family, value]) => [
      family,
      value.expected.filter((asset) => asset !== sidecar),
    ]),
  );
  const plan = await planNativeArtifactBuilds(present);
  assert.deepEqual(
    rows(plan).map((row) => row.asset),
    ["hermes-arm64-android.tar.gz"],
  );
  assert.deepEqual(plan.assets["native-artifacts"].missing, [sidecar]);
});

test("recipe releases schedule only rows missing from that immutable tag", async () => {
  const initial = await planNativeArtifactBuilds();
  const present = {
    "hermes-host": initial.assets["hermes-host"].expected,
    dehermc: initial.assets.dehermc.expected,
  };
  for (const [key, release] of Object.entries(initial.releases)) present[key] = release.expected;
  present["native-artifacts/windows"] = [];
  const windows = await planNativeArtifactBuilds(present);
  assert.deepEqual(
    rows(windows).map((row) => row.target),
    ["x86_64-win32"],
  );

  present["native-artifacts/windows"] = initial.releases["native-artifacts/windows"].expected;
  present["native-artifacts/linux"] = [];
  const linux = await planNativeArtifactBuilds(present);
  assert.deepEqual(
    rows(linux)
      .map((row) => row.target)
      .sort(),
    ["arm64-linux", "x86_64-linux"],
  );
});

test("published fingerprint rows are immutable at the upload boundary", async () => {
  const uploader = await readFile("scripts/ci/upload-release-asset.sh", "utf8");
  assert.match(uploader, /if asset_exists "\$candidate"; then[\s\S]*skipping upload/u);
  assert.doesNotMatch(uploader, /gh release upload[^\n]*--clobber/u);
});

test("complete artifact publication refreshes policy before consumer proof", async () => {
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");
  const final = workflow.slice(workflow.indexOf("  summary:"));
  const completeness = final.indexOf("Verify every fingerprinted row is published");
  const releaseLock = final.indexOf("Regenerate and verify the published release lock");
  const regenerate = final.indexOf("generate-release-tags.mjs --published");
  const reverify = final.indexOf("generate-release-tags.mjs --check --published");
  const preserved = final.indexOf("name: published-release-tags");
  const policy = final.indexOf("gh workflow run policy.yml");
  assert.ok(completeness >= 0);
  assert.ok(releaseLock > completeness, "release-lock derivation must follow release completeness");
  assert.ok(regenerate > releaseLock, "the published lock must be regenerated before checking it");
  assert.ok(reverify > regenerate, "the regenerated lock must be re-verified against published sidecars");
  assert.ok(preserved > reverify && policy > preserved, "only a verified, preserved lock may precede policy refresh");
  assert.match(final, /if: inputs\.policy_run_id == ''[\s\S]*generate-release-tags\.mjs --check --published/u);
  assert.match(final, /-f artifact_refresh_only=true/u);
  assert.doesNotMatch(final, /gh workflow run end-to-end\.yml/u);
});

test("target publication is not circularly gated by the package host-tool lock", async () => {
  const [workflow, generator, policy] = await Promise.all([
    readFile(".github/workflows/native-artifacts.yml", "utf8"),
    readFile("scripts/generate-release-tags.mjs", "utf8"),
    readFile(".github/workflows/policy.yml", "utf8"),
  ]);
  const lock = await buildReleaseTags();
  assert.deepEqual(Object.keys(lock.families).sort(), ["dehermc", "hermes-host"]);
  assert.match(generator, /families: \["hermes-host", "dehermc"\]/u);
  assert.match(
    workflow,
    /Verify every fingerprinted row is published[\s\S]*generate-release-tags\.mjs --check --published/u,
  );
  assert.match(workflow, /generate-release-tags\.mjs --check --published[\s\S]*gh workflow run policy\.yml/u);
  assert.match(policy, /publish-site:[\s\S]*dispatch-end-to-end/u);
  assert.match(policy, /dispatch-end-to-end:[\s\S]*needs: consumer-smoke/u);
});

test("authenticated release-lock verification rejects a complete but stale sidecar digest", async () => {
  const expected = JSON.parse(await readFile("packages/toolchains/release-tags.json", "utf8"));
  const stale = structuredClone(expected);
  stale.families["hermes-host"].integrity["darwin-arm64"].sha256 = "0".repeat(64);
  assert.doesNotThrow(() => assertReleaseTagsCurrent(expected, expected, { authenticated: true }));
  assert.throws(
    () => assertReleaseTagsCurrent(stale, expected, { authenticated: true }),
    /release-tags\.json is stale/u,
  );
  // Offline checks lack publisher sidecars and intentionally verify only
  // coordinates plus a complete local integrity shape.
  assert.doesNotThrow(() => assertReleaseTagsCurrent(stale, expected));
});

test("policy-derived SDK compatibility inputs flow through every target artifact job", async () => {
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");
  assert.match(workflow, /policy_run_id:[\s\S]*Download policy-derived artifact inputs/u);
  assert.match(workflow, /run-id: \$\{\{ inputs\.policy_run_id \}\}/u);
  assert.match(
    workflow,
    /policy-surface\.mjs extract[\s\S]*--path packages\/toolchains\/defold-bundle-targets\.json[\s\S]*name: native-artifact-inputs/u,
  );
  const installs = workflow.match(/name: native-artifact-inputs\s+path: \./gu) ?? [];
  assert.equal(installs.length, 6, "five target builders and the completeness summary must install derived inputs");
});

test("every dehermc row is authenticated and the Linux artifact is consumed before upload", async () => {
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");
  const packageSmoke = await readFile("tests/package-smoke.test.mjs", "utf8");
  const job = workflow.slice(workflow.indexOf("  go-compiler:"), workflow.indexOf("  # ── Target libraries"));
  const verify = job.indexOf('manage-host-compilers.mjs verify-file "$HOST" dehermc');
  const smoke = job.indexOf("DEHERM_PACKAGE_SMOKE_DEHERMC_ARCHIVE=");
  const upload = job.indexOf("upload-release-asset.sh");
  assert.ok(verify >= 0, "the producer never compares its binary with host-compilers.json");
  assert.ok(smoke > verify, "the package smoke must consume only an authenticated artifact");
  assert.ok(upload > smoke, "the consumer smoke must finish before the release asset is published");
  assert.match(job, /--test-name-pattern "packed npm artifact" tests\/package-smoke\.test\.mjs/u);
  assert.doesNotMatch(job.slice(smoke, upload), /build-dehermc\.sh/u);
  assert.doesNotMatch(
    packageSmoke,
    /build-dehermc\.sh/u,
    "a consumer smoke must not produce a substitute compiler artifact",
  );
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
    asset: "hermes-arm64-linux.tar.gz",
    recipe: "linux",
    release_key: "native-artifacts/linux",
    release_tag: plan.releases["native-artifacts/linux"].tag,
    release_fingerprint: plan.releases["native-artifacts/linux"].fingerprint,
    release_title: plan.releases["native-artifacts/linux"].title,
  });
  assert.deepEqual(describeBuildRow(plan, "android=0"), {
    slot: 0,
    abi: "armeabi-v7a",
    api_kind: "android_ndk_api",
    target: "armv7-android",
    asset: "hermes-armv7-android.tar.gz",
    recipe: "android",
    release_key: "native-artifacts/android",
    release_tag: plan.releases["native-artifacts/android"].tag,
    release_fingerprint: plan.releases["native-artifacts/android"].fingerprint,
    release_title: plan.releases["native-artifacts/android"].title,
  });
  assert.deepEqual(describeBuildRow(plan, "hermes_host=4"), {
    slot: 4,
    runner: "windows-2022",
    host: "win32-x64",
    asset: "hermes-host-win32-x64.tar.gz",
  });
  assert.throws(() => describeBuildRow(plan, "android=9"), /has no slot 9/u);
});

test("planner refuses a derived target omitted from the recipe index", () => {
  assert.throws(
    () => assertNativeArtifactPlanCoverage([{ target: "mystery-console", asset: "hermes-mystery-console.tar.gz" }]),
    /No native-artifact executor is declared/u,
  );
});

test("planner rejects an asset listing attributed to the wrong immutable tag", async () => {
  const initial = await planNativeArtifactBuilds();
  await assert.rejects(
    planNativeArtifactBuilds({
      "native-artifacts/linux": {
        tag: "libs-linux-wrong",
        assets: initial.releases["native-artifacts/linux"].expected,
      },
    }),
    /Published-asset index mismatch for native-artifacts\/linux/u,
  );
});

test("pre-install row resolution does not import the archive verifier", async () => {
  const [planner, releases, naming] = await Promise.all([
    readFile("scripts/plan-native-artifact-builds.mjs", "utf8"),
    readFile("scripts/lib/artifact-releases.mjs", "utf8"),
    readFile("packages/cli/src/release-integrity-name.mjs", "utf8"),
  ]);
  assert.match(planner, /release-integrity-name\.mjs/u);
  assert.match(releases, /release-integrity-name\.mjs/u);
  assert.doesNotMatch(planner, /from ["'][^"']*release-integrity\.mjs["']/u);
  assert.doesNotMatch(releases, /from ["'][^"']*release-integrity\.mjs["']/u);
  assert.doesNotMatch(naming, /from ["'](?:fflate|yaml|semver)["']/u);
});

test("pre-checkout runner slot maps agree with the planner", async () => {
  const plan = await planNativeArtifactBuilds();
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");
  const runners = (lane) =>
    plan.matrices[lane].include.toSorted((left, right) => left.slot - right.slot).map((row) => row.runner);

  assert.deepEqual(runners("linux"), ["ubuntu-24.04", "ubuntu-24.04-arm"]);
  assert.deepEqual(runners("hermes_host"), [
    "macos-15",
    "macos-15-intel",
    "ubuntu-22.04",
    "ubuntu-22.04-arm",
    "windows-2022",
  ]);
  assert.match(workflow, /fromJSON\('\["ubuntu-24\.04","ubuntu-24\.04-arm"\]'\)\[matrix\.row\]/u);
  assert.match(
    workflow,
    /fromJSON\('\["macos-15","macos-15-intel","ubuntu-22\.04","ubuntu-22\.04-arm","windows-2022"\]'\)\[matrix\.row\]/u,
  );
});

test("release publication uses authoritative platform inputs", async () => {
  const workflow = await readFile(".github/workflows/native-artifacts.yml", "utf8");

  assert.match(workflow, /push:\s+branches: \[main\]/u);
  assert.match(workflow, /--build-arg "ANDROID_ABI=\$ABI"/u);
  assert.doesNotMatch(workflow, /ANDROID_ABI=\$ANDROID_ABI/u);
  assert.match(
    workflow,
    /windows:[\s\S]*?if: needs\.plan\.outputs\.windows_any == 'true' && needs\.plan\.outputs\.registry_credential == 'true'/u,
  );
  assert.match(
    workflow,
    /windows-native:[\s\S]*?if: needs\.plan\.outputs\.windows_any == 'true' && needs\.plan\.outputs\.registry_credential != 'true'/u,
  );
  assert.doesNotMatch(workflow, /windows:[\s\S]*?continue-on-error: true/u);
  assert.match(workflow, /--list-releases/u);
  assert.match(workflow, /native_args\+=\(--present "\$release_key@\$tag=\$destination"\)/u);
  assert.match(workflow, /upload-release-asset\.sh[\s\S]*?"\$RELEASE_TAG"/u);
  assert.doesNotMatch(workflow, /needs\.plan\.outputs\.target_tag/u);
});

test("the Apple archive stages Hermes' configured header from the CMake build root", async () => {
  const builder = await readFile("toolchains/hermes/build-apple.sh", "utf8");
  const rootCmake = await readFile("upstream/hermes/CMakeLists.txt", "utf8");
  const libraryCmake = await readFile("upstream/hermes/lib/CMakeLists.txt", "utf8");

  assert.match(rootCmake, /add_subdirectory\(lib\)/u);
  assert.match(libraryCmake, /configure_file\(config\/libhermesvm-config\.h\.in config\/libhermesvm-config\.h\)/u);
  assert.match(builder, /cp "\$cross_build\/lib\/config\/libhermesvm-config\.h" "\$staging\/libhermesvm-config\.h"/u);
  assert.doesNotMatch(builder, /\$cross_build\/hermes\/lib\/config\/libhermesvm-config\.h/u);
});

test("every native builder stages Hermes' configured header from the CMake build root", async () => {
  const builders = await Promise.all(
    [
      "toolchains/hermes/Dockerfile.linux",
      "toolchains/hermes/Dockerfile.android",
      "toolchains/hermes/Dockerfile.win32",
      "toolchains/hermes/build-windows.sh",
    ].map(async (file) => [file, await readFile(file, "utf8")]),
  );

  for (const [file, builder] of builders) {
    assert.doesNotMatch(
      builder,
      /(?:\/work\/build|\$work)\/hermes\/lib\/config\/libhermesvm-config\.h/u,
      `${file} must not treat the Hermes source directory as the CMake build root`,
    );
    assert.match(
      builder,
      file.endsWith("build-windows.sh")
        ? /\$work\/lib\/config\/libhermesvm-config\.h/u
        : /\/work\/build\/lib\/config\/libhermesvm-config\.h/u,
      `${file} must package the configured header emitted under <build>/lib/config`,
    );
  }
});
