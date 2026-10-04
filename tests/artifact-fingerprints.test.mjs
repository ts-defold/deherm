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
import { RELEASE_INTEGRITY_KIND, sha256 } from "../packages/cli/src/release-integrity.mjs";
import { buildArtifactReferences } from "../scripts/generate-api-policy.mjs";
import { artifactAssetRows } from "../scripts/project-artifact-references.mjs";
import { planNativeArtifactBuilds } from "../scripts/plan-native-artifact-builds.mjs";
import {
  artifactFamilies,
  artifactFamilyNames,
  expectedAssetNames,
  familyRelease,
  familyTag,
  fingerprintFamily,
  fingerprintNativeArtifactRecipe,
  hostArtifactFamilyNames,
  nativeArtifactRecipes,
  nativeArtifactRelease,
  publishedAssets,
  parseLock,
  readLockKeys,
  repositoryRoot,
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
  await symlink(path.join(repositoryRoot, "packages", "cli"), path.join(directory, "packages", "cli"));
  await mkdir(path.join(directory, "packages", "toolchains"), { recursive: true });
  for (const name of ["host-compilers.json", "native-artifacts.json"]) {
    await symlink(
      path.join(repositoryRoot, "packages", "toolchains", name),
      path.join(directory, "packages", "toolchains", name),
    );
  }

  const lockText = await readFile(lockPath, "utf8");
  await writeFile(path.join(directory, "upstream.lock"), lock ? lock(lockText) : lockText);

  const targets = JSON.parse(await readFile(path.join(repositoryRoot, bundleTargetsRelative), "utf8"));
  await writeFile(
    path.join(directory, bundleTargetsRelative),
    `${JSON.stringify(bundleTargets ? bundleTargets(targets) : targets, null, 2)}\n`,
  );
  return directory;
}

async function fingerprintAll(root) {
  return Object.fromEntries(
    await Promise.all(artifactFamilyNames.map(async (name) => [name, await fingerprintFamily(name, { root })])),
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
    lock: replaceLockValue("DEFOLD_REV", "0000000000000000000000000000000000000000"),
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
    lock: replaceLockValue("HERMES_REV", "1111111111111111111111111111111111111111"),
  });
  t.after(() => Promise.all([before, after].map((directory) => rm(directory, { recursive: true, force: true }))));

  const left = await fingerprintAll(before);
  const right = await fingerprintAll(after);
  assert.notEqual(right["hermes-host"], left["hermes-host"], "hermesc and shermes ARE the pinned Hermes tree");
  assert.notEqual(right["native-artifacts"], left["native-artifacts"], "libhermes.a IS the pinned Hermes tree");
  // dehermc links the typescript-go compiler and compiles TypeScript to
  // TypeScript. It has never touched Hermes.
  assert.equal(right.dehermc, left.dehermc, "dehermc must not be a function of HERMES_REV");
  for (const recipe of Object.keys(nativeArtifactRecipes)) {
    assert.notEqual(
      await fingerprintNativeArtifactRecipe(recipe, { root: after }),
      await fingerprintNativeArtifactRecipe(recipe, { root: before }),
      `${recipe} target bytes consume HERMES_REV`,
    );
  }
});

test("every dehermc Go source and its stamped package version rotate the tool tag", async (t) => {
  const sourceChanged = await scratchCheckout();
  const versionChanged = await scratchCheckout();
  t.after(() =>
    Promise.all([sourceChanged, versionChanged].map((directory) => rm(directory, { recursive: true, force: true }))),
  );

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
    bundleTargets: (targets) => ({ ...targets, sdk: { ...targets.sdk, androidNdkApiVersion: "21" } }),
  });
  // The coupling that must NOT: these fields say where the numbers came from,
  // and they move on every repin.
  const provenance = await scratchCheckout({
    bundleTargets: (targets) => ({
      ...targets,
      defoldRevision: "2222222222222222222222222222222222222222",
      sourceSha256: "3".repeat(64),
    }),
  });
  t.after(() =>
    Promise.all([before, pinned, provenance].map((directory) => rm(directory, { recursive: true, force: true }))),
  );

  const baseline = await fingerprintFamily("native-artifacts", { root: before });
  assert.notEqual(await fingerprintFamily("native-artifacts", { root: pinned }), baseline);
  assert.equal(await fingerprintFamily("native-artifacts", { root: provenance }), baseline);
});

