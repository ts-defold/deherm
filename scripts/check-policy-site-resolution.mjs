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
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashBytes } from "../packages/compiler/src/api-policy.mjs";
import { releaseAssetUrl } from "../packages/cli/src/release-assets.mjs";
import { buildPolicySite } from "./build-policy-site.mjs";
import { readSiteConfig, shippedIndexPath } from "./generate-api-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      tampered,
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done))
    }));
  });
}

function expand(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`index template ${template} names unknown field ${key}`);
    return values[key];
  });
}

/**
 * The whole consumer path, written the way a consumer would have to write it:
 * the base and the three path templates come from the index, and every fetched
 * body is verified against the hash in its own path before it is parsed.
 */
export async function resolvePolicy({ index, fetchImpl = fetch }) {
  const base = `${index.base.url.replace(/\/$/, "")}${index.base.pathPrefix ? `/${index.base.pathPrefix}` : ""}`;
  const get = async (relative) => {
    const response = await fetchImpl(`${base}/${relative}`);
    if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
    return response.text();
  };
  const trace = [];
  const results = [];
  for (const asserted of index.entries) {
    const indexRelative = expand(index.base.index, { defoldRevision: asserted.defoldRevision });
    const entry = JSON.parse(await get(indexRelative));
    trace.push(`${indexRelative} -> policyRoot ${entry.policyRoot}`);
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
    results.push({ revision: asserted.defoldRevision, entry, policy, subtrees });
  }
  return { trace, results };
}

/**
 * Build one artifact download URL the way a consumer would: the tag and the
 * asset name come from the index entry it just fetched, and the URL shape comes
 * from the index's own `base.releaseAsset` template. Nothing here knows what a
 * forge is called.
 *
 * A key the entry does not name is a refusal, not an invented URL. Guessing
 * `hermes-<target>-libhermes.a` would produce a plausible URL for a target that
 * was never built, and a 404 six months later is a worse diagnostic than a
 * failure here.
 */
export function resolveArtifactUrl({ index, entry, family, key, tool = null }) {
  const reference = entry.artifacts?.[family];
  if (!reference) throw new Error(`${entry.defoldRevision}: the index entry names no ${family} artifacts`);
  const named = reference.assets[key];
  const asset = tool ? named?.[tool] : named;
  if (typeof asset !== "string") {
    throw new Error(`${family} publishes nothing for ${key}${tool ? ` ${tool}` : ""}`);
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

      const handshake = rebuildHandshake({
        profiles: subtrees["@profiles"],
        revision,
        profileId: "default-legacy-bullet"
      });
      const original = JSON.parse(
        await readFile(path.join(root, "packages/bindings/generated/defold-script-route-availability-profiles.json"), "utf8")
      ).profiles["default-legacy-bullet"].runtimeHandshake;
      for (const field of Object.keys(original)) {
        if (handshake[field] !== original[field]) {
          throw new Error(`rebuilt handshake ${field} ${handshake[field]} != generated ${original[field]}`);
        }
      }
      lines.push(`  rebuilt runtime handshake for default-legacy-bullet matches the generated profile ` +
        `(catalogSha256 ${handshake.catalogSha256.slice(0, 12)})`);
    }

    // The artifact half of the entry, resolved from index data alone. One
    // bundle-target archive and one host compiler, because the two are indexed
    // differently and a consumer that conflated them would download the wrong
    // file for the right-looking reason.
    for (const { revision, entry } of results) {
      for (const [family, key, tool] of [["native-artifacts", "arm64-osx", null], ["hermes-host", "linux-x64", "hermesc"]]) {
        const resolved = resolveArtifactUrl({ index, entry, family, key, tool });
        // The vendoring path builds the same URL from the same tag and asset
        // without ever reading the index. If these two disagree, a user who
        // followed the index would download something `pull` would not.
        const vendored = releaseAssetUrl({ tag: resolved.tag, asset: resolved.asset });
        if (resolved.url !== vendored) {
          throw new Error(`index template resolved ${resolved.url} but release-assets.mjs builds ${vendored}`);
        }
        lines.push(`  ${revision} ${family} ${key}${tool ? `/${tool}` : ""} -> ${resolved.url}`);
      }
      // Negative control for the same reason the tampered object exists below:
      // a resolver that answers for a target nobody built is not resolving.
      let refused = null;
      try {
        resolveArtifactUrl({ index, entry, family: "native-artifacts", key: "x86-osx" });
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
