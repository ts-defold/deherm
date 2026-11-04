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
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePolicy } from "./check-policy-site-resolution.mjs";
import { shippedIndexPath } from "./generate-api-policy.mjs";

export function manifestUrl(index) {
  const base = index.base.url.replace(/\/$/u, "");
  const prefix = String(index.base.pathPrefix ?? "").replace(/^\/+|\/+$/gu, "");
  const layout = index.base.layoutVersion ?? "v1";
  return `${base}${prefix ? `/${prefix}` : ""}/${layout}/index/manifest.json`;
}

function assertExpectedManifest(index) {
  if (index?.kind !== "deherm.policy.index" || index.schemaVersion !== 1) {
    throw new Error("Expected policy index must be a schema-v1 deherm.policy.index manifest");
  }
  if (!Array.isArray(index.entries) || index.entries.length === 0) {
    throw new Error("Expected policy index manifest must contain at least one entry");
  }
  if (typeof index.base?.url !== "string" || typeof index.base?.index !== "string") {
    throw new Error("Expected policy index manifest must contain base.url and base.index");
  }
  try {
    const url = new URL(index.base.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported URL scheme");
  } catch (error) {
    throw new Error(`Expected policy index has an invalid base.url: ${error instanceof Error ? error.message : error}`);
  }
  if (!index.base.index.includes("{defoldRevision}")) {
    throw new Error("Expected policy index base.index must include {defoldRevision}");
  }

  const seen = new Set();
  for (const entry of index.entries) {
    if (!/^[0-9a-f]{40}$/u.test(entry?.defoldRevision ?? "")) {
      throw new Error(`Expected policy index has an invalid Defold revision: ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry.defoldRevision)) {
      throw new Error(`Expected policy index repeats Defold revision ${entry.defoldRevision}`);
    }
    seen.add(entry.defoldRevision);
    if (!/^[0-9a-f]{64}$/u.test(entry.policyRoot ?? "") || !/^sha256:[0-9a-f]{64}$/u.test(entry.generator ?? "")) {
      throw new Error(`Expected policy index has an invalid policy identity for ${entry.defoldRevision}`);
    }
  }
}

/**
 * Load the exact manifest and revision pointers emitted by this publication.
 * The manifest is the authority for the checked revision set; the sidecar
 * pointers bind each revision to the artifact document that Pages must serve.
 */
export async function loadExpectedPolicyIndex(directory) {
  const manifestPath = path.join(directory, "manifest.json");
  let expected;
  try {
    expected = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read expected policy index manifest ${manifestPath}: ${error instanceof Error ? error.message : error}`,
    );
  }
  assertExpectedManifest(expected);

  const artifactDigests = new Map();
  for (const entry of expected.entries) {
    const pointerPath = path.join(directory, `${entry.defoldRevision}.json`);
    let pointer;
    try {
      pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Expected policy index is incomplete: cannot read pointer ${entry.defoldRevision}.json: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (
      pointer?.kind !== "deherm.policy.index-entry" ||
      pointer.schemaVersion !== 1 ||
      pointer.defoldRevision !== entry.defoldRevision ||
      pointer.policyRoot !== entry.policyRoot ||
      pointer.generator !== entry.generator ||
      !/^[0-9a-f]{64}$/u.test(pointer.artifactsSha256 ?? "")
    ) {
      throw new Error(`Expected policy index pointer ${entry.defoldRevision}.json is incomplete or inconsistent`);
    }
    artifactDigests.set(entry.defoldRevision, pointer.artifactsSha256);
  }
  return { expected, artifactDigests };
}

function pointerUrl(index, revision) {
  const base = index.base.url.replace(/\/$/u, "");
  const prefix = String(index.base.pathPrefix ?? "").replace(/^\/+|\/+$/gu, "");
  const relative = index.base.index.replace("{defoldRevision}", revision).replace(/^\/+/, "");
  return `${base}${prefix ? `/${prefix}` : ""}/${relative}`;
}

function validateExpectedArtifactDigests(expected, artifactDigests) {
  if (!(artifactDigests instanceof Map)) throw new Error("Expected artifact digests must be a Map");
  for (const entry of expected.entries ?? []) {
    if (!/^[0-9a-f]{64}$/u.test(artifactDigests.get(entry.defoldRevision) ?? "")) {
      throw new Error(`Expected artifact digest is missing for ${entry.defoldRevision}`);
    }
  }
}

async function missingPublishedArtifactPointers(expected, artifactDigests, fetchImpl, requestOptions) {
  const checks = await Promise.all(
    expected.entries.map(async (entry) => {
      const url = pointerUrl(expected, entry.defoldRevision);
      try {
        const response = await fetchImpl(url, requestOptions);
        if (!response.ok) return `${entry.defoldRevision} (HTTP ${response.status})`;
        const pointer = await response.json();
        if (
          pointer?.kind !== "deherm.policy.index-entry" ||
          pointer.schemaVersion !== 1 ||
          pointer.defoldRevision !== entry.defoldRevision ||
          pointer.policyRoot !== entry.policyRoot ||
          pointer.generator !== entry.generator ||
          pointer.artifactsSha256 !== artifactDigests.get(entry.defoldRevision)
        ) {
          return `${entry.defoldRevision} (stale or inconsistent pointer)`;
        }
        return null;
      } catch (error) {
        return `${entry.defoldRevision} (${error instanceof Error ? error.message : String(error)})`;
      }
    }),
  );
  return checks.filter(Boolean);
}

export function missingPublishedEntries(expected, observed) {
  const published = new Map((observed.entries ?? []).map((entry) => [entry.defoldRevision, entry]));
  return (expected.entries ?? []).filter((entry) => {
    const candidate = published.get(entry.defoldRevision);
    return !candidate || candidate.policyRoot !== entry.policyRoot || candidate.generator !== entry.generator;
  });
}

/** A partial derivation may publish older usable entries, but must not pass the nightly. */
export function missingPlannedRevisions(planned, expected) {
  if (!Array.isArray(planned)) throw new Error("Planned Defold revisions must be an array");
  const emitted = new Set((expected.entries ?? []).map((entry) => entry.defoldRevision));
  return planned.filter((row) => {
    if (!/^[0-9a-f]{40}$/u.test(row?.sha1 ?? "")) {
      throw new Error(`Invalid planned Defold revision: ${JSON.stringify(row)}`);
    }
    return !emitted.has(row.sha1);
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForPublishedPolicy({
  expected,
  expectedArtifactDigests,
  fetchImpl = fetch,
  timeoutMs = 300_000,
  intervalMs = 5_000,
  sleep = delay,
}) {
  if (expectedArtifactDigests !== undefined) validateExpectedArtifactDigests(expected, expectedArtifactDigests);
  const url = manifestUrl(expected);
  const deadline = Date.now() + timeoutMs;
  let last = "not requested";
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const requestOptions = {
      cache: "no-store",
      signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, Math.ceil(remainingMs)))),
    };
    try {
      const response = await fetchImpl(url, requestOptions);
      if (!response.ok) {
        last = `HTTP ${response.status}`;
      } else {
        const observed = await response.json();
        const missing = missingPublishedEntries(expected, observed);
        if (missing.length === 0) {
          if (expectedArtifactDigests === undefined) return { url, observed };
          const stalePointers = await missingPublishedArtifactPointers(
            expected,
            expectedArtifactDigests,
            fetchImpl,
            requestOptions,
          );
          if (stalePointers.length === 0) return { url, observed };
          last = `${stalePointers.length} expected revision pointer(s) still absent or stale: ${stalePointers.join(", ")}`;
        } else {
          last =
            `${missing.length} expected revision(s) still absent or stale: ` +
            missing.map((entry) => entry.defoldRevision).join(", ");
        }
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(`Published policy did not converge at ${url} within ${timeoutMs} ms: ${last}`);
}

export async function loadPolicyExpectation(expectedIndexDirectory) {
  if (expectedIndexDirectory) return loadExpectedPolicyIndex(expectedIndexDirectory);
  return { expected: JSON.parse(await readFile(shippedIndexPath, "utf8")), artifactDigests: undefined };
}

async function main(argv = process.argv.slice(2)) {
  let timeoutMs = 300_000;
  let expectedIndexDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--timeout-ms") {
      const value = argv[++index];
      if (value === undefined) throw new Error("--timeout-ms requires a value");
      timeoutMs = Number(value);
    } else if (argv[index] === "--expected-index") {
      expectedIndexDirectory = argv[++index];
      if (!expectedIndexDirectory) throw new Error("--expected-index requires a directory");
    } else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive number");

  const { expected, artifactDigests: expectedArtifactDigests } = await loadPolicyExpectation(expectedIndexDirectory);
  const planned = JSON.parse(process.env.PLANNED_REVISIONS ?? "[]");
  const missing = missingPlannedRevisions(planned, expected);
  if (missing.length) {
    throw new Error(
      `Policy derivation omitted ${missing.length} planned Defold revision(s): ` +
        missing.map(({ channel, sha1, version }) => `${channel}@${version ?? "unknown"} (${sha1})`).join(", "),
    );
  }
  const { url, observed } = await waitForPublishedPolicy({ expected, expectedArtifactDigests, timeoutMs });
  // Resolve only the entries this derivation asserts. The accumulated public
  // manifest may legitimately contain policies newer than an older checkout.
  const asserted = { ...observed, entries: expected.entries };
  const result = await resolvePolicy({ index: asserted });
  if (expectedArtifactDigests !== undefined) {
    for (const { revision, entry } of result.results) {
      if (entry.artifactsSha256 !== expectedArtifactDigests.get(revision)) {
        throw new Error(`${revision}: served policy pointer changed after freshness verification`);
      }
    }
  }
  console.log(
    `ok published policy: ${expected.entries.length} derived revision(s), ` +
      `${result.results.length} resolved and content-verified through ${url}`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
