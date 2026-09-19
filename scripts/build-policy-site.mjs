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

// The figures here are read from the canonical generation plan rather than
// written into the markup. A hand-maintained number on a public page is a claim
// nothing checks: if the plan moves and this page is not regenerated the page is
// stale in a way the next run corrects, whereas a literal would be wrong in a
// way nothing would ever notice.
const planPath = path.join(root, "packages", "bindings", "generated", "defold-binding-lowering-plan.json");
const wordmarkPath = path.join(root, "docs", "assets", "brand", "deherm-wordmark-basalt-heart.png");

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const groupDigits = (value) => Number(value).toLocaleString("en-US");

function landingPage({ site, entries, objectCount, plan, defoldRevision }) {
  const published = `${site.baseUrl.replace(/\/$/, "")}${site.pathPrefix ? `/${site.pathPrefix}` : ""}`;
  const hermes = plan.runtimes.hermes;
  const browser = plan.runtimes.browser;

  // Transport rows, not "backends". A transport is how a route reaches the
  // engine within a runtime; calling them backends invited the reading that they
  // are separate engines, which they are not.
  const transports = [
    ["hermes", "jsi", hermes.byTransport["jsi"].emit, hermes.unitsWithAnyTransport],
    ["hermes", "lua-stack", hermes.byTransport["lua-stack"].emit, hermes.unitsWithAnyTransport],
    ["hermes", "typed-native", hermes.byTransport["typed-native"].emit, hermes.unitsWithAnyTransport],
    ["browser", "direct-memory", browser.byTransport["direct-memory"].emit, browser.unitsWithAnyTransport]
  ];

  const facts = [
    [groupDigits(entries.length), entries.length === 1 ? "Revision indexed" : "Revisions indexed", "Defold engine revisions with a published policy"],
    [groupDigits(objectCount), "Objects", "content-addressed namespace subtrees, shared across revisions"],
    [groupDigits(plan.coverage.scriptUnits), "Script routes", "Lua-registered functions the compiler projects"],
    [groupDigits(plan.coverage.dmsdkUnits), "dmSDK declarations", "native runtime declarations carried alongside them"],
    [groupDigits(plan.tables.marshallingPrograms.length), "Marshalling programs", "distinct argument and result conversion programs"],
    [groupDigits(plan.tables.contracts.length), "Interned contracts", "after interning; many routes share one contract"]
  ];

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>deherm policy store</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Content-addressed Defold API policies derived from engine sources.">
<style>
  :root {
    --basalt: #262626; --basalt-2: #303030; --basalt-3: #3a3a3a; --basalt-4: #585858;
    --ink: #e8e6e3; --ink-dim: #a5a19c;
    --ember: #d75f00; --amber: #d78700; --sand: #d7af5f; --slate: #5f5f87; --cyan: #00afd7;
    --heart: #d70000;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--basalt); color: var(--ink);
    font: 15px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 56rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
  header { text-align: center; margin-bottom: 3rem; }
  header img { width: 100%; max-width: 34rem; height: auto; }
  .tagline { color: var(--ink-dim); margin: 1rem 0 0; }
  .alpha {
    display: inline-block; margin-top: 1.25rem; padding: .3rem .7rem;
    border: 1px solid var(--heart); border-radius: 999px;
    color: #ff6b6b; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase;
  }
  h2 {
    font-size: .8rem; letter-spacing: .1em; text-transform: uppercase;
    color: var(--sand); margin: 3rem 0 1rem; font-weight: 600;
  }
  p { color: var(--ink-dim); }
  p strong { color: var(--ink); font-weight: 600; }
  a { color: var(--cyan); }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { background: var(--basalt-2); padding: .12em .4em; border-radius: 3px; font-size: .9em; }
  pre {
    background: var(--basalt-2); border: 1px solid var(--basalt-3); border-left: 3px solid var(--ember);
    padding: 1rem 1.15rem; border-radius: 5px; overflow-x: auto; font-size: .82rem; line-height: 1.7;
  }
  pre code { background: none; padding: 0; }
  .facts { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
  .fact { background: var(--basalt-2); border: 1px solid var(--basalt-3); border-radius: 6px; padding: 1rem; }
  .fact b { display: block; font-size: 1.7rem; font-weight: 600; color: var(--amber); line-height: 1.2; }
  .fact span { display: block; font-size: .78rem; color: var(--ink); margin-top: .35rem; }
  .fact em { display: block; font-size: .72rem; color: var(--ink-dim); font-style: normal; margin-top: .3rem; }
  table { width: 100%; border-collapse: collapse; font-size: .88rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--basalt-3); }
  th { color: var(--ink-dim); font-weight: 500; font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--amber); }
  .bar { height: 3px; background: var(--basalt-4); border-radius: 2px; overflow: hidden; min-width: 4rem; }
  .bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--ember), var(--sand)); }
  .note { border-left: 3px solid var(--slate); padding: .1rem 0 .1rem 1rem; color: var(--ink-dim); font-size: .88rem; }
  footer {
    margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--basalt-3);
    color: var(--ink-dim); font-size: .78rem;
  }
