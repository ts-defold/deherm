// What determines the BYTES of each published artifact family - stated once,
// as data, so the release tag is a fingerprint of the real dependency graph
// instead of a fingerprint of "files we happened to list".
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// Both manager scripts used to hash `upstream.lock` in its entirety. That made
// every artifact a function of every pin in it, and the consequence was
// measured rather than theorised: changing ONLY `DEFOLD_REV` rotated the
// host-tool tag from 7a3536af to 35787eb7 and the target tag from d37e4040 to
// 6fb21b2c. `hermesc` and `shermes` do not link, read or embed anything of
// Defold's, so a nightly Defold repin - which
// `.github/workflows/policy-revisions.yml` does routinely - would have forced a
// rebuild and republish of all 25 artifacts for zero byte change.
//
// So each family names the lock KEYS it consumes, not the file. A key a family
// declares and the lock does not carry is a hard error: silently skipping it
// would publish different bytes under an existing tag, which is the one failure
// mode content addressing exists to prevent.
//
// ── The real graph ───────────────────────────────────────────────────────────
//
//   hermesc, shermes  <- the pinned Hermes tree and one build script. NOT Defold.
//   dehermc           <- the ttsc version, its Go sources and its build script.
//                        NOT Defold, NOT Hermes; it is a TypeScript transform
//                        compiler and touches neither engine.
//   libhermes.a       <- the pinned Hermes tree, the per-target build recipe,
//                        AND Defold's SDK pins, because an archive built
//                        against a different NDK API level or deployment
//                        minimum than the engine links against is an ABI
//                        mismatch Extender only finds at link time.
//
// That last dependency is why `defold-bundle-targets.json` is hashed by FIELD
// and not whole: the file also carries `defoldRevision` and `sourceSha256`,
// which move on every repin and would reintroduce exactly the coupling this
// split removes.
//
// ── What is deliberately still over-hashed ───────────────────────────────────
//
// Comments in the build scripts are hashed with everything else, so a
// prose-only edit to `Dockerfile.android` rotates a tag and republishes
// identical bytes. That is waste, and it is the SAFE direction: a false
// negative would serve different bytes under a tag users have already pinned.
// Stripping comments would mean parsing five languages correctly enough to bet
// artifact identity on it.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serializeObject } from "../../packages/compiler/src/api-policy.mjs";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The three published artifact families, each with the exact inputs that decide
 * its bytes.
 *
 * `hermes-host` and `dehermc` were one `host-tools` family. They are split
 * because they share nothing: a Go transform edit used to republish ten
 * unchanged LLVM compilers, and a Hermes repin used to republish five unchanged
 * Go binaries. Both matrices are still indexed by the user's HOST; that is the
 * only thing they have in common.
 */
