#!/usr/bin/env node

// Verify the policy site a user can actually reach, after publication.
//
// The existing policy-site resolution test deliberately serves a relocated
// local copy so it can exercise content addressing and tamper rejection on
// every push. That is necessary but it cannot prove that Pages deployed the
// bytes the publish job just wrote. This companion waits for the public
// manifest to contain the exact locally-derived entries, then resolves and
// hashes those entries through the public site's own URL templates.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { resolvePolicy } from "./check-policy-site-resolution.mjs";
import { shippedIndexPath } from "./generate-api-policy.mjs";

export function manifestUrl(index) {
  const base = index.base.url.replace(/\/$/u, "");
  const prefix = String(index.base.pathPrefix ?? "").replace(/^\/+|\/+$/gu, "");
  const layout = index.base.layoutVersion ?? "v1";
  return `${base}${prefix ? `/${prefix}` : ""}/${layout}/index/manifest.json`;
}

export function missingPublishedEntries(expected, observed) {
  const published = new Map((observed.entries ?? []).map((entry) => [entry.defoldRevision, entry]));
  return (expected.entries ?? []).filter((entry) => {
    const candidate = published.get(entry.defoldRevision);
    return !candidate || candidate.policyRoot !== entry.policyRoot || candidate.generator !== entry.generator;
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForPublishedPolicy({
  expected,
  fetchImpl = fetch,
  timeoutMs = 300_000,
  intervalMs = 5_000
}) {
  const url = manifestUrl(expected);
  const deadline = Date.now() + timeoutMs;
  let last = "not requested";
  while (Date.now() <= deadline) {
    try {
      const response = await fetchImpl(url, { cache: "no-store" });
      if (!response.ok) {
        last = `HTTP ${response.status}`;
      } else {
        const observed = await response.json();
        const missing = missingPublishedEntries(expected, observed);
        if (missing.length === 0) return { url, observed };
        last = `${missing.length} expected revision(s) still absent or stale: ` +
          missing.map((entry) => entry.defoldRevision).join(", ");
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() + intervalMs > deadline) break;
    await delay(intervalMs);
  }
  throw new Error(`Published policy did not converge at ${url} within ${timeoutMs} ms: ${last}`);
}

async function main(argv = process.argv.slice(2)) {
  let timeoutMs = 300_000;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--timeout-ms") timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive number");

  const expected = JSON.parse(await readFile(shippedIndexPath, "utf8"));
  const { url, observed } = await waitForPublishedPolicy({ expected, timeoutMs });
  // Resolve only the entries this derivation asserts. The accumulated public
  // manifest may legitimately contain policies newer than an older checkout.
  const asserted = { ...observed, entries: expected.entries };
  const result = await resolvePolicy({ index: asserted });
  console.log(
    `ok published policy: ${expected.entries.length} derived revision(s), ` +
    `${result.results.length} resolved and content-verified through ${url}`
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
