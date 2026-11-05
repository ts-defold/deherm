import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
  fingerprintNativeArtifactRecipe,
  nativeArtifactRecipeForTarget,
  nativeArtifactRecipes,
  nativeArtifactRelease,
} from "../scripts/lib/artifact-releases.mjs";
import { buildArtifactReferences } from "../packages/generator/src/policy/artifact-references.mjs";
import { RELEASE_INTEGRITY_KIND } from "../packages/cli/src/release-integrity.mjs";
import { artifactAssetRows } from "../scripts/project-artifact-references.mjs";
import { selectArtifactReferencesForRevision } from "../scripts/build-policy-site.mjs";
import { collectPolicyNativeArtifactInputs } from "../scripts/policy-native-artifact-inputs.mjs";
import { assertNativeArtifactReconciliationHealth } from "../scripts/check-policy-native-artifact-health.mjs";
import {
  githubReleaseAssets,
  inspectPolicyNativeReleaseMapping,
  isUnsupportedNativeRecipe,
  reconcilePolicyNativeArtifactMappings,
  releaseLookupWasNotFound,
} from "../scripts/reconcile-policy-native-artifacts.mjs";
import { readStore, storeRoot } from "../scripts/generate-api-policy.mjs";

const repository = "ts-defold/deherm";

test("artifact health workflow runs without installed packages and preserves failing exits", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "deherm-artifact-health-cli-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workflow = YAML.parse(await readFile(".github/workflows/policy.yml", "utf8"));
  const step = workflow.jobs["native-artifact-reconciliation-health"].steps.find((row) =>
    row.run?.includes("native-health.json"),
  );
  const command =
    /^node (scripts\/[\w-]+\.mjs)( --assert-health)? "\$RUNNER_TEMP\/native-artifact-health\/native-health.json"$/u.exec(
      step?.run ?? "",
    );
  assert.ok(command, "exercise the actual health workflow entrypoint and its report argument");
  const executable = path.join(directory, command[1]);
  await mkdir(path.dirname(executable), { recursive: true });
  await copyFile(command[1], executable);
  const report = path.join(directory, "native-health.json");
  const cases = [
    { name: "clean", value: { failures: [], unsupported: [] }, status: 0, output: /health is clean/u },
    {
      name: "unsupported optimization",
      value: { failures: [], unsupported: [{ compatibilitySha256: "a".repeat(64), message: "new target" }] },
      status: 0,
      output: /::notice::Native optimization is unsupported/u,
    },
    {
      name: "inventory failure",
      value: { failures: [{ compatibilitySha256: "a".repeat(64), message: "HTTP 403" }], unsupported: [] },
      status: 1,
      output: /1 native-artifact reconciliation failure.*HTTP 403/u,
    },
    { name: "missing failure collection", value: { unsupported: [] }, status: 1, output: /report is malformed/u },
    {
      name: "invalid failure collection",
      value: { failures: {}, unsupported: [] },
      status: 1,
      output: /report is malformed/u,
    },
    { name: "null report", value: null, status: 1, output: /report is malformed/u },
    { name: "invalid JSON", text: "{", status: 1, output: /SyntaxError/u },
  ];
  for (const fixture of cases) {
    await writeFile(report, fixture.text ?? JSON.stringify(fixture.value));
    const result = spawnSync(process.execPath, [executable, ...(command[2] ? ["--assert-health"] : []), report], {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined, fixture.name);
    assert.equal(result.status, fixture.status, `${fixture.name}: ${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, fixture.output, fixture.name);
  }
});

async function bundleTargetsFixture() {
  return JSON.parse(await readFile("packages/toolchains/defold-bundle-targets.json", "utf8"));
}

function withFixtureIntegrity(references) {
  const complete = structuredClone(references);
  for (const family of Object.values(complete)) {
    family.integrity = Object.fromEntries(
      Object.entries(family.assets).map(([key, asset]) => [
        key,
        {
          asset: `${asset}.integrity.json`,
          sha256: "a".repeat(64),
          archiveSha256: "b".repeat(64),
          archiveBytes: 7,
        },
      ]),
    );
  }
  return complete;
}

function inputFor(references, bundleTargets, revision = "c".repeat(40)) {
  return {
    schemaVersion: 1,
    kind: "deherm.policy-native-artifact-input",
    defoldRevision: revision,
    revisions: [revision],
    compatibility: references["native-artifacts"].compatibility,
    bundleTargets,
  };
}

function workItem(input, revision = input.defoldRevision) {
  return { defoldRevision: revision, compatibility: input.compatibility };
}

function withOldNativeReleaseTags(references) {
  const old = structuredClone(references);
  const native = old["native-artifacts"];
  if (native.releases) {
    for (const release of Object.values(native.releases)) {
      release.tag = `libs-${release.recipe}-previous-${release.fingerprint.slice(0, 12)}`;
    }
  } else {
    native.tag = `libs-previous-${native.fingerprint.slice(0, 12)}`;
  }
  return old;
}

function withOldHostReleaseTag(references) {
  const old = structuredClone(references);
  old["hermes-host"].tag = `hermes-host-previous-${old["hermes-host"].fingerprint.slice(0, 12)}`;
  return old;
}

function summarizeMappings(mappings) {
  return mappings.map((references) => {
    const native = references["native-artifacts"];
    const nativeTags = native.releases
      ? Object.fromEntries(Object.entries(native.releases).map(([target, release]) => [target, release.tag]))
      : Object.fromEntries(Object.keys(native.assets).map((target) => [target, native.tag]));
    return { compatibility: native.compatibility.sha256, nativeTags };
  });
}

async function makeReleaseSource(references, options = {}, t) {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-native-sidecars-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inventory = new Map();
  for (const row of artifactAssetRows(references, { includeIntegrity: true })) {
    if (options.omit?.(row)) continue;
    let assets = inventory.get(row.tag);
    if (!assets) {
      assets = new Set();
      inventory.set(row.tag, assets);
    }
    assets.add(row.asset);
  }

  const sidecars = new Map();
  for (const [familyName, family] of Object.entries(references)) {
    for (const [key, asset] of Object.entries(family.assets)) {
      const release = familyName === "native-artifacts" ? (family.releases?.[key] ?? family) : family;
      sidecars.set(`${familyName}/${asset}.integrity.json`, {
        schemaVersion: 1,
        kind: RELEASE_INTEGRITY_KIND,
        family: familyName,
        tag: release.tag,
        fingerprint: release.fingerprint,
        asset,
        archive: { bytes: 7, sha256: "c".repeat(64) },
        members: (family.contents[key] ?? []).map((name) => ({
          name,
          bytes: 1,
          sha256: "d".repeat(64),
        })),
      });
    }
  }

  return {
    directory,
    integrityRoot: path.join(directory, "integrity"),
    async listAssets(tag) {
      if (options.listError) throw options.listError;
      return inventory.get(tag) ?? new Set();
    },
    async downloadSidecar({ family, asset, integrityRoot }) {
      const filename = path.join(integrityRoot, family, asset);
      await mkdir(path.dirname(filename), { recursive: true });
      const sidecar = sidecars.get(`${family}/${asset}`);
      const value = options.corruptSidecar
        ? "{ not valid JSON"
        : options.invalidSidecarSchema
          ? { ...sidecar, schemaVersion: 99 }
          : sidecar;
      assert.ok(value, `no sidecar fixture for ${family}/${asset}`);
      await writeFile(filename, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    },
  };
}

async function completeReferences(bundleTargets) {
  return withFixtureIntegrity(await buildArtifactReferences({ bundleTargets }));
}

test("two compatibility mappings merge after reverse completion and duplicate work deduplicates", async () => {
  const originalTargets = await bundleTargetsFixture();
  const alternateTargets = structuredClone(originalTargets);
  alternateTargets.sdk.androidNdkVersion = "alternate-fixture-ndk";
  const [mappingA, mappingB] = await Promise.all([
    completeReferences(originalTargets),
    completeReferences(alternateTargets),
  ]);
  const inputA = inputFor(mappingA, originalTargets, "a".repeat(40));
  const inputB = inputFor(mappingB, alternateTargets, "b".repeat(40));
  assert.notEqual(inputA.compatibility.sha256, inputB.compatibility.sha256);
  const staleA = withOldNativeReleaseTags(mappingA);
  const staleB = withOldNativeReleaseTags(mappingB);

  const completedBFirst = reconcilePolicyNativeArtifactMappings({
    inputs: [inputA, inputB],
    artifactHistory: [staleA, staleB],
    completedMappings: [mappingB],
    workItems: [workItem(inputA), workItem(inputA, "d".repeat(40)), workItem(inputB)],
  });
  const completedASecond = reconcilePolicyNativeArtifactMappings({
    inputs: [inputA, inputB],
    artifactHistory: completedBFirst.artifactHistory,
    completedMappings: [mappingA],
    workItems: [],
  });

  const completedAFirst = reconcilePolicyNativeArtifactMappings({
    inputs: [inputA, inputB],
    artifactHistory: [staleA, staleB],
    completedMappings: [mappingA],
    workItems: [workItem(inputA), workItem(inputA, "d".repeat(40)), workItem(inputB)],
  });
  const completedBSecond = reconcilePolicyNativeArtifactMappings({
    inputs: [inputA, inputB],
    artifactHistory: completedAFirst.artifactHistory,
    completedMappings: [mappingB],
    workItems: [],
  });

  assert.deepEqual(
    completedASecond.artifactHistory.map((references) => references["native-artifacts"].compatibility.sha256),
    [inputA.compatibility.sha256, inputB.compatibility.sha256].sort(),
  );
  assert.deepEqual(
    summarizeMappings(completedASecond.artifactHistory),
    summarizeMappings(completedBSecond.artifactHistory),
  );
  assert.deepEqual(
    summarizeMappings([
      selectArtifactReferencesForRevision(mappingA, completedASecond.artifactHistory, inputB.compatibility),
      selectArtifactReferencesForRevision(mappingB, completedBSecond.artifactHistory, inputA.compatibility),
    ]),
    summarizeMappings([mappingB, mappingA]),
    "publication must select each newly completed map over stale same-compatibility history",
  );
  assert.deepEqual(
    completedBFirst.workItems,
    [
      { defoldRevision: inputA.defoldRevision, compatibilitySha256: inputA.compatibility.sha256 },
      { defoldRevision: inputB.defoldRevision, compatibilitySha256: inputB.compatibility.sha256 },
    ].sort((left, right) => left.compatibilitySha256.localeCompare(right.compatibilitySha256)),
  );
});

test("a lost channel callback still recovers old indexed revisions and current recipe fingerprints", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-native-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copiedStore = path.join(directory, "store");
  await cp(storeRoot, copiedStore, { recursive: true });

  const shipped = await readStore(storeRoot, "v1");
  const defaultBundleTargets = await bundleTargetsFixture();
  const currentEntry = shipped.entries.find((entry) => entry.defoldRevision === defaultBundleTargets.defoldRevision);
  assert.ok(
    currentEntry,
    `the current bundle-target revision ${defaultBundleTargets.defoldRevision} must have an indexed policy fixture`,
  );
  const indexedRevisions = new Set(shipped.entries.map(({ defoldRevision }) => defoldRevision));
  const oldRevision = Array.from({ length: 10 }, (_, digit) => String(digit).repeat(40)).find(
    (revision) => !indexedRevisions.has(revision),
  );
  assert.ok(oldRevision, "fixture must leave an unindexed revision available for recovery");
  const currentEntryPath = path.join(copiedStore, "v1", "index", `${currentEntry.defoldRevision}.json`);
  const oldEntry = { ...JSON.parse(await readFile(currentEntryPath, "utf8")), defoldRevision: oldRevision };
  await writeFile(path.join(copiedStore, "v1", "index", `${oldRevision}.json`), `${JSON.stringify(oldEntry)}\n`);

  const inputs = await collectPolicyNativeArtifactInputs({ storeDirectory: copiedStore });
  const input = inputs.find(
    ({ revisions }) => revisions.includes(oldRevision) && revisions.includes(currentEntry.defoldRevision),
  );
  assert.ok(input, "same @toolchain compatibility should group the old and indexed revisions");
  assert.ok(input.revisions.includes(oldRevision));
  assert.ok(input.revisions.includes(currentEntry.defoldRevision));
  assert.equal(input.policyRoot, currentEntry.policyRoot, "old and current revisions should keep their policy root");

  const sidecars = await completeReferences(input.bundleTargets);
  const source = await makeReleaseSource(sidecars, {}, t);
  const inspection = await inspectPolicyNativeReleaseMapping(input, source);
  assert.equal(inspection.missingDesired, false);
  assert.equal(inspection.references["native-artifacts"].compatibility.sha256, input.compatibility.sha256);

  const reconciled = reconcilePolicyNativeArtifactMappings({
    inputs,
    artifactHistory: [],
    completedMappings: [inspection.references],
    workItems: [],
  });
  assert.deepEqual(reconciled.workItems, [], "recovered compatibility must not requeue an identical mapping");
  assert.equal(reconciled.artifactHistory.length, 1);

  for (const recipe of Object.keys(nativeArtifactRecipes)) {
    const defaultFingerprint = await fingerprintNativeArtifactRecipe(recipe);
    const projectedFingerprint = await fingerprintNativeArtifactRecipe(recipe, { bundleTargets: input.bundleTargets });
    const defaultRelease = await nativeArtifactRelease(recipe);
    const projectedRelease = await nativeArtifactRelease(recipe, { bundleTargets: input.bundleTargets });
    assert.equal(
      projectedFingerprint,
      defaultFingerprint,
      `${recipe} policy projection must preserve the checked-in default recipe fingerprint`,
    );
    assert.deepEqual(
      { tag: projectedRelease.tag, fingerprint: projectedRelease.fingerprint },
      { tag: defaultRelease.tag, fingerprint: defaultRelease.fingerprint },
      `${recipe} policy projection must preserve its legacy/default release identity`,
    );
    const rows = Object.entries(inspection.references["native-artifacts"].assets)
      .filter(([target]) => nativeArtifactRecipeForTarget(target) === recipe)
      .map(
        ([target]) =>
          inspection.references["native-artifacts"].releases?.[target] ?? inspection.references["native-artifacts"],
      );
    assert.ok(rows.length > 0, `${recipe} had no target row in the recovered map`);
    for (const row of rows) {
      assert.equal(row.fingerprint, defaultFingerprint, `${recipe} must use current recipe fingerprint`);
      assert.equal(row.tag, defaultRelease.tag, `${recipe} must use the current recipe tag`);
    }
  }
});

test("a missing host-only asset still produces work despite same-compatibility history", async (t) => {
  const bundleTargets = await bundleTargetsFixture();
  const current = await completeReferences(bundleTargets);
  const input = inputFor(current, bundleTargets);
  const staleHistory = withOldHostReleaseTag(current);

  const source = await makeReleaseSource(
    current,
    {
      omit: (row) => row.family === "hermes-host" && !row.asset.endsWith(".integrity.json"),
    },
    t,
  );
  const inspected = await inspectPolicyNativeReleaseMapping(input, source);
  assert.equal(inspected.missingDesired, true);
  assert.ok(inspected.missing.length > 0);
  assert.ok(inspected.missing.every((row) => row.family === "hermes-host"));

  const reconciled = reconcilePolicyNativeArtifactMappings({
    inputs: [input],
    artifactHistory: [staleHistory],
    completedMappings: [],
    workItems: inspected.missingDesired ? [workItem(input)] : [],
  });
  assert.equal(reconciled.workItems.length, 1);
  assert.equal(reconciled.workItems[0].compatibilitySha256, input.compatibility.sha256);
});

test("a same-compatibility historical map does not suppress an unavailable current native release tag", async (t) => {
  const bundleTargets = await bundleTargetsFixture();
  const current = await completeReferences(bundleTargets);
  const input = inputFor(current, bundleTargets);
  const staleHistory = withOldNativeReleaseTags(current);
  assert.equal(staleHistory["native-artifacts"].compatibility.sha256, input.compatibility.sha256);

  const target = Object.keys(current["native-artifacts"].assets)[0];
  const desiredAsset = current["native-artifacts"].assets[target];
  const desiredTag = (current["native-artifacts"].releases?.[target] ?? current["native-artifacts"]).tag;
  const source = await makeReleaseSource(
    current,
    {
      omit: (row) => row.family === "native-artifacts" && row.tag === desiredTag && row.asset === desiredAsset,
    },
    t,
  );
  const inspected = await inspectPolicyNativeReleaseMapping(input, source);
  assert.equal(inspected.missingDesired, true);
  assert.ok(inspected.missing.some((row) => row.family === "native-artifacts" && row.asset === desiredAsset));

  const reconciled = reconcilePolicyNativeArtifactMappings({
    inputs: [input],
    artifactHistory: [staleHistory],
    completedMappings: [],
    workItems: [workItem(input)],
  });
  assert.equal(reconciled.workItems.length, 1);
  assert.equal(reconciled.workItems[0].compatibilitySha256, input.compatibility.sha256);
});

test("inventory authorization failures and corrupt sidecars fail closed; only a real 404 is absent", async (t) => {
  const bundleTargets = await bundleTargetsFixture();
  const references = await completeReferences(bundleTargets);
  const input = inputFor(references, bundleTargets);
  const token = "fixture-secret-token";
  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  });
  const requests = [];
  const inventory = await githubReleaseAssets("immutable/tag", repository, {
    token,
    apiRoot: "https://api.example/",
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
      return response(200, { assets: [{ name: "archive.tar.gz" }] });
    },
  });
  assert.deepEqual([...inventory], ["archive.tar.gz"]);
  assert.deepEqual(requests, [
    {
      url: "https://api.example/repos/ts-defold/deherm/releases/tags/immutable%2Ftag",
      authorization: `Bearer ${token}`,
    },
  ]);

  const inventoryErrors = new Map();
  for (const status of [404, 403, 500]) {
    const error = await githubReleaseAssets("immutable/tag", repository, {
      token,
      fetchImpl: async () => response(status, null),
    }).then(
      () => assert.fail(`HTTP ${status} must not produce a release inventory`),
      (failure) => failure,
    );
    inventoryErrors.set(status, error);
    assert.equal(releaseLookupWasNotFound(error), status === 404);
    assert.ok(!error.message.includes(token), "HTTP errors must not disclose the authorization header");
  }
  for (const body of [new Error("invalid JSON"), { assets: [{ url: "missing name" }] }]) {
    const error = await githubReleaseAssets("immutable/tag", repository, {
      token,
      fetchImpl: async () => response(200, body),
    }).then(
      () => assert.fail("malformed release responses must not produce an asset inventory"),
      (failure) => failure,
    );
    assert.equal(releaseLookupWasNotFound(error), false);
    assert.ok(!error.message.includes(token), "response errors must not disclose the authorization header");
  }
  const transportError = await githubReleaseAssets("immutable/tag", repository, {
    token,
    fetchImpl: async (_url, options) => {
      throw new Error(`transport details contained ${options.headers.Authorization}`);
    },
  }).then(
    () => assert.fail("a failed HTTP transport must not produce an asset inventory"),
    (failure) => failure,
  );
  assert.equal(releaseLookupWasNotFound(transportError), false);
  assert.ok(!transportError.message.includes(token), "transport errors must not disclose the authorization header");

  let unsupportedTargetError;
  assert.throws(
    () => nativeArtifactRecipeForTarget("fixture-unsupported-target"),
    (error) => {
      unsupportedTargetError = error;
      return /No native-artifact recipe is declared/u.test(error.message);
    },
  );
  assert.equal(isUnsupportedNativeRecipe(unsupportedTargetError), true);
  const unsupportedRecipeError = await fingerprintNativeArtifactRecipe("fixture-unsupported-recipe").then(
    () => assert.fail("an undeclared native recipe must fail"),
    (error) => error,
  );
  assert.equal(isUnsupportedNativeRecipe(unsupportedRecipeError), true);
  assert.equal(isUnsupportedNativeRecipe(new Error(unsupportedTargetError.message)), false);
  assert.equal(isUnsupportedNativeRecipe(new Error("malformed artifact mapping schema")), false);

  const authorizationError = Object.assign(new Error("release inventory HTTP 403 Forbidden"), {
    stderr: "HTTP 403 Forbidden",
  });
  assert.equal(releaseLookupWasNotFound({ httpStatus: 404 }), true);
  assert.equal(releaseLookupWasNotFound(authorizationError), false);
  assert.equal(releaseLookupWasNotFound(new Error("connect ETIMEDOUT release API")), false);
  assert.equal(releaseLookupWasNotFound({ stderr: "gh: command not found" }), false);
  assert.equal(releaseLookupWasNotFound({ stderr: "API rate limit exceeded" }), false);
  const failures = [];
  for (const listError of [authorizationError, new Error("connect ETIMEDOUT release API")]) {
    const error = await inspectPolicyNativeReleaseMapping(
      input,
      await makeReleaseSource(references, { listError }, t),
    ).then(
      () => assert.fail("an unavailable release inventory must not become a missing release"),
      (failure) => failure,
    );
    failures.push({ compatibilitySha256: input.compatibility.sha256, message: error.message });
  }

  const corruptError = await inspectPolicyNativeReleaseMapping(
    input,
    await makeReleaseSource(references, { corruptSidecar: true }, t),
  ).then(
    () => assert.fail("corrupt sidecar must not become a completed mapping"),
    (error) => error,
  );
  assert.equal(releaseLookupWasNotFound(corruptError), false);
  assert.equal(isUnsupportedNativeRecipe(corruptError), false);

  const invalidSchemaError = await inspectPolicyNativeReleaseMapping(
    input,
    await makeReleaseSource(references, { invalidSidecarSchema: true }, t),
  ).then(
    () => assert.fail("a malformed sidecar schema must not become a completed mapping"),
    (error) => error,
  );
  assert.equal(isUnsupportedNativeRecipe(invalidSchemaError), false);

  failures.push(
    { compatibilitySha256: input.compatibility.sha256, message: corruptError.message },
    { compatibilitySha256: input.compatibility.sha256, message: invalidSchemaError.message },
  );
  const healthPath = path.join((await makeReleaseSource(references, {}, t)).directory, "health.json");
  await writeFile(healthPath, `${JSON.stringify({ failures, unsupported: [] })}\n`);
  await assert.rejects(
    assertNativeArtifactReconciliationHealth(healthPath),
    /4 native-artifact reconciliation failure/u,
  );

  const notFoundError = inventoryErrors.get(404);
  const absentRelease = await makeReleaseSource(references, { listError: notFoundError }, t);
  const absentReleaseAsEmpty = {
    ...absentRelease,
    async listAssets(tag, repo) {
      try {
        return await absentRelease.listAssets(tag, repo);
      } catch (error) {
        if (releaseLookupWasNotFound(error)) return new Set();
        throw error;
      }
    },
  };
  const missing = await inspectPolicyNativeReleaseMapping(input, absentReleaseAsEmpty);
  assert.equal(missing.missingDesired, true);
  assert.ok(missing.missing.length > 0);
  const missingWork = reconcilePolicyNativeArtifactMappings({
    inputs: [input],
    artifactHistory: [],
    completedMappings: [],
    workItems: missing.missingDesired ? [workItem(input)] : [],
  });
  assert.equal(missingWork.workItems.length, 1, "a genuine 404 must queue the exact missing compatibility");
  await writeFile(healthPath, `${JSON.stringify({ failures: [], unsupported: [] })}\n`);
  await assert.doesNotReject(assertNativeArtifactReconciliationHealth(healthPath));
});
