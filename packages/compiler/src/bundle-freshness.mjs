import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { BUNDLE_FINGERPRINT_GLOBAL, BUNDLE_FINGERPRINT_LENGTH } from "./bundle-fingerprint.mjs";

/**
 * Bob archives whatever `/deherm/app.dehermc` happens to be on disk as a
 * `custom_resources` entry. Nothing in Bob relates that file to the TypeScript
 * it was compiled from, so a project whose bundler has not run since the last
 * edit ships old code and says nothing about it. This module is the missing
 * relation: it binds a materialised build artifact to the exact source files
 * that produced it, and recomputes that binding from content hashes so the
 * check costs a few file reads rather than a compile.
 *
 * The binding lives in `<project>/deherm.lock`, beside the generation cache key
 * that already records how the SDK was generated, because the lock is the one
 * file that travels with a project whether déherm runs on the build machine or
 * the artifacts are committed and only Bob runs.
 */
export const BUILD_ARTIFACT_SCHEMA = "deherm.build-artifacts/v1";

/**
 * `bundle` is a single fingerprinted JavaScript bundle the runtime evaluates.
 * `generated-sources` is a set of files assembled into the native extension
 * before Bob uploads it - `shermes -emit-c` output, per-extension FFI glue -
 * which is equally project-specific and equally capable of going stale. The
 * emission lane does not exist yet; the freshness relation it will need does.
 */
export const BUILD_ARTIFACT_KINDS = new Set(["bundle", "generated-sources"]);

