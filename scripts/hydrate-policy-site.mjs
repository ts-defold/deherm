#!/usr/bin/env node

// Seed a checkout's one-revision offline policy store from the accumulated
// branch-served site before a nightly derives another revision. `main` stays
// intentionally small; the website is the catalogue. Without this hydration a
// no-op nightly would rebuild a one-entry site and erase every older revision.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readSiteConfig, readStore, shippedIndexPath, storeRoot } from "./generate-api-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVISION = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;

async function walk(directory, prefix = "") {
  const rows = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...await walk(path.join(directory, entry.name), relative));
    else if (entry.isFile()) rows.push(relative);
  }
  return rows;
}

function assertEntry(entry, source) {
  if (!entry || entry.kind !== "deherm.policy.index-entry" || entry.schemaVersion !== 1 ||
      !REVISION.test(entry.defoldRevision ?? "") || !HASH.test(entry.policyRoot ?? "") ||
      !/^sha256:[0-9a-f]{64}$/u.test(entry.generator ?? "")) {
    throw new Error(`${source}: malformed policy index entry`);
  }
}

async function copyImmutable(source, destination, relative) {
  const from = path.join(source, relative);
  const to = path.join(destination, relative);
  const bytes = await readFile(from);
  const present = await readFile(to).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (present && !present.equals(bytes)) {
    throw new Error(`${relative}: published and packaged policy bytes disagree`);
  }
  if (!present) {
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, bytes);
    return true;
  }
  return false;
}

export async function hydratePolicySite(options) {
  const site = options.site ?? await readSiteConfig();
  const publishedRoot = path.resolve(options.from);
  const layoutSource = path.join(publishedRoot, ...site.pathPrefix.split("/").filter(Boolean), site.layoutVersion);
  const manifestFile = path.join(layoutSource, "index", "manifest.json");
  const published = JSON.parse(await readFile(manifestFile, "utf8"));
  if (published.kind !== "deherm.policy.index" || published.schemaVersion !== 1 || !Array.isArray(published.entries)) {
    throw new Error(`${manifestFile}: malformed published policy manifest`);
  }
  if (published.base?.layoutVersion !== site.layoutVersion) {
    throw new Error(`${manifestFile}: layout ${published.base?.layoutVersion} does not match ${site.layoutVersion}`);
  }

  const seen = new Set();
  for (const summary of published.entries) {
    if (!REVISION.test(summary?.defoldRevision ?? "") || !HASH.test(summary?.policyRoot ?? "") ||
        !/^sha256:[0-9a-f]{64}$/u.test(summary?.generator ?? "")) {
      throw new Error(`${manifestFile}: malformed entry summary`);
    }
    if (seen.has(summary.defoldRevision)) throw new Error(`${manifestFile}: duplicate ${summary.defoldRevision}`);
    seen.add(summary.defoldRevision);
    const entryFile = path.join(layoutSource, "index", `${summary.defoldRevision}.json`);
    const entry = JSON.parse(await readFile(entryFile, "utf8"));
    assertEntry(entry, entryFile);
    if (entry.policyRoot !== summary.policyRoot || entry.generator !== summary.generator) {
      throw new Error(`${entryFile}: entry does not match the published manifest`);
    }
  }

  const layoutDestination = path.join(options.store ?? storeRoot, site.layoutVersion);
  let copied = 0;
  for (const family of ["index", "policy", "object"]) {
    const familyRoot = path.join(layoutSource, family);
    for (const relative of await walk(familyRoot)) {
      if (family === "index" && relative === "manifest.json") continue;
      if (await copyImmutable(familyRoot, path.join(layoutDestination, family), relative)) copied += 1;
    }
  }

  const localIndexPath = options.index ?? shippedIndexPath;
  const local = JSON.parse(await readFile(localIndexPath, "utf8"));
  const merged = new Map(published.entries.map((entry) => [entry.defoldRevision, entry]));
  for (const entry of local.entries ?? []) {
    const prior = merged.get(entry.defoldRevision);
    if (prior && (prior.policyRoot !== entry.policyRoot || prior.generator !== entry.generator)) {
      throw new Error(`${entry.defoldRevision}: published and packaged policy entries disagree`);
    }
    merged.set(entry.defoldRevision, entry);
  }
  const document = {
    ...local,
    entries: [...merged.values()].sort((a, b) => a.defoldRevision.localeCompare(b.defoldRevision))
  };
  await writeFile(localIndexPath, `${JSON.stringify(document, null, 2)}\n`);

  const store = await readStore(options.store ?? storeRoot, site.layoutVersion);
  if (store.problems.length || store.orphans.length) {
    throw new Error([
      ...store.problems,
      ...(store.orphans.length ? [`${store.orphans.length} orphaned policy objects after hydration`] : [])
    ].join("\n"));
  }
  return { copied, revisions: document.entries.length };
}

function parseArguments(argv) {
  const options = { from: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--from") options.from = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.from) throw new Error("Usage: hydrate-policy-site.mjs --from <published-site-directory>");
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const report = await hydratePolicySite(parseArguments(argv));
  console.log(`Hydrated ${report.revisions} published policy revision(s); copied ${report.copied} new file(s).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
