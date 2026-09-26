import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { hashBytes, POLICY_REALIZER_CAPABILITIES } from "../packages/compiler/src/api-policy.mjs";
import {
  policySurfaceRealizationIdentity,
  publishPolicySurface,
  resolvePublishedPolicy
} from "../packages/cli/src/policy-client.mjs";

const revision = "1".repeat(40);

function json(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function fixture({ tamper = false, entryRealizer, rootRealizer, defoldRevision = revision, fixtureValue = true } = {}) {
  const documentNamespace = "@compiler:document:fixture.json";
  const documentBytes = json({
    schemaVersion: 1,
    kind: "deherm.policy.compiler-document",
    namespace: documentNamespace,
    name: "fixture.json",
    value: { fixture: fixtureValue }
  });
  const documentHash = hashBytes(documentBytes);
  const compilerBytes = json({
    schemaVersion: 1,
    kind: "deherm.policy.compiler-surface",
    namespace: "@compiler",
    manifestVersion: 2,
    documents: {
      schemaVersion: 1,
      kind: "deherm.policy.compiler-document-manifest",
      entries: { "fixture.json": { object: documentNamespace, recipe: "fixture.copy.v1" } }
    },
    sdk: { schemaVersion: 1, kind: "deherm.policy.sdk-manifest", entries: {} },
    outputs: { schemaVersion: 1, kind: "deherm.policy.output-manifest", entries: {} },
    realizationRecipes: { documents: { "fixture.json": "fixture.copy.v1" }, sdk: {}, outputs: {} }
  });
  const compilerHash = hashBytes(compilerBytes);
  const toolchainBytes = json({ schemaVersion: 1, kind: "deherm.policy.toolchain", bob: {} });
  const toolchainHash = hashBytes(toolchainBytes);
  const unusedBytes = json({ schemaVersion: 1, kind: "deherm.policy.namespace", namespace: "go", script: { functions: [] } });
  const unusedHash = hashBytes(unusedBytes);
  const generator = `sha256:${"2".repeat(64)}`;
  const realizer = entryRealizer ?? {
    minimumPackageVersion: "0.0.0",
    requiredCapabilities: [...POLICY_REALIZER_CAPABILITIES]
  };
  const rootBytes = json({
    schemaVersion: 1,
    kind: "deherm.policy.root",
    hash: "sha256",
    generator,
    realizer: rootRealizer ?? realizer,
    counts: { namespaces: 1, subtrees: 4 },
    subtrees: {
      "@compiler": compilerHash,
      "@compiler:document:fixture.json": documentHash,
      "@toolchain": toolchainHash,
      go: unusedHash
    }
  });
  const policyRoot = hashBytes(rootBytes);
  const entryBytes = json({ schemaVersion: 1, kind: "deherm.policy.index-entry", defoldRevision, policyRoot, generator, realizer });
  const routes = new Map([
    [`https://policy.invalid/deherm/v1/index/${defoldRevision}.json`, entryBytes],
    [`https://policy.invalid/deherm/v1/policy/${policyRoot}.json`, rootBytes],
    [`https://policy.invalid/deherm/v1/object/${compilerHash}.json`, compilerBytes],
    [`https://policy.invalid/deherm/v1/object/${toolchainHash}.json`, toolchainBytes],
    [`https://policy.invalid/deherm/v1/object/${documentHash}.json`, tamper ? json({ namespace: documentNamespace, altered: true }) : documentBytes],
    [`https://policy.invalid/deherm/v1/object/${unusedHash}.json`, unusedBytes]
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
  return { index, fetchImpl, policyRoot, documentHash, unusedHash, requests, materializeImpl: false };
}

async function verifyFixtureSurface(root) {
  const descriptor = JSON.parse(await readFile(path.join(root, "surface.json"), "utf8"));
  return { ok: true, descriptor };
}

test("surface realization identity binds policy, compiler, and relevant options", () => {
  const base = {
    policyRoot: "e".repeat(64),
    generator: `sha256:${"2".repeat(64)}`,
    realizer: {
      minimumPackageVersion: "0.0.0",
      requiredCapabilities: [...POLICY_REALIZER_CAPABILITIES]
    }
  };
  const first = policySurfaceRealizationIdentity({ entry: base, packageVersion: "1.2.3" });
  const reordered = policySurfaceRealizationIdentity({
    entry: { ...base, realizer: { ...base.realizer, requiredCapabilities: [...base.realizer.requiredCapabilities].reverse() } },
    packageVersion: "1.2.3"
  });
  assert.equal(first.realizationId, reordered.realizationId, "capability discovery order must not change identity");
  assert.notEqual(first.realizationId, policySurfaceRealizationIdentity({
    entry: { ...base, policyRoot: "f".repeat(64) }, packageVersion: "1.2.3"
  }).realizationId);
  assert.notEqual(first.realizationId, policySurfaceRealizationIdentity({
    entry: base, packageVersion: "1.2.4"
  }).realizationId);
  assert.notEqual(first.realizationId, policySurfaceRealizationIdentity({
    entry: base,
    packageVersion: "1.2.3",
    artifacts: { kind: "deherm.policy.artifacts", release: "next" }
  }).realizationId);
});

test("immutable publication refuses a symlink winner and cleans a failed stage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-publish-safety-"));
  const surfaceBase = path.join(root, "surfaces", revision);
  const entry = {
    policyRoot: "e".repeat(64),
    generator: `sha256:${"2".repeat(64)}`,
    realizer: { minimumPackageVersion: "0.0.0", requiredCapabilities: [...POLICY_REALIZER_CAPABILITIES] }
  };
  const realization = policySurfaceRealizationIdentity({ entry, packageVersion: "1.2.3" });
  const parent = path.join(surfaceBase, "r");
  const target = path.join(root, "outside");
  await mkdir(target, { recursive: true });
  await mkdir(parent, { recursive: true });
  await symlink(target, path.join(parent, realization.realizationId.slice(0, 32)), "dir");
  await assert.rejects(
    publishPolicySurface({ entry }, {
      revision,
      realization,
      surfaceBase,
      surfaceBoundary: root,
      materialize: async () => { throw new Error("must not materialize through a symlink"); },
      artifacts: null
    }),
    /must not be a symlink/u
  );

  const cleanBase = path.join(root, "clean", "surfaces", revision);
  await assert.rejects(
    publishPolicySurface({ entry }, {
      revision,
      realization,
      surfaceBase: cleanBase,
      surfaceBoundary: root,
      materialize: async (_policy, options) => {
        await mkdir(options.outputRoot, { recursive: true });
        await writeFile(path.join(options.outputRoot, "partial"), "partial\n");
        throw new Error("synthetic materializer failure");
      },
      artifacts: null
    }),
    /synthetic materializer failure/u
  );
  assert.ok(!(await readdir(path.join(cleanBase, "r"))).some((name) => name.startsWith(".s-")),
    "a failed materializer must not leave a staging directory");
});

