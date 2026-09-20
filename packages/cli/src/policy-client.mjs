// Resolve one immutable Defold API policy from the published Pages index.
//
// The shipped index supplies the base and path templates, but it is not the
// catalogue: Defold publishes revisions after an npm package is released. The
// exact revision entry is fetched from Pages, then the policy and every object
// are verified against the digest in their path before any byte is cached.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashBytes, POLICY_REALIZER_CAPABILITIES } from "../../generator/src/policy/api-policy.mjs";
import { materializePolicySurface } from "../../generator/src/policy/surface-materializer.mjs";
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

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseSemver(value, label) {
  const match = SEMVER.exec(String(value ?? ""));
  if (!match) throw new Error(`${label} is not a valid semantic version: ${JSON.stringify(value)}`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? []
  };
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function validateRealizer(realizer, label) {
  if (!realizer || typeof realizer.minimumPackageVersion !== "string" ||
      !Array.isArray(realizer.requiredCapabilities) || realizer.requiredCapabilities.length === 0 ||
      realizer.requiredCapabilities.some((capability) => typeof capability !== "string" || capability.length === 0) ||
      new Set(realizer.requiredCapabilities).size !== realizer.requiredCapabilities.length) {
    throw new Error(`${label}: invalid policy realizer compatibility contract`);
  }
  parseSemver(realizer.minimumPackageVersion, `${label} minimumPackageVersion`);
  return realizer;
}

function sameRealizer(left, right) {
  return left?.minimumPackageVersion === right?.minimumPackageVersion &&
    Array.isArray(left?.requiredCapabilities) && Array.isArray(right?.requiredCapabilities) &&
    left.requiredCapabilities.length === right.requiredCapabilities.length &&
    left.requiredCapabilities.every((capability, index) => capability === right.requiredCapabilities[index]);
}

async function installedPackageVersion() {
  const document = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  return document.version;
}

function upgradePrompt() {
  return "Upgrade with `pnpm up @ts-defold/deherm@latest` or `npm install @ts-defold/deherm@latest`.";
}

async function assertCompatibleRealizer(revision, realizer, options) {
  const packageVersion = options.packageVersion ?? await installedPackageVersion();
  const installed = parseSemver(packageVersion, "Installed @ts-defold/deherm version");
  const minimum = parseSemver(realizer.minimumPackageVersion, "Policy minimumPackageVersion");
  if (compareSemver(installed, minimum) < 0) {
    throw new Error(
      `Policy for Defold ${revision} requires @ts-defold/deherm >= ${realizer.minimumPackageVersion}, ` +
      `but ${packageVersion} is installed. ${upgradePrompt()}`
    );
  }
  const capabilities = new Set(options.capabilities ?? POLICY_REALIZER_CAPABILITIES);
  const missing = realizer.requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) {
    throw new Error(
      `Policy for Defold ${revision} requires unsupported realization capabilities: ${missing.join(", ")}. ` +
      upgradePrompt()
    );
  }
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
  validateRealizer(entry.realizer, entryResult.relative);
  // This happens before the root or any object is fetched: a package that
  // cannot realize the policy should not download the large authenticated
  // surface only to discover that fact afterwards.
  await assertCompatibleRealizer(revision, entry.realizer, options);
  const shipped = index.entries?.find((candidate) => candidate.defoldRevision === revision);
  if (shipped && (shipped.policyRoot !== entry.policyRoot || shipped.generator !== entry.generator ||
      !sameRealizer(shipped.realizer, entry.realizer))) {
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
  validateRealizer(policy.realizer, rootResult.relative);
  if (!sameRealizer(policy.realizer, entry.realizer)) {
    throw new Error(`${rootResult.relative}: policy realizer contract does not match its index entry`);
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

  const surfaceRoot = path.join(cacheHome, "surfaces", revision);
  const surface = objects.has("@compiler")
    ? await materializePolicySurface({ revision, entry, policy, objects }, { revision, outputRoot: surfaceRoot })
    : null;

  return {
    revision,
    entry,
    policy,
    objects,
    cacheRoot,
    receipt: path.join(cacheRoot, "receipt", `${revision}.json`),
    surface,
    written: writes.filter(Boolean).length,
    source: `${base}/${entryResult.relative}`
  };
}