test("native target recipe fingerprints invalidate only byte-compatible lanes", async (t) => {
  const checkout = await scratchCheckout();
  t.after(() => rm(checkout, { recursive: true, force: true }));
  for (const entry of ["toolchains", "scripts"]) {
    await rm(path.join(checkout, entry));
    await cp(path.join(repositoryRoot, entry), path.join(checkout, entry), { recursive: true });
  }
  const baseline = Object.fromEntries(
    await Promise.all(
      Object.keys(nativeArtifactRecipes).map(async (recipe) => [
        recipe,
        await fingerprintNativeArtifactRecipe(recipe, { root: checkout }),
      ]),
    ),
  );

  await writeFile(
    path.join(checkout, "toolchains/hermes/package-msvc.sh"),
    `${await readFile(path.join(checkout, "toolchains/hermes/package-msvc.sh"), "utf8")}\n# test\n`,
  );
  const afterMsvc = Object.fromEntries(
    await Promise.all(
      Object.keys(nativeArtifactRecipes).map(async (recipe) => [
        recipe,
        await fingerprintNativeArtifactRecipe(recipe, { root: checkout }),
      ]),
    ),
  );
  assert.notEqual(afterMsvc.windows, baseline.windows);
  for (const recipe of ["linux", "android", "apple"]) assert.equal(afterMsvc[recipe], baseline[recipe]);

  await writeFile(
    path.join(checkout, "toolchains/hermes/Dockerfile.linux"),
    `${await readFile(path.join(checkout, "toolchains/hermes/Dockerfile.linux"), "utf8")}\n# test\n`,
  );
  const afterLinux = Object.fromEntries(
    await Promise.all(
      Object.keys(nativeArtifactRecipes).map(async (recipe) => [
        recipe,
        await fingerprintNativeArtifactRecipe(recipe, { root: checkout }),
      ]),
    ),
  );
  assert.notEqual(afterLinux.linux, afterMsvc.linux);
  for (const recipe of ["windows", "android", "apple"]) assert.equal(afterLinux[recipe], afterMsvc[recipe]);
});

test("actual target-recipe edits schedule only their consuming build rows", async (t) => {
  const baselinePlan = await planNativeArtifactBuilds();
  const publishedByTag = new Map();
  for (const release of Object.values(baselinePlan.releases)) {
    const assets = publishedByTag.get(release.tag) ?? new Set();
    for (const asset of release.expected) assets.add(asset);
    publishedByTag.set(release.tag, assets);
  }
  const presentFor = (plan) =>
    Object.fromEntries(
      Object.entries(plan.releases).map(([key, release]) => [
        key,
        { tag: release.tag, assets: publishedByTag.get(release.tag) ?? [] },
      ]),
    );
  const scheduledTargets = (plan) =>
    Object.values(plan.matrices)
      .flatMap(({ include }) => include)
      .filter(({ target }) => target)
      .map(({ target }) => target)
      .sort();

  for (const [relative, expected] of [
    ["toolchains/hermes/package-msvc.sh", ["x86_64-win32"]],
    ["toolchains/hermes/Dockerfile.linux", ["arm64-linux", "x86_64-linux"]],
  ]) {
    const checkout = await scratchCheckout();
    t.after(() => rm(checkout, { recursive: true, force: true }));
    for (const entry of ["toolchains", "scripts"]) {
      await rm(path.join(checkout, entry));
      await cp(path.join(repositoryRoot, entry), path.join(checkout, entry), { recursive: true });
    }
    const file = path.join(checkout, relative);
    await writeFile(file, `${await readFile(file, "utf8")}\n# scheduling regression fixture\n`);
    const candidate = await planNativeArtifactBuilds({}, { root: checkout });
    const plan = await planNativeArtifactBuilds(presentFor(candidate), { root: checkout });
    assert.deepEqual(scheduledTargets(plan), expected, relative);
  }
});

test("a consumed lock key that the lock does not carry is a refusal, never a skipped input", async (t) => {
  const directory = await scratchCheckout({
    lock: (text) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("HERMES_REV="))
        .join("\n"),
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
  assert.throws(() => parseLock("HERMES_REV=a\nHERMES_REV=b\n"), /upstream\.lock declares HERMES_REV more than once/);
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
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "packages/toolchains/host-compilers.json"), "utf8"),
  );
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
  const assets = Object.fromEntries(
    await Promise.all(hostArtifactFamilyNames.map(async (name) => [name, await expectedAssetNames(name)])),
  );
  const flat = hostArtifactFamilyNames.flatMap((name) => assets[name]);
  assert.equal(new Set(flat).size, flat.length, "two families expect the same asset");
  assert.equal(flat.length, Object.keys(manifest.hosts).length * hostArtifactFamilyNames.length);
});

