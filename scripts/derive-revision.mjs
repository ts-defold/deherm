#!/usr/bin/env node

// Derive one Defold revision's API policy without touching the committed surface.
//
// See `.agents/docs/decisions/layered-api-policy-cache.md` ("The nightly job")
// and `.agents/docs/decisions/revision-parametric-derivation.md`.
//
// ── The problem this exists to solve ────────────────────────────────────────
//
// Every generator in this repository reads and writes FIXED repository paths,
// and the whole generated surface describes exactly one Defold revision - the
// one `upstream.lock` pins. Deriving a policy for a different revision means
// regenerating that whole surface against that revision's sources, which in a
// checkout means overwriting the committed one. The nightly did exactly that,
// in place, which is why it repinned the lock as its first step.
//
// That is wrong in two ways at once. It makes a scheduled job mutate the thing
// `pnpm check` verifies, so a failed or cancelled run leaves a checkout that
// describes a revision nobody chose; and it makes "derive" and "adopt" the same
// irreversible operation, so nothing can derive a revision in order to LOOK at
// it.
//
// ── The approach ───────────────────────────────────────────────────────────
//
// A scratch workspace, not a scratch output root. Redirecting output would mean
// teaching roughly thirty generators - plus the ownership registries, the clean
// rooms and the policy store - about an output root they do not have, and one
// generator that missed the redirect would write into the committed surface
// silently. Materialising the repository into a workspace and running the
// unmodified chain there makes the committed surface unreachable BY
// CONSTRUCTION: no generator can write to a path it cannot address.
//
// The workspace is a copy of every tracked and every new non-ignored file, taken
// from the working tree so uncommitted generator changes are exercised, with
// `node_modules` symlinked and `upstream/` materialised for the revision being
// derived. Nothing is shared with the checkout that can be written.
//
// ── What it proves ─────────────────────────────────────────────────────────
//
// The committed surface is fingerprinted before and after, over every path any
// generator in the chain can write plus `upstream.lock`, and a derivation that
// moved a single byte of it fails. `--adopt` is the separate, explicit step
// that copies the derived surface back, and it fingerprints first, so adopting
// is never how an accidental in-place write gets laundered into a commit.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  generatedScriptArtifacts,
  luaRegistrationSurfaceGenerator,
  resourceNamespaceGenerator,
  apiPolicyGenerator
} from "./lib/script-generator-pipeline.mjs";
import { generatedDmSdkArtifacts } from "./lib/dmsdk-generator-pipeline.mjs";
import { generatedBundleTargetArtifacts } from "./generate-defold-bundle-targets.mjs";
import { CARRIED_REVIEW_LEDGER_ENV, DERIVED_REVISION_ENV, isDefoldRevision } from "./lib/reviewed-revision.mjs";
import { auditReviewedEvidence } from "./lib/reviewed-evidence.mjs";

const execFileAsync = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The derivation chain, in the order the ownership registries imply: the
 * declared surface first, then the source-derived registration ground truth
 * over it, then the generators that consume the registration gate, then the
 * policy that assembles them.
 *
 * This list is the single authority. It used to live inline in
 * `.github/workflows/policy.yml`, where nothing could run it and
 * nothing could check it against the registries.
 */
