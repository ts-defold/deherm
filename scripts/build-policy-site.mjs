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

const planPath = path.join(root, "packages", "bindings", "generated", "defold-binding-lowering-plan.json");
const wordmarkPath = path.join(root, "docs", "assets", "brand", "deherm-wordmark-basalt-heart.png");

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Deliberately minimal. This page exists so a human who lands on a hash URL can
// tell what the store is and where the project lives; the policies themselves
// are machine-fetched and explain nothing to a browser. Prose about the design
// belongs in the decision record, not on the artifact host.
function landingPage({ site, plan, defoldRevision }) {
  const published = `${site.baseUrl.replace(/\/$/, "")}${site.pathPrefix ? `/${site.pathPrefix}` : ""}`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>deherm policy store</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Content-addressed Defold API policies derived from engine sources.">
<style>
  :root {
    --basalt: #262626; --basalt-2: #303030; --basalt-3: #3a3a3a;
    --ink: #e8e6e3; --ink-dim: #a5a19c;
    --ember: #d75f00; --sand: #d7af5f; --cyan: #00afd7; --heart: #d70000;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--basalt); color: var(--ink);
    font: 15px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 46rem; margin: 0 auto; padding: 4rem 1.5rem 5rem; }
  header { text-align: center; margin-bottom: 2.5rem; }
  header img { width: 100%; max-width: 30rem; height: auto; }
  .alpha {
    display: inline-block; margin-top: 1.25rem; padding: .3rem .7rem;
    border: 1px solid var(--heart); border-radius: 999px;
    color: #ff6b6b; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase;
  }
  p { color: var(--ink-dim); }
  p strong { color: var(--ink); font-weight: 600; }
  a { color: var(--cyan); }
  .links { margin: 1.75rem 0 2.5rem; display: flex; gap: 1.5rem; flex-wrap: wrap; }
  .links a { text-decoration: none; border-bottom: 1px solid transparent; }
  .links a:hover { border-bottom-color: var(--cyan); }
  h2 {
    font-size: .78rem; letter-spacing: .1em; text-transform: uppercase;
    color: var(--sand); margin: 0 0 .9rem; font-weight: 600;
  }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre {
    background: var(--basalt-2); border: 1px solid var(--basalt-3); border-left: 3px solid var(--ember);
    padding: 1rem 1.15rem; border-radius: 5px; overflow-x: auto; font-size: .82rem; line-height: 1.7;
    color: var(--ink);
  }
  footer {
    margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--basalt-3);
    color: var(--ink-dim); font-size: .78rem;
  }
</style>

<div class="wrap">
<header>
  <img src="deherm-wordmark.png" alt="d\u00e9herm">
  <span class="alpha">Early alpha &middot; nothing here is stable</span>
</header>

<p>
  <strong>d\u00e9herm</strong> is a TypeScript runtime for
  <a href="https://defold.com">Defold</a>, backed by Hermes on native targets and
  the browser's JavaScript engine on HTML5. It generates its Defold bindings
  rather than hand-writing them, covering both the Lua script API and the
  dmSDK native surface.
</p>
<p>
  This host serves the <strong>API policies</strong> those bindings are generated
  from: the registered surface of a pinned Defold revision, derived from engine
  sources and addressed by content hash.
</p>

<div class="links">
  <a href="https://github.com/ts-defold/deherm">GitHub &rarr;</a>
  <a href="https://www.npmjs.com/package/@ts-defold/deherm">npm &rarr;</a>
</div>

<h2>URL schema</h2>
<pre>${escapeHtml(published)}/${escapeHtml(site.layoutVersion)}/index/&lt;defold-sha&gt;.json    &rarr; { policyRoot, generator }
${escapeHtml(published)}/${escapeHtml(site.layoutVersion)}/policy/&lt;root-hash&gt;.json    &rarr; names its subtrees
${escapeHtml(published)}/${escapeHtml(site.layoutVersion)}/object/&lt;subtree-hash&gt;.json &rarr; one namespace's surface</pre>

<footer>
  Defold <code>${escapeHtml(defoldRevision.slice(0, 12))}</code>
  &middot; plan <code>${escapeHtml(plan.planSha256.slice(0, 12))}</code>
  &middot; layout <code>${escapeHtml(site.layoutVersion)}</code>
  <br>
  Generated and re-derivable from <a href="https://github.com/ts-defold/deherm">ts-defold/deherm</a>.
</footer>
</div>
</html>
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
  const plan = JSON.parse(await readFile(options.planPath ?? planPath, "utf8"));
  files.set([...prefix, "index.html"].join("/"),
    Buffer.from(landingPage({ site, plan, defoldRevision: plan.defoldRevision })));
  // The wordmark is the only non-generated byte the site serves. It sits beside
  // index.html rather than under the layout prefix, because it belongs to the
  // page and not to the versioned object scheme.
  files.set([...prefix, "deherm-wordmark.png"].join("/"), await readFile(wordmarkPath));
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
