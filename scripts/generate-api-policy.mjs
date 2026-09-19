#!/usr/bin/env node

// Derive one Defold revision's API policy and write it into the content-addressed
// policy store.
//
// See `.agents/docs/decisions/layered-api-policy-cache.md`. Everything this
// script consumes is already derived: the script API IR, the dmSDK IR, the
// source-derived Lua registration surface, the route availability profiles, the
// resource declaration schema, and the engine's own toolchain pins. What did not
// exist until now is the artifact that assembles them into something a user can
// consume without a Defold checkout.
//
// Three things this script is deliberately strict about:
//
//   * **No policy object may carry the revision.** The sha-to-root mapping is
//     the index's job, and only the index's. If a revision string reached a
//     subtree, every revision would produce a distinct root and the storage
//     argument for content addressing would stop holding silently.
//   * **The store is additive and verified as a closure.** `--check` refuses a
//     store with a dangling reference or an orphan object, because either one
//     means the committed store and the committed index disagree about what
//     exists.
//   * **Defold's toolchain pins are read, never restated.** `upstream.lock`
//     carries `EMSCRIPTEN_VERSION` as our pin of their number; the policy is the
//     authority, so a divergence is a hard failure here rather than a surprise
//     at link time.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import {
  assertNoRevisionLeak,
  buildIndexEntry,
  buildPolicy,
  hashBytes,
  indexPath,
  objectPath,
  policyPath,
  serializeObject
} from "../packages/compiler/src/api-policy.mjs";
import { buildToolchainPins } from "../packages/compiler/src/defold-toolchain-pins.mjs";
import { apiPolicyGenerator } from "./lib/script-generator-pipeline.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const storeRoot = path.join(root, "packages", "bindings", "generated", "policy");
export const manifestPath = path.join(root, "packages", "bindings", "generated", "defold-api-policy.json");
export const shippedIndexPath = path.join(root, "packages", "bindings", "generated", "defold-policy-index.json");
export const sitePath = path.join(root, "packages", "bindings", "policy-site.json");

const generatedDir = path.join(root, "packages", "bindings", "generated");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readSiteConfig(file = sitePath) {
  const config = await readJson(file);
  const url = new URL(config.baseUrl);
  const segments = [...url.pathname.split("/"), ...String(config.pathPrefix ?? "").split("/")]
    .filter((segment) => segment.length > 0);
  // The decision's hard constraint: everything sits beneath one segment this
  // project owns. A base with an empty path and no prefix would publish
  // `/v1/index/...` at the domain root, where it collides with whatever the
  // organisation site routes now or later.
  if (segments.length === 0) {
    throw new Error(
      `${path.relative(root, file)}: baseUrl "${config.baseUrl}" has no owned path segment and pathPrefix is empty. ` +
      "Nothing may be published at a root-level segment."
    );
  }
  if (!/^v\d+$/.test(config.layoutVersion)) {
    throw new Error(`${path.relative(root, file)}: layoutVersion must look like v1`);
  }
  return { ...config, ownedSegments: segments };
}

/**
 * The generator's own revision, so a policy derived by an older parser is
 * detectably stale. It hashes the sources the ownership registry declares, in
 * the order the registry declares them.
 */
