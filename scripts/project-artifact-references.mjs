#!/usr/bin/env node

// Project the artifact mapping for the surface installed in this checkout.
//
// `release-tags.json` belongs to the shipped npm package: it tells that exact
// package which prebuilt tools to download. Policy publication may instead be
// processing a newly derived stable, beta, or alpha Defold surface. Its desired
// artifact mapping must therefore be computed from the installed derived inputs,
// not copied from the package's pinned release map.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildArtifactReferences } from "../packages/generator/src/policy/artifact-references.mjs";

export function artifactAssetRows(value, options = {}) {
  const references = value?.artifacts ?? value;
  if (!references || typeof references !== "object" || Array.isArray(references)) {
    throw new Error("artifact references must be an artifact mapping or published artifacts document");
  }
  const rows = [];
  for (const family of Object.keys(references).sort()) {
    const reference = references[family];
    if (!reference?.assets || typeof reference.assets !== "object") {
      throw new Error(`artifact references have an invalid ${family} family`);
    }
    if (reference.releases) {
      const assetKeys = Object.keys(reference.assets).sort();
      const releaseKeys = Object.keys(reference.releases).sort();
      if (JSON.stringify(assetKeys) !== JSON.stringify(releaseKeys)) {
        throw new Error(`artifact references have mismatched ${family} asset and release indexes`);
      }
    }
    for (const key of Object.keys(reference.assets).sort()) {
      const asset = reference.assets[key];
      if (typeof asset !== "string" || !asset.length) {
        throw new Error(`artifact references have an invalid ${family}/${key} asset`);
      }
      const tag = reference.releases?.[key]?.tag ?? reference.tag;
      if (typeof tag !== "string" || !tag.length) {
        throw new Error(`artifact references have no release coordinate for ${family}/${key}`);
      }
      rows.push({ family, key, tag, asset });
      if (options.includeIntegrity) rows.push({ family, key, tag, asset: `${asset}.integrity.json` });
    }
  }
  return rows;
}

async function main(argv = process.argv.slice(2)) {
  let input;
  let output;
  let list;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--from") input = path.resolve(argv[++index]);
    else if (argument === "--out") output = path.resolve(argv[++index]);
    else if (argument === "--list") list = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (list && !["archives", "all"].includes(list)) throw new Error("--list must be archives or all");
  if (output && list) throw new Error("--out and --list are mutually exclusive");

  const references = input ? JSON.parse(await readFile(input, "utf8")) : await buildArtifactReferences();
  if (list) {
    for (const row of artifactAssetRows(references, { includeIntegrity: list === "all" })) {
      process.stdout.write(`${row.family}\t${row.tag}\t${row.asset}\n`);
    }
    return;
  }
  const serialized = `${JSON.stringify(references, null, 2)}\n`;
  if (output) await writeFile(output, serialized);
  else process.stdout.write(serialized);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
