import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPolicySite, validateArtifactReferences, verifyEmittedTree } from "../scripts/build-policy-site.mjs";
import {
  artifactFamilyNames,
  artifactReleaseForRow,
  nativeArtifactRecipeForTarget,
  publishedAssets,
} from "../scripts/lib/artifact-releases.mjs";
import { resolveArtifactUrl } from "../scripts/check-policy-site-resolution.mjs";
import { RELEASE_INTEGRITY_KIND } from "../packages/cli/src/release-integrity.mjs";
import {
  buildArtifactReferences,
  readSiteConfig,
  readStore,
  shippedIndexPath,
  storeRoot,
} from "../scripts/generate-api-policy.mjs";
import { hydratePolicySite } from "../scripts/hydrate-policy-site.mjs";

function divergentNativeReferences(references) {
  const divergent = structuredClone(references);
  const native = divergent["native-artifacts"];
  const baseline = native.releases?.["arm64-osx"] ?? native;
  native.releases = Object.fromEntries(
    Object.keys(native.assets).map((target) => [
      target,
      {
        recipe: nativeArtifactRecipeForTarget(target),
        tag: baseline.tag,
        fingerprint: baseline.fingerprint,
      },
    ]),
  );
  native.releases["arm64-osx"] = {
    recipe: "apple",
    tag: "libs-fixture-apple",
    fingerprint: "a".repeat(64),
  };
  delete native.tag;
  delete native.fingerprint;
  return divergent;
}

function addFixtureIntegrity(references) {
  const complete = structuredClone(references);
  for (const row of Object.values(complete)) {
    row.integrity = Object.fromEntries(
      Object.entries(row.assets).map(([key, asset]) => [
        key,
        {
          asset: `${asset}.integrity.json`,
          sha256: "b".repeat(64),
          archiveSha256: "c".repeat(64),
          archiveBytes: 7,
        },
      ]),
    );
  }
  return complete;
}

test("site validation accepts one native release or an exact per-target release map", async () => {
  const homogeneous = await buildArtifactReferences();
  assert.equal(validateArtifactReferences(homogeneous), homogeneous);
  const divergent = divergentNativeReferences(homogeneous);
  assert.equal(validateArtifactReferences(divergent), divergent);

  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-divergent-releases-"));
  const result = await buildPolicySite({ output: directory, artifactReferences: divergent });
  const verified = await verifyEmittedTree({ output: directory, site: result.site });
  assert.equal(verified.revisions, result.entries.length);
  const index = JSON.parse(await readFile(path.join(directory, result.site.layoutVersion, "index", "manifest.json")));
  const artifacts = JSON.parse(
    await readFile(
      path.join(directory, result.site.layoutVersion, "artifacts", `${result.entries[0].defoldRevision}.json`),
    ),
  );
  for (const [target, release] of Object.entries(divergent["native-artifacts"].releases)) {
    const resolved = resolveArtifactUrl({ index, artifacts, family: "native-artifacts", key: target });
    assert.equal(resolved.tag, release.tag, target);
    assert.equal(resolved.asset, divergent["native-artifacts"].assets[target], target);
  }
});

test("per-target native release validation rejects gaps, extras, malformed identities, and mixed shapes", async () => {
  const baseline = divergentNativeReferences(await buildArtifactReferences());
  const invalidCases = [
    [
      "missing target",
      (row) => delete row.releases["arm64-osx"],
      /mismatched native-artifacts asset and release indexes/u,
    ],
    [
      "unexpected target",
      (row) => {
        row.releases["not-a-target"] = row.releases["arm64-osx"];
      },
      /mismatched native-artifacts asset and release indexes/u,
    ],
    [
      "array map",
      (row) => {
        row.releases = [];
      },
      /malformed native-artifacts releases map/u,
    ],
    [
      "empty tag",
      (row) => {
        row.releases["arm64-osx"].tag = "";
      },
      /invalid native-artifacts\/arm64-osx release identity/u,
    ],
    [
      "invalid tag",
      (row) => {
        row.releases["arm64-osx"].tag = "path/slash";
      },
      /invalid native-artifacts\/arm64-osx release identity/u,
    ],
    [
      "invalid fingerprint",
      (row) => {
        row.releases["arm64-osx"].fingerprint = "bad";
      },
      /invalid native-artifacts\/arm64-osx release identity/u,
    ],
    [
      "missing fingerprint",
      (row) => {
        delete row.releases["arm64-osx"].fingerprint;
      },
      /invalid native-artifacts\/arm64-osx release identity/u,
    ],
    [
      "wrong recipe",
      (row) => {
        row.releases["arm64-osx"].recipe = "linux";
      },
      /invalid native-artifacts\/arm64-osx recipe/u,
    ],
    [
      "mixed identity",
      (row) => {
        row.tag = "libs-ambiguous";
      },
      /mixes family and per-target native-artifacts release coordinates/u,
    ],
    [
      "undeclared asset target",
      (row) => {
        row.assets["not-a-target"] = "hermes-not-a-target.tar.gz";
        row.releases["not-a-target"] = row.releases["arm64-osx"];
      },
      /undeclared native-artifacts target not-a-target/u,
    ],
    [
      "asset bound to a different target",
      (row) => {
        row.assets["arm64-osx"] = row.assets["x86_64-osx"];
      },
      /asset mismatch for native-artifacts\/arm64-osx/u,
    ],
  ];
  for (const [label, mutate, diagnostic] of invalidCases) {
    const candidate = structuredClone(baseline);
    mutate(candidate["native-artifacts"]);
    assert.throws(() => validateArtifactReferences(candidate), diagnostic, label);
  }
  const nonNative = structuredClone(baseline);
  nonNative["hermes-host"].fingerprint = "bad";
  assert.throws(() => validateArtifactReferences(nonNative), /invalid hermes-host release identity/u);
  const nonNativeSplit = structuredClone(baseline);
  nonNativeSplit["dehermc"].releases = {};
  assert.throws(() => validateArtifactReferences(nonNativeSplit), /invalid dehermc release identity/u);
});

