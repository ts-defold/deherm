#!/usr/bin/env node

// Prove the consumer path end to end, over HTTP, against a served copy of the
// emitted site.
//
// Asserting that content addressing works is cheap. This exercises it:
//
//   1. emit the site under a DIFFERENT base than the configured one, which is
//      the claim that relocation is a configuration edit rather than a release;
//   2. serve it on loopback;
//   3. resolve sha -> index -> policy -> objects using only the shipped index's
//      base and path templates, never a hard-coded URL;
//   4. hash every fetched body and compare to the hash in its path;
//   5. rebuild the revision-keyed runtime handshake from the policy alone, to
//      show that stripping the revision out of the policy lost nothing;
//   6. resolve a DOWNLOAD URL for a Hermes archive and a host compiler out of
//      the same entry, because "I am on Defold X, what do I download?" is the
//      other half of the question the index exists to answer, and a client that
//      had to hardcode a forge to answer it would not be resolving anything; and
//   7. serve a tampered object and confirm the verification actually fails,
//      because a check that never fails proves nothing.

import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hashBytes } from "../packages/compiler/src/api-policy.mjs";
import { releaseAssetUrl } from "../packages/cli/src/release-assets.mjs";
import { buildPolicySite } from "./build-policy-site.mjs";
import { readSiteConfig, shippedIndexPath } from "./generate-api-policy.mjs";

function serve(directory) {
  const tampered = new Map();
  const server = createServer(async (request, response) => {
    const relative = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
    if (relative.includes("..")) {
      response.writeHead(400).end();
      return;
    }
    if (tampered.has(relative)) {
      response.writeHead(200, { "content-type": "application/json" }).end(tampered.get(relative));
      return;
    }
    try {
      const bytes = await readFile(path.join(directory, relative));
      response.writeHead(200, {
        "content-type": relative.endsWith(".json") ? "application/json" : "text/html",
        // Objects are immutable: a change produces a different path rather than
        // a new version of one.
        "cache-control": /\/(object|policy)\//.test(relative) ? "public, max-age=31536000, immutable" : "no-cache"
      }).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    // A restricted host may deny loopback sockets. Surface that as the real
    // error instead of leaving the promise unsettled (which Node reports only
    // as exit code 13 and hides the cause).
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      tampered,
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done, reject) => {
        // Node's fetch implementation keeps loopback HTTP/1.1 connections
        // alive. `server.close()` waits for those sockets and left this check
        // suspended until Node exited with code 13 for an unsettled top-level
        // await. Stop accepting requests, then explicitly retire the idle
        // consumer connections the check itself created.
        server.close((error) => error ? reject(error) : done());
        server.closeIdleConnections();
      })
    }));
  });
}

function expand(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`index template ${template} names unknown field ${key}`);
    return values[key];
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function transientHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Read one immutable policy-site object, retrying only transport failures and
 * HTTP statuses which can be transient. A 4xx content/path failure still fails
 * immediately; retrying it would hide a broken published graph for minutes.
 */
export async function fetchPolicyText({
  url,
  label,
  fetchImpl = fetch,
  maxAttempts = 5,
  retryDelayMs = 1_000,
  sleep = delay
}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { cache: "no-store" });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
      continue;
    }
    if (response.ok) return response.text();
    lastError = new Error(`${label}: HTTP ${response.status}`);
    if (!transientHttpStatus(response.status)) throw lastError;
    await response.body?.cancel?.().catch(() => {});
    if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
  }
  throw lastError ?? new Error(`${label}: request failed`);
}

/**
 * The whole consumer path, written the way a consumer would have to write it:
 * the base and the three path templates come from the index, and every fetched
 * body is verified against the hash in its own path before it is parsed.
 */
