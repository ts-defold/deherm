#!/usr/bin/env node

// Watch Defold's release channels and decide whether anything has to be derived.
//
// See `.agents/docs/decisions/api-source-resolution.md`: a channel is a moving
// pointer, never a pin. `https://d.defold.com/<channel>/info.json` is an input;
// the sha it resolves to is recorded immediately and everything downstream keys
// on that sha.
//
//   plan            read every tracked channel, and report which resolved shas
//                   the shipped index does not already carry. A channel whose
//                   sha is already indexed needs NOTHING derived and NOTHING
//                   published - the policy objects already exist and the index
//                   already points at them.
//   pin <sha>       rewrite upstream.lock's Defold pins for one revision,
//                   recording the SHA-256 of each artifact fetched from the
//                   immutable archive. This is the step a human reviews: it
//                   changes what this repository treats as ground truth.
//
// Fail closed: an unreachable channel, a malformed response or a revision that
// is not 40 hex characters is an error, never an empty plan. "Nothing to do"
// and "could not find out" must never look the same.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readSiteConfig, shippedIndexPath } from "./generate-api-policy.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const lockPath = path.join(root, "upstream.lock");

const REVISION = /^[0-9a-f]{40}$/;

export async function readChannel(channel, { template, fetchImpl = fetch }) {
  const url = template.replace("{channel}", channel);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const info = await response.json();
  if (!REVISION.test(info?.sha1 ?? "")) throw new Error(`${url}: sha1 is not a Defold revision: ${info?.sha1}`);
  return { channel, url, version: info.version ?? null, sha1: info.sha1 };
}

/**
 * What a scheduled run would have to do.
 *
 * `derive` is the list of revisions with no index entry. Everything else is
 * reported as already covered, because the interesting property of this system
 * is how often the answer is "nothing".
 */
export async function planChannels({ site, index, indexPath, fetchImpl = fetch } = {}) {
  const config = site ?? await readSiteConfig();
  const shipped = index ?? JSON.parse(await readFile(indexPath ?? shippedIndexPath, "utf8"));
  const indexed = new Map(shipped.entries.map((entry) => [entry.defoldRevision, entry]));
  const observations = [];
  for (const channel of config.channels) {
    observations.push(await readChannel(channel, { template: config.channelInfoUrl, fetchImpl }));
  }
  const derive = [];
  const covered = [];
  for (const observation of observations) {
    const entry = indexed.get(observation.sha1);
    if (entry) covered.push({ ...observation, policyRoot: entry.policyRoot });
    else if (!derive.some((row) => row.sha1 === observation.sha1)) derive.push(observation);
  }
  return { observations, covered, derive };
}

const ARCHIVE = "https://d.defold.com/archive";

async function digest(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/**
 * Rewrite the Defold pins in `upstream.lock` for one revision.
 *
 * The digests are computed from what the immutable archive actually served, so
 * the lock records an attested digest rather than a recalled constant. Only the
 * five DEFOLD_ keys move; every other pin in the lock is a separate decision.
 */
export async function pinRevision(revision, { fetchImpl = fetch, lock } = {}) {
  if (!REVISION.test(revision)) throw new Error(`Not a Defold revision: ${revision}`);
  const current = lock ?? await readFile(lockPath, "utf8");
  const refDocUrl = `${ARCHIVE}/${revision}/engine/share/ref-doc.zip`;
  const bobUrl = `${ARCHIVE}/${revision}/bob/bob.jar`;
  const refDoc = await digest(refDocUrl, fetchImpl);
  const bob = await digest(bobUrl, fetchImpl);
  const replacements = {
    DEFOLD_REV: revision,
    DEFOLD_REF_DOC_URL: refDocUrl,
    DEFOLD_REF_DOC_SHA256: refDoc.sha256,
    DEFOLD_BOB_URL: bobUrl,
    DEFOLD_BOB_SHA256: bob.sha256
  };
  let updated = current;
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (!pattern.test(updated)) throw new Error(`upstream.lock does not declare ${key}`);
    updated = updated.replace(pattern, `${key}=${value}`);
  }
  return { updated, replacements, sizes: { refDoc: refDoc.bytes, bob: bob.bytes } };
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === "plan" || command === undefined) {
    const json = rest.includes("--json");
    const indexFlag = rest.indexOf("--index");
    const indexPath = indexFlag === -1 ? undefined : rest[indexFlag + 1];
    if (indexFlag !== -1 && !indexPath) throw new Error("--index requires a path");
    const known = new Set(["--json", "--index", indexPath].filter(Boolean));
    const unknown = rest.filter((argument) => !known.has(argument));
    if (unknown.length) throw new Error(`Unknown plan argument: ${unknown[0]}`);
    const plan = await planChannels({ indexPath });
    if (json) {
      // `derive` is what a matrix fans out over. An empty list is the steady
      // state and means this run publishes nothing at all.
      console.log(JSON.stringify({ derive: plan.derive.map(({ channel, sha1, version }) => ({ channel, sha1, version })) }));
      return;
    }
    for (const row of plan.observations) console.log(`${row.channel.padEnd(7)} ${row.sha1} ${row.version ?? ""}`);
    for (const row of plan.covered) console.log(`  covered: ${row.channel} -> policy ${row.policyRoot.slice(0, 12)}`);
    console.log(plan.derive.length
      ? `derive: ${plan.derive.map((row) => `${row.channel}@${row.sha1.slice(0, 12)}`).join(", ")}`
      : "derive: nothing - every tracked channel resolves to an indexed revision");
    return;
  }
  if (command === "pin") {
    const revision = rest[0];
    const write = rest.includes("--write");
    const { updated, replacements, sizes } = await pinRevision(revision);
    if (write) await writeFile(lockPath, updated);
    console.log(`${write ? "Pinned" : "Would pin"} Defold ${revision}`);
    console.log(`  ref-doc.zip ${sizes.refDoc} bytes sha256 ${replacements.DEFOLD_REF_DOC_SHA256}`);
    console.log(`  bob.jar     ${sizes.bob} bytes sha256 ${replacements.DEFOLD_BOB_SHA256}`);
    return;
  }
  throw new Error("Usage: track-defold-channels.mjs {plan [--json] [--index <manifest>] | pin <sha> [--write]}");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
