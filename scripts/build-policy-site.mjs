#!/usr/bin/env node

// Emit the static policy site from the committed content-addressed store.
//
// See `.agents/docs/decisions/layered-api-policy-cache.md`. The emitted tree is
// exactly the URL scheme the decision specifies, beneath one owned prefix:
//
//   <base>/v1/index/<defold-sha>.json    -> { policyRoot, generator }
//   <base>/v1/policy/<root-hash>.json    -> names its subtrees
//   <base>/v1/object/<subtree-hash>.json -> one namespace's surface
//
// Three properties the emitter is responsible for:
//
//   * **Nothing at a root-level segment.** `readSiteConfig` refuses a base with
//     no owned path segment, so `/v1/index/...` can never land at a shared
//     domain's root where it would collide with whatever that site routes.
//   * **The base is data.** It is read from `packages/bindings/policy-site.json`
//     and written into the index the site serves, so relocating to another
//     repository, another domain or a CDN is an edit to that file - never a code
//     change, and never a release.
//   * **Re-running publishes nothing.** Objects are immutable, so a file already
//     present with identical bytes is left alone and reported as unchanged. That
//     is what makes the deploy workflow re-runnable rather than merely rerunnable
//     without error.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashBytes } from "../packages/compiler/src/api-policy.mjs";
import { readSiteConfig, readStore, shippedIndexPath, storeRoot } from "./generate-api-policy.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultOutputDirectory = path.join(root, "build", "policy-site");

async function walk(directory, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : 1)) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(path.join(directory, entry.name), next));
    else out.push(next);
  }
  return out;
}

function landingPage({ site, entries, objectCount }) {
  const published = `${site.baseUrl.replace(/\/$/, "")}${site.pathPrefix ? `/${site.pathPrefix}` : ""}`;
  return `<!doctype html>
<meta charset="utf-8">
<title>deherm API policy store</title>
<h1>deherm API policy store</h1>
<p>Content-addressed, source-derived API policies for pinned Defold engine revisions.</p>
<pre>${published}/${site.layoutVersion}/index/&lt;defold-sha&gt;.json    -&gt; { policyRoot, generator }
${published}/${site.layoutVersion}/policy/&lt;root-hash&gt;.json    -&gt; names its subtrees
${published}/${site.layoutVersion}/object/&lt;subtree-hash&gt;.json -&gt; one namespace's surface</pre>
<p>Every object under <code>policy/</code> and <code>object/</code> is immutable and self-verifying:
fetch it, hash the bytes with SHA-256, and compare to the hash in the path. Only the index is a
mutable mapping, and it also ships inside the npm package.</p>
<p>${entries.length} revision${entries.length === 1 ? "" : "s"} indexed, ${objectCount} objects.</p>
`;
}

