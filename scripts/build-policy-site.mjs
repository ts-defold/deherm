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

import { ARTIFACTS_DOCUMENT_KIND, artifactsPath, hashBytes } from "../packages/generator/src/policy/api-policy.mjs";
import { buildArtifactReferences, readSiteConfig, readStore, shippedIndexPath, storeRoot } from "./generate-api-policy.mjs";

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
// A 1.91:1 card, because the wordmark's own 3:1 is cropped badly by every
// unfurler. Regenerate with sips: fit the wordmark to 1000px wide, then pad to
// 1200x630 with the page background (262626) so the card has no seam.
const ogImagePath = path.join(root, "docs", "assets", "brand", "deherm-og.png");

// Intrinsic size straight from the PNG's IHDR, so the markup can pin the
// aspect ratio and the browser reserves the space before the image loads.
// Hardcoding it would silently drift the moment the asset is replaced.
function pngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("Expected a PNG when reading intrinsic image dimensions");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Deliberately minimal. This page exists so a human who lands on a hash URL can
// tell what the store is and where the project lives; the policies themselves
// are machine-fetched and explain nothing to a browser. Prose about the design
// belongs in the decision record, not on the artifact host.
function landingPage({ site, plan, defoldRevision, wordmark, ogImage }) {
  const published = `${site.baseUrl.replace(/\/$/, "")}${site.pathPrefix ? `/${site.pathPrefix}` : ""}`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>d\u00e9herm \u2014 TypeScript for Defold</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="d\u00e9herm is a TypeScript runtime and tool kit for Defold. Use TypeScript anywhere Defold runs, powered by Hermes, the same JS runtime used by react-native.">
<link rel="canonical" href="${escapeHtml(published)}/">
<meta name="theme-color" content="#262626">
<meta property="og:type" content="website">
<meta property="og:site_name" content="d\u00e9herm">
<meta property="og:title" content="d\u00e9herm \u2014 TypeScript for Defold">
<meta property="og:description" content="Use TypeScript anywhere Defold runs, powered by Hermes, the same JS runtime used by react-native.">
<meta property="og:url" content="${escapeHtml(published)}/">
<meta property="og:image" content="${escapeHtml(published)}/deherm-og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${ogImage.width}">
<meta property="og:image:height" content="${ogImage.height}">
<meta property="og:image:alt" content="d\u00e9herm">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="d\u00e9herm \u2014 TypeScript for Defold">
<meta name="twitter:description" content="Use TypeScript anywhere Defold runs, powered by Hermes, the same JS runtime used by react-native.">
<meta name="twitter:image" content="${escapeHtml(published)}/deherm-og.png">
<meta name="twitter:image:alt" content="d\u00e9herm">
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
  .wrap { max-width: 58rem; margin: 0 auto; padding: 4rem 1.5rem 5rem; }
  header { text-align: center; margin-bottom: 2.5rem; }
  header img { width: 100%; max-width: 30rem; height: auto; aspect-ratio: ${wordmark.width} / ${wordmark.height}; }
  .alpha {
    display: inline-block; margin-top: 1.25rem; padding: .3rem .7rem;
    border: 1px solid var(--heart); border-radius: 999px;
    color: #ff6b6b; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase;
  }
  p { color: var(--ink-dim); }
  p strong { color: var(--ink); font-weight: 600; }
  a { color: var(--cyan); }
  .tagline { color: var(--ink-dim); margin: 1rem 0 0; }
  .links { margin: 1.75rem 0 2.5rem; display: flex; gap: 1.25rem; flex-wrap: wrap; }
  .links a {
    display: inline-flex; align-items: center; gap: .45rem; text-decoration: none;
    color: var(--ink-dim); border: 1px solid var(--basalt-3); border-radius: 5px;
    padding: .4rem .8rem; font-size: .85rem;
  }
  .links a:hover { color: var(--cyan); border-color: var(--cyan); }
  .links svg { width: 1.05em; height: 1.05em; fill: currentColor; }
  h2 {
    font-size: .78rem; letter-spacing: .1em; text-transform: uppercase;
    color: var(--sand); margin: 0 0 .9rem; font-weight: 600;
  }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre .base { color: var(--ink-dim); display: block; margin-bottom: .55rem; }
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
  <img src="deherm-wordmark.png" alt="d\u00e9herm" width="${wordmark.width}" height="${wordmark.height}" fetchpriority="high">
  <p class="tagline">Content-addressed Defold API policies, derived from engine sources.</p>
  <span class="alpha">Early alpha &middot; nothing here is stable</span>
</header>

<p>
  <strong>d\u00e9herm</strong> is a TypeScript runtime and tool kit for
  <a href="https://defold.com">Defold</a>. Use TypeScript anywhere Defold runs,
  powered by Hermes, the same JS runtime used by react-native.
</p>

<div class="links">
  <a href="https://github.com/ts-defold/deherm">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
    GitHub
  </a>
  <a href="https://www.npmjs.com/package/@ts-defold/deherm">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm6.666 6.664H5.334v-4H3.999v4H1.335V8.667h5.331v5.331zm4 0v1.336H8.001V8.667h5.334v5.332h-2.669zm12.001 0h-1.33v-4h-1.336v4h-1.335v-4h-1.33v4h-2.671V8.667h8.002v5.331zM10.665 10H12v2.667h-1.335V10z"/></svg>
    npm
  </a>
</div>

<h2>URL schema</h2>
<pre><span class="base">${escapeHtml(published)}/</span>${escapeHtml(site.layoutVersion)}/index/&lt;defold-sha&gt;.json     &rarr; { policyRoot, generator }
${escapeHtml(site.layoutVersion)}/policy/&lt;root-hash&gt;.json     &rarr; names its subtrees
${escapeHtml(site.layoutVersion)}/object/&lt;subtree-hash&gt;.json  &rarr; one namespace's surface</pre>

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

  // The artifact mapping is emitted here rather than committed to the store,
  // because it is a function of the BUILD RECIPE and not of the engine: a tag
  // rotates when a Dockerfile changes. Keeping it out of the store is what lets
  // an index entry stay a pure, write-once function of its Defold revision, and
  // stops a build-script edit invalidating a policy derived months earlier.
  //
  // Every indexed revision gets one, naming the tags this publish is current
  // for. It is the one served document that is legitimately rewritten.
  const artifactReferences = options.artifactReferences ?? await buildArtifactReferences();
  for (const entry of store.entries) {
    const document = {
      schemaVersion: 1,
      kind: ARTIFACTS_DOCUMENT_KIND,
      defoldRevision: entry.defoldRevision,
      artifacts: artifactReferences
    };
    files.set([...prefix, artifactsPath(site.layoutVersion, entry.defoldRevision)].join("/"),
      Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
  }
  const plan = JSON.parse(await readFile(options.planPath ?? planPath, "utf8"));
  // The wordmark and the unfurl card are the only non-generated bytes the site
  // serves. They sit beside index.html rather than under the layout prefix,
  // because they belong to the page and not to the versioned object scheme.
  const wordmarkBytes = await readFile(wordmarkPath);
  const ogImageBytes = await readFile(ogImagePath);
  files.set([...prefix, "index.html"].join("/"), Buffer.from(landingPage({
    site,
    plan,
    defoldRevision: plan.defoldRevision,
    wordmark: pngSize(wordmarkBytes),
    ogImage: pngSize(ogImageBytes)
  })));
  files.set([...prefix, "deherm-wordmark.png"].join("/"), wordmarkBytes);
  files.set([...prefix, "deherm-og.png"].join("/"), ogImageBytes);
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