export async function resolvePolicy({ index, fetchImpl = fetch, retry = {} }) {
  const base = `${index.base.url.replace(/\/$/, "")}${index.base.pathPrefix ? `/${index.base.pathPrefix}` : ""}`;
  const get = (relative) => fetchPolicyText({
    url: `${base}/${relative}`,
    label: relative,
    fetchImpl,
    ...retry
  });
  const trace = [];
  const results = [];
  for (const asserted of index.entries) {
    const indexRelative = expand(index.base.index, { defoldRevision: asserted.defoldRevision });
    const entry = JSON.parse(await get(indexRelative));
    trace.push(`${indexRelative} -> policyRoot ${entry.policyRoot}`);
    // A SIBLING of the entry, not part of it: release tags are a function of
    // the build recipe, so embedding them made a Dockerfile edit drift an
    // unrelated revision's entry. Fetching it here is what proves a consumer
    // still gets from a revision to a download without that coupling.
    const artifactsRelative = expand(index.base.artifacts, { defoldRevision: asserted.defoldRevision });
    const artifacts = JSON.parse(await get(artifactsRelative));
    if (artifacts.defoldRevision !== asserted.defoldRevision) {
      throw new Error(`${asserted.defoldRevision}: artifacts document names ${artifacts.defoldRevision}`);
    }
    trace.push(`${artifactsRelative} -> ${Object.keys(artifacts.artifacts ?? {}).length} families`);
    // The shipped index is the released authority. A fetched index may extend it
    // for revisions published after that release, but never overrides an entry
    // the package already asserts.
    if (entry.policyRoot !== asserted.policyRoot || entry.generator !== asserted.generator) {
      throw new Error(`${asserted.defoldRevision}: served index contradicts the shipped index`);
    }
    const policyRelative = expand(index.base.policy, { policyRoot: entry.policyRoot });
    const policyBytes = await get(policyRelative);
    if (hashBytes(policyBytes) !== entry.policyRoot) throw new Error(`${policyRelative} does not hash to its path`);
    const policy = JSON.parse(policyBytes);
    trace.push(`${policyRelative} -> ${Object.keys(policy.subtrees).length} subtrees, generator ${policy.generator}`);
    const subtrees = {};
    for (const [namespace, hash] of Object.entries(policy.subtrees)) {
      const objectRelative = expand(index.base.object, { subtreeHash: hash });
      const bytes = await get(objectRelative);
      if (hashBytes(bytes) !== hash) throw new Error(`${objectRelative} does not hash to its path`);
      subtrees[namespace] = JSON.parse(bytes);
    }
    trace.push(`verified ${Object.keys(subtrees).length} objects against their own paths`);
    results.push({ revision: asserted.defoldRevision, entry, artifacts, policy, subtrees });
  }
  return { trace, results };
}

/**
 * Build one artifact download URL the way a consumer would: the tag and the
 * asset name come from the ARTIFACTS document for the revision - a sibling of
 * the index entry, not part of it, because release tags are a function of the
 * build recipe rather than of the engine - and the URL shape comes from the
 * index's own `base.releaseAsset` template. Nothing here knows what a forge is
 * called.
 *
 * A key the document does not name is a refusal, not an invented URL. Guessing
 * `hermes-<target>.tar.gz` would produce a plausible URL for a target that was
 * never built, and a 404 six months later is a worse diagnostic than a failure
 * here.
 */
export function resolveArtifactUrl({ index, artifacts, family, key, member = null }) {
  const reference = artifacts?.artifacts?.[family];
  if (!reference) throw new Error(`${artifacts?.defoldRevision}: the artifacts document names no ${family} artifacts`);
  const asset = reference.assets?.[key];
  if (typeof asset !== "string") throw new Error(`${family} publishes nothing for ${key}`);
  // One archive per row, so a caller asks for the MEMBER it needs and the
  // document says whether that member unpacks out of this archive. Checking it
  // here means a rename inside an archive fails at resolution rather than as a
  // missing file after extraction.
  if (member) {
    const contents = reference.contents?.[key] ?? [];
    if (!contents.includes(member)) {
      throw new Error(`${family} ${key} carries ${contents.join(", ") || "nothing"}, not ${member}`);
    }
  }
  return { url: expand(index.base.releaseAsset, { tag: reference.tag, asset }), tag: reference.tag, asset };
}

