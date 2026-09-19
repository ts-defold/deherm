#!/usr/bin/env node
// Re-derives the vendored netcode sources from the pinned upstream revision and
// records their digests, or verifies that what is committed still matches.
//
// The vendored bytes ARE committed, unlike the Hermes target libraries, because
// Extender compiles them from source for every bundle target - there is no `.a`
// to download. Committing them without a way to re-derive them would make them
// opaque blobs, so this script is the provenance: clone at NETCODE_REV, copy the
// exact file list, and record a sha256 per file.
//
// Usage:
//   node scripts/vendor-netcode.mjs           re-derive from upstream and record
//   node scripts/vendor-netcode.mjs --check    verify committed bytes and digests

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionRoot = path.join(packageRoot, "extension/defold_netcode");
const licenceRoot = path.join(extensionRoot, "licenses");
const digestsPath = path.join(packageRoot, "vendor-digests.json");

// Upstream path -> path under the extension root.
//
// The split between `include/` and `src/vendor/` is not cosmetic, it is what
// makes the extension build with NO ext.manifest context of its own.
//
// `netcode.c` opens sodium with ANGLE brackets (`#include <sodium.h>`), which
// searches the include path and never the including file's directory. Extender
// puts every extension's own `include/` on the include path automatically, so
// putting `sodium.h` there resolves it without declaring anything. The
// alternative - an `includes:` entry in ext.manifest - is worse twice over:
// ext.manifest contexts merge across the WHOLE build, so it would land on
// defold_hermes too, and the path-resolution rules for that key are not
// something this repository has ever exercised.
//
// `netcode.h` stays in src/vendor because netcode.c opens it with QUOTES, which
// does search the including file's directory. It is the vendored library's
// header, not this package's API; the API is include/defold_netcode/.
//
// `sodium.c` opens `"sodium.h"` with quotes, does not find it next to itself,
// and falls through to the include path - where include/sodium.h is. So the
// flattening of sodium/ costs nothing.
const VENDORED = Object.freeze({
  "netcode.c": "src/vendor/netcode.c",
  "netcode.h": "src/vendor/netcode.h",
  "sodium/sodium.c": "src/vendor/sodium.c",
  "sodium/sodium.h": "include/sodium.h",
});

const LICENCES = Object.freeze({
  "LICENCE": "NETCODE.txt",
});

function readLock() {
  const text = readFileSync(path.join(packageRoot, "upstream.lock"), "utf8");
  const lock = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    lock[line.slice(0, index)] = line.slice(index + 1);
  }
  for (const key of ["NETCODE_URL", "NETCODE_REV", "NETCODE_VERSION", "NETCODE_LICENCE"]) {
    if (!lock[key]) throw new Error(`packages/defold-netcode/upstream.lock is missing ${key}`);
  }
  return lock;
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function record(relative, absolute) {
  const bytes = readFileSync(absolute);
  return { path: relative, bytes: bytes.byteLength, sha256: digest(bytes) };
}

function derive(lock) {
  const scratch = mkdtempSync(path.join(tmpdir(), "deherm-netcode-"));
  try {
    const checkout = path.join(scratch, "netcode");
    // A full clone then a hard checkout of the pinned revision: `--depth 1` can
    // only fetch a branch tip, and the tip is not what this package is pinned to.
    execFileSync("git", ["clone", "--quiet", lock.NETCODE_URL, checkout], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("git", ["-C", checkout, "checkout", "--quiet", lock.NETCODE_REV], { stdio: ["ignore", "ignore", "inherit"] });

    const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== lock.NETCODE_REV) {
      throw new Error(`checked out ${head}, expected ${lock.NETCODE_REV}`);
    }

    for (const [from, to] of Object.entries(VENDORED)) {
      const target = path.join(extensionRoot, to);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(checkout, from), target);
    }
    for (const [from, to] of Object.entries(LICENCES)) {
      mkdirSync(licenceRoot, { recursive: true });
      copyFileSync(path.join(checkout, from), path.join(licenceRoot, to));
    }

    // The vendored libsodium subset carries no licence file of its own - its ISC
    // terms live in the leading comment of sodium.h. Extracting them is the only
    // way to ship a licence file that is derived from the vendored bytes rather
    // than transcribed beside them, so a change upstream shows up as a digest
    // mismatch instead of going unnoticed.
    const sodiumHeader = readFileSync(path.join(checkout, "sodium/sodium.h"), "utf8");
    const banner = sodiumHeader.match(/^\/\*[\s\S]*?\*\//);
    if (!banner || !banner[0].includes("ISC License")) {
      throw new Error("sodium.h no longer opens with the ISC licence banner; re-check the vendored licence");
    }
    writeFileSync(path.join(licenceRoot, "LIBSODIUM.txt"), `${banner[0]}\n`);

    return head;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function inventory() {
  const files = [];
  for (const to of Object.values(VENDORED)) {
    const absolute = path.join(extensionRoot, to);
    if (!existsSync(absolute)) throw new Error(`vendored source is missing: ${path.relative(packageRoot, absolute)}`);
    files.push(record(`extension/defold_netcode/${to}`, absolute));
  }
  for (const to of [...Object.values(LICENCES), "LIBSODIUM.txt"]) {
    const absolute = path.join(licenceRoot, to);
    if (!existsSync(absolute)) throw new Error(`vendored licence is missing: ${path.relative(packageRoot, absolute)}`);
    files.push(record(`extension/defold_netcode/licenses/${to}`, absolute));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

const lock = readLock();
const check = process.argv.includes("--check");

if (!check) derive(lock);

const files = inventory();
const document = {
  schemaVersion: 1,
  scope: "Digests of the netcode sources vendored into the defold_netcode extension, and the upstream revision they were derived from.",
  upstream: {
    url: lock.NETCODE_URL,
    revision: lock.NETCODE_REV,
    version: lock.NETCODE_VERSION,
    licence: lock.NETCODE_LICENCE,
    sodiumBaseline: lock.NETCODE_SODIUM_BASELINE ?? null,
    sodiumLicence: lock.NETCODE_SODIUM_LICENCE ?? null,
  },
  // Re-derivation is the reproducibility claim: a `git clone` of the pinned
  // revision followed by a byte copy of this file list must reproduce these
  // digests exactly. That is checked by running this script without --check and
  // then with it; nothing about compilation or linkage is asserted here.
  derivation: {
    producer: "packages/defold-netcode/scripts/vendor-netcode.mjs",
    method: "git clone at NETCODE_REV, verbatim file copy, sha256 per file",
    files: files.length,
  },
  files,
  treeSha256: digest(JSON.stringify(files)),
};

if (check) {
  const committed = JSON.parse(readFileSync(digestsPath, "utf8"));
  const actual = JSON.stringify(document, null, 2);
  const expected = JSON.stringify(committed, null, 2);
  if (actual !== expected) {
    console.error("vendored netcode sources do not match vendor-digests.json.");
    console.error("Re-derive with: node packages/defold-netcode/scripts/vendor-netcode.mjs");
    process.exit(1);
  }
  console.log(`netcode vendoring verified (${files.length} files, tree ${document.treeSha256.slice(0, 16)})`);
} else {
  writeFileSync(digestsPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`netcode vendored at ${lock.NETCODE_REV} (${files.length} files, tree ${document.treeSha256.slice(0, 16)})`);
}