test("a client can build a download URL, and the index entry stays free of artifacts", async () => {
  const shipped = JSON.parse(
    await readFile(path.join(repositoryRoot, "packages/bindings/generated/defold-policy-index.json"), "utf8"),
  );
  // Absolute, because release storage is not the policy site. What matters is
  // that the forge appears in index DATA and never in a consumer's code.
  assert.equal(shipped.base.releaseAsset, releaseAssetUrlTemplate());
  assert.match(shipped.base.releaseAsset, /\{tag\}.*\{asset\}/);
  // The template that leads to the artifacts document. Without it a client has
  // the entry and no way to reach the tags.
  assert.match(shipped.base.artifacts, /\{defoldRevision\}/);

  const entry = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "packages/bindings/generated/policy/v1/index",
        `${shipped.entries[0].defoldRevision}.json`,
      ),
      "utf8",
    ),
  );
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
    if (name === "native-artifacts") {
      for (const target of Object.keys(references[name].assets)) {
        const release = await nativeArtifactRelease(target);
        const coordinate = references[name].releases?.[target] ?? references[name];
        assert.equal(coordinate.tag, release.tag);
        assert.equal(coordinate.fingerprint, release.fingerprint);
      }
    } else assert.equal(references[name].tag, await familyTag(name), `${name} tag is stale`);
    assert.deepEqual(Object.values(references[name].assets).sort(), [...(await expectedAssetNames(name))].sort());
  }
  assert.equal(references["native-artifacts"].indexedBy, "bundleTarget");
  assert.equal(references["hermes-host"].indexedBy, "host");
});

test("policy publication projects release assets from the installed derived surface", async () => {
  const references = await buildArtifactReferences();
  const archives = artifactAssetRows(references);
  const complete = artifactAssetRows(references, { includeIntegrity: true });
  assert.equal(complete.length, archives.length * 2);
  assert.deepEqual(
    complete.filter((row) => !row.asset.endsWith(".integrity.json")),
    archives,
  );
  for (const archive of archives) {
    assert.ok(
      complete.some(
        (row) =>
          row.family === archive.family && row.tag === archive.tag && row.asset === `${archive.asset}.integrity.json`,
      ),
      `${archive.family}/${archive.asset} has no projected integrity sidecar`,
    );
  }
});

test("release projection rejects an omitted or mismatched per-target coordinate", async () => {
  const references = await buildArtifactReferences();
  const missing = structuredClone(references);
  missing["native-artifacts"].releases = Object.fromEntries(
    Object.keys(missing["native-artifacts"].assets).map((target) => [
      target,
      { tag: missing["native-artifacts"].tag, fingerprint: missing["native-artifacts"].fingerprint },
    ]),
  );
  delete missing["native-artifacts"].tag;
  delete missing["native-artifacts"].fingerprint;
  delete missing["native-artifacts"].releases["arm64-osx"];
  assert.throws(() => artifactAssetRows(missing), /mismatched native-artifacts asset and release indexes/u);

  const invalid = structuredClone(missing);
  invalid["native-artifacts"].releases["arm64-osx"] = { tag: "", fingerprint: "0".repeat(64) };
  assert.throws(() => artifactAssetRows(invalid), /no release coordinate for native-artifacts\/arm64-osx/u);
});

test("published artifact references bind every publisher integrity document", async () => {
  const integrityRoot = await mkdtemp(path.join(tmpdir(), "deherm-artifact-integrity-"));
  try {
    for (const family of artifactFamilyNames) {
      await mkdir(path.join(integrityRoot, family), { recursive: true });
      for (const row of await publishedAssets(family)) {
        const release =
          family === "native-artifacts" ? await nativeArtifactRelease(row.target) : await familyRelease(family);
        const document = {
          schemaVersion: 1,
          kind: RELEASE_INTEGRITY_KIND,
          family,
          tag: release.tag,
          fingerprint: release.fingerprint,
          asset: row.asset,
          archive: { bytes: 7, sha256: "a".repeat(64) },
          members: row.files.map((name) => ({ name, bytes: 1, sha256: "b".repeat(64) })),
        };
        await writeFile(
          path.join(integrityRoot, family, `${row.asset}.integrity.json`),
          `${JSON.stringify(document, null, 2)}\n`,
        );
      }
    }
    const references = await buildArtifactReferences({ integrityRoot });
    for (const family of artifactFamilyNames) {
      for (const record of Object.values(references[family].integrity)) {
        const bytes = await readFile(path.join(integrityRoot, family, record.asset));
        assert.equal(record.sha256, sha256(bytes));
        assert.equal(record.archiveSha256, "a".repeat(64));
      }
    }
  } finally {
    await rm(integrityRoot, { recursive: true, force: true });
  }
});