/**
 * Rebuild the runtime handshake the policy deliberately does not carry.
 *
 * The handshake's `defoldRevision` and `catalogSha256` are keyed to the
 * revision, so a policy carrying them could not be shared between two revisions
 * with an identical surface. This shows the consumer can reconstruct them from
 * the policy plus the revision it already resolved, so nothing was lost.
 */
export function rebuildHandshake({ profiles, revision, profileId }) {
  const { catalogRecipe } = profiles;
  const material = {
    defoldRevision: revision,
    profiles: Object.fromEntries(catalogRecipe.profileOrder.map((id) => [id, Object.fromEntries(
      catalogRecipe.profileFields.map((field) => [
        field,
        field === "features" ? profiles.profiles[id].features : profiles.profiles[id].runtimeHandshake[field]
      ])
    )]))
  };
  const catalogSha256 = createHash("sha256").update(JSON.stringify(material)).digest("hex");
  return { ...profiles.profiles[profileId].runtimeHandshake, defoldRevision: revision, catalogSha256 };
}

export function validateRebuiltHandshake({ profiles, revision, profileId }) {
  const handshake = rebuildHandshake({ profiles, revision, profileId });
  const profile = profiles.profiles[profileId];
  if (!profile) throw new Error(`policy profiles carry no ${profileId}`);
  for (const [field, expected] of Object.entries(profile.runtimeHandshake)) {
    if (handshake[field] !== expected) {
      throw new Error(`rebuilt handshake ${field} ${handshake[field]} != policy profile ${expected}`);
    }
  }
  if (handshake.defoldRevision !== revision) {
    throw new Error(`rebuilt handshake revision ${handshake.defoldRevision} != resolved ${revision}`);
  }
  if (!/^[a-f0-9]{64}$/.test(handshake.catalogSha256)) {
    throw new Error(`rebuilt handshake catalog hash is invalid: ${handshake.catalogSha256}`);
  }
  const rebound = new Set(profile.boundAtResolution ?? []);
  if (rebound.size !== 2 || !rebound.has("defoldRevision") || !rebound.has("catalogSha256")) {
    throw new Error("policy profile does not declare the two revision-bound handshake fields");
  }
  return handshake;
}