</style>

<div class="wrap">
<header>
  <img src="deherm-wordmark.png" alt="d\u00e9herm">
  <p class="tagline">Content-addressed Defold API policies, derived from engine sources.</p>
  <span class="alpha">Early alpha &middot; nothing here is stable</span>
</header>

<p>
  A <strong>policy</strong> is the source-derived record of a Lua-shaped surface:
  which functions are registered, under which module, with which parameter types,
  arity, optionality, results and constants &mdash; plus every construct the parser
  refused, with its reason. Documentation is not authority; the Lua C registration
  and the C function body are.
</p>

<h2>The URL scheme is the key</h2>
<pre><code>${escapeHtml(published)}/${escapeHtml(site.layoutVersion)}/index/&lt;defold-sha&gt;.json    &rarr; { policyRoot, generator }
${escapeHtml(published)}/${escapeHtml(site.layoutVersion)}/policy/&lt;root-hash&gt;.json    &rarr; names its subtrees
${escapeHtml(published)}/${escapeHtml(site.layoutVersion)}/object/&lt;subtree-hash&gt;.json &rarr; one namespace's surface</code></pre>

<p class="note">
  Every object under <code>policy/</code> and <code>object/</code> is
  <strong>immutable and self-verifying</strong>: fetch it, hash the bytes with
  SHA-256, and compare to the hash in the path. A hostile or corrupted mirror
  cannot substitute content without changing the hash, so the transport needs no
  trust beyond availability. An index entry is keyed by a revision Defold has
  already published and is written once, never rewritten &mdash; so it is fetched
  per revision rather than shipped as a growing manifest. Unchanged subtrees
  across revisions are the same URL, and therefore already in your cache.
</p>

<h2>Derived surface</h2>
<div class="facts">
${facts.map(([value, label, detail]) => `  <div class="fact"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span><em>${escapeHtml(detail)}</em></div>`).join("\n")}
</div>

<h2>Transport selection</h2>
<table>
  <tr><th>Runtime</th><th>Transport</th><th>Routes</th><th style="width:30%"></th></tr>
${transports.map(([runtime, transport, emit, reachable]) => `  <tr><td>${escapeHtml(runtime)}</td><td><code>${escapeHtml(transport)}</code></td><td class="num">${groupDigits(emit)} / ${groupDigits(reachable)}</td><td><div class="bar"><i style="width:${(emit / reachable * 100).toFixed(1)}%"></i></div></td></tr>`).join("\n")}
</table>
<p class="note">
  A transport is how a route reaches the engine <em>within</em> a runtime &mdash;
  not a separate engine. This is transport selection only: it is not compile,
  link, runtime, or conformance evidence.
</p>

<h2>Why a static site</h2>
<p>
  Release assets suit a handful of large files with semantic tags. They suit
  thousands of small content-addressed blobs badly. Here the path <em>is</em> the
  hash, so a revision whose declaration inputs did not change publishes nothing
  at all &mdash; the subtree hashes already exist, and the index simply gains one
  more pointer at them.
</p>

<footer>
  Defold <code>${escapeHtml(defoldRevision.slice(0, 12))}</code>
  &middot; plan <code>${escapeHtml(plan.planSha256.slice(0, 12))}</code>
  &middot; layout <code>${escapeHtml(site.layoutVersion)}</code>
  <br>
  Source: <a href="https://github.com/ts-defold/deherm">ts-defold/deherm</a>.
  This branch is generated and re-derivable; it carries no history worth preserving.
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
  files.set([...prefix, "index.html"].join("/"), Buffer.from(landingPage({
    site,
    entries: store.entries,
    objectCount: store.referenced.size,
    plan,
    defoldRevision: plan.defoldRevision
  })));
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