test("integrity-required publication still binds each sidecar to its exact asset", async () => {
  const complete = addFixtureIntegrity(divergentNativeReferences(await buildArtifactReferences()));
  assert.equal(validateArtifactReferences(complete, "fixture", { requireIntegrity: true }), complete);
  for (const [label, mutate, diagnostic] of [
    [
      "missing record",
      (row) => delete row.integrity["arm64-osx"],
      /mismatched native-artifacts asset and integrity indexes/u,
    ],
    [
      "wrong sidecar",
      (row) => {
        row.integrity["arm64-osx"].asset = "another.integrity.json";
      },
      /no authenticated native-artifacts\/arm64-osx integrity record/u,
    ],
    [
      "bad digest",
      (row) => {
        row.integrity["arm64-osx"].sha256 = "bad";
      },
      /no authenticated native-artifacts\/arm64-osx integrity record/u,
    ],
    [
      "zero archive",
      (row) => {
        row.integrity["arm64-osx"].archiveBytes = 0;
      },
      /no authenticated native-artifacts\/arm64-osx integrity record/u,
    ],
  ]) {
    const candidate = structuredClone(complete);
    mutate(candidate["native-artifacts"]);
    assert.throws(
      () => validateArtifactReferences(candidate, "fixture", { requireIntegrity: true }),
      diagnostic,
      label,
    );
  }
  const host = structuredClone(complete);
  const hostKey = Object.keys(host["hermes-host"].assets)[0];
  delete host["hermes-host"].integrity[hostKey];
  assert.throws(
    () => validateArtifactReferences(host, "fixture", { requireIntegrity: true }),
    /mismatched hermes-host asset and integrity indexes/u,
  );
});

test("publication consumes authenticated integrity sidecars for every artifact family", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-publisher-"));
  const integrityRoot = path.join(directory, "integrity");
  for (const family of artifactFamilyNames) {
    await mkdir(path.join(integrityRoot, family), { recursive: true });
    for (const row of await publishedAssets(family)) {
      const release = await artifactReleaseForRow(family, row);
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
      await writeFile(path.join(integrityRoot, family, `${row.asset}.integrity.json`), `${JSON.stringify(document)}\n`);
    }
  }
  const output = path.join(directory, "site");
  const result = await buildPolicySite({ output, artifactIntegrityRoot: integrityRoot });
  const verified = await verifyEmittedTree({ output, site: result.site });
  assert.equal(verified.revisions, result.entries.length);
  assert.ok(verified.objects > 0);
  const artifacts = JSON.parse(
    await readFile(
      path.join(output, result.site.layoutVersion, "artifacts", `${result.entries[0].defoldRevision}.json`),
    ),
  );
  validateArtifactReferences(artifacts, "published fixture", { requireIntegrity: true });
});

test("the packaged one-revision store hydrates idempotently from the accumulated website", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-hydration-"));
  const published = path.join(directory, "published");
  const hydratedStore = path.join(directory, "store");
  const hydratedIndex = path.join(directory, "defold-policy-index.json");
  const site = await readSiteConfig();

  await buildPolicySite({ output: published });
  await mkdir(path.dirname(hydratedIndex), { recursive: true });
  await copyFile(shippedIndexPath, hydratedIndex);

  const first = await hydratePolicySite({ from: published, store: hydratedStore, index: hydratedIndex, site });
  assert.ok(first.copied > 0);
  assert.equal(first.revisions, 1);
  const store = await readStore(hydratedStore, site.layoutVersion);
  assert.deepEqual(store.problems, []);
  assert.deepEqual(store.orphans, []);

  const second = await hydratePolicySite({ from: published, store: hydratedStore, index: hydratedIndex, site });
  assert.equal(second.copied, 0);
  assert.equal(second.revisions, first.revisions);
});