async function main() {
  const site = await readSiteConfig();
  const output = await mkdtemp(path.join(tmpdir(), "deherm-policy-site-"));
  const host = await serve(output);
  try {
    // Deliberately NOT the configured base: a different host and a different
    // owned prefix, proving the consumer follows the index's data rather than a
    // constant compiled into it.
    const relocated = { baseUrl: host.origin, pathPrefix: "deherm-relocated" };
    await buildPolicySite({ site, output, ...relocated });

    const shipped = JSON.parse(await readFile(shippedIndexPath, "utf8"));
    const index = { ...shipped, base: { ...shipped.base, url: relocated.baseUrl, pathPrefix: relocated.pathPrefix } };
    const { trace, results } = await resolvePolicy({ index });

    const lines = [...trace];
    for (const { revision, policy, subtrees } of results) {
      const namespaces = Object.keys(policy.subtrees).filter((key) => !key.startsWith("@"));
      lines.push(`${revision}: ${namespaces.length} namespaces, toolchain pins from ${subtrees["@toolchain"].source}`);

      // The toolchain subtree must answer the questions the artifact matrix asks.
      for (const pin of ["ANDROID_NDK_API_VERSION", "VERSION_IPHONEOS_MIN", "EMSCRIPTEN_VERSION_STR"]) {
        if (!subtrees["@toolchain"].pins[pin]) throw new Error(`policy toolchain subtree is missing ${pin}`);
      }
      lines.push(`  NDK ${subtrees["@toolchain"].pins.ANDROID_NDK_VERSION} api ${subtrees["@toolchain"].pins.ANDROID_NDK_API_VERSION}, ` +
        `emscripten ${subtrees["@toolchain"].pins.EMSCRIPTEN_VERSION_STR}, iOS min ${subtrees["@toolchain"].pins.VERSION_IPHONEOS_MIN}`);

      // A namespace subtree must actually answer for its namespace.
      const gui = subtrees.gui;
      if (!gui?.script?.functions?.length) throw new Error("the gui subtree carries no script functions");
      if (!gui.registration) throw new Error("the gui subtree carries no source-derived registration");
      lines.push(`  gui: ${gui.script.functions.length} declared routes, ` +
        `${Object.values(gui.registration).reduce((total, target) => total + target.routes.length, 0)} registered route records`);

      const defaultProfileId = subtrees["@compiler:document:defold-script-route-availability-profiles.json"]
        ?.value?.engineProfileSelection?.defaultProfileId;
      if (typeof defaultProfileId !== "string" || !defaultProfileId) {
        throw new Error("policy profile subtree has no default engine profile");
      }
      const handshake = validateRebuiltHandshake({
        profiles: subtrees["@profiles"],
        revision,
        profileId: defaultProfileId
      });
      lines.push(`  rebuilt runtime handshake for ${defaultProfileId} matches its policy profile ` +
        `(catalogSha256 ${handshake.catalogSha256.slice(0, 12)})`);
    }

    // The artifact half, resolved from served data alone. It is a SIBLING of
    // the index entry rather than part of it: release tags are a function of
    // the build recipe, so embedding them made a Dockerfile edit drift an
    // unrelated revision's entry. Fetching it here is what proves a consumer
    // can still get from a revision to a download without that coupling.
    //
    // One bundle-target archive and one host archive, because the two are
    // indexed differently and a consumer that conflated them would download the
    // wrong file for the right-looking reason.
    for (const { revision, artifacts } of results) {
      for (const [family, key, member] of [
        ["native-artifacts", "arm64-osx", "libhermes.a"],
        ["hermes-host", "linux-x64", "hermesc"]
      ]) {
        const resolved = resolveArtifactUrl({ index, artifacts, family, key, member });
        // The vendoring path builds the same URL from the same tag and asset
        // without ever reading the index. If these two disagree, a user who
        // followed the index would download something `pull` would not.
        const vendored = releaseAssetUrl({ tag: resolved.tag, asset: resolved.asset });
        if (resolved.url !== vendored) {
          throw new Error(`index template resolved ${resolved.url} but release-assets.mjs builds ${vendored}`);
        }
        lines.push(`  ${revision} ${family} ${key}${member ? `[${member}]` : ""} -> ${resolved.url}`);
      }
      // Negative control for the same reason the tampered object exists below:
      // a resolver that answers for a target nobody built is not resolving.
      let refused = null;
      try {
        resolveArtifactUrl({ index, artifacts, family: "native-artifacts", key: "x86-osx" });
      } catch (error) {
        refused = error.message;
      }
      if (!refused) throw new Error("a retired bundle target resolved to a download URL");
      lines.push(`  unbuilt target refused: ${refused}`);
    }

    // Negative control: a mirror that serves different bytes at the same path
    // must be caught by the consumer, not trusted because the host answered.
    const victim = Object.values(results[0].policy.subtrees)[0];
    const relative = `deherm-relocated/${site.layoutVersion}/object/${victim}.json`;
    host.tampered.set(relative, '{"kind":"not-the-policy"}');
    let caught = null;
    try {
      await resolvePolicy({ index });
    } catch (error) {
      caught = error.message;
    }
    host.tampered.delete(relative);
    if (!caught?.includes("does not hash to its path")) {
      throw new Error("a tampered object was accepted; the store is not self-verifying");
    }
    lines.push(`tampered object rejected: ${caught}`);

    console.log(lines.map((line) => `  ${line}`).join("\n"));
    console.log(`ok policy site resolves end to end from ${host.origin}/deherm-relocated, ` +
      "including an artifact download URL built from the index's own template");
  } finally {
    await host.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
