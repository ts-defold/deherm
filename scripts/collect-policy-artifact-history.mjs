#!/usr/bin/env node

// Recover validated, immutable native release mappings from the policy site's
// Git history. This seeds per-compatibility reuse without changing policy roots.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readSiteConfig, readStore, storeRoot } from "./generate-api-policy.mjs";
import { expectedNativeCompatibility, validateArtifactReferences } from "./build-policy-site.mjs";
import { ARTIFACTS_DOCUMENT_KIND, hashBytes } from "../packages/compiler/src/api-policy.mjs";

export function collectArtifactHistory({ siteRoot, revisions, needed, git = execFileSync }) {
  const run = (...args) =>
    git("git", ["-C", siteRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const commits = run("log", "--format=%H", "--", "v1/artifacts").trim().split("\n").filter(Boolean);
  const found = new Map();
  for (const commit of commits) {
    const present = new Set(run("ls-tree", "-r", "--name-only", commit, "--", "v1/artifacts").trim().split("\n"));
    for (const revision of revisions) {
      const filename = `v1/artifacts/${revision}.json`;
      if (!present.has(filename)) continue;
      let document;
      try {
        const bytes = run("show", `${commit}:${filename}`);
        const pointer = JSON.parse(run("show", `${commit}:v1/index/${revision}.json`));
        document = JSON.parse(bytes);
        if (
          document.kind !== ARTIFACTS_DOCUMENT_KIND ||
          document.defoldRevision !== revision ||
          pointer.defoldRevision !== revision ||
          pointer.artifactsSha256 !== hashBytes(Buffer.from(bytes))
        )
          continue;
        validateArtifactReferences(document.artifacts, `${commit}:${filename}`, { requireIntegrity: true });
      } catch {
        continue; // Older layouts may not contain this document or its integrity records.
      }
      const references = document.artifacts;
      const compatibility = references["native-artifacts"]?.compatibility;
      if (!needed.has(compatibility?.sha256) || found.has(compatibility.sha256)) continue;
      found.set(compatibility.sha256, references);
      if (found.size === needed.size) return [...found.values()];
    }
  }
  return [...found.values()];
}

async function main(argv = process.argv.slice(2)) {
  if ((argv.length !== 4 && argv.length !== 6) || argv[0] !== "--site" || argv[2] !== "--out") {
    throw new Error(
      "Usage: collect-policy-artifact-history.mjs --site <checkout> --out <json> [--store <policy-store>]",
    );
  }
  const siteRoot = path.resolve(argv[1]);
  const output = path.resolve(argv[3]);
  if (argv.length === 6 && argv[4] !== "--store") throw new Error("--store must follow --out");
  const selectedStoreRoot = argv.length === 6 ? path.resolve(argv[5]) : storeRoot;
  const site = await readSiteConfig();
  const store = await readStore(selectedStoreRoot, site.layoutVersion);
  if (store.problems.length) throw new Error(`Policy store is inconsistent: ${store.problems.join("; ")}`);
  const needed = new Set();
  for (const entry of store.entries) {
    needed.add((await expectedNativeCompatibility(selectedStoreRoot, site.layoutVersion, entry)).sha256);
  }
  const references = collectArtifactHistory({
    siteRoot,
    revisions: store.entries.map(({ defoldRevision }) => defoldRevision),
    needed,
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(references, null, 2)}\n`);
  console.log(`Recovered ${references.length}/${needed.size} native compatibility mapping(s) from policy-site history`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
