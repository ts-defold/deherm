// Resolve one immutable Defold API policy from the published Pages index.
// Policy evidence is kept in a content-addressed user cache; realized compiler
// output is written to a separate, explicitly selected surface root.

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashBytes, POLICY_REALIZER_CAPABILITIES } from "../../compiler/src/api-policy.mjs";
import {
  assertPolicySurfaceRealizationIdentity,
  materializePolicySurface,
  policySurfaceRealizationIdentity
} from "../../compiler/src/policy-surface-materializer.mjs";
import { DEFOLD_REVISION_PATTERN } from "./defold-revision.mjs";
import {
  defoldSurfaceCacheHome,
  verifyMaterializedSurfaceRoot
} from "./defold-surface.mjs";

const defaultSiteConfig = new URL("../../bindings/policy-site.json", import.meta.url);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_FETCH_RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 4_000, 8_000]);
const MAX_RETRY_AFTER_MS = 8_000;
const ABANDONED_STAGE_MIN_AGE_MS = 6 * 60 * 60 * 1_000;

export { policySurfaceRealizationIdentity };

export function policyLocatorFromSiteConfig(config) {
  if (config?.schemaVersion !== 1 || typeof config.baseUrl !== "string" ||
      typeof config.pathPrefix !== "string" || !/^v\d+$/u.test(config.layoutVersion ?? "") ||
      !Array.isArray(config.channels) || typeof config.channelInfoUrl !== "string") {
    throw new Error("The packaged policy publication locator is invalid");
  }
  const layout = config.layoutVersion;
  return {
    schemaVersion: 1,
    kind: "deherm.policy.publication-locator",
    base: {
      url: config.baseUrl,
      pathPrefix: config.pathPrefix,
      layoutVersion: layout,
      index: `${layout}/index/{defoldRevision}.json`,
      artifacts: `${layout}/artifacts/{defoldRevision}.json`,
      policy: `${layout}/policy/{policyRoot}.json`,
      object: `${layout}/object/{subtreeHash}.json`,
      releaseAsset: "https://github.com/ts-defold/deherm/releases/download/{tag}/{asset}"
    },
    channels: [...config.channels],
    channelInfoUrl: config.channelInfoUrl,
    entries: []
  };
}

export async function readPolicyLocator(file = defaultSiteConfig) {
  return policyLocatorFromSiteConfig(JSON.parse(await readFile(file, "utf8")));
}

export async function resolveDefoldChannelRevision(channel = "stable", options = {}) {
  const locator = options.locator ?? await readPolicyLocator(options.siteConfig);
  if (!locator.channels.includes(channel)) {
    throw new Error(`Unknown Defold channel ${JSON.stringify(channel)}; expected ${locator.channels.join(", ")}`);
  }
  const url = locator.channelInfoUrl.replace("{channel}", channel);
  const fetchImpl = options.fetchImpl ?? ((value) => fetch(value, { signal: AbortSignal.timeout(30_000) }));
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const info = await response.json();
  const revision = String(info?.sha1 ?? "").toLowerCase();
  if (!DEFOLD_REVISION_PATTERN.test(revision)) {
    throw new Error(`${url}: sha1 is not a Defold revision: ${JSON.stringify(info?.sha1)}`);
  }
  return { channel, revision, version: info.version ?? null, source: url };
}

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
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
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
  return packageVersion;
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
    const winner = await readFile(file).catch(() => null);
    if (!winner?.equals(bytes)) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

async function atomicReplace(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const current = await readFile(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current?.equals(bytes)) return false;
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

function retryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  if (/^\d+$/u.test(value)) return Math.min(MAX_RETRY_AFTER_MS, Number(value) * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now())) : null;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function reapAbandonedRealizationStages(parent) {
  await mkdir(parent, { recursive: true });
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    const match = /^\.s-[0-9a-f]{16}-(\d+)-[0-9a-f]{12}$/u.exec(entry.name);
    if (!match || processIsAlive(Number(match[1]))) continue;
    const stage = path.join(parent, entry.name);
    const information = await lstat(stage).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!information || Date.now() - information.mtimeMs < ABANDONED_STAGE_MIN_AGE_MS) continue;
    await rm(stage, { recursive: true, force: true });
  }
}