export const artifactFamilies = Object.freeze({
  "hermes-host": {
    tagPrefix: "hermes-host",
    summary: "hermesc and shermes, per user host",
    tools: ["hermesc", "shermes"],
    lockKeys: ["HERMES_URL", "HERMES_REV"],
    files: ["toolchains/hermes/build-host-compilers.sh"],
    json: []
  },
  dehermc: {
    tagPrefix: "dehermc",
    summary: "dehermc, déherm's TypeScript transform compiler, per user host",
    tools: ["dehermc"],
    // Nothing from upstream.lock. dehermc links the typescript-go compiler that
    // arrives with the pinned ttsc npm package; neither engine is involved.
    lockKeys: [],
    files: [
      "toolchains/go/build-dehermc.sh",
      "packages/compiler/go.mod",
      "packages/compiler/ttsc/cmd/dehermc/main.go",
      "packages/compiler/ttsc/hash-literal/hash_literal.go",
      "packages/compiler/ttsc/hash-literal/resource_name.go",
      "packages/compiler/ttsc/hash-literal/api_usage.go"
    ],
    // The ttsc npm version decides which typescript-go dehermc is linked
    // against, so it belongs in the fingerprint even though no file above
    // contains it.
    json: [{ file: "packages/toolchains/host-compilers.json", fields: ["ttscVersion"] }]
  },
  "native-artifacts": {
    tagPrefix: "native-artifacts",
    summary: "libhermes.a / hermes.lib, per Defold bundle target",
    lockKeys: ["HERMES_URL", "HERMES_REV"],
    files: [
      "toolchains/hermes/Dockerfile.linux",
      "toolchains/hermes/Dockerfile.win32",
      "toolchains/hermes/Dockerfile.android",
      "toolchains/hermes/build-apple.sh",
      // The fallback Windows lane, which runs whenever no Defold registry
      // credential is configured. It was missing from the old input list, so a
      // change to the recipe that actually produced `hermes.lib` on a fork left
      // the tag - and therefore the published bytes' identity - unchanged.
      "toolchains/hermes/build-windows.sh",
      "toolchains/hermes/package-posix.sh",
      "toolchains/hermes/package-msvc.sh",
      "toolchains/hermes/windows-msvc.cmake",
      // The local macOS packaging path, which produces the artifact
      // `manage-native-artifacts.mjs record` pins.
      "scripts/package-defold-extension.sh"
    ],
    // `sdk` is what every cross build compiles against and `targets` is the
    // matrix it compiles for. The rest of that file - `defoldRevision`,
    // `sourceSha256`, `source` - describes where the numbers came from, not
    // what the compiler does with them.
    json: [{ file: "packages/toolchains/defold-bundle-targets.json", fields: ["sdk", "targets"] }]
  }
});

export const artifactFamilyNames = Object.freeze(Object.keys(artifactFamilies));

/** The families whose artifacts are indexed by the user's host, not by a bundle target. */
export const hostArtifactFamilyNames = Object.freeze(
  artifactFamilyNames.filter((name) => Array.isArray(artifactFamilies[name].tools))
);

export function requireFamily(name) {
  const family = artifactFamilies[name];
  if (!family) {
    throw new Error(`Unknown artifact family ${name}; declared families are ${artifactFamilyNames.join(", ")}`);
  }
  return family;
}

/** Which family publishes a given host tool. */
export function familyForHostTool(tool) {
  const name = hostArtifactFamilyNames.find((candidate) => artifactFamilies[candidate].tools.includes(tool));
  if (!name) throw new Error(`No artifact family publishes the host tool ${tool}`);
  return name;
}

/**
 * Parse `upstream.lock` into key/value pairs.
 *
 * A repeated key is rejected rather than resolved by first-or-last match: the
 * old whole-file hash could not tell the two apart, and a fingerprint that
 * silently picks one of two conflicting pins is worse than one that refuses.
 */
export function parseLock(text, label = "upstream.lock") {
  const values = new Map();
  const duplicates = [];
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    if (values.has(match[1])) duplicates.push(match[1]);
    values.set(match[1], match[2]);
  }
  if (duplicates.length) throw new Error(`${label} declares ${[...new Set(duplicates)].join(", ")} more than once`);
  return values;
}

/**
 * Read exactly the lock keys a family consumes.
 *
 * Missing keys are a hard error naming all of them at once, because the point
 * of hashing keys instead of the file is that the set is explicit - a typo that
 * silently dropped a key would produce a stable tag over an incomplete input
 * set, and the artifacts published under it would be unreproducible.
 */
export async function readLockKeys(lockFile, keys) {
  const label = path.basename(lockFile);
  const values = parseLock(await readFile(lockFile, "utf8"), label);
  const missing = keys.filter((key) => !values.has(key));
  if (missing.length) {
    throw new Error(`${label} does not declare ${missing.join(", ")}, which this artifact family consumes`);
  }
  return Object.fromEntries(keys.map((key) => [key, values.get(key)]));
}

/**
 * The content fingerprint of one family's inputs.
 *
 * `root` is a parameter so a test can fingerprint a tree holding a temp copy of
 * `upstream.lock` or of a generated manifest, without mutating the real ones.
 */