test("cold policy resolution transfers only the authenticated realization closure", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-"));
  const source = fixture();
  const first = await resolvePublishedPolicy(revision, { ...source, cacheHome });
  assert.equal(first.entry.policyRoot, source.policyRoot);
  assert.equal(first.objects.size, 3);
  assert.equal(first.transfer.cacheHits, 0);
  assert.equal(first.transfer.cacheMisses, 5);
  assert.equal(first.transfer.cacheWrites, 6);
  assert.ok(first.transfer.transferBytes > 0);
  assert.equal(source.requests.length, 5);
  assert.ok(!source.requests.some((url) => url.endsWith(`${source.unusedHash}.json`)), "unused API namespace was transferred");
  const receipt = JSON.parse(await readFile(first.receipt, "utf8"));
  assert.equal(receipt.defoldRevision, revision);
  assert.equal(receipt.policyRoot, source.policyRoot);
  assert.deepEqual(Object.keys(receipt.objects).sort(), [
    "@compiler",
    "@compiler:document:fixture.json",
    "@toolchain"
  ]);
});

test("a warm authenticated cache resolves offline without invoking fetch", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-offline-"));
  const source = fixture();
  await resolvePublishedPolicy(revision, { ...source, cacheHome });
  const warm = await resolvePublishedPolicy(revision, {
    ...source,
    cacheHome,
    offline: true,
    fetchImpl: async () => { throw new Error("offline resolution attempted network I/O"); }
  });
  assert.deepEqual(warm.transfer, { cacheHits: 5, cacheMisses: 0, cacheWrites: 0, transferBytes: 0 });
});

