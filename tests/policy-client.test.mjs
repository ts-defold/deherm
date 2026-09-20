import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { hashBytes, POLICY_REALIZER_CAPABILITIES } from "../packages/generator/src/policy/api-policy.mjs";
import { resolvePublishedPolicy } from "../packages/cli/src/policy-client.mjs";

const revision = "1".repeat(40);

function json(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function fixture({ tamper = false, entryRealizer, rootRealizer } = {}) {
  const objectBytes = json({ schemaVersion: 1, kind: "deherm.policy.namespace", namespace: "go", script: { functions: [] } });
  const objectHash = hashBytes(objectBytes);
  const generator = `sha256:${"2".repeat(64)}`;
  const realizer = entryRealizer ?? {
    minimumPackageVersion: "0.0.0",
    requiredCapabilities: [...POLICY_REALIZER_CAPABILITIES]
  };
  const rootBytes = json({ schemaVersion: 1, kind: "deherm.policy.root", hash: "sha256", generator, realizer: rootRealizer ?? realizer, counts: { namespaces: 1, subtrees: 1 }, subtrees: { go: objectHash } });
  const policyRoot = hashBytes(rootBytes);
  const entryBytes = json({ schemaVersion: 1, kind: "deherm.policy.index-entry", defoldRevision: revision, policyRoot, generator, realizer });
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
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const bytes = routes.get(String(url));
    return bytes
      ? new Response(bytes, { status: 200, headers: { "content-type": "application/json" } })
      : new Response("missing", { status: 404 });
  };
  return { index, fetchImpl, policyRoot, objectHash, requests };
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

test("an incompatible package version is rejected before the policy root is fetched", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-version-"));
  const source = fixture({
    entryRealizer: {
      minimumPackageVersion: "2.0.0",
      requiredCapabilities: [...POLICY_REALIZER_CAPABILITIES]
    }
  });
  await assert.rejects(
    resolvePublishedPolicy(revision, { ...source, cacheHome, packageVersion: "1.9.9" }),
    /requires @ts-defold\/deherm >= 2\.0\.0[\s\S]*pnpm up[\s\S]*npm install/u
  );
  assert.equal(source.requests.length, 1);
  assert.match(source.requests[0], /\/index\//u);
});

test("a missing realizer capability is rejected before the policy root is fetched", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-capability-"));
  const source = fixture({
    entryRealizer: {
      minimumPackageVersion: "0.0.0",
      requiredCapabilities: [...POLICY_REALIZER_CAPABILITIES, "sdk.future-shape.v1"]
    }
  });
  await assert.rejects(
    resolvePublishedPolicy(revision, {
      ...source,
      cacheHome,
      packageVersion: "9.0.0",
      capabilities: POLICY_REALIZER_CAPABILITIES
    }),
    /unsupported realization capabilities: sdk\.future-shape\.v1[\s\S]*pnpm up[\s\S]*npm install/u
  );
  assert.equal(source.requests.length, 1);
});

test("the authenticated root must repeat the index realizer contract exactly", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-root-realizer-"));
  const source = fixture({
    rootRealizer: {
      minimumPackageVersion: "0.0.1",
      requiredCapabilities: [...POLICY_REALIZER_CAPABILITIES]
    }
  });
  await assert.rejects(
    resolvePublishedPolicy(revision, { ...source, cacheHome, packageVersion: "9.0.0" }),
    /policy realizer contract does not match its index entry/u
  );
  assert.equal(source.requests.length, 2);
  assert.match(source.requests[1], /\/policy\//u);
});
