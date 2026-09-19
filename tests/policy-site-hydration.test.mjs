import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPolicySite } from "../scripts/build-policy-site.mjs";
import { readSiteConfig, readStore, shippedIndexPath, storeRoot } from "../scripts/generate-api-policy.mjs";
import { hydratePolicySite } from "../scripts/hydrate-policy-site.mjs";

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
    expected
  );
  const index = JSON.parse(await readFile(hydratedIndex, "utf8"));
  assert.notEqual(index.entries[0].generator, staleGenerator);
});

test("hydration refuses mutable bytes at a content-addressed path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-hydration-conflict-"));
  const published = path.join(directory, "published");
  const hydratedStore = path.join(directory, "store");
  const hydratedIndex = path.join(directory, "defold-policy-index.json");
  const site = await readSiteConfig();
  await buildPolicySite({ output: published });
  await copyFile(shippedIndexPath, hydratedIndex);

  const manifest = JSON.parse(await readFile(path.join(published, site.layoutVersion, "index", "manifest.json"), "utf8"));
  const revision = manifest.entries[0].defoldRevision;
  const root = manifest.entries[0].policyRoot;
  const relative = path.join(site.layoutVersion, "policy", `${root}.json`);
  await mkdir(path.dirname(path.join(hydratedStore, relative)), { recursive: true });
  await writeFile(path.join(hydratedStore, relative), "not the published entry");

  await assert.rejects(
    hydratePolicySite({ from: published, store: hydratedStore, index: hydratedIndex, site }),
    /published and packaged policy bytes disagree/
  );
});