test("content-addressed roots and objects are reused across exact revision entries", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-revisions-"));
  const firstSource = fixture();
  await resolvePublishedPolicy(revision, { ...firstSource, cacheHome });
  const nextRevision = "2".repeat(40);
  const secondSource = fixture({ defoldRevision: nextRevision });
  const second = await resolvePublishedPolicy(nextRevision, { ...secondSource, cacheHome });
  assert.equal(second.transfer.cacheHits, 4);
  assert.equal(second.transfer.cacheMisses, 1);
  assert.equal(second.transfer.cacheWrites, 2);
  assert.ok(second.transfer.transferBytes > 0);
  assert.deepEqual(secondSource.requests, [`https://policy.invalid/deherm/v1/index/${nextRevision}.json`]);
});

test("online resolution refreshes a replaced revision pointer while immutable objects remain keyed by digest", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-replaced-pointer-"));
  const firstSource = fixture({ fixtureValue: "first" });
  const first = await resolvePublishedPolicy(revision, { ...firstSource, cacheHome });
  const secondSource = fixture({ fixtureValue: "second" });
  const second = await resolvePublishedPolicy(revision, { ...secondSource, cacheHome });
  assert.notEqual(second.entry.policyRoot, first.entry.policyRoot);
  assert.equal(second.entry.policyRoot, secondSource.policyRoot);
  assert.notEqual(second.receipt, first.receipt, "receipts are immutable evidence keyed by policy root");
  assert.equal(second.transfer.cacheHits, 2, "the unchanged compiler manifest and toolchain are reused by digest");
  assert.equal(second.transfer.cacheMisses, 3, "the mutable pointer, new root, and changed document are fetched");
  assert.ok(secondSource.requests[0].endsWith(`/index/${revision}.json`), "online resolution revalidates the pointer");
});

test("an absent exact revision is rejected without revision fallback", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-no-fallback-"));
  const source = fixture();
  const absentRevision = "3".repeat(40);
  await assert.rejects(
    resolvePublishedPolicy(absentRevision, { ...source, cacheHome }),
    new RegExp(`/index/${absentRevision}\\.json: HTTP 404`, "u")
  );
  assert.deepEqual(source.requests, [`https://policy.invalid/deherm/v1/index/${absentRevision}.json`]);
});

test("published policy resolution retries transient Pages propagation failures", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-transient-"));
  const source = fixture();
  const objectUrl = `https://policy.invalid/deherm/v1/object/${source.documentHash}.json`;
  const fetchImpl = source.fetchImpl;
  let transientFailures = 2;
  const sleeps = [];
  const resolved = await resolvePublishedPolicy(revision, {
    ...source,
    cacheHome,
    fetchImpl: async (url) => {
      if (String(url) === objectUrl && transientFailures-- > 0) {
        source.requests.push(String(url));
        return new Response("publishing", { status: 503 });
      }
      return fetchImpl(url);
    },
    fetchRetryDelaysMs: [1, 2],
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); }
  });
  assert.equal(resolved.entry.policyRoot, source.policyRoot);
  assert.deepEqual(sleeps, [1, 2]);
  assert.equal(source.requests.filter((url) => url === objectUrl).length, 3);
});

test("published policy resolution rejects an object substituted at its digest path", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-tamper-"));
  await assert.rejects(
    resolvePublishedPolicy(revision, { ...fixture({ tamper: true }), cacheHome }),
    /object bytes do not hash/
  );
});

test("a corrupt cached content-addressed object is rejected without network fallback", async () => {
  const cacheHome = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-corrupt-"));
  const source = fixture();
  await resolvePublishedPolicy(revision, { ...source, cacheHome });
  await writeFile(path.join(cacheHome, "policies", "v1", "object", `${source.documentHash}.json`), "{}\n");
  await assert.rejects(
    resolvePublishedPolicy(revision, {
      ...source,
      cacheHome,
      offline: true,
      fetchImpl: async () => { throw new Error("corrupt cache fell back to network"); }
    }),
    /Corrupt authenticated policy cache entry[\s\S]*object bytes do not hash/u
  );
});

