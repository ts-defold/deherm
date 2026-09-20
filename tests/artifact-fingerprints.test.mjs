// The release tag is the artifact's identity, so what moves it is a property
// worth testing directly rather than inferring from a workflow run.
//
// Every case here fingerprints a TEMPORARY tree: `upstream.lock` and the
// generated bundle-target list are copied into it and edited there, and the
// directories a family reads but no case mutates are symlinked back at the real
// checkout. Nothing in this file writes inside the repository.

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { releaseAssetUrlTemplate } from "../packages/cli/src/release-assets.mjs";
import { buildArtifactReferences } from "../scripts/generate-api-policy.mjs";
import {
  artifactFamilies,
  artifactFamilyNames,
  expectedAssetNames,
  familyTag,
  fingerprintFamily,
  hostArtifactFamilyNames,
  parseLock,
  readLockKeys,
  repositoryRoot
} from "../scripts/lib/artifact-releases.mjs";

const lockPath = path.join(repositoryRoot, "upstream.lock");
const bundleTargetsRelative = "packages/toolchains/defold-bundle-targets.json";

/**
 * A checkout-shaped tree whose `upstream.lock` and bundle-target list are this
 * case's own copies. `lock` receives the raw lock text and `bundleTargets` the
 * parsed document; each returns what should be written in its place.
 */
async function scratchCheckout({ lock, bundleTargets } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-artifact-fingerprint-"));
  // Read through to the real checkout for everything the cases do not touch:
  // the build recipes and the Go sources are megabytes of content whose bytes
  // are the point, and copying them would only add a way for the copy to lie.
  for (const entry of ["toolchains", "scripts"]) {
    await symlink(path.join(repositoryRoot, entry), path.join(directory, entry));
  }
  await symlink(path.join(repositoryRoot, "package.json"), path.join(directory, "package.json"));
  await mkdir(path.join(directory, "packages"), { recursive: true });
  await symlink(path.join(repositoryRoot, "packages", "compiler"), path.join(directory, "packages", "compiler"));
  await mkdir(path.join(directory, "packages", "toolchains"), { recursive: true });
  for (const name of ["host-compilers.json", "native-artifacts.json"]) {
    await symlink(
      path.join(repositoryRoot, "packages", "toolchains", name),
      path.join(directory, "packages", "toolchains", name)
    );
  }

  const lockText = await readFile(lockPath, "utf8");
  await writeFile(path.join(directory, "upstream.lock"), lock ? lock(lockText) : lockText);

  const targets = JSON.parse(await readFile(path.join(repositoryRoot, bundleTargetsRelative), "utf8"));
  await writeFile(
    path.join(directory, bundleTargetsRelative),
    `${JSON.stringify(bundleTargets ? bundleTargets(targets) : targets, null, 2)}\n`
  );
  return directory;
}

async function fingerprintAll(root) {
  return Object.fromEntries(
    await Promise.all(artifactFamilyNames.map(async (name) => [name, await fingerprintFamily(name, { root })]))
  );
}

function replaceLockValue(key, value) {
  return (text) => {
    const replaced = text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
    assert.notEqual(replaced, text, `the fixture did not change ${key}`);
    return replaced;
  };
}

test("the scratch checkout reproduces the real fingerprints before anything is edited", async (t) => {
  const directory = await scratchCheckout();
  t.after(() => rm(directory, { recursive: true, force: true }));
  // If this drifts, every other case in the file is comparing two fixtures
  // rather than testing the shipped fingerprint.
  assert.deepEqual(await fingerprintAll(directory), await fingerprintAll(repositoryRoot));
});

test("repinning Defold moves no artifact fingerprint", async (t) => {
  const before = await scratchCheckout();
  // A plausible nightly repin: the whole point of the split is that this is the
  // routine event, not a rare one. policy.yml does it daily.
  const after = await scratchCheckout({
    lock: replaceLockValue("DEFOLD_REV", "0000000000000000000000000000000000000000")
  });
  t.after(() => Promise.all([before, after].map((directory) => rm(directory, { recursive: true, force: true }))));

  const left = await fingerprintAll(before);
  const right = await fingerprintAll(after);
  for (const name of artifactFamilyNames) {
    assert.equal(right[name], left[name], `${name} must not be a function of DEFOLD_REV`);
  }
});