export async function generatorRevision() {
  const digest = createHash("sha256");
  for (const relative of apiPolicyGenerator.sources) {
    digest.update(relative).update("\0").update(await readFile(path.join(root, relative))).update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function lockValue(lock, key) {
  return lock.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1] ?? null;
}

/**
 * Reconcile the numbers this repository pins against the engine's declaration.
 *
 * `upstream.lock` names an emsdk version so the bootstrap can check one out. The
 * policy is the authority for what that number must be, so a divergence is a
 * fail-closed blocker: an HTML5 build against a different Emscripten than the
 * engine's own is an ABI mismatch nobody discovers until the link.
 */
export function reconcileLocalPins({ lock, pins }) {
  const comparisons = [
    { local: "EMSCRIPTEN_VERSION", localValue: lockValue(lock, "EMSCRIPTEN_VERSION"), engine: "EMSCRIPTEN_VERSION_STR" },
    { local: "EMSDK_VERSION", localValue: lockValue(lock, "EMSDK_VERSION"), engine: "EMSCRIPTEN_VERSION_STR" }
  ].filter((row) => row.localValue !== null);
  const rows = comparisons.map((row) => ({
    localSymbol: row.local,
    localValue: row.localValue,
    engineSymbol: row.engine,
    engineValue: pins[row.engine],
    agrees: row.localValue === pins[row.engine]
  }));
  const divergent = rows.filter((row) => !row.agrees);
  if (divergent.length) {
    throw new Error(
      "upstream.lock restates a Defold toolchain pin and now disagrees with it:\n" +
      divergent.map((row) =>
        `  upstream.lock ${row.localSymbol}=${row.localValue} but sdk.py ${row.engineSymbol}="${row.engineValue}"`
      ).join("\n") +
      "\nThe policy is the authority. Update upstream.lock to the engine's number, or stop restating it."
    );
  }
  return rows;
}

export async function derivePolicy(options = {}) {
  const sourceRoot = options.sourceRoot ?? root;
  const artifacts = options.artifacts ?? generatedDir;
  const [scriptIr, dmsdkIr, registrationSurface, routeProfiles, resourceSchema] = await Promise.all([
    readJson(path.join(artifacts, "defold-script-api-ir.json")),
    readJson(path.join(artifacts, "defold-sdk-ir.json")),
    readJson(path.join(artifacts, "defold-lua-registration-surface.json")),
    readJson(path.join(artifacts, "defold-script-route-availability-profiles.json")),
    readJson(path.join(artifacts, "defold-resource-declaration-schema.json"))
  ]);

  // Every input must agree about which revision it describes. A policy assembled
  // from two revisions' artifacts would be exactly the failure the api-source
  // resolution decision exists to prevent: types that compile and are wrong.
  const revisions = new Map([
    ["defold-script-api-ir.json", scriptIr.defoldRevision],
    ["defold-sdk-ir.json", dmsdkIr.defoldRevision],
    ["defold-lua-registration-surface.json", registrationSurface.defoldRevision],
    ["defold-script-route-availability-profiles.json", routeProfiles.defoldRevision]
  ]);
  const distinct = new Set(revisions.values());
  if (distinct.size !== 1 || [...distinct][0] === undefined) {
    throw new Error(
      "Generated inputs disagree about the Defold revision:\n" +
      [...revisions].map(([file, revision]) => `  ${file}: ${revision ?? "(none)"}`).join("\n")
    );
  }
  const defoldRevision = [...distinct][0];

  const lock = await readFile(path.join(sourceRoot, "upstream.lock"), "utf8");
  const lockRevision = lockValue(lock, "DEFOLD_REV");
  if (lockRevision !== defoldRevision) {
    throw new Error(`upstream.lock pins ${lockRevision} but the generated surface describes ${defoldRevision}`);
  }

  const sdkSource = await readFile(path.join(sourceRoot, "upstream", "defold", "build_tools", "sdk.py"), "utf8");
  const buildInput = parseYaml(
    await readFile(path.join(sourceRoot, "upstream", "defold", "share", "extender", "build_input.yml"), "utf8")
  );
  if (!buildInput?.platforms) throw new Error("share/extender/build_input.yml declares no platforms map");
  const toolchain = buildToolchainPins({
    sdkSource,
    buildInputPlatforms: Object.keys(buildInput.platforms)
  });
  const reconciliation = reconcileLocalPins({ lock, pins: toolchain.pins });

  const generator = options.generator ?? await generatorRevision();
  const policy = buildPolicy({
    scriptIr,
    dmsdkIr,
    registrationSurface,
    routeProfiles,
    resourceSchema,
    toolchain,
    generator,
    repositoryRoot: sourceRoot
  });
  assertNoRevisionLeak({ rootBytes: policy.rootBytes, objects: policy.objects, revision: defoldRevision });
  return { ...policy, defoldRevision, generator, toolchain, reconciliation };
}

// ── The store ───────────────────────────────────────────────────────────────

async function listStoreFiles(directory) {
  const files = [];
  async function visit(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : 1)) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), next);
      else files.push(next);
    }
  }
  await visit(directory, "");
  return files;
}

