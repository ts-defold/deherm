#!/usr/bin/env node

// Compare the actual site bytes materialized from a policy store on each host.
// This needs no historical Defold archive: source derivation already happened
// on Linux, and cross-host parity concerns our package-owned projection.

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Policy site contains a symbolic link: ${child}`);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Policy site contains an unsupported entry: ${child}`);
  }
  return files;
}

export async function policySiteParity(root) {
  const files = await filesUnder(root);
  if (files.length === 0) throw new Error("Policy site is empty");
  const hash = createHash("sha256");
  let bytes = 0;
  for (const relative of files) {
    const file = path.join(root, ...relative.split("/"));
    if (!(await lstat(file)).isFile()) throw new Error(`Policy site file changed during hashing: ${relative}`);
    const content = await readFile(file);
    bytes += content.length;
    hash.update(`${relative}\0${content.length}\0`);
    hash.update(content);
    hash.update("\0");
  }
  return { schemaVersion: 1, files: files.length, bytes, sha256: hash.digest("hex") };
}

async function main(argv = process.argv.slice(2)) {
  const root = argv[argv.indexOf("--root") + 1];
  const expected = argv.includes("--expected") ? argv[argv.indexOf("--expected") + 1] : null;
  const output = argv.includes("--write") ? argv[argv.indexOf("--write") + 1] : null;
  if (
    !root ||
    (expected && output) ||
    (argv.includes("--expected") && !expected) ||
    (argv.includes("--write") && !output)
  ) {
    throw new Error("Usage: check-policy-site-parity.mjs --root <site> [--expected <json> | --write <json>]");
  }
  const actual = await policySiteParity(path.resolve(root));
  if (expected) {
    const baseline = JSON.parse(await readFile(expected, "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(baseline)) {
      throw new Error(
        `Policy site differs from Linux canonical bytes: expected ${JSON.stringify(baseline)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  if (output) await writeFile(output, `${JSON.stringify(actual)}\n`);
  console.log(`Policy site parity: ${actual.files} files, ${actual.bytes} bytes, sha256 ${actual.sha256}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
