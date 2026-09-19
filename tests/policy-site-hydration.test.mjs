import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPolicySite } from "../scripts/build-policy-site.mjs";
import { readSiteConfig, readStore, shippedIndexPath } from "../scripts/generate-api-policy.mjs";
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
  const relative = path.join(site.layoutVersion, "index", `${revision}.json`);
  await mkdir(path.dirname(path.join(hydratedStore, relative)), { recursive: true });
  await writeFile(path.join(hydratedStore, relative), "not the published entry");

  await assert.rejects(
    hydratePolicySite({ from: published, store: hydratedStore, index: hydratedIndex, site }),
    /published and packaged policy bytes disagree/
  );
});