test("shared authenticated evidence realizes two project caches offline and stays idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-projects-"));
  const cacheHome = path.join(root, "shared");
  const projectOne = path.join(root, "one", ".deherm", "cache", "surfaces", revision);
  const projectTwo = path.join(root, "two", ".deherm", "cache", "surfaces", revision);
  const source = fixture();
  const materializeImpl = async (_policy, options) => {
    const file = path.join(options.outputRoot, "surface.json");
    const bytes = `${JSON.stringify({
      kind: "fixture-surface",
      defoldRevision: options.revision,
      policyRoot: options.realization.policyRoot,
      realization: options.realization
    })}\n`;
    const current = await readFile(file, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (current === bytes) return { outputRoot: options.outputRoot, written: [] };
    await mkdir(options.outputRoot, { recursive: true });
    await writeFile(file, bytes);
    return { outputRoot: options.outputRoot, written: ["surface.json"] };
  };
  const cold = await resolvePublishedPolicy(revision, {
    ...source, cacheHome, surfaceRoot: projectOne, materializeImpl, verifySurfaceImpl: verifyFixtureSurface
  });
  assert.deepEqual(cold.surface.written, ["surface.json"]);
  const offlineSource = {
    ...source,
    cacheHome,
    offline: true,
    fetchImpl: async () => { throw new Error("cross-project reuse attempted network I/O"); },
    materializeImpl,
    verifySurfaceImpl: verifyFixtureSurface
  };
  const reused = await resolvePublishedPolicy(revision, { ...offlineSource, surfaceRoot: projectTwo });
  assert.deepEqual(reused.transfer, { cacheHits: 5, cacheMisses: 0, cacheWrites: 1, transferBytes: 0 });
  assert.deepEqual(reused.surface.written, ["surface.json"]);
  const idempotent = await resolvePublishedPolicy(revision, { ...offlineSource, surfaceRoot: projectTwo });
  assert.deepEqual(idempotent.surface.written, []);
  assert.equal(idempotent.surface.outputRoot, reused.surface.outputRoot);
  const pointer = JSON.parse(await readFile(path.join(projectTwo, "current.json"), "utf8"));
  assert.equal(pointer.realizationId, reused.realization.realizationId);
  assert.deepEqual(
    (await readdir(path.join(projectTwo, "r"))).filter((name) => !name.startsWith(".s-")),
    [reused.realization.realizationId.slice(0, 32)],
    "one policy/compiler/options identity must publish one immutable realization directory"
  );
});

test("a replaced policy publishes a new immutable realization and atomically moves only the pointer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-policy-client-realizations-"));
  const cacheHome = path.join(root, "shared");
  const surfaceRoot = path.join(root, "project", ".deherm", "cache", "surfaces", revision);
  const materializeImpl = async (_policy, options) => {
    await mkdir(options.outputRoot, { recursive: true });
    const descriptor = {
      schemaVersion: 2,
      kind: "deherm.materialized-defold-surface",
      defoldRevision: options.revision,
      policyRoot: options.realization.policyRoot,
      realization: options.realization
    };
    await writeFile(path.join(options.outputRoot, "surface.json"), `${JSON.stringify(descriptor)}\n`);
    return { outputRoot: options.outputRoot, descriptor, written: ["surface.json"] };
  };

  const first = await resolvePublishedPolicy(revision, {
    ...fixture({ fixtureValue: "first" }), cacheHome, surfaceRoot, materializeImpl,
    verifySurfaceImpl: verifyFixtureSurface
  });
  const second = await resolvePublishedPolicy(revision, {
    ...fixture({ fixtureValue: "second" }), cacheHome, surfaceRoot, materializeImpl,
    verifySurfaceImpl: verifyFixtureSurface
  });
  assert.notEqual(second.realization.realizationId, first.realization.realizationId);
  assert.notEqual(second.surface.outputRoot, first.surface.outputRoot);
  const pointer = JSON.parse(await readFile(path.join(surfaceRoot, "current.json"), "utf8"));
  assert.equal(pointer.realizationId, second.realization.realizationId);
  assert.deepEqual(
    (await readdir(path.join(surfaceRoot, "r"))).sort(),
    [first.realization.realizationId.slice(0, 32), second.realization.realizationId.slice(0, 32)].sort(),
    "publishing a replacement must preserve the prior immutable realization"
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