export const derivationSteps = Object.freeze([
  Object.freeze({ runtime: "python3", script: "scripts/import-defold-sdk.py" }),
  Object.freeze({ runtime: "python3", script: "scripts/import-defold-script-api.py" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-sdk-semantics.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-lua-registration-surface.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-defold-resource-schema.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-resource-namespace-classification.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-defold-bundle-targets.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-dmsdk-sdk.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-dmsdk-symbol-evidence.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-dmsdk-runtime.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-runtime.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/ensure-binding-lowering-plan.mjs", args: ["--force"] }),
  Object.freeze({ runtime: "node", script: "scripts/generate-typed-native-bridge.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-recording-engine.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-api-policy.mjs", args: ["--prune"] }),
  Object.freeze({ runtime: "node", script: "scripts/generate-api-policy.mjs", args: ["--check"] })
]);

/**
 * Revision-keyed inputs that are not part of the sparse source checkout.
 *
 * `track-defold-channels pin` rewrites these URLs and digests before this list
 * runs. Keep the download in the scratch workspace: the dmSDK importer must
 * resolve generated DDF and third-party headers from the exact SDK archive for
 * the revision being derived, never from the repository's pinned revision.
 */
export const revisionSupportSteps = Object.freeze([
  Object.freeze({ runtime: "bash", script: "scripts/bootstrap-upstreams.sh", args: ["defold-sdk"] })
]);

/**
 * The sparse slice of the Defold tree the chain reads.
 *
 * `packages/` carries `vectormathlibrary-*.tar.gz`, which the dmSDK importer
 * unpacks so that every `dmsdk/**` header that includes `vectormath/cpp/...`
 * resolves. Leaving it out does not fail: the importer used to parse without it
 * and emit a quietly degraded inventory, so a CI derivation and a local
 * derivation of the SAME revision produced different policy roots.
 */
export const enginePaths = Object.freeze([
  "engine",
  "build_tools/sdk.py",
  "share/extender/build_input.yml",
  "share/extender/variants",
  "com.dynamo.cr/com.dynamo.cr.bob/src",
  "editor/test/resources/test_project/app_manifest",
  "packages"
]);

/**
 * Every repository path the derivation chain can write.
 *
 * The fingerprint is taken over these and nothing else. Restricting it is not a
 * convenience: a repository-wide `git status` would also see unrelated work in
 * the checkout and could neither prove nor disprove anything about this chain.
 */
export const derivedSurfaceRoots = Object.freeze([
  "upstream.lock",
  "packages/toolchains",
  "packages/bindings/generated",
  "packages/sdk/src/generated",
  "packages/static-hermes/src/generated",
  "defold/defold_hermes/include/defold_hermes",
  "defold/defold_hermes/src",
  "defold/defold_hermes/lib/web",
  "examples/runtime-smoke/src/generated",
  "tests/fixtures",
  ".agents/docs/research"
]);

/** Documentation the importers own outright, beside the registries' artifact lists. */
const generatedDocumentation = Object.freeze([
  ".agents/docs/research/sdk-coverage.md",
  ".agents/docs/research/script-api-coverage.md",
  ".agents/docs/research/script-table-tuple-schema-classification.md"
]);

/**
 * The paths `--adopt` may copy back.
 *
 * Anything the derivation changed that is not here is a generator writing an
 * artifact no ownership registry declares, which is a defect to fix rather than
 * a file to copy. `packages/bindings/generated/` is admitted wholesale because
 * the policy store's filenames are content hashes and so cannot be enumerated
 * before the derivation runs - see `apiPolicyGenerator.storeRoot`.
 */
export function ownedArtifactPaths() {
  return new Set([
    "upstream.lock",
    ...generatedBundleTargetArtifacts,
    ...generatedDocumentation,
    ...generatedScriptArtifacts,
    ...generatedDmSdkArtifacts,
    ...luaRegistrationSurfaceGenerator.artifacts,
    ...resourceNamespaceGenerator.artifacts,
    ...apiPolicyGenerator.artifacts
  ]);
}

function isOwned(relativePath, owned) {
  return owned.has(relativePath) ||
    relativePath.startsWith("packages/bindings/generated/") ||
    relativePath.startsWith("packages/sdk/src/generated/");
}

// ── Fingerprinting the committed surface ────────────────────────────────────

async function walk(base, relative = "") {
  const absolute = path.join(base, relative);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : 1)) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(base, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/**
 * Paths beneath the derivable roots that this checkout ignores.
 *
 * `tests/fixtures/**\/.deherm/generated/` is the case that forced this: those
 * are a harness's own scratch output, ignored and therefore never materialised
 * into a workspace, so comparing them would report every one of them as
 * "removed by the derivation".
 */
export async function ignoredSurfacePaths(sourceRoot) {
  const { stdout } = await run(
    "git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...derivedSurfaceRoots],
    { cwd: sourceRoot }
  );
  return new Set(stdout.split("\0").filter(Boolean));
}

/** Every file beneath the derivable roots, path-sorted, with its SHA-256. */
export async function surfaceFingerprint(treeRoot, ignored = new Set()) {
  const files = new Map();
  const record = async (file) => {
    if (ignored.has(file)) return;
    files.set(file, createHash("sha256").update(await readFile(path.join(treeRoot, file))).digest("hex"));
  };
  for (const entry of derivedSurfaceRoots) {
    const absolute = path.join(treeRoot, entry);
    let info;
    try {
      info = await stat(absolute);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (info.isFile()) {
      await record(entry);
      continue;
    }
    for (const relative of await walk(absolute)) await record(`${entry}/${relative}`);
  }
  const sorted = [...files].sort(([left], [right]) => left < right ? -1 : 1);
  const digest = createHash("sha256");
  for (const [file, hash] of sorted) digest.update(file).update("\0").update(hash).update("\0");
  return { files: new Map(sorted), root: `sha256:${digest.digest("hex")}` };
}

export function fingerprintDifference(before, after) {
  const changed = [];
  for (const [file, hash] of after.files) {
    const previous = before.files.get(file);
    if (previous === undefined) changed.push({ file, disposition: "added" });
    else if (previous !== hash) changed.push({ file, disposition: "changed" });
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) changed.push({ file, disposition: "removed" });
  }
  return changed.sort((left, right) => left.file < right.file ? -1 : 1);
}

// ── The workspace ───────────────────────────────────────────────────────────

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}

/**
 * Copy every tracked file into the workspace, from the WORKING TREE rather than
 * from HEAD, so a generator change under review is the one that runs.
 */
export async function materializeWorkspace({ sourceRoot, workspace }) {
  // Tracked files plus anything new that is not ignored - the set a commit would
  // carry. A derivation must exercise the generator change being written, and a
  // new generator library is untracked until the moment it is committed.
  const { stdout } = await run(
    "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: sourceRoot }
  );
  const files = stdout.split("\0").filter(Boolean);
  const directories = new Set();
  for (const file of files) {
    const directory = path.dirname(file);
    if (directory !== "." && !directories.has(directory)) {
      await mkdir(path.join(workspace, directory), { recursive: true });
      directories.add(directory);
    }
    const source = path.join(sourceRoot, file);
    let info;
    try {
      info = await lstat(source);
    } catch (error) {
      // `git ls-files --cached` includes a tracked path deleted by the working
      // tree. A derivation exercises the working tree that would be committed,
      // so the deletion is an input too; attempting to copy the index's stale
      // pathname made every workflow consolidation impossible to derive before
      // its deletion commit existed.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    // Tracked symlinks are reproduced as symlinks. Following one would copy a
    // whole vendored extension tree into the workspace, and - where it points
    // outside the repository - would quietly import something `git ls-files`
    // never claimed was part of this checkout.
    if (info.isSymbolicLink()) await symlink(await readlink(source), path.join(workspace, file));
    else await copyFile(source, path.join(workspace, file));
  }
  // One symlink, not a copy: the installed tree is gigabytes, it is an input
  // that no generator writes to, and `pnpm-lock.yaml` is copied beside it so
  // the clean rooms can still check what is installed against what is locked.
  await symlink(path.join(sourceRoot, "node_modules"), path.join(workspace, "node_modules"), "dir");
  return files.length;
}

function lockValue(lock, key) {
  return lock.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1] ?? null;
}

/**
 * Fetch the engine slice for one revision into the workspace.
 *
 * Identical to what a fresh CI runner does, and deliberately so: a derivation
 * that read a checkout somebody had already modified would not be a derivation
 * of the revision it names.
 */
async function fetchEngineSlice({ workspace, revision }) {
  const lock = await readFile(path.join(workspace, "upstream.lock"), "utf8");
  const url = lockValue(lock, "DEFOLD_URL");
  const refDocUrl = lockValue(lock, "DEFOLD_REF_DOC_URL");
  const refDocSha256 = lockValue(lock, "DEFOLD_REF_DOC_SHA256");
  if (!url || !refDocUrl || !refDocSha256) throw new Error("upstream.lock does not declare the Defold source pins");
  const defold = path.join(workspace, "upstream", "defold");
  await mkdir(defold, { recursive: true });
  await run("git", ["init", "-q"], { cwd: defold });
  await run("git", ["remote", "add", "origin", url], { cwd: defold });
  await run("git", ["config", "core.sparseCheckout", "true"], { cwd: defold });
  await run("git", ["sparse-checkout", "set", ...enginePaths], { cwd: defold });
  await run("git", ["fetch", "--depth=1", "--filter=blob:none", "origin", revision], { cwd: defold });
  await run("git", ["checkout", "--detach", revision], { cwd: defold });

  const response = await fetch(refDocUrl);
  if (!response.ok) throw new Error(`${refDocUrl}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== refDocSha256) {
    throw new Error(`${refDocUrl} served ${observed}, but upstream.lock pins ${refDocSha256}`);
  }
  await writeFile(path.join(workspace, "upstream", "ref-doc.zip"), bytes);
}

/**
 * Clone an already-materialised `upstream/` into the workspace.
 *
 * A local fast path, and the one the byte-identity control uses. It is verified,
 * not trusted: the checkout must be at the revision being derived and the
 * reference archive must hash to what the repinned lock says.
 */
async function reuseEngineSlice({ workspace, revision, from }) {
  const source = path.resolve(from);
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: path.join(source, "defold") });
  if (stdout.trim() !== revision) {
    throw new Error(`${from}/defold is at ${stdout.trim()}, not the revision being derived (${revision})`);
  }
  await mkdir(path.join(workspace, "upstream"), { recursive: true });
  // Clone-on-write where the filesystem offers it (APFS), hard links otherwise;
  // either way the derivation reads real files beneath the workspace, which a
  // symlink would not give it - the importers resolve every header path and
  // refuse one that escapes the tree.
  const target = path.join(workspace, "upstream", "defold");
  const strategies = process.platform === "darwin" ? [["-c", "-R"], ["-R"]] : [["-al"], ["-a"]];
  let copied = false;
  for (const flags of strategies) {
    try {
      await run("cp", [...flags, path.join(source, "defold"), target]);
      copied = true;
      break;
    } catch {
      await rm(target, { recursive: true, force: true });
    }
  }
  if (!copied) throw new Error(`Could not clone ${from}/defold into the workspace`);
  await copyFile(path.join(source, "ref-doc.zip"), path.join(workspace, "upstream", "ref-doc.zip"));

  const lock = await readFile(path.join(workspace, "upstream.lock"), "utf8");
  const expected = lockValue(lock, "DEFOLD_REF_DOC_SHA256");
  const observed = createHash("sha256")
    .update(await readFile(path.join(workspace, "upstream", "ref-doc.zip")))
    .digest("hex");
  if (observed !== expected) {
    throw new Error(`${from}/ref-doc.zip hashes to ${observed}, but the repinned lock expects ${expected}`);
  }
}

/**
 * Let the workspace share this checkout's pinned dmSDK parse sysroot.
 *
 * `scripts/import-defold-sdk.py` fetches and digest-verifies it on demand, so a
 * workspace without one still derives - it just downloads 62MB again for every
 * revision in the matrix. A symlink is enough because nothing writes there: the
 * importer only reads the headers, and it re-verifies nothing it did not fetch
 * because the cache directory is named by the pinned digest.
 *
 * `upstream/` is ignored, so `materializeWorkspace` never copies it.
 */
async function reuseParseSysroot({ workspace, sourceRoot }) {
  const cache = path.join(sourceRoot, "upstream", "dmsdk-parse-sysroot");
  try {
    if (!(await stat(cache)).isDirectory()) return;
  } catch {
    return;
  }
  await mkdir(path.join(workspace, "upstream"), { recursive: true });
  await symlink(cache, path.join(workspace, "upstream", "dmsdk-parse-sysroot"), "dir");
}

// ── The derivation ──────────────────────────────────────────────────────────

export async function deriveRevision(options) {
  const {
    revision,
    sourceRoot = root,
    workspace,
    upstreamFrom = null,
    carryReviews = false,
    auditOnly = false,
    adopt = false,
    onProgress = () => {}
  } = options;
  if (!isDefoldRevision(revision)) throw new Error(`Not a Defold revision: ${revision}`);

  const ignored = await ignoredSurfacePaths(sourceRoot);
  const before = await surfaceFingerprint(sourceRoot, ignored);
  const pinned = lockValue(await readFile(path.join(sourceRoot, "upstream.lock"), "utf8"), "DEFOLD_REV");

  await mkdir(workspace, { recursive: true });
  if ((await readdir(workspace)).length) throw new Error(`Workspace is not empty: ${workspace}`);

  onProgress(`materialising ${path.relative(sourceRoot, workspace) || workspace}`);
  const fileCount = await materializeWorkspace({ sourceRoot, workspace });

  // Repin FIRST: the engine slice's reference archive is verified against the
  // digest the repinned lock records, which is the digest the immutable archive
  // actually served for this revision rather than a recalled constant.
  onProgress(`pinning Defold ${revision}`);
  await run(process.execPath, ["scripts/track-defold-channels.mjs", "pin", revision, "--write"], { cwd: workspace });

  onProgress(upstreamFrom ? `reusing ${upstreamFrom}` : "fetching the engine slice");
  if (upstreamFrom) await reuseEngineSlice({ workspace, revision, from: upstreamFrom });
  else await fetchEngineSlice({ workspace, revision });
  await reuseParseSysroot({ workspace, sourceRoot });
  for (const step of revisionSupportSteps) {
    const label = `${step.script} ${step.args.join(" ")}`;
    onProgress(label);
    await run(step.runtime, [step.script, ...step.args], { cwd: workspace });
  }

  // Before running anything: does every reviewed input still speak for this
  // revision's sources? Each generator checks its own and stops at the first
  // failure, which reports one moved file and says nothing about the rest. The
  // whole census is what decides whether a revision is derivable at all, and it
  // is what a reviewer needs in order to act.
  onProgress("auditing reviewed evidence");
  const evidence = await auditReviewedEvidence(workspace);

  const ledger = path.join(workspace, "carried-reviews.jsonl");
  await writeFile(ledger, "");
  const env = { ...process.env };
  if (carryReviews) {
    env[DERIVED_REVISION_ENV] = revision;
    env[CARRIED_REVIEW_LEDGER_ENV] = ledger;
  } else {
    delete env[DERIVED_REVISION_ENV];
    delete env[CARRIED_REVIEW_LEDGER_ENV];
  }

  // The evidence census does NOT gate the derivation. It used to: any drifted
  // claim stopped the run, which meant a Defold release that edited a cited
  // file - the ordinary case, and the thing this job exists to derive for -
  // produced nothing. A moved source is a new policy entry for that revision,
  // not an error, and a withdrawn entry is a policy difference that shows up in
  // the diff a reviewer reads. See `scripts/lib/revision-audit.mjs`.
  //
  // What still blocks is a generator that actually refuses (recorded below) and
  // the proof that this checkout's committed surface did not move.
  const steps = [];
  let blocker = null;
  if (!auditOnly) {
    for (const step of derivationSteps) {
      const label = `${step.script}${step.args ? ` ${step.args.join(" ")}` : ""}`;
      onProgress(label);
      const command = step.runtime === "node" ? process.execPath : step.runtime;
      const started = Date.now();
      try {
        const { stdout, stderr } = await run(command, [step.script, ...(step.args ?? [])], { cwd: workspace, env });
        steps.push({ step: label, seconds: Math.round((Date.now() - started) / 100) / 10, stdout, stderr });
      } catch (error) {
        // A refusal is the derivation's result, not a crash. The committed
        // surface still has to be proven untouched below, and a scheduled run
        // has to be able to report WHICH generator refused and why.
        steps.push({ step: label, seconds: Math.round((Date.now() - started) / 100) / 10, failed: true });
        blocker = { kind: "generator", step: label, message: error.message };
        break;
      }
    }
  }

  const carried = (await readFile(ledger, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let manifest = null;
  if (!blocker && !auditOnly) {
    manifest = JSON.parse(
      await readFile(path.join(workspace, "packages/bindings/generated/defold-api-policy.json"), "utf8")
    );
    if (manifest.defoldRevision !== revision) {
      throw new Error(`The derived policy manifest names ${manifest.defoldRevision}, not ${revision}`);
    }
  }

  // The proof, taken before anything may be copied back. A derivation that
  // reached the committed surface fails here rather than being adopted.
  const after = await surfaceFingerprint(sourceRoot, ignored);
  const disturbed = fingerprintDifference(before, after);
  if (disturbed.length) {
    throw new Error(
      `The committed surface of ${pinned} moved while ${revision} was being derived:\n` +
      disturbed.map(({ file, disposition }) => `  ${disposition} ${file}`).join("\n") +
      "\nA derivation must never write into this checkout. If nothing else was editing the tree, " +
      "a generator in the chain addressed a repository path instead of the workspace."
    );
  }

  const derived = await surfaceFingerprint(workspace, ignored);
  const changed = fingerprintDifference(before, derived);
  const owned = ownedArtifactPaths();
  const unowned = changed.filter(({ file }) => !isOwned(file, owned));
  if (unowned.length) {
    throw new Error(
      "The derivation changed files that no ownership registry declares:\n" +
      unowned.map(({ file, disposition }) => `  ${disposition} ${file}`).join("\n") +
      "\nRegister them with their generator, or stop writing them."
    );
  }

  const adopted = [];
  if (adopt && blocker) throw new Error(`Refusing to adopt a blocked derivation of ${revision}: ${blocker.message}`);
  if (adopt) {
    for (const { file, disposition } of changed) {
      const destination = path.join(sourceRoot, file);
      if (disposition === "removed") {
        await rm(destination, { force: true });
      } else {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(workspace, file), destination);
      }
      adopted.push(file);
    }
  }

  return {
    revision,
    pinnedRevision: pinned,
    workspace,
    fileCount,
    steps,
    status: blocker ? "blocked" : auditOnly ? "audited" : "derived",
    blocker,
    reviewedEvidence: {
      inputCount: evidence.inputCount,
      claimCount: evidence.claimCount,
      fileCount: evidence.fileCount,
      driftedCount: evidence.drifted.length,
      driftedByInput: evidence.driftedByInput,
      drifted: evidence.drifted
    },
    carriedReviews: carried,
    policyRoot: manifest?.policyRoot ?? null,
    generator: manifest?.generator ?? null,
    counts: manifest?.counts ?? null,
    committedSurfaceRoot: before.root,
    committedSurfaceUnchanged: true,
    changed,
    adopted
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArguments(argv) {
  const options = {
    revision: null, workspace: null, upstreamFrom: null,
    carryReviews: false, auditOnly: false, adopt: false, clean: false, json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === "--revision") options.revision = take();
    else if (argument === "--workspace") options.workspace = take();
    else if (argument === "--upstream-from") options.upstreamFrom = take();
    else if (argument === "--carry-reviews") options.carryReviews = true;
    else if (argument === "--audit-only") options.auditOnly = true;
    else if (argument === "--adopt") options.adopt = true;
    else if (argument === "--clean") options.clean = true;
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.revision) {
    throw new Error("Usage: derive-revision.mjs --revision <sha> [--workspace <dir>] [--upstream-from <dir>] " +
      "[--carry-reviews] [--audit-only] [--adopt] [--clean] [--json]");
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const workspace = options.workspace
    ? path.resolve(options.workspace)
    : await mkdtemp(path.join(tmpdir(), `deherm-derive-${options.revision.slice(0, 12)}-`));
  const report = await deriveRevision({
    ...options,
    workspace,
    onProgress: (message) => { if (!options.json) console.log(`  ${message}`); }
  });
  if (options.clean) await rm(workspace, { recursive: true, force: true });

  if (options.json) {
    console.log(JSON.stringify({ ...report, steps: report.steps.map(({ stdout: _o, stderr: _e, ...row }) => row) }, null, 2));
    if (report.status === "blocked") process.exitCode = 1;
    return;
  }
  console.log("");
  for (const { step, seconds, failed } of report.steps) {
    console.log(`  ${seconds.toFixed(1)}s  ${step}${failed ? "   REFUSED" : ""}`);
  }
  console.log("");

  const evidence = report.reviewedEvidence;
  console.log(`Reviewed evidence at ${report.revision}: ` +
    `${evidence.claimCount - evidence.driftedCount}/${evidence.claimCount} claims hold ` +
    `across ${evidence.fileCount} pinned Defold sources.`);
  if (evidence.driftedCount) {
    for (const [input, count] of Object.entries(evidence.driftedByInput)) {
      const rows = evidence.drifted.filter((row) => row.input === input);
      const moved = rows.filter((row) => row.status === "moved").length;
      const withdrawn = rows.filter((row) => row.status === "void");
      console.log(`  ${count} in ${input}` +
        (moved ? `, ${moved} moved with every reviewed anchor intact (entry still applies)` : "") +
        (withdrawn.length ? `, ${withdrawn.length} WITHDRAWN for this revision` : ""));
      for (const row of withdrawn) {
        console.log(`      ${row.id ?? row.file} - ${row.reason === "absent" ? "source absent at this revision" : `lost ${row.anchorsLost.length} reviewed anchor(s)`}`);
      }
    }
  }
  console.log("");

  if (report.status === "derived") {
    console.log(`Derived Defold ${report.revision} -> policy ${report.policyRoot.slice(0, 12)}`);
    console.log(`  ${report.counts.namespaces} namespaces, ${report.counts.subtrees} subtrees, ` +
      `${report.counts.indexEntries} index entries`);
    console.log(`  ${report.changed.length} generated files differ from the pinned surface`);
  } else if (report.status === "audited") {
    console.log(`Audited Defold ${report.revision}; no generator was run.`);
  } else {
    console.log(`Defold ${report.revision} is NOT derivable from this checkout.`);
    console.log(`  blocked by ${report.blocker.kind}` +
      (report.blocker.step ? ` at ${report.blocker.step}` : "") + `: ${report.blocker.message}`);
  }
  console.log(`  committed surface of ${report.pinnedRevision} unchanged (${report.committedSurfaceRoot.slice(0, 19)})`);
  if (report.carriedReviews.length) {
    console.log(`  ${report.carriedReviews.length} reviewed inputs were CARRIED forward and must be re-reviewed:`);
    for (const row of report.carriedReviews) {
      console.log(`    ${row.input}\n      reviewed at ${row.reviewed}${row.detail ? ` - ${row.detail}` : ""}`);
    }
  }
  if (report.adopted.length) console.log(`  adopted ${report.adopted.length} files into this checkout`);
  if (!options.clean) console.log(`  workspace ${report.workspace}`);
  if (report.status === "blocked") process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