test("hydration lets the packaged generator replace a published pointer for the same revision", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-hydration-replace-"));
  const published = path.join(directory, "published");
  const hydratedStore = path.join(directory, "store");
  const hydratedIndex = path.join(directory, "defold-policy-index.json");
  const site = await readSiteConfig();
  await buildPolicySite({ output: published });
  await cp(storeRoot, hydratedStore, { recursive: true });
  await copyFile(shippedIndexPath, hydratedIndex);

  const manifestFile = path.join(published, site.layoutVersion, "index", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const revision = manifest.entries[0].defoldRevision;
  const staleGenerator = `sha256:${"0".repeat(64)}`;
  manifest.entries[0].generator = staleGenerator;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const publishedEntryFile = path.join(published, site.layoutVersion, "index", `${revision}.json`);
  const publishedEntry = JSON.parse(await readFile(publishedEntryFile, "utf8"));
  publishedEntry.generator = staleGenerator;
  await writeFile(publishedEntryFile, `${JSON.stringify(publishedEntry, null, 2)}\n`);

  const expected = await readFile(path.join(hydratedStore, site.layoutVersion, "index", `${revision}.json`), "utf8");
  const result = await hydratePolicySite({ from: published, store: hydratedStore, index: hydratedIndex, site });
  assert.equal(result.copied, 0);
  assert.equal(
    await readFile(path.join(hydratedStore, site.layoutVersion, "index", `${revision}.json`), "utf8"),
    expected,
  );
  const index = JSON.parse(await readFile(hydratedIndex, "utf8"));
  assert.notEqual(index.entries[0].generator, staleGenerator);
});

test("hydration preserves a packaged pointer when publication binds artifact metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-hydration-artifacts-"));
  const published = path.join(directory, "published");
  const hydratedStore = path.join(directory, "store");
  const hydratedIndex = path.join(directory, "defold-policy-index.json");
  const site = await readSiteConfig();
  await buildPolicySite({ output: published });
  await cp(storeRoot, hydratedStore, { recursive: true });
  await copyFile(shippedIndexPath, hydratedIndex);

  const revision = JSON.parse(await readFile(hydratedIndex, "utf8")).entries[0].defoldRevision;
  const packagedEntryFile = path.join(hydratedStore, site.layoutVersion, "index", `${revision}.json`);
  const packagedEntry = await readFile(packagedEntryFile, "utf8");
  const publishedEntry = JSON.parse(
    await readFile(path.join(published, site.layoutVersion, "index", `${revision}.json`), "utf8"),
  );
  assert.match(publishedEntry.artifactsSha256, /^[a-f0-9]{64}$/u);

  const result = await hydratePolicySite({ from: published, store: hydratedStore, index: hydratedIndex, site });
  assert.equal(result.copied, 0);
  assert.equal(await readFile(packagedEntryFile, "utf8"), packagedEntry);
});

test("hydration refuses mutable bytes at a content-addressed path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-hydration-conflict-"));
  const published = path.join(directory, "published");
  const hydratedStore = path.join(directory, "store");
  const hydratedIndex = path.join(directory, "defold-policy-index.json");
  const site = await readSiteConfig();
  await buildPolicySite({ output: published });
  await copyFile(shippedIndexPath, hydratedIndex);

  const manifest = JSON.parse(
    await readFile(path.join(published, site.layoutVersion, "index", "manifest.json"), "utf8"),
  );
  const root = manifest.entries[0].policyRoot;
  const relative = path.join(site.layoutVersion, "policy", `${root}.json`);
  await mkdir(path.dirname(path.join(hydratedStore, relative)), { recursive: true });
  await writeFile(path.join(hydratedStore, relative), "not the published entry");

  await assert.rejects(
    hydratePolicySite({ from: published, store: hydratedStore, index: hydratedIndex, site }),
    /published and packaged policy bytes disagree/,
  );
});

test("policy publication can retain a previously complete artifact mapping", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-artifact-fallback-"));
  const site = await readSiteConfig();
  const fallback = addFixtureIntegrity(divergentNativeReferences(await buildArtifactReferences()));
  for (const [index, family] of Object.values(fallback).entries()) {
    if (family.releases) continue;
    family.tag = `last-complete-${index}`;
    family.fingerprint = String(index + 1).repeat(64);
  }
  const result = await buildPolicySite({ output: directory, artifactReferences: fallback, requireIntegrity: true });
  for (const entry of result.entries) {
    const document = JSON.parse(
      await readFile(path.join(directory, site.layoutVersion, "artifacts", `${entry.defoldRevision}.json`), "utf8"),
    );
    assert.deepEqual(document.artifacts, fallback);
  }
  assert.throws(
    () => validateArtifactReferences({ "native-artifacts": fallback["native-artifacts"] }),
    /has no hermes-host family/u,
  );
  const unauthenticated = structuredClone(fallback);
  delete unauthenticated["native-artifacts"].integrity["arm64-osx"];
  await assert.rejects(
    buildPolicySite({ output: directory, artifactReferences: unauthenticated, requireIntegrity: true }),
    /mismatched native-artifacts asset and integrity indexes/u,
  );
});
