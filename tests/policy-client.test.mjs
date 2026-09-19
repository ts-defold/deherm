import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { hashBytes } from "../packages/compiler/src/api-policy.mjs";
import { resolvePublishedPolicy } from "../packages/cli/src/policy-client.mjs";

const revision = "1".repeat(40);

function json(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function fixture({ tamper = false } = {}) {
  const objectBytes = json({ schemaVersion: 1, kind: "deherm.policy.namespace", namespace: "go", script: { functions: [] } });
  const objectHash = hashBytes(objectBytes);
  const generator = `sha256:${"2".repeat(64)}`;
  const rootBytes = json({ schemaVersion: 1, kind: "deherm.policy.root", hash: "sha256", generator, counts: { namespaces: 1, subtrees: 1 }, subtrees: { go: objectHash } });
  const policyRoot = hashBytes(rootBytes);
  const entryBytes = json({ schemaVersion: 1, kind: "deherm.policy.index-entry", defoldRevision: revision, policyRoot, generator });
  const routes = new Map([
    [`https://policy.invalid/deherm/v1/index/${revision}.json`, entryBytes],
    [`https://policy.invalid/deherm/v1/policy/${policyRoot}.json`, rootBytes],
    [`https://policy.invalid/deherm/v1/object/${objectHash}.json`, tamper ? json({ namespace: "go", altered: true }) : objectBytes]
  ]);
  const index = {
    base: {
      url: "https://policy.invalid/deherm",
      pathPrefix: "",
      layoutVersion: "v1",
      index: "v1/index/{defoldRevision}.json",
      policy: "v1/policy/{policyRoot}.json",
      object: "v1/object/{subtreeHash}.json"
    },
    entries: []
  };
  const fetchImpl = async (url) => {
    const bytes = routes.get(String(url));
    return bytes
      ? new Response(bytes, { status: 200, headers: { "content-type": "application/json" } })
      : new Response("missing", { status: 404 });
  };
  return { index, fetchImpl, policyRoot, objectHash };
}

test("published policy resolution verifies and immutably caches every object", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-"));
  const source = fixture();
  const first = await resolvePublishedPolicy(revision, { ...source, cacheHome });
  assert.equal(first.entry.policyRoot, source.policyRoot);
  assert.equal(first.objects.size, 1);
  assert.equal(first.written, 4);
  const second = await resolvePublishedPolicy(revision, { ...source, cacheHome });
  assert.equal(second.written, 0);
  const receipt = JSON.parse(await readFile(second.receipt, "utf8"));
  assert.equal(receipt.defoldRevision, revision);
  assert.equal(receipt.policyRoot, source.policyRoot);
});

test("published policy resolution rejects an object substituted at its digest path", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-tamper-"));
  await assert.rejects(
    resolvePublishedPolicy(revision, { ...fixture({ tamper: true }), cacheHome }),
    /object bytes do not hash/
  );
});