const fingerprintAssignment = new RegExp(
  `${BUNDLE_FINGERPRINT_GLOBAL}\\s*=\\s*"([0-9a-f]{${BUNDLE_FINGERPRINT_LENGTH}})"`
);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Portable, comparable spelling of a path recorded in the lock. */
export function portableRelativePath(fromDirectory, file) {
  const relative = path.relative(fromDirectory, path.resolve(file));
  if (!relative || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function resolveRecorded(baseDirectory, relative) {
  if (typeof relative !== "string" || !relative || path.posix.isAbsolute(relative) || path.isAbsolute(relative)) {
    throw new Error(`Recorded build artifact path must be project-relative: ${JSON.stringify(relative)}`);
  }
  return path.resolve(baseDirectory, relative.split("/").join(path.sep));
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Artifacts are read the same way the generated-state gates read their inputs:
 * a regular file or nothing. A symlink could point outside the project and make
 * the recorded digest describe something Bob will never archive.
 */
async function readRegularFile(file, label) {
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile()) throw new Error(`${label} must be a regular file, not a symlink or directory: ${file}`);
  return await readFile(file);
}

/**
 * Recover a bundle's own fingerprint from the bundle itself, and recompute it
 * the way `applyBundleFingerprint` originally did: hash the program with the
 * fingerprint span zeroed. A bundle whose declared value disagrees with its
 * content was edited after it was built, which is a different fault from being
 * merely out of date and deserves a different message.
 */
export function inspectBundleFingerprint(source) {
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : String(source);
  const match = fingerprintAssignment.exec(text);
  if (!match) return { declared: null, computed: null, consistent: false, reason: "no-fingerprint" };
  const declared = match[1];
  const start = match.index + match[0].indexOf(declared);
  const head = text.slice(0, start);
  const tail = text.slice(start + BUNDLE_FINGERPRINT_LENGTH);
  const computed = sha256(`${head}${"0".repeat(BUNDLE_FINGERPRINT_LENGTH)}${tail}`);
  return { declared, computed, consistent: declared === computed, reason: null };
}

/**
 * The digest that binds an artifact to its sources. It covers the build
 * configuration as well as the file contents, because the same sources compiled
 * through a different entry point, tsconfig, or output target are a different
 * program. Entries are sorted by code unit so the digest does not depend on the
 * order a bundler happened to report its inputs in.
 */
export function sourceBindingDigest({ build, files }) {
  const entries = Object.entries(files ?? {}).sort(([left], [right]) => compareCodeUnits(left, right));
  for (const [file, digest] of entries) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Source binding digest for ${file} must be a SHA-256`);
  }
  return sha256(JSON.stringify({ schema: BUILD_ARTIFACT_SCHEMA, build: build ?? null, files: entries }));
}

/**
 * Hash a recorded source set from the files currently on disk.
 *
 * Only files that were inputs to the recorded build are read. A source file
 * that became reachable since - a new import, a new component - cannot hide
 * from this, because reaching it required editing a file that is already in the
 * recorded set, and that edit changes the digest.
 */
export async function digestSourceFiles(baseDirectory, relativePaths) {
  const files = {};
  const missing = [];
  for (const relative of [...relativePaths].sort(compareCodeUnits)) {
    const resolved = resolveRecorded(baseDirectory, relative);
    const contents = await readRegularFile(resolved, `Recorded source ${relative}`);
    if (contents === null) missing.push(relative);
    else files[relative] = sha256(contents);
  }
  return { files, missing };
}

/**
 * Build the lock record for one materialised artifact. `files` maps
 * project-relative source paths to their SHA-256; `artifacts` maps
 * project-relative output paths to their SHA-256. A `bundle` record carries one
 * artifact and its self-published fingerprint; a `generated-sources` record
 * carries however many files the emitter wrote.
 */
export function buildArtifactRecord({ kind, resource, build, files, artifacts, fingerprint }) {
  if (!BUILD_ARTIFACT_KINDS.has(kind)) throw new Error(`Unknown build artifact kind: ${kind}`);
  const outputs = Object.fromEntries(
    Object.entries(artifacts ?? {}).sort(([left], [right]) => compareCodeUnits(left, right))
  );
  if (!Object.keys(outputs).length) throw new Error(`Build artifact record for ${kind} names no output file`);
  if (kind === "bundle") {
    if (Object.keys(outputs).length !== 1) throw new Error("A bundle record describes exactly one output file");
    if (!/^[0-9a-f]{64}$/.test(fingerprint ?? "")) throw new Error("A bundle record requires its published fingerprint");
  }
  const sourceFiles = Object.fromEntries(
    Object.entries(files ?? {}).sort(([left], [right]) => compareCodeUnits(left, right))
  );
  return {
    kind,
    ...(resource ? { resource } : {}),
    ...(kind === "bundle" ? { fingerprint } : {}),
    outputs,
    build: build ?? null,
    sources: {
      digest: sourceBindingDigest({ build: build ?? null, files: sourceFiles }),
      fileCount: Object.keys(sourceFiles).length,
      files: sourceFiles
    }
  };
}

/**
 * A recorded artifact that disagrees with its sources is an error wherever it
 * is found. An artifact that is merely unbound, absent, or built by a slightly
 * different toolchain is a warning by default and an error only where the
 * caller has said a binding is required - before Bob packages a build.
 */
function statusSeverity(status) {
  if (status === "fresh") return "ok";
  return ["unbound", "artifact-absent", "toolchain-drift", "lock-missing", "equivalent-rebuild"]
    .includes(status) ? "warn" : "error";
}

/** Re-derive the roll-up after a caller has escalated individual entries. */
export function summarizeBuildArtifacts(result) {
  const failures = result.entries.filter(({ severity }) => severity === "error");
  const warnings = result.entries.filter(({ severity }) => severity === "warn");
  result.failureCount = failures.length;
  result.warningCount = warnings.length;
  result.ok = failures.length === 0;
  result.status = failures.length ? "stale" : warnings.length ? "unverified" : "fresh";
  return result;
}

async function checkArtifactOutputs(projectRoot, name, record) {
  const outputs = [];
  for (const [relative, expected] of Object.entries(record.outputs ?? {})) {
    const resolved = resolveRecorded(projectRoot, relative);
    if (!isContained(projectRoot, resolved)) {
      throw new Error(`Recorded build artifact ${relative} resolves outside ${projectRoot}`);
    }
    const contents = await readRegularFile(resolved, `Build artifact ${relative}`);
    if (contents === null) {
      outputs.push({ path: relative, status: "missing", expected, actual: null });
      continue;
    }
    const actual = sha256(contents);
    const output = { path: relative, status: actual === expected ? "current" : "replaced", expected, actual };
    if (record.kind === "bundle") {
      const fingerprint = inspectBundleFingerprint(contents);
      output.fingerprint = { recorded: record.fingerprint, ...fingerprint };
      if (!fingerprint.consistent) output.status = "corrupt";
      else if (fingerprint.declared !== record.fingerprint) output.status = "replaced";
    }
    outputs.push(output);
  }
  return { name, outputs };
}

/**
 * Compare every recorded artifact against the working tree.
 *
 * `expected` names artifacts the caller knows Bob will consume - today the
 * bundle resource declared in `game.project`. An expected artifact that exists
 * on disk but appears in no lock record is reported as `unbound`: nothing
 * relates it to any source, which is exactly the state this check exists to
 * make visible, but it is not by itself evidence that the artifact is wrong.
 */
export async function checkBuildArtifacts({ projectRoot, lock, expected = [], toolchain = {} }) {
  const root = path.resolve(projectRoot);
  const records = lock?.buildArtifacts?.artifacts ?? {};
  const schema = lock?.buildArtifacts?.schema ?? null;
  if (Object.keys(records).length && schema !== BUILD_ARTIFACT_SCHEMA) {
    throw new Error(`deherm.lock build-artifact schema ${JSON.stringify(schema)} is not ${BUILD_ARTIFACT_SCHEMA}`);
  }
  const entries = [];
  for (const [name, record] of Object.entries(records).sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (!BUILD_ARTIFACT_KINDS.has(record?.kind)) {
      throw new Error(`deherm.lock build artifact ${name} declares unknown kind ${JSON.stringify(record?.kind)}`);
    }
    const { outputs } = await checkArtifactOutputs(root, name, record);
    const recordedFiles = Object.keys(record.sources?.files ?? {});
    const { files: currentFiles, missing } = await digestSourceFiles(root, recordedFiles);
    const currentDigest = missing.length
      ? null
      : sourceBindingDigest({ build: record.build ?? null, files: currentFiles });
    const changed = recordedFiles
      .filter((file) => currentFiles[file] && currentFiles[file] !== record.sources.files[file])
      .sort(compareCodeUnits);
    const recordedToolchain = record.build?.toolchain ?? {};
    const drifted = Object.entries(toolchain)
      .filter(([key, value]) => value && recordedToolchain[key] && recordedToolchain[key] !== value)
      .map(([key, value]) => ({ component: key, recorded: recordedToolchain[key], current: value }));
    const missingOutput = outputs.find(({ status }) => status === "missing");
    const corruptOutput = outputs.find(({ status }) => status === "corrupt");
    const replacedOutput = outputs.find(({ status }) => status === "replaced");
    const status = missingOutput
      ? "artifact-missing"
      : corruptOutput
        ? "artifact-corrupt"
        : missing.length || changed.length || currentDigest !== record.sources?.digest
          ? "stale-sources"
          : replacedOutput
            ? "artifact-replaced"
            : drifted.length
              ? "toolchain-drift"
              : "fresh";
    entries.push({
      name,
      kind: record.kind,
      resource: record.resource ?? null,
      status,
      severity: statusSeverity(status),
      fingerprint: record.kind === "bundle"
        ? { recorded: record.fingerprint, onDisk: outputs[0]?.fingerprint?.declared ?? null, recomputed: outputs[0]?.fingerprint?.computed ?? null }
        : null,
      sources: {
        recordedDigest: record.sources?.digest ?? null,
        currentDigest,
        fileCount: recordedFiles.length,
        changed,
        missing
      },
      outputs,
      toolchainDrift: drifted,
      build: record.build ?? null
    });
  }
  const bound = new Set(entries.flatMap(({ outputs }) => outputs.map(({ path: file }) => file)));
  for (const candidate of expected) {
    if (bound.has(candidate.path)) continue;
    const resolved = resolveRecorded(root, candidate.path);
    const contents = await readRegularFile(resolved, `Build artifact ${candidate.path}`);
    if (contents === null) {
      entries.push({
        name: candidate.path,
        kind: candidate.kind ?? "bundle",
        resource: candidate.resource ?? null,
        status: "artifact-absent",
        severity: statusSeverity("artifact-absent"),
        fingerprint: null,
        sources: null,
        outputs: [{ path: candidate.path, status: "missing", expected: null, actual: null }],
        toolchainDrift: [],
        build: null
      });
      continue;
    }
    const fingerprint = candidate.kind === "generated-sources" ? null : inspectBundleFingerprint(contents);
    entries.push({
      name: candidate.path,
      kind: candidate.kind ?? "bundle",
      resource: candidate.resource ?? null,
      status: "unbound",
      severity: "warn",
      fingerprint: fingerprint && { recorded: null, onDisk: fingerprint.declared, recomputed: fingerprint.computed },
      sources: null,
      outputs: [{ path: candidate.path, status: "unbound", expected: null, actual: sha256(contents) }],
      toolchainDrift: [],
      build: null
    });
  }
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  return summarizeBuildArtifacts({
    schemaVersion: 1,
    schema: BUILD_ARTIFACT_SCHEMA,
    projectRoot: root,
    entries
  });
}

function shortDigest(value) {
  return typeof value === "string" && value.length === 64 ? `${value.slice(0, 12)}…` : String(value ?? "<none>");
}

/**
 * The whole point of the check is the message it prints when it fails, so both
 * fingerprints are always named in full: the one the lock says these sources
 * produce, and the one Bob is about to archive.
 */
export function formatBuildArtifactReport(result, options = {}) {
  const lines = [];
  const workflowHint = options.workflowHint ?? true;
  for (const entry of result.entries) {
    const marker = entry.severity === "ok" ? "ok" : entry.severity === "warn" ? "--" : "!!";
    if (entry.status === "fresh") {
      const detail = entry.kind === "bundle"
        ? `fingerprint ${entry.fingerprint.onDisk}`
        : `${entry.outputs.length} generated file(s)`;
      lines.push(`${marker} ${entry.kind} ${entry.name}: ${detail}, ${entry.sources.fileCount} bound source(s) unchanged`);
    } else if (entry.status === "stale-sources") {
      lines.push(`${marker} ${entry.kind} ${entry.name} is stale: its sources changed after it was built`);
      if (entry.kind === "bundle") {
        lines.push(`   expected fingerprint (deherm.lock): ${entry.fingerprint.recorded}`);
        lines.push(`   fingerprint on disk:                ${entry.fingerprint.onDisk ?? "<none>"}`);
      }
      lines.push(`   bound source digest:   ${shortDigest(entry.sources.recordedDigest)}`);
      lines.push(`   current source digest: ${shortDigest(entry.sources.currentDigest)}`);
      const changes = [
        ...entry.sources.changed.map((file) => `modified ${file}`),
        ...entry.sources.missing.map((file) => `missing  ${file}`)
      ];
      lines.push(`   ${changes.length} of ${entry.sources.fileCount} bound source(s) differ:`);
      for (const change of changes.slice(0, 10)) lines.push(`     ${change}`);
      if (changes.length > 10) lines.push(`     … and ${changes.length - 10} more`);
    } else if (entry.status === "artifact-corrupt") {
      lines.push(`${marker} ${entry.kind} ${entry.name} does not match its own fingerprint: it was modified after it was built`);
      lines.push(`   published fingerprint: ${entry.fingerprint.onDisk ?? "<none>"}`);
      lines.push(`   content fingerprint:   ${entry.fingerprint.recomputed ?? "<none>"}`);
    } else if (entry.status === "artifact-replaced") {
      lines.push(`${marker} ${entry.kind} ${entry.name} is not the artifact deherm.lock records`);
      if (entry.kind === "bundle") {
        lines.push(`   expected fingerprint (deherm.lock): ${entry.fingerprint.recorded}`);
        lines.push(`   fingerprint on disk:                ${entry.fingerprint.onDisk ?? "<none>"}`);
      }
      for (const output of entry.outputs.filter(({ status }) => status === "replaced")) {
        lines.push(`   ${output.path}: expected ${shortDigest(output.expected)}, found ${shortDigest(output.actual)}`);
      }
    } else if (entry.status === "artifact-missing") {
      lines.push(`${marker} ${entry.kind} ${entry.name} is recorded in deherm.lock but missing from the working tree`);
      for (const output of entry.outputs.filter(({ status }) => status === "missing")) lines.push(`   ${output.path}`);
    } else if (entry.status === "artifact-absent") {
      lines.push(`${marker} ${entry.name} does not exist; Bob would archive nothing for ${entry.resource ?? entry.name}`);
    } else if (entry.status === "unbound") {
      lines.push(`${marker} ${entry.kind} ${entry.name} exists but deherm.lock binds it to no sources`);
      if (entry.fingerprint?.onDisk) lines.push(`   fingerprint on disk: ${entry.fingerprint.onDisk}`);
      lines.push("   Nothing relates this artifact to the TypeScript Bob will package with it.");
    } else if (entry.status === "transform-disabled") {
      lines.push(`${marker} ${entry.kind} ${entry.name} was built with TypeScript transforms disabled`);
      lines.push("   --no-ttsc is diagnostic-only; rebuild with 'deherm dev --once' before Bob packages the project.");
    } else if (entry.status === "equivalent-rebuild") {
      lines.push(`${marker} ${entry.kind} ${entry.name}: its sources changed, but they compile to the artifact on disk`);
      lines.push(`   ${entry.sources.changed.length + entry.sources.missing.length} bound source(s) differ; the program does not`);
      lines.push("   The binding in deherm.lock is out of date; rebuilding refreshes it.");
    } else if (entry.status === "toolchain-drift") {
      lines.push(`${marker} ${entry.kind} ${entry.name} was built by a different toolchain than the one installed here`);
      for (const drift of entry.toolchainDrift) {
        lines.push(`   ${drift.component}: recorded ${drift.recorded}, installed ${drift.current}`);
      }
    }
    // An exact answer, when the caller paid for one: the cheap check can prove
    // the sources moved, but only a bundle of the current sources can name the
    // fingerprint they produce.
    if (entry.fingerprint?.fromCurrentSources) {
      const agrees = entry.fingerprint.fromCurrentSources === entry.fingerprint.onDisk;
      lines.push(`   fingerprint of current sources:     ${entry.fingerprint.fromCurrentSources}`);
      lines.push(`   ${agrees ? "matches the bundle on disk" : "differs from the bundle on disk"}`);
    }
    if (entry.recomputeError) lines.push(`   could not re-bundle current sources: ${entry.recomputeError}`);
  }
  if (workflowHint && !result.ok) {
    lines.push("   Either rebuild here (deherm dev --once) so the artifact matches these sources,");
    lines.push("   or, if the artifact is committed, commit the rebuilt artifact together with deherm.lock.");
  }
  return lines;
}
