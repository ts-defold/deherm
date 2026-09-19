#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { downloadReleaseAssets, extractReleaseArchive } from "../packages/cli/src/release-assets.mjs";
import { fileURLToPath } from "node:url";

import { allTargetNames, buildInputPath, deriveBundleTargets, readBundleTargets } from "./generate-defold-bundle-targets.mjs";
// The input set that decides these bytes - and therefore the release tag - is
// declared in one place for all three artifact families. It hashes the Hermes
// pin and the per-target build recipe, and only the `sdk` and `targets` fields
// of the derived bundle-target list, so a Defold repin that moves nothing but
// `defoldRevision` no longer rebuilds and republishes ten unchanged archives.
import {
  expectedAssetNames,
  familyRelease,
  fingerprintFamily,
  publishedAssets,
  targetDebugLibraryName,
  targetLibraryName
} from "./lib/artifact-releases.mjs";

const FAMILY = "native-artifacts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages", "toolchains", "native-artifacts.json");

// A target whose artifact has to exist before a user can bundle for it. The
// remaining statuses are not "not done yet": `vendored-source` targets link
// generated JavaScript instead of a Hermes archive, and `retired-upstream`
// targets carry no Extender toolchain at all.
const missingStatuses = new Set(["required-missing", "blocked"]);
const knownStatuses = new Set(["vendored", "vendored-source", "required-missing", "blocked", "retired-upstream"]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function filesBelow(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(directory);
  return files;
}

function installable(artifact) {
  return artifact.status === "vendored" || artifact.status === "required-missing";
}

// The asset names this workflow is expected to publish for a complete release.
//
// A release EXISTING is not evidence that it is complete: the first run of the
// native-artifacts workflow created both releases and then every Hermes lane
// failed, leaving an empty release that the next run's existence check happily
// treated as already built. The skip has to be keyed on the assets, not on the
// tag.
//
// The listing lives beside the fingerprint in ./lib/artifact-releases.mjs,
// because the same names have to serve three consumers - this check, `pull`,
// and the policy index entry that tells a user what to download - and three
// copies of a naming rule is three chances to drift.
async function expectedAssets() {
  return expectedAssetNames(FAMILY, { root });
}

/**
 * Where the debugger-enabled sibling of a target's library lives in the tree:
 * beside the release archive, under the name it carries inside the published
 * tarball. Derived rather than stored, so the two names cannot disagree.
 */
export function debugLibraryPath(target, artifact) {
  return path.posix.join(path.posix.dirname(artifact.library), targetDebugLibraryName(target, artifact));
}

async function install(downloadRoot) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const available = await filesBelow(path.resolve(downloadRoot));
  const installed = [];
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    if (!installable(artifact)) continue;
    // The archive unpacks into a directory named for the row it answers for, so
    // both libraries are found the same way and neither is matched by parsing a
    // flat asset name.
    const find = (name) => {
      const candidates = available.filter((file) =>
        path.basename(file) === name && file.split(path.sep).includes(`hermes-${target}`));
      if (candidates.length > 1) throw new Error(`Expected one ${name} in hermes-${target}, found ${candidates.length}`);
      return candidates[0] ?? null;
    };
    const release = find(targetLibraryName(target, artifact));
    // A download that carries nothing for a target leaves that target alone, so
    // one platform's build failing in CI never silently unpins another's digest.
    if (!release) continue;

    const place = async (source, relative) => {
      const destination = path.join(root, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
      const bytes = await readFile(destination);
      if (bytes.byteLength < 1_000_000) throw new Error(`${relative} is implausibly small (${bytes.byteLength} bytes)`);
      return bytes;
    };

    const bytes = await place(release, artifact.library);
    artifact.status = "vendored";
    artifact.sha256 = digest(bytes);
    artifact.bytes = bytes.byteLength;

    // The debugger-enabled variant is a second compilation, shipped in the same
    // archive. It is recorded when present rather than required, because the
    // locally-packaged macOS artifact is produced by one `libtool` invocation
    // that has no second build behind it.
    const debug = find(targetDebugLibraryName(target, artifact));
    if (debug) {
      const debugRelative = debugLibraryPath(target, artifact);
      const debugBytes = await place(debug, debugRelative);
      artifact.debugLibrary = debugRelative;
      artifact.debugSha256 = digest(debugBytes);
      artifact.debugBytes = debugBytes.byteLength;
    }
    installed.push(target);
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return installed;
}

// The macOS host artifact is produced locally by
// scripts/package-defold-extension.sh, so the manifest must describe the
// archive that script just wrote. Recording it there keeps the pinned digest a
// statement about the artifact actually present instead of one that goes stale
// the moment Hermes is rebuilt, while `verify` still rejects a missing, foreign,
// or corrupted library.
async function record(target) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const artifact = manifest.targets[target];
  if (!artifact) throw new Error(`Unknown native artifact target ${target}`);
  if (!installable(artifact)) throw new Error(`${target} is ${artifact.status} and carries no digest`);
  const bytes = await readFile(path.join(root, artifact.library));
  if (bytes.byteLength < 1_000_000) throw new Error(`${target} artifact is implausibly small (${bytes.byteLength} bytes)`);
  artifact.status = "vendored";
  artifact.sha256 = digest(bytes);
  artifact.bytes = bytes.byteLength;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return artifact.sha256;
}