export async function fingerprintFamily(name, options = {}) {
  const family = requireFamily(name);
  const root = options.root ?? repositoryRoot;
  const lockFile = path.join(root, "upstream.lock");

  const hash = createHash("sha256");
  // Domain separation: two families that happened to consume an identical input
  // set must still address different releases, because their asset names and
  // their matrices differ.
  hash.update(`deherm.artifact-family\0${name}\0`);

  if (family.lockKeys.length) {
    const values = await readLockKeys(lockFile, family.lockKeys);
    for (const key of family.lockKeys) hash.update(`upstream.lock#${key}\0${values[key]}\0`);
  }
  for (const relative of family.files) {
    const bytes = await readFile(path.join(root, relative));
    hash.update(`${relative}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  for (const { file, fields } of family.json) {
    const document = JSON.parse(await readFile(path.join(root, file), "utf8"));
    for (const field of fields) {
      // Same rule as the lock keys: a field this family declares and the
      // document does not carry is a refusal, never a skipped input.
      if (!(field in document)) throw new Error(`${file} does not carry ${field}, which ${name} consumes`);
      // Canonical JSON, so reordering keys in a generated file does not rotate
      // a tag and reformatting it cannot hide a changed value.
      const bytes = Buffer.from(serializeObject(document[field]), "utf8");
      hash.update(`${file}#${field}\0${bytes.byteLength}\0`);
      hash.update(bytes);
    }
  }
  return hash.digest("hex");
}

/** The release tag a family's artifacts are published under. */
export async function familyTag(name, options = {}) {
  return `${requireFamily(name).tagPrefix}-${await fingerprintFamily(name, options)}`;
}

// ── What each family publishes ──────────────────────────────────────────────
//
// The asset NAME is load-bearing rather than cosmetic: it is the last path
// segment of the download URL - see packages/cli/src/release-assets.mjs - so
// the same listing has to serve the CI completeness check, the `pull` verb and
// the policy index entry. Stating it once is what keeps those three from
// drifting into three slightly different answers.

const nativeManifestPath = "packages/toolchains/native-artifacts.json";
const hostManifestPath = "packages/toolchains/host-compilers.json";

/**
 * A target that is `blocked` or `retired-upstream` links no archive, so it is
 * not expected in a release and must not hold one open forever. Same predicate
 * `manage-native-artifacts.mjs install` uses.
 */
function installableTarget(artifact) {
  return artifact.status === "vendored" || artifact.status === "required-missing";
}

/** Windows publishes one merged `hermes.lib`; every other target a `libhermes.a`. */
export function targetLibraryName(target, artifact) {
  return target === "x86_64-win32" ? "hermes.lib" : path.posix.basename(artifact.library);
}

/**
 * Every asset one family is expected to publish, with the matrix row it answers
 * for. Target rows carry `target`; host rows carry `host` and `tool`.
 */
export async function publishedAssets(name, options = {}) {
  const family = requireFamily(name);
  const root = options.root ?? repositoryRoot;
  const rows = [];
  if (family.tools) {
    const manifest = JSON.parse(await readFile(path.join(root, hostManifestPath), "utf8"));
    for (const [host, record] of Object.entries(manifest.hosts)) {
      for (const tool of family.tools) {
        const toolRecord = record.tools?.[tool];
        // A host that declares no record for one of the family's tools is a
        // manifest the matrix test already rejects; here it simply publishes
        // nothing, rather than naming an asset no lane uploads.
        if (!toolRecord || toolRecord.status === "blocked") continue;
        rows.push({ host, tool, asset: `host-compilers-${host}-${path.posix.basename(toolRecord.file)}` });
      }
    }
  } else {
    const manifest = JSON.parse(await readFile(path.join(root, nativeManifestPath), "utf8"));
    for (const [target, artifact] of Object.entries(manifest.targets)) {
      if (!installableTarget(artifact)) continue;
      rows.push({ target, asset: `hermes-${target}-${targetLibraryName(target, artifact)}` });
    }
  }
  return rows.sort((left, right) => left.asset.localeCompare(right.asset));
}

/** The flat, sorted asset listing CI checks a release's completeness against. */
export async function expectedAssetNames(name, options = {}) {
  return (await publishedAssets(name, options)).map((row) => row.asset);
}