/**
 * Read every index entry in the store and resolve the closure it implies.
 *
 * This is the same walk a consumer performs - sha to index, index to policy,
 * policy to objects - and it is what makes "re-running publishes nothing new"
 * checkable rather than asserted.
 */
export async function readStore(directory = storeRoot, layoutVersion = "v1") {
  const files = await listStoreFiles(directory);
  const entries = [];
  const referenced = new Set();
  const problems = [];
  for (const file of files) {
    if (!file.startsWith(`${layoutVersion}/index/`)) continue;
    const revision = path.basename(file, ".json");
    const entry = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    if (entry.defoldRevision !== revision) {
      problems.push(`${file} names revision ${entry.defoldRevision}`);
      continue;
    }
    entries.push(entry);
    const rootFile = policyPath(layoutVersion, entry.policyRoot);
    referenced.add(rootFile);
    let rootBytes;
    try {
      rootBytes = await readFile(path.join(directory, rootFile), "utf8");
    } catch {
      problems.push(`${file} points at ${rootFile}, which the store does not hold`);
      continue;
    }
    if (hashBytes(rootBytes) !== entry.policyRoot) problems.push(`${rootFile} does not hash to its own path`);
    for (const hash of Object.values(JSON.parse(rootBytes).subtrees)) {
      const object = objectPath(layoutVersion, hash);
      referenced.add(object);
      let bytes;
      try {
        bytes = await readFile(path.join(directory, object), "utf8");
      } catch {
        problems.push(`${rootFile} names ${object}, which the store does not hold`);
        continue;
      }
      if (hashBytes(bytes) !== hash) problems.push(`${object} does not hash to its own path`);
    }
  }
  const orphans = files.filter((file) => !file.startsWith(`${layoutVersion}/index/`) && !referenced.has(file));
  return { files, entries: entries.sort((a, b) => a.defoldRevision < b.defoldRevision ? -1 : 1), referenced, orphans, problems };
}

function buildShippedIndex({ site, entries }) {
  return {
    schemaVersion: 1,
    kind: "deherm.policy.index",
    comment:
      "Maps a Defold revision to the policy derived from it. An entry is keyed by a revision " +
      "Defold has already published and is written once, never rewritten, because that " +
      "revision's declaration inputs are fixed forever. Consumers FETCH the entry they need " +
      "from v1/index/<defold-sha>.json rather than relying on a shipped copy: Defold publishes " +
      "nightlies daily, so an index that had to be re-released to stay current would be a pin, " +
      "not an index. The policy an entry names is content-addressed and therefore " +
      "self-verifying, so a substituted policy fails its own hash check.",
    base: {
      url: site.baseUrl,
      pathPrefix: site.pathPrefix,
      layoutVersion: site.layoutVersion,
      index: `${site.layoutVersion}/index/{defoldRevision}.json`,
      policy: `${site.layoutVersion}/policy/{policyRoot}.json`,
      object: `${site.layoutVersion}/object/{subtreeHash}.json`
    },
    channels: site.channels,
    channelInfoUrl: site.channelInfoUrl,
    entries: entries.map(({ defoldRevision, policyRoot, generator }) => ({ defoldRevision, policyRoot, generator }))
  };
}

function buildManifest({ policy, site, entries, reconciliation }) {
  const objectSizes = Object.fromEntries(
    Object.entries(policy.root.subtrees).map(([key, hash]) => [key, policy.objects.get(hash).length])
  );
  return {
    schemaVersion: 1,
    kind: "deherm.policy.manifest",
    comment:
      "A reviewable statement of what this checkout's policy store holds. It is NOT a policy " +
      "object: it names the revision, which no content-addressed object may, and it records " +
      "the reconciliation between upstream.lock's restated pins and Defold's own declaration.",
    generator: policy.generator,
    defoldRevision: policy.defoldRevision,
    policyRoot: policy.rootHash,
    layoutVersion: site.layoutVersion,
    counts: {
      ...policy.root.counts,
      objectBytes: [...policy.objects.values()].reduce((total, bytes) => total + bytes.length, 0),
      indexEntries: entries.length
    },
    toolchainPins: policy.toolchain.pins,
    localPinReconciliation: reconciliation,
    subtrees: Object.fromEntries(
      Object.entries(policy.root.subtrees)
        .sort(([left], [right]) => left < right ? -1 : 1)
        .map(([key, hash]) => [key, { hash, bytes: objectSizes[key] }])
    )
  };
}