test("repinning Hermes moves the Hermes artifacts and nothing else", async (t) => {
  const before = await scratchCheckout();
  const after = await scratchCheckout({
    lock: replaceLockValue("HERMES_REV", "1111111111111111111111111111111111111111")
  });
  t.after(() => Promise.all([before, after].map((directory) => rm(directory, { recursive: true, force: true }))));

  const left = await fingerprintAll(before);
  const right = await fingerprintAll(after);
  assert.notEqual(right["hermes-host"], left["hermes-host"], "hermesc and shermes ARE the pinned Hermes tree");
  assert.notEqual(right["native-artifacts"], left["native-artifacts"], "libhermes.a IS the pinned Hermes tree");
  // dehermc links the typescript-go compiler and compiles TypeScript to
  // TypeScript. It has never touched Hermes.
  assert.equal(right.dehermc, left.dehermc, "dehermc must not be a function of HERMES_REV");
});

test("every dehermc Go source and its stamped package version rotate the tool tag", async (t) => {
  const sourceChanged = await scratchCheckout();
  const versionChanged = await scratchCheckout();
  t.after(() => Promise.all([sourceChanged, versionChanged]
    .map((directory) => rm(directory, { recursive: true, force: true }))));

  const baseline = await fingerprintFamily("dehermc");
  const compiler = path.join(sourceChanged, "packages", "compiler");
  await rm(compiler, { recursive: true, force: true });
  await cp(path.join(repositoryRoot, "packages", "compiler"), compiler, { recursive: true });
  const dmsdkUsage = path.join(compiler, "ttsc", "hash-literal", "dmsdk_usage.go");
  await writeFile(dmsdkUsage, `${await readFile(dmsdkUsage, "utf8")}\n// fingerprint regression fixture\n`);
  assert.notEqual(await fingerprintFamily("dehermc", { root: sourceChanged }), baseline);

  await rm(path.join(versionChanged, "package.json"));
  const packageDocument = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  packageDocument.version = "99.0.0-fingerprint-test";
  await writeFile(path.join(versionChanged, "package.json"), `${JSON.stringify(packageDocument, null, 2)}\n`);
  assert.notEqual(await fingerprintFamily("dehermc", { root: versionChanged }), baseline);
});

test("Defold's SDK pins still move the target archives, and its provenance fields do not", async (t) => {
  const before = await scratchCheckout();
  // The coupling that must SURVIVE the split: an archive built against a
  // different NDK API level than the engine links against is an ABI mismatch
  // Extender only finds at link time.
  const pinned = await scratchCheckout({
    bundleTargets: (targets) => ({ ...targets, sdk: { ...targets.sdk, androidNdkApiVersion: "21" } })
  });
  // The coupling that must NOT: these fields say where the numbers came from,
  // and they move on every repin.
  const provenance = await scratchCheckout({
    bundleTargets: (targets) => ({
      ...targets,
      defoldRevision: "2222222222222222222222222222222222222222",
      sourceSha256: "3".repeat(64)
    })
  });
  t.after(() => Promise.all([before, pinned, provenance]
    .map((directory) => rm(directory, { recursive: true, force: true }))));

  const baseline = await fingerprintFamily("native-artifacts", { root: before });
  assert.notEqual(await fingerprintFamily("native-artifacts", { root: pinned }), baseline);
  assert.equal(await fingerprintFamily("native-artifacts", { root: provenance }), baseline);
});