export async function publishPolicySurface(resolvedPolicy, options) {
  const { revision, realization, surfaceBase, materialize, artifacts } = options;
  const verifySurface = options.verifySurface ?? verifyMaterializedSurfaceRoot;
  assertPolicySurfaceRealizationIdentity(realization, {
    realizationId: realization.realizationId,
    policyRoot: resolvedPolicy.entry.policyRoot
  });
  const parent = path.join(surfaceBase, "r");
  const leaf = realization.realizationId.slice(0, 32);
  const realizationRoot = path.join(parent, leaf);
  await reapAbandonedRealizationStages(parent);

  const existing = await lstat(realizationRoot).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw new Error(`Immutable materialized surface must not be a symlink: ${realizationRoot}`);
  if (existing) {
    const verified = await verifySurface(realizationRoot, revision, realization);
    if (verified.ok) {
      return {
        revision,
        outputRoot: realizationRoot,
        descriptor: verified.descriptor,
        written: [],
        reused: true
      };
    }
    const quarantine = path.join(
      parent,
      `.bad-${leaf}-${process.pid}-${randomBytes(6).toString("hex")}`
    );
    try {
      await rename(realizationRoot, quarantine);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const stagingRoot = path.join(
    parent,
    `.s-${realization.realizationId.slice(0, 16)}-${process.pid}-${randomBytes(6).toString("hex")}`
  );
  try {
    let surface = await materialize(resolvedPolicy, {
      revision,
      outputRoot: stagingRoot,
      outputBoundary: path.resolve(options.surfaceBoundary),
      artifacts,
      realization
    });
    await mkdir(parent, { recursive: true });
    try {
      await rename(stagingRoot, realizationRoot);
      surface = { ...surface, outputRoot: realizationRoot };
    } catch (error) {
      const winnerStatus = await lstat(realizationRoot)
        .catch((readError) => readError?.code === "ENOENT" ? null : Promise.reject(readError));
      if (!winnerStatus || winnerStatus.isSymbolicLink()) throw error;
      const winner = await verifySurface(realizationRoot, revision, realization);
      if (!winner.ok) throw new Error(`Concurrent materialized-surface winner failed verification: ${winner.error}`);
      surface = {
        revision,
        outputRoot: realizationRoot,
        descriptor: winner.descriptor,
        written: [],
        reused: true
      };
    }
    return surface;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function fetchBytes(url, fetchImpl, options = {}) {
  const delays = options.fetchRetryDelaysMs ?? DEFAULT_FETCH_RETRY_DELAYS_MS;
  const sleep = options.sleepImpl ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      lastError = error;
      if (attempt === delays.length) throw error;
      await sleep(delays[attempt]);
      continue;
    }
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    lastError = new Error(`${url}: HTTP ${response.status}`);
    if (!retryableHttpStatus(response.status) || attempt === delays.length) throw lastError;
    await response.body?.cancel?.();
    await sleep(retryAfterMilliseconds(response) ?? delays[attempt]);
  }
  throw lastError;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})`);
  }
}

function referencedCompilerObjects(compiler, subtrees) {
  const references = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      // Match authenticated root keys instead of fixed manifest field names so
      // compatible manifest revisions can add and remove compiler entries.
      if (value.startsWith("@compiler:") && Object.hasOwn(subtrees, value)) references.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(compiler);
  return [...references].sort();
}

/**
 * Fetch, authenticate and cache the realization closure for an exact Defold
 * revision. Ordinary API namespace objects are intentionally not transferred:
 * the authenticated @compiler manifest names the document/source objects the
 * shipped realizer actually consumes.
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
  const environment = options.env ?? process.env;
  const offline = options.offline ?? environment.DEHERM_OFFLINE === "1";
  const fetchImpl = options.fetchImpl ?? ((url) => fetch(url, { signal: AbortSignal.timeout(30_000) }));
  const base = policyBase(index);
  const cacheHome = path.resolve(options.cacheHome ?? defoldSurfaceCacheHome(environment));
  const cacheRoot = path.join(cacheHome, "policies", index.base.layoutVersion ?? "v1");
  const transfer = { cacheHits: 0, cacheMisses: 0, cacheWrites: 0, transferBytes: 0 };

  const cachedFetch = async ({ relative, file, label, validate }) => {
    const cached = await readFile(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (cached) {
      try {
        const value = validate(cached, relative);
        transfer.cacheHits += 1;
        return { relative, bytes: cached, value, source: "cache" };
      } catch (error) {
        throw new Error(`Corrupt authenticated policy cache entry ${file}: ${error.message}`);
      }
    }
    transfer.cacheMisses += 1;
    if (offline) {
      throw new Error(`No authenticated cached ${label} for Defold ${revision} at ${file}; DEHERM_OFFLINE=1`);
    }
    const url = `${base}/${relative}`;
    const bytes = await fetchBytes(url, fetchImpl, options);
    transfer.transferBytes += bytes.length;
    const value = validate(bytes, relative);
    if (await atomicWrite(file, bytes)) transfer.cacheWrites += 1;
    return { relative, bytes, value, source: url };
  };

  // Revision entries and artifact mappings are replaceable publication
  // pointers, not content-addressed objects. Revalidate them from the site
  // whenever networking is allowed, while retaining the last validated copy
  // for explicit offline use.
  const refreshableFetch = async ({ relative, file, label, validate }) => {
    if (offline) {
      const cached = await readFile(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (!cached) {
        transfer.cacheMisses += 1;
        throw new Error(`No cached ${label} for Defold ${revision} at ${file}; DEHERM_OFFLINE=1`);
      }
      try {
        const value = validate(cached, relative);
        transfer.cacheHits += 1;
        return { relative, bytes: cached, value, source: "cache" };
      } catch (error) {
        throw new Error(`Corrupt cached ${label} ${file}: ${error.message}`);
      }
    }
    transfer.cacheMisses += 1;
    const url = `${base}/${relative}`;
    const bytes = await fetchBytes(url, fetchImpl, options);
    transfer.transferBytes += bytes.length;
    const value = validate(bytes, relative);
    if (await atomicReplace(file, bytes)) transfer.cacheWrites += 1;
    return { relative, bytes, value, source: url };
  };

  const entryRelative = expand(index.base.index, { defoldRevision: revision });
  const entryResult = await refreshableFetch({
    relative: entryRelative,
    file: path.join(cacheRoot, "index", `${revision}.json`),
    label: "policy index entry",
    validate(bytes, label) {
      const entry = parseJson(bytes, label);
      if (entry.kind !== "deherm.policy.index-entry" || entry.defoldRevision !== revision ||
          !DIGEST_PATTERN.test(entry.policyRoot ?? "")) {
        throw new Error(`${label}: invalid policy index entry for ${revision}`);
      }
      validateRealizer(entry.realizer, label);
      return entry;
    }
  });
  const entry = entryResult.value;
  const packageVersion = await assertCompatibleRealizer(revision, entry.realizer, options);
  const shipped = index.entries?.find((candidate) => candidate.defoldRevision === revision);
  if (shipped && (shipped.policyRoot !== entry.policyRoot || shipped.generator !== entry.generator ||
      !sameRealizer(shipped.realizer, entry.realizer))) {
    throw new Error(`${revision}: published entry contradicts this package's shipped index`);
  }

  const rootRelative = expand(index.base.policy, { policyRoot: entry.policyRoot });
  const rootResult = await cachedFetch({
    relative: rootRelative,
    file: path.join(cacheRoot, "policy", `${entry.policyRoot}.json`),
    label: "policy root",
    validate(bytes, label) {
      if (hashBytes(bytes) !== entry.policyRoot) throw new Error(`${label}: policy bytes do not hash to ${entry.policyRoot}`);
      const policy = parseJson(bytes, label);
      if (policy.kind !== "deherm.policy.root" || policy.generator !== entry.generator || !policy.subtrees) {
        throw new Error(`${label}: invalid policy root`);
      }
      validateRealizer(policy.realizer, label);
      if (!sameRealizer(policy.realizer, entry.realizer)) {
        throw new Error(`${label}: policy realizer contract does not match its index entry`);
      }
      return policy;
    }
  });
  const policy = rootResult.value;

  const objects = new Map();
  const loadObject = async (namespace) => {
    if (objects.has(namespace)) return objects.get(namespace);
    const digest = policy.subtrees[namespace];
    if (!DIGEST_PATTERN.test(digest ?? "")) {
      throw new Error(`${rootResult.relative}: ${namespace} has invalid or missing object digest`);
    }
    const relative = expand(index.base.object, { subtreeHash: digest });
    const result = await cachedFetch({
      relative,
      file: path.join(cacheRoot, "object", `${digest}.json`),
      label: `${namespace} policy object`,
      validate(bytes, label) {
        if (hashBytes(bytes) !== digest) throw new Error(`${label}: object bytes do not hash to ${digest}`);
        const object = parseJson(bytes, label);
        if (object.namespace !== namespace && namespace !== "@profiles" && namespace !== "@toolchain") {
          throw new Error(`${label}: object names namespace ${object.namespace}, expected ${namespace}`);
        }
        return object;
      }
    });
    const record = { digest, bytes: result.bytes, value: result.value };
    objects.set(namespace, record);
    return record;
  };

  const compiler = await loadObject("@compiler");
  await loadObject("@toolchain");
  for (const namespace of referencedCompilerObjects(compiler.value, policy.subtrees)) await loadObject(namespace);

  let artifacts = null;
  if (index.base.artifacts) {
    const relative = expand(index.base.artifacts, { defoldRevision: revision });
    const result = await refreshableFetch({
      relative,
      file: path.join(cacheRoot, "artifacts", `${revision}.json`),
      label: "artifact mapping",
      validate(bytes, label) {
        const value = parseJson(bytes, label);
        if (value.kind !== "deherm.policy.artifacts" || value.defoldRevision !== revision ||
            value.artifacts?.["native-artifacts"]?.indexedBy !== "bundleTarget") {
          throw new Error(`${label}: invalid artifact mapping for ${revision}`);
        }
        return value;
      }
    });
    artifacts = { ...result.value, releaseAsset: index.base.releaseAsset ?? null };
  }

  const receipt = {
    schemaVersion: 2,
    kind: "deherm.policy.receipt",
    defoldRevision: revision,
    policyRoot: entry.policyRoot,
    generator: entry.generator,
    objects: Object.fromEntries([...objects].map(([namespace, { digest }]) => [namespace, digest]))
  };
  const receiptFile = path.join(cacheRoot, "receipt", revision, `${entry.policyRoot}.json`);
  const priorReceipt = await readFile(receiptFile, "utf8")
    .then((source) => JSON.parse(source), (error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (priorReceipt && (priorReceipt.defoldRevision !== revision || priorReceipt.policyRoot !== entry.policyRoot)) {
    throw new Error(`Corrupt authenticated policy receipt ${receiptFile}: revision or policy root mismatch`);
  }
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  // Schema-1 receipts from eager clients remain valid evidence for the same
  // exact revision/root. Do not rewrite immutable evidence merely to add the
  // smaller realization-closure inventory introduced by schema 2.
  if (!priorReceipt && await atomicWrite(receiptFile, receiptBytes)) transfer.cacheWrites += 1;

  const surfaceBase = path.resolve(options.surfaceRoot ?? path.join(cacheHome, "surfaces", revision));
  const materialize = options.materializeImpl === false ? null : options.materializeImpl ?? materializePolicySurface;
  const realization = policySurfaceRealizationIdentity({ entry, packageVersion, artifacts });
  let surface = null;
  if (materialize) {
    surface = await publishPolicySurface({ revision, entry, policy, objects }, {
      revision,
      realization,
      surfaceBase,
      surfaceBoundary: path.resolve(options.surfaceBoundary ?? cacheHome),
      materialize,
      artifacts,
      verifySurface: options.verifySurfaceImpl ?? verifyMaterializedSurfaceRoot
    });
    const pointer = {
      schemaVersion: 1,
      kind: "deherm.materialized-defold-surface-pointer",
      defoldRevision: revision,
      realizationId: realization.realizationId,
      policyRoot: realization.policyRoot
    };
    if (await atomicReplace(path.join(surfaceBase, "current.json"), Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`))) {
      transfer.cacheWrites += 1;
    }
  }

  return {
    revision,
    entry,
    policy,
    objects,
    artifacts,
    cacheRoot,
    realization,
    receipt: receiptFile,
    surface,
    transfer,
    written: transfer.cacheWrites,
    source: `${base}/${entryRelative}`
  };
}