export async function writeStore({ policy, site, check }) {
  const layout = site.layoutVersion;
  const planned = new Map();
  planned.set(policyPath(layout, policy.rootHash), policy.rootBytes);
  for (const [hash, bytes] of policy.objects) planned.set(objectPath(layout, hash), bytes);
  const entry = buildIndexEntry({
    defoldRevision: policy.defoldRevision,
    policyRoot: policy.rootHash,
    generator: policy.generator
  });
  planned.set(indexPath(layout, policy.defoldRevision), `${serializeObject(entry)}\n`);

  const existing = await listStoreFiles(storeRoot);
  const existingSet = new Set(existing);
  const written = [];
  const republished = [];
  for (const [file, bytes] of planned) {
    const absolute = path.join(storeRoot, file);
    if (existingSet.has(file)) {
      const current = await readFile(absolute, "utf8");
      if (current === bytes) continue;
      republished.push(file);
      if (check) continue;
    } else {
      written.push(file);
      if (check) continue;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  // A content-addressed object whose path no root names is unreachable, so it is
  // removed rather than left to make the store's size a mystery.
  const store = await readStore(check ? storeRoot : storeRoot, layout);
  return { written, republished, orphans: store.orphans, problems: store.problems, entries: store.entries };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => !["--check", "--prune"].includes(argument));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const prune = argv.includes("--prune");

  const site = await readSiteConfig();
  const policy = await derivePolicy();
  const result = await writeStore({ policy, site, check });

  if (prune && !check && result.orphans.length) {
    for (const file of result.orphans) await rm(path.join(storeRoot, file));
  }
  const store = await readStore(storeRoot, site.layoutVersion);

  const shippedIndex = `${JSON.stringify(buildShippedIndex({ site, entries: store.entries }), null, 2)}\n`;
  const manifest = `${JSON.stringify(
    buildManifest({ policy, site, entries: store.entries, reconciliation: policy.reconciliation }),
    null,
    2
  )}\n`;

  const failures = [...store.problems];
  if (store.orphans.length && !prune) {
    failures.push(`${store.orphans.length} unreferenced objects in the store: ${store.orphans.slice(0, 3).join(", ")}…`);
  }
  if (check) {
    if (result.written.length) failures.push(`${result.written.length} policy objects are missing from the store`);
    if (result.republished.length) failures.push(`${result.republished.length} stored objects disagree with the derivation`);
    if (await readFile(shippedIndexPath, "utf8").catch(() => "") !== shippedIndex) failures.push("defold-policy-index.json is stale");
    if (await readFile(manifestPath, "utf8").catch(() => "") !== manifest) failures.push("defold-api-policy.json is stale");
    if (failures.length) throw new Error(`Policy store check failed:\n  ${failures.join("\n  ")}`);
  } else {
    if (failures.length) throw new Error(`Policy store is inconsistent:\n  ${failures.join("\n  ")}`);
    await writeFile(shippedIndexPath, shippedIndex);
    await writeFile(manifestPath, manifest);
  }

  const bytes = [...policy.objects.values()].reduce((total, value) => total + value.length, 0);
  console.log(
    `${check ? "Verified" : "Generated"} policy ${policy.rootHash.slice(0, 12)} for ${policy.defoldRevision.slice(0, 12)}: ` +
    `${policy.root.counts.namespaces} namespaces, ${policy.root.counts.subtrees} subtrees, ` +
    `${(bytes / 1e6).toFixed(2)} MB, ${store.entries.length} index entries` +
    (check ? "" : ` (${result.written.length} new objects, ${result.republished.length} rewritten)`)
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