test("a consumed lock key that the lock does not carry is a refusal, never a skipped input", async (t) => {
  const directory = await scratchCheckout({
    lock: (text) => text.split("\n").filter((line) => !line.startsWith("HERMES_REV=")).join("\n")
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const name of ["hermes-host", "native-artifacts"]) {
    await assert.rejects(fingerprintFamily(name, { root: directory }), (error) => {
      assert.match(error.message, /upstream\.lock does not declare HERMES_REV/);
      return true;
    });
  }
  // dehermc consumes no lock key at all, so a lock missing one is not its
  // problem and must not become one.
  assert.match(await fingerprintFamily("dehermc", { root: directory }), /^[a-f0-9]{64}$/);
});

test("a lock that declares a key twice is rejected rather than silently resolved", () => {
  assert.throws(
    () => parseLock("HERMES_REV=a\nHERMES_REV=b\n"),
    /upstream\.lock declares HERMES_REV more than once/
  );
});

test("the committed lock carries every key every family declares", async () => {
  // The families are data, so this is the one place that checks the declared
  // key set against the lock actually committed. It is the same refusal the
  // case above exercises on a fixture, pointed at the real file.
  const consumed = [...new Set(artifactFamilyNames.flatMap((name) => artifactFamilies[name].lockKeys))].sort();
  const values = await readLockKeys(lockPath, consumed);
  for (const key of consumed) assert.ok(values[key]?.length > 0, `${key} is declared but empty`);
});

test("the two host families partition the host tool matrix, with no tool in both and none left out", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "packages/toolchains/host-compilers.json"), "utf8"));
  const declared = Object.keys(manifest.tools).sort();
  const claimed = hostArtifactFamilyNames.flatMap((name) => artifactFamilies[name].tools);
  assert.deepEqual([...claimed].sort(), declared, "every declared host tool belongs to exactly one release family");
  assert.equal(new Set(claimed).size, claimed.length, "no host tool may be published under two tags");

  // And the same partition at the asset level: splitting the tag would be
  // pointless if one family still uploaded the other's binaries.
  //
  // One archive per HOST per family now, not one asset per tool: a release
  // asset is a single file, so hermesc and shermes travel together and dehermc
  // travels alone. The count therefore tracks the families, and the tool-level
  // partition is the assertion above.
  const assets = Object.fromEntries(await Promise.all(
    hostArtifactFamilyNames.map(async (name) => [name, await expectedAssetNames(name)])
  ));
  const flat = hostArtifactFamilyNames.flatMap((name) => assets[name]);
  assert.equal(new Set(flat).size, flat.length, "two families expect the same asset");
  assert.equal(flat.length, Object.keys(manifest.hosts).length * hostArtifactFamilyNames.length);
});

test("a client can build a download URL, and the index entry stays free of artifacts", async () => {
  const shipped = JSON.parse(await readFile(
    path.join(repositoryRoot, "packages/bindings/generated/defold-policy-index.json"), "utf8"));
  // Absolute, because release storage is not the policy site. What matters is
  // that the forge appears in index DATA and never in a consumer's code.
  assert.equal(shipped.base.releaseAsset, releaseAssetUrlTemplate());
  assert.match(shipped.base.releaseAsset, /\{tag\}.*\{asset\}/);
  // The template that leads to the artifacts document. Without it a client has
  // the entry and no way to reach the tags.
  assert.match(shipped.base.artifacts, /\{defoldRevision\}/);

  const entry = JSON.parse(await readFile(path.join(
    repositoryRoot,
    "packages/bindings/generated/policy/v1/index",
    `${shipped.entries[0].defoldRevision}.json`
  ), "utf8"));
  // The regression this guards: artifact tags are a function of the BUILD
  // RECIPE, not of the engine revision. While they lived in the entry, editing
  // a Dockerfile rotated a tag, which drifted the entry, which failed the store
  // check - a build-script edit invalidating the derived API surface of an
  // unrelated engine revision, and breaking the write-once rule the entry's
  // trust argument rests on.
  assert.ok(!("artifacts" in entry), "the committed index entry must not carry artifact references");

  // The mapping itself is emitted at publish time, so it is asserted against
  // the live derivation rather than against a committed file.
  const references = await buildArtifactReferences();
  for (const name of artifactFamilyNames) {
    assert.equal(references[name].tag, await familyTag(name), `${name} tag is stale`);
    assert.deepEqual(
      Object.values(references[name].assets).sort(),
      [...await expectedAssetNames(name)].sort()
    );
  }
  assert.equal(references["native-artifacts"].indexedBy, "bundleTarget");
  assert.equal(references["hermes-host"].indexedBy, "host");
});