export async function buildPolicySite(options = {}) {
  const site = options.site ?? await readSiteConfig();
  const output = options.output ?? defaultOutputDirectory;
  const store = await readStore(options.storeRoot ?? storeRoot, site.layoutVersion);
  if (store.problems.length) {
    throw new Error(`Refusing to publish an inconsistent store:\n  ${store.problems.join("\n  ")}`);
  }
  if (!store.entries.length) throw new Error("The policy store holds no index entries");
  if (store.orphans.length) {
    throw new Error(`Refusing to publish ${store.orphans.length} unreferenced objects: ${store.orphans.slice(0, 3).join(", ")}`);
  }

  const shippedIndex = JSON.parse(await readFile(options.shippedIndexPath ?? shippedIndexPath, "utf8"));
  // The index the site serves is the shipped index with the base this build is
  // publishing under, so a consumer that fetched the index knows where the rest
  // of the tree is without being told out of band.
  const served = {
    ...shippedIndex,
    base: {
      ...shippedIndex.base,
      url: options.baseUrl ?? shippedIndex.base.url,
      pathPrefix: options.pathPrefix ?? shippedIndex.base.pathPrefix
    }
  };

  const prefix = (options.pathPrefix ?? site.pathPrefix ?? "").split("/").filter(Boolean);
  const files = new Map();
  for (const relative of await walk(options.storeRoot ?? storeRoot)) {
    files.set([...prefix, relative].join("/"), await readFile(path.join(options.storeRoot ?? storeRoot, relative)));
  }
  // `manifest.json` cannot collide with a revision entry: a Defold sha is 40 hex
  // characters and this is not one. It is how a consumer discovers every indexed
  // revision and the base, without a listing endpoint.
  files.set([...prefix, site.layoutVersion, "index", "manifest.json"].join("/"),
    Buffer.from(`${JSON.stringify(served, null, 2)}\n`));
  files.set([...prefix, "index.html"].join("/"),
    Buffer.from(landingPage({ site, entries: store.entries, objectCount: store.referenced.size })));
  // Pages runs Jekyll unless told not to, and Jekyll drops paths it considers
  // private. Content-addressed names are hex, but this costs nothing and removes
  // a class of silent 404.
  files.set(".nojekyll", Buffer.from(""));

  const written = [];
  const unchanged = [];
  for (const [relative, bytes] of [...files].sort(([left], [right]) => left < right ? -1 : 1)) {
    const absolute = path.join(output, relative);
    const current = await readFile(absolute).catch(() => null);
    if (current && current.equals(bytes)) {
      unchanged.push(relative);
      continue;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    written.push(relative);
  }
  return { site, output, files: [...files.keys()], written, unchanged, entries: store.entries, served };
}

/** Re-verify the emitted tree the way a consumer would, against the file system. */
export async function verifyEmittedTree({ output, site, pathPrefix }) {
  const prefix = (pathPrefix ?? site.pathPrefix ?? "").split("/").filter(Boolean);
  const at = (...segments) => path.join(output, ...prefix, ...segments);
  const manifest = JSON.parse(await readFile(at(site.layoutVersion, "index", "manifest.json"), "utf8"));
  const checked = [];
  for (const entry of manifest.entries) {
    const indexBytes = await readFile(at(site.layoutVersion, "index", `${entry.defoldRevision}.json`), "utf8");
    const index = JSON.parse(indexBytes);
    if (index.policyRoot !== entry.policyRoot) throw new Error(`${entry.defoldRevision}: manifest and index entry disagree`);
    const rootBytes = await readFile(at(site.layoutVersion, "policy", `${index.policyRoot}.json`), "utf8");
    if (hashBytes(rootBytes) !== index.policyRoot) throw new Error(`policy ${index.policyRoot} does not hash to its path`);
    for (const [namespace, hash] of Object.entries(JSON.parse(rootBytes).subtrees)) {
      const bytes = await readFile(at(site.layoutVersion, "object", `${hash}.json`), "utf8");
      if (hashBytes(bytes) !== hash) throw new Error(`object ${hash} (${namespace}) does not hash to its path`);
      checked.push(hash);
    }
  }
  return { revisions: manifest.entries.length, objects: new Set(checked).size };
}

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") options.output = path.resolve(argv[++index]);
    else if (argument === "--base-url") options.baseUrl = argv[++index];
    else if (argument === "--path-prefix") options.pathPrefix = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  const result = await buildPolicySite(options);
  const verified = await verifyEmittedTree({
    output: result.output,
    site: result.site,
    pathPrefix: options.pathPrefix ?? result.site.pathPrefix
  });
  console.log(
    `Emitted ${result.files.length} files to ${path.relative(root, result.output)} ` +
    `(${result.written.length} written, ${result.unchanged.length} already current); ` +
    `verified ${verified.revisions} revision(s) and ${verified.objects} objects against their own paths; ` +
    `base ${result.served.base.url}${result.served.base.pathPrefix ? `/${result.served.base.pathPrefix}` : ""}`
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