// The matrix is derived from the pinned Defold sources rather than listed here,
// so a Defold release that adds a bundle platform fails this check instead of
// letting a user select a platform nothing in this package mentions.
async function expectedTargets() {
  const generated = await readBundleTargets();
  let derived = null;
  try {
    await stat(buildInputPath);
    derived = await deriveBundleTargets();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (derived && derived.sourceSha256 !== generated.sourceSha256) {
    throw new Error("packages/toolchains/defold-bundle-targets.json is stale; run node scripts/generate-defold-bundle-targets.mjs");
  }
  return { generated, targets: allTargetNames(generated) };
}

async function report() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { generated, targets } = await expectedTargets();
  const declared = Object.keys(manifest.targets).sort();
  const missingFromManifest = targets.filter((target) => !declared.includes(target));
  const unknownInManifest = declared.filter((target) => !targets.includes(target));
  const rows = [];
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    const row = {
      target,
      kind: generated.targets.find((entry) => entry.target === target)?.kind ?? "unknown",
      status: artifact.status,
      builder: artifact.builder ?? null,
      library: artifact.library ?? null,
      blocker: artifact.blocker ?? null,
      detail: ""
    };
    if (!knownStatuses.has(artifact.status)) {
      row.detail = `unknown status ${artifact.status}`;
      row.invalid = true;
    } else if (artifact.status === "vendored") {
      try {
        const bytes = await readFile(path.join(root, artifact.library));
        if (digest(bytes) !== artifact.sha256) {
          row.detail = "checksum mismatch";
          row.invalid = true;
        } else {
          row.detail = `${artifact.sha256.slice(0, 12)} (${bytes.byteLength} bytes)`;
        }
      } catch {
        row.detail = `missing ${artifact.library}`;
        row.invalid = true;
      }
      // The debugger-enabled sibling is checked only when the manifest claims
      // one. A target vendored before the archives existed, or packaged locally
      // by scripts/package-defold-extension.sh, simply has none - and inventing
      // a requirement here would mark every such target invalid.
      if (!row.invalid && artifact.debugLibrary) {
        row.debugLibrary = artifact.debugLibrary;
        try {
          const debugBytes = await readFile(path.join(root, artifact.debugLibrary));
          if (digest(debugBytes) !== artifact.debugSha256) {
            row.detail = "debug library checksum mismatch";
            row.invalid = true;
          } else {
            row.detail += `, debug ${artifact.debugSha256.slice(0, 12)} (${debugBytes.byteLength} bytes)`;
          }
        } catch {
          row.detail = `missing ${artifact.debugLibrary}`;
          row.invalid = true;
        }
      }
    } else if (artifact.status === "vendored-source") {
      try {
        await stat(path.join(root, artifact.library));
        row.detail = artifact.library;
      } catch {
        row.detail = `missing ${artifact.library}`;
        row.invalid = true;
      }
    } else if (artifact.status === "required-missing") {
      if (!artifact.builder) {
        row.detail = "required-missing without a builder";
        row.invalid = true;
      } else row.detail = `build with ${artifact.builder}`;
    } else if (!artifact.blocker?.code || !artifact.blocker?.reason) {
      row.detail = `${artifact.status} without a machine-readable blocker`;
      row.invalid = true;
    } else row.detail = artifact.blocker.code;
    rows.push(row);
  }
  rows.sort((left, right) => left.target.localeCompare(right.target));
  return {
    schemaVersion: 1,
    defoldRevision: manifest.defoldRevision,
    hermesRevision: manifest.hermesRevision,
    source: generated.source,
    missingFromManifest,
    unknownInManifest,
    targets: rows
  };
}

