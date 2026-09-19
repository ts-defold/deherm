// Resolve one immutable Defold API policy from the published Pages index.
//
// The shipped index supplies the base and path templates, but it is not the
// catalogue: Defold publishes revisions after an npm package is released. The
// exact revision entry is fetched from Pages, then the policy and every object
// are verified against the digest in their path before any byte is cached.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashBytes } from "../../compiler/src/api-policy.mjs";
import { DEFOLD_REVISION_PATTERN } from "./defold-revision.mjs";
import { defoldSurfaceCacheHome } from "./defold-surface.mjs";

function expand(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Policy index template ${template} names unknown field ${key}`);
    return values[key];
  });
}

function policyBase(index) {
  return `${index.base.url.replace(/\/$/, "")}${index.base.pathPrefix ? `/${index.base.pathPrefix.replace(/^\/+|\/+$/g, "")}` : ""}`;
}

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const current = await readFile(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current && current.equals(bytes)) return false;
  if (current) throw new Error(`Immutable policy cache entry changed at ${file}`);
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, file);
  } catch (error) {
    // Another process may have won the same immutable write. Accept only the
    // exact bytes we already authenticated.
    const winner = await readFile(file).catch(() => null);
    if (!winner?.equals(bytes)) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

async function fetchBytes(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fetch, authenticate and cache the policy for an exact Defold revision.
 * This does not substitute a nearby revision and does not trust HTTP cache
 * metadata: the content-addressed hashes are the authority.
 */
export async function resolvePublishedPolicy(revision, options = {}) {
  revision = String(revision).toLowerCase();
  if (!DEFOLD_REVISION_PATTERN.test(revision)) {
    throw new Error(`A published policy is keyed by a 40-character Defold SHA, got ${JSON.stringify(revision)}`);
  }
  const index = options.index;
  if (!index?.base?.url || !index?.base?.index || !index?.base?.policy || !index?.base?.object) {
    throw new Error("The shipped policy index has no complete publication base");
  }
  const fetchImpl = options.fetchImpl ?? ((url) => fetch(url, { signal: AbortSignal.timeout(30_000) }));
  const base = policyBase(index);
  const fetchRelative = async (relative) => ({
    relative,
    bytes: await fetchBytes(`${base}/${relative}`, fetchImpl)
  });

  const entryResult = await fetchRelative(expand(index.base.index, { defoldRevision: revision }));
  const entry = JSON.parse(entryResult.bytes.toString("utf8"));
  if (entry.kind !== "deherm.policy.index-entry" || entry.defoldRevision !== revision ||
      !/^[0-9a-f]{64}$/.test(entry.policyRoot ?? "")) {
    throw new Error(`${entryResult.relative}: invalid policy index entry for ${revision}`);
  }
  const shipped = index.entries?.find((candidate) => candidate.defoldRevision === revision);
  if (shipped && (shipped.policyRoot !== entry.policyRoot || shipped.generator !== entry.generator)) {
    throw new Error(`${revision}: published entry contradicts this package's shipped index`);
  }

  const rootResult = await fetchRelative(expand(index.base.policy, { policyRoot: entry.policyRoot }));
  if (hashBytes(rootResult.bytes) !== entry.policyRoot) {
    throw new Error(`${rootResult.relative}: policy bytes do not hash to ${entry.policyRoot}`);
  }
  const policy = JSON.parse(rootResult.bytes.toString("utf8"));
  if (policy.kind !== "deherm.policy.root" || policy.generator !== entry.generator || !policy.subtrees) {
    throw new Error(`${rootResult.relative}: invalid policy root`);
  }

  const objects = new Map();
  for (const [namespace, digest] of Object.entries(policy.subtrees)) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${rootResult.relative}: ${namespace} has invalid object digest`);
    const result = await fetchRelative(expand(index.base.object, { subtreeHash: digest }));
    if (hashBytes(result.bytes) !== digest) throw new Error(`${result.relative}: object bytes do not hash to ${digest}`);
    const object = JSON.parse(result.bytes.toString("utf8"));
    if (object.namespace !== namespace && namespace !== "@profiles" && namespace !== "@toolchain") {
      throw new Error(`${result.relative}: object names namespace ${object.namespace}, expected ${namespace}`);
    }
    objects.set(namespace, { digest, bytes: result.bytes, value: object });
  }

  const cacheHome = path.resolve(options.cacheHome ?? defoldSurfaceCacheHome(options.env));
  const cacheRoot = path.join(cacheHome, "policies", index.base.layoutVersion ?? "v1");
  const writes = [];
  writes.push(await atomicWrite(path.join(cacheRoot, "index", `${revision}.json`), entryResult.bytes));
  writes.push(await atomicWrite(path.join(cacheRoot, "policy", `${entry.policyRoot}.json`), rootResult.bytes));
  for (const { digest, bytes } of objects.values()) {
    writes.push(await atomicWrite(path.join(cacheRoot, "object", `${digest}.json`), bytes));
  }
  const receipt = {
    schemaVersion: 1,
    kind: "deherm.policy.receipt",
    defoldRevision: revision,
    policyRoot: entry.policyRoot,
    generator: entry.generator,
    objectCount: objects.size
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writes.push(await atomicWrite(path.join(cacheRoot, "receipt", `${revision}.json`), receiptBytes));

  return {
    revision,
    entry,
    policy,
    objects,
    cacheRoot,
    receipt: path.join(cacheRoot, "receipt", `${revision}.json`),
    written: writes.filter(Boolean).length,
    source: `${base}/${entryResult.relative}`
  };
}
