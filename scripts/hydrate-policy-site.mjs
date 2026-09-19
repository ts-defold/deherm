#!/usr/bin/env node

// Seed a checkout's one-revision offline policy store from the accumulated
// branch-served site before a nightly derives another revision. `main` stays
// intentionally small; the website is the catalogue. Without this hydration a
// no-op nightly would rebuild a one-entry site and erase every older revision.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readSiteConfig, readStore, shippedIndexPath, storeRoot } from "./generate-api-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVISION = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;

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

async function importPublishedClosure({ entry, layoutSource, layoutDestination }) {
  let copied = 0;
  const rootRelative = `policy/${entry.policyRoot}.json`;
  const root = JSON.parse(await readFile(path.join(layoutSource, rootRelative), "utf8"));
  for (const hash of Object.values(root.subtrees ?? {})) {
    if (!HASH.test(hash)) throw new Error(`${rootRelative}: malformed subtree hash`);
    if (await copyImmutable(layoutSource, layoutDestination, `object/${hash}.json`)) copied += 1;
  }
  if (await copyImmutable(layoutSource, layoutDestination, rootRelative)) copied += 1;
  if (await copyImmutable(layoutSource, layoutDestination, `index/${entry.defoldRevision}.json`)) copied += 1;
  return copied;
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

  const publishedEntries = new Map();
  for (const summary of published.entries) {
    if (!REVISION.test(summary?.defoldRevision ?? "") || !HASH.test(summary?.policyRoot ?? "") ||
        !/^sha256:[0-9a-f]{64}$/u.test(summary?.generator ?? "")) {
      throw new Error(`${manifestFile}: malformed entry summary`);
    }
    if (publishedEntries.has(summary.defoldRevision)) throw new Error(`${manifestFile}: duplicate ${summary.defoldRevision}`);
    const entryFile = path.join(layoutSource, "index", `${summary.defoldRevision}.json`);
    const entry = JSON.parse(await readFile(entryFile, "utf8"));
    assertEntry(entry, entryFile);
    if (entry.policyRoot !== summary.policyRoot || entry.generator !== summary.generator) {
      throw new Error(`${entryFile}: entry does not match the published manifest`);
    }
    publishedEntries.set(entry.defoldRevision, entry);
  }

  const layoutDestination = path.join(options.store ?? storeRoot, site.layoutVersion);
  const localIndexPath = options.index ?? shippedIndexPath;
  const local = JSON.parse(await readFile(localIndexPath, "utf8"));
  const localEntries = new Map((local.entries ?? []).map((entry) => [entry.defoldRevision, entry]));

  // A revision index is a replaceable pointer produced by a particular
  // generator, not a content-addressed object. When the parser improves, the
  // same immutable Defold source revision can legitimately acquire a better
  // policy root. The checkout is the authority for revisions it packages;
  // hydration imports only published revisions it does not already own (or an
  // identical closure when a custom/empty destination is being seeded).
  let copied = 0;
  for (const entry of publishedEntries.values()) {
    const packaged = localEntries.get(entry.defoldRevision);
    const agrees = packaged && packaged.policyRoot === entry.policyRoot && packaged.generator === entry.generator;
    if (packaged && !agrees) {
      const packagedEntryFile = path.join(layoutDestination, "index", `${entry.defoldRevision}.json`);
      const packagedEntry = JSON.parse(await readFile(packagedEntryFile, "utf8").catch((error) => {
        if (error.code === "ENOENT") {
          throw new Error(`${entry.defoldRevision}: packaged index claims the revision but its store entry is missing`);
        }
        throw error;
      }));
      assertEntry(packagedEntry, packagedEntryFile);
      if (packagedEntry.policyRoot !== packaged.policyRoot || packagedEntry.generator !== packaged.generator) {
        throw new Error(`${packagedEntryFile}: entry does not match the packaged index`);
      }
      continue;
    }
    copied += await importPublishedClosure({ entry, layoutSource, layoutDestination });
  }

  const merged = new Map(published.entries.map((entry) => [entry.defoldRevision, entry]));
  for (const entry of local.entries ?? []) merged.set(entry.defoldRevision, entry);
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