async function verify(complete, json) {
  const result = await report();
  if (json) console.log(JSON.stringify(result, null, 2));
  const problems = [];
  for (const target of result.missingFromManifest) {
    problems.push(`${target}: declared by ${result.source} and absent from the native artifact manifest`);
  }
  for (const target of result.unknownInManifest) {
    problems.push(`${target}: declared by the native artifact manifest and unknown to ${result.source}`);
  }
  for (const row of result.targets) {
    if (row.invalid) problems.push(`${row.target}: ${row.detail}`);
    else if (complete && missingStatuses.has(row.status)) {
      problems.push(`${row.target}: ${row.status}${row.blocker ? ` (${row.blocker.code}: ${row.blocker.reason})` : ` (${row.detail})`}`);
    }
  }
  if (problems.length) {
    throw new Error(`Native artifact matrix (${complete ? "complete" : "declared"}) failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  if (!json) {
    for (const row of result.targets) console.log(`${row.status === "vendored" || row.status === "vendored-source" ? "ok" : "--"} ${row.target}: ${row.status} ${row.detail}`);
    console.log(`ok native artifact matrix (${complete ? "complete" : "declared"}): ${result.targets.length} target(s)`);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === "fingerprint") console.log(await fingerprintFamily(FAMILY, { root }));
// The TAG, derived where the expected-asset listing is derived. The workflow
// used to build it by concatenating a prefix onto `fingerprint` output, which
// put the prefix in two places and let the tag and the asset listing be
// computed from different rules; truncating the digest would have made that
// divergence quiet instead of obvious.
else if (command === "tag") console.log((await familyRelease(FAMILY, { root })).tag);
else if (command === "release-metadata") console.log(JSON.stringify(await familyRelease(FAMILY, { root }), null, 2));
else if (command === "install") {
  if (!args[0]) throw new Error("install requires a downloaded artifact directory");
  const installed = await install(args[0]);
  console.log(`installed ${installed.length} native artifact(s): ${installed.join(", ") || "none"}`);
} else if (command === "record") {
  if (!args[0]) throw new Error("record requires a target, for example arm64-osx");
  console.log(`recorded ${args[0]} ${await record(args[0])}`);
} else if (command === "report") console.log(JSON.stringify(await report(), null, 2));
else if (command === "expected-assets") console.log((await expectedAssets()).join("\n"));
else if (command === "verify") await verify(args.includes("--complete"), args.includes("--json"));
else if (command === "pull") {
  // Release assets, not workflow artifacts. A workflow artifact expires, is
  // scoped to one run, and needs an authenticated API call to fetch; none of
  // that survives to a user six months after a release. The tag defaults to
  // this checkout's own input fingerprint, because the artifacts are
  // content-addressed: many déherm versions share one artifact release.
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : (await familyRelease(FAMILY, { root })).tag;
  const destination = path.join(root, "build", "native-artifact-downloads", tag);
  await mkdir(destination, { recursive: true });
  // By URL, not through `gh`: a user vendoring artifacts should not need a
  // second CLI or an authenticated session. The asset names come from the same
  // listing the CI completeness check uses, so no release listing is fetched to
  // discover them - see packages/cli/src/release-assets.mjs.
  const requestedTargets = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--target") continue;
    const target = args[index + 1];
    if (!target || target.startsWith("--")) throw new Error("--target requires a Defold bundle target");
    requestedTargets.push(target);
    index += 1;
  }
  const published = await publishedAssets(FAMILY, { root });
  const knownTargets = new Set(published.map((row) => row.target));
  const unknownTargets = [...new Set(requestedTargets)].filter((target) => !knownTargets.has(target));
  if (unknownTargets.length) {
    throw new Error(
      `No native artifact is published for ${unknownTargets.join(", ")}; ` +
      `published targets are ${[...knownTargets].sort().join(", ")}`
    );
  }
  const selected = new Set(requestedTargets);
  const rows = selected.size ? published.filter((row) => selected.has(row.target)) : published;
  const { missing } = await downloadReleaseAssets({
    tag,
    assets: rows.map((row) => row.asset),
    destination,
    optional: args.includes("--partial"),
    onProgress: ({ asset, status }) => console.log(`${status === "missing" ? "absent" : "fetched"} ${asset}`)
  });
  if (missing.length) console.log(`${missing.length} asset(s) not published for these inputs`);
  // Each asset is one reproducible .tar.gz holding a target's release and
  // debugger-enabled libraries. Unpack each into a directory named for the row
  // that asked for it, which is what `install` matches on - so nothing here has
  // to re-derive structure by parsing the name it just requested.
  const absent = new Set(missing);
  for (const row of rows) {
    if (absent.has(row.asset)) continue;
    await extractReleaseArchive({
      archive: path.join(destination, row.asset),
      destination: path.join(destination, `hermes-${row.target}`)
    });
  }
  const installed = await install(destination);
  const missingInstalls = rows.map((row) => row.target).filter((target) => !installed.includes(target));
  if (!args.includes("--partial") && missingInstalls.length) {
    throw new Error(`Downloaded archives did not install requested targets: ${missingInstalls.join(", ")}`);
  }
  console.log(`installed ${installed.length} native artifact(s): ${installed.join(", ") || "none"}`);
  // A targeted pull promises that row, not the entire release. The explicit
  // missingInstalls check above is its completeness gate; asking verify() for
  // global completeness here would make `--target x86_64-linux` fail because
  // an unrelated iOS row was intentionally not downloaded.
  await verify(!args.includes("--partial") && selected.size === 0, false);
} else {
  throw new Error(
    "Usage: manage-native-artifacts.mjs {fingerprint|tag|release-metadata|expected-assets|report|" +
    "verify [--complete] [--json]|install <dir>|record <target>|" +
    "pull [--tag <tag>] [--target <bundle-target>] [--partial]}"
  );
}
