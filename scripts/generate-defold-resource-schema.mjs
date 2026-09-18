#!/usr/bin/env node

// Derives the Defold resource declaration schema from pinned upstream sources:
// bob's builder annotations bind a file extension to the protobuf message its
// text resources parse as, and the message shape says which fields declare an
// addressable name.

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildResourceDeclarationSchema,
  parseBuilderAnnotations
} from "../packages/compiler/src/resource-declaration-schema.mjs";

const root = new URL("../", import.meta.url);
const builderDirectoryUrl = new URL(
  "upstream/defold/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/pipeline/",
  root
);
const protoRootUrl = new URL("upstream/defold/engine/", root);
const outputUrl = new URL("packages/bindings/generated/defold-resource-declaration-schema.json", root);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portable(value) {
  return value.split(path.sep).join("/");
}

async function collectFiles(directory, accept) {
  const matches = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && accept(absolute)) matches.push(absolute);
    }
  }
  await visit(directory);
  return matches;
}

export async function generateDefoldResourceSchema() {
  const repositoryRoot = fileURLToPath(root);
  const builderDirectory = fileURLToPath(builderDirectoryUrl);
  const protoRoot = fileURLToPath(protoRootUrl);
  const builderFiles = await collectFiles(builderDirectory, (file) => file.endsWith(".java"));
  const protoPaths = await collectFiles(protoRoot, (file) => file.endsWith(".proto"));

  const builders = [];
  const inputs = [];
  for (const file of builderFiles) {
    const source = await readFile(file, "utf8");
    const relative = portable(path.relative(repositoryRoot, file));
    const parsed = parseBuilderAnnotations(source, relative);
    if (!parsed.length) continue;
    builders.push(...parsed);
    inputs.push({ path: relative, sha256: sha256(source) });
  }
  const protoFiles = [];
  for (const file of protoPaths) {
    const source = await readFile(file, "utf8");
    protoFiles.push({ file: portable(path.relative(repositoryRoot, file)), source });
  }

  const { resources, blockers } = buildResourceDeclarationSchema({ builders, protoFiles });
  const usedProtos = new Set(resources.map(({ proto }) => proto));
  for (const { file, source } of protoFiles) {
    if (usedProtos.has(file)) inputs.push({ path: file, sha256: sha256(source) });
  }
  inputs.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const namespaceCount = resources.reduce((count, resource) => count + resource.namespaces.length, 0);
  return {
    schemaVersion: 1,
    generator: "scripts/generate-defold-resource-schema.mjs",
    derivation: [
      "extension-to-message from @ProtoParams(srcClass)/@BuilderParams(inExts) in bob's pipeline builders",
      "declaration site = repeated sub-message field whose element carries an identity string field",
      "identity field = a non-resource, non-runtime string field named id or name, else the sole string field",
      "namespace kind = a non-generic identity field name, else the singular primary field name",
      "sites reached through another declaration site are nested and never become a namespace"
    ],
    inputs,
    resourceCount: resources.length,
    namespaceCount,
    blockerCount: blockers.length,
    resources,
    blockers
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const report = await generateDefoldResourceSchema();
  const expected = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    if (await readFile(outputUrl, "utf8") !== expected) throw new Error(`${outputUrl.pathname} is stale`);
  } else await writeFile(outputUrl, expected);
  console.log(`${check ? "Verified" : "Generated"} ${report.resourceCount} Defold resource kinds ` +
    `with ${report.namespaceCount} declaration namespaces (${report.blockerCount} blockers).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
