// Resolve and download published toolchain artifacts by URL alone.
//
// ── Why not `gh` ─────────────────────────────────────────────────────────────
//
// The repository scripts used to shell out to `gh release download`. That is
// fine for a maintainer and wrong for a user: `gh` is a separate installation,
// it wants authentication, and the product contract is that a user compiles and
// installs nothing they did not ask for. A published release asset already has
// a stable public URL, so no API client is required to reach one.
//
// ── Why the URL is deterministic ─────────────────────────────────────────────
//
//   https://github.com/<repo>/releases/download/<tag>/<asset>
//
// Both variables are computed locally, with no network round trip to discover
// them:
//
//   * the TAG is the content fingerprint of the inputs that determine the
//     artifact, which the manager scripts compute from this checkout, and
//   * the ASSET NAME comes from the same `expected-assets` listing the CI
//     completeness check uses.
//
// So resolution needs no release listing and no search. It also means the asset
// NAME is load-bearing rather than cosmetic: it is the last path segment of the
// URL. Uploading under a basename - which is what `gh release upload file#label`
// silently does, since `#` sets a display label and not the name - both collides
// across lanes and makes the URL unresolvable.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const defaultReleaseRepository = "ts-defold/deherm";

/**
 * The URL shape itself, with `{tag}` and `{asset}` left unexpanded.
 *
 * The policy index carries this template so a consumer that resolved "I am on
 * Defold X, what do I download?" can build the URL from index data alone rather
 * than hardcoding github.com. It is derived from the same expression
 * `releaseAssetUrl` uses, so the served template and the vendoring code cannot
 * drift into two answers.
 */
export function releaseAssetUrlTemplate({ repository = defaultReleaseRepository } = {}) {
  return `https://github.com/${repository}/releases/download/{tag}/{asset}`;
}

export function releaseAssetUrl({ repository = defaultReleaseRepository, tag, asset }) {
  if (!tag) throw new Error("releaseAssetUrl requires a tag");
  if (!asset) throw new Error("releaseAssetUrl requires an asset name");
  // Tags and asset names are generated from hex digests and manifest keys, so
  // they need no escaping - but encoding them keeps a malformed one from
  // silently producing a URL that resolves to something else.
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

// A 404 is not a transport failure: on a content-addressed release it means
// this artifact was never published for these inputs. Callers distinguish the
// two, because `--partial` tolerates the first and never the second.
export class ReleaseAssetMissing extends Error {
  constructor(url) {
    super(`No published asset at ${url}`);
    this.name = "ReleaseAssetMissing";
    this.url = url;
  }
}

async function fetchWithRetry(url, { attempts = 4, delayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { redirect: "follow" });
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
      continue;
    }
    if (response.status === 404) throw new ReleaseAssetMissing(url);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    // 5xx and 429 are worth another try; other 4xx are not going to change.
    if (response.status < 500 && response.status !== 429) {
      throw new Error(`${url} responded ${response.status} ${response.statusText}`);
    }
    lastError = new Error(`${url} responded ${response.status} ${response.statusText}`);
    if (attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
  }
  throw lastError;
}

// Download a known set of assets into a directory, named exactly as published.
// `optional` reports what was absent instead of failing, which is what a partial
// vendor pass wants; a missing asset is still never silently skipped.
export async function downloadReleaseAssets({
  repository = defaultReleaseRepository,
  tag,
  assets,
  destination,
  optional = false,
  onProgress
}) {
  await mkdir(destination, { recursive: true });
  const downloaded = [];
  const missing = [];
  for (const asset of assets) {
    const url = releaseAssetUrl({ repository, tag, asset });
    try {
      const bytes = await fetchWithRetry(url);
      const file = path.join(destination, asset);
      await writeFile(file, bytes);
      downloaded.push(file);
      onProgress?.({ asset, url, bytes: bytes.length, status: "downloaded" });
    } catch (error) {
      if (error instanceof ReleaseAssetMissing && optional) {
        missing.push(asset);
        onProgress?.({ asset, url, status: "missing" });
        continue;
      }
      throw error;
    }
  }
  return { downloaded, missing };
}
