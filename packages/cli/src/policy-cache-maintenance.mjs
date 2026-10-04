// Bounded maintenance for immutable policy-surface realizations.
//
// Placement and mutable pointers are never authentication. This module only
// decides which already-published directories may be reclaimed; consumers
// continue to authenticate retained surfaces through defold-surface.mjs.

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { defoldSurfaceCacheHome } from "./defold-surface.mjs";

const DIGEST = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const REALIZATION_LEAF = /^[0-9a-f]{32}$/u;
const QUARANTINE = /^\.bad-([0-9a-f]{32})-(\d+)-([0-9a-f]{12})$/u;
const DEFAULT_ROLLBACK_WINDOW = 2;
const DEFAULT_QUARANTINE_WINDOW = 1;
const LOCK_STALE_MS = 5 * 60 * 1_000;
const LOCK_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 160, 320, 640, 1_000]);
const WINDOWS_SHARING_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);

function json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readJson(file) {
  const source = await readFile(file, "utf8").catch((error) =>
    error?.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (source === null) return null;
  return JSON.parse(source);
}

async function atomicReplace(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const current = await readFile(file).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (current?.equals(bytes)) return false;
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

function contentionError(error, target, operation, outcome = "the immutable entry was left untouched") {
  if (!WINDOWS_SHARING_CODES.has(error?.code)) return error;
  const wrapped = new Error(
    `${operation} could not update ${target} because another process still has it open ` +
      `(${error.code}). Close the Defold/editor process using this cache and retry the same command; ` +
      `${outcome}.`,
    { cause: error },
  );
  wrapped.code = "DEHERM_CACHE_SHARING_VIOLATION";
  wrapped.retryable = true;
  wrapped.path = target;
  return wrapped;
}

export async function withPolicyCacheLock(surfaceBase, callback, options = {}) {
  const lock = path.join(surfaceBase, ".current.lock");
  const delays = options.retryDelaysMs ?? LOCK_RETRY_DELAYS_MS;
  const sleep = options.sleepImpl ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => Date.now());
  await mkdir(surfaceBase, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lock);
      try {
        await writeFile(
          path.join(lock, "owner.json"),
          json({ schemaVersion: 1, kind: "deherm.policy-cache-lock", pid: process.pid, acquiredAt: now() }),
          { flag: "wx" },
        );
      } catch (error) {
        await rm(lock, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw contentionError(error, lock, "Policy-cache coordination");
      const information = await lstat(lock).catch((readError) =>
        readError?.code === "ENOENT" ? null : Promise.reject(readError),
      );
      const owner = await readJson(path.join(lock, "owner.json")).catch(() => null);
      if (
        information &&
        now() - information.mtimeMs >= LOCK_STALE_MS &&
        (!Number.isSafeInteger(owner?.pid) || !processIsAlive(owner.pid))
      ) {
        try {
          await rm(lock, { recursive: true });
          continue;
        } catch (removeError) {
          throw contentionError(removeError, lock, "Stale policy-cache lock cleanup");
        }
      }
      if (attempt >= delays.length) {
        const busy = new Error(
          `Policy-cache pointer is busy at ${lock}; retry after the other deherm process completes.`,
        );
        busy.code = "DEHERM_CACHE_BUSY";
        busy.retryable = true;
        busy.path = lock;
        throw busy;
      }
      await sleep(delays[attempt]);
    }
  }
  let result;
  let callbackError = null;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  }
  try {
    await rm(lock, { recursive: true, force: true });
  } catch (error) {
    if (!callbackError) throw contentionError(error, lock, "Policy-cache unlock");
  }
  if (callbackError) throw callbackError;
  return result;
}

function validPointer(pointer, revision) {
  return (
    pointer?.schemaVersion === 1 &&
    pointer.kind === "deherm.materialized-defold-surface-pointer" &&
    pointer.defoldRevision === revision &&
    DIGEST.test(pointer.realizationId ?? "") &&
    DIGEST.test(pointer.policyRoot ?? "")
  );
}

async function descriptorFor(surfaceBase, realizationId) {
  if (!DIGEST.test(realizationId ?? "")) return null;
  return readJson(path.join(surfaceBase, "r", realizationId.slice(0, 32), "surface.json")).catch(() => null);
}

function compareSemverText(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/u.exec(String(value ?? ""));
    return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4] ?? null } : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return compareCodeUnits(a.prerelease, b.prerelease);
}

async function appendSelectionHistory(surfaceBase, pointer) {
  const file = path.join(surfaceBase, "selection-history.json");
  const prior = await readJson(file).catch(() => null);
  const entries = Array.isArray(prior?.entries)
    ? prior.entries.filter((entry) => DIGEST.test(entry.realizationId ?? ""))
    : [];
  if (entries.at(-1)?.realizationId === pointer.realizationId) return false;
  const next = {
    schemaVersion: 1,
    kind: "deherm.policy-surface-selection-history",
    defoldRevision: pointer.defoldRevision,
    generation: Math.max(Number(prior?.generation) || 0, ...entries.map((entry) => Number(entry.generation) || 0)) + 1,
    entries: [
      ...entries,
      {
        generation:
          Math.max(Number(prior?.generation) || 0, ...entries.map((entry) => Number(entry.generation) || 0)) + 1,
        realizationId: pointer.realizationId,
        policyRoot: pointer.policyRoot,
      },
    ].slice(-32),
  };
  return atomicReplace(file, json(next));
}

/**
 * Move current.json under a cross-process lock.
 *
 * Online callers must revalidate their mutable publication entry while the
 * lock is held. Offline callers can initialize an absent pointer or reuse an
 * identical one, but never replace a different selection. For an unchanged
 * policy/artifact identity, an older installed package may not regress a
 * pointer selected by a newer package.
 */
export async function selectPolicySurface(surfaceBase, candidate, options = {}) {
  const revision = candidate.defoldRevision;
  if (!validPointer(candidate, revision)) throw new Error("Invalid materialized surface pointer candidate");
  return withPolicyCacheLock(
    surfaceBase,
    async () => {
      const file = path.join(surfaceBase, "current.json");
      const current = await readJson(file).catch((error) => {
        throw new Error(`Invalid materialized surface pointer at ${file}: ${error.message}`);
      });
      if (current && !validPointer(current, revision)) {
        throw new Error(`Invalid materialized surface pointer at ${file}`);
      }
      if (current?.realizationId === candidate.realizationId) {
        await appendSelectionHistory(surfaceBase, current);
        return { pointer: current, changed: false, reason: "already-selected" };
      }
      if (options.offline && current) {
        return { pointer: current, changed: false, reason: "offline-preserved-current" };
      }
      if (!options.offline && typeof options.revalidate !== "function") {
        throw new Error("Online policy-surface selection requires publication revalidation under the cache lock");
      }
      if (!options.offline) await options.revalidate();

      if (current) {
        const [selectedDescriptor, candidateDescriptor] = await Promise.all([
          descriptorFor(surfaceBase, current.realizationId),
          descriptorFor(surfaceBase, candidate.realizationId),
        ]);
        const sameInputs =
          selectedDescriptor?.realization?.policyRoot === candidateDescriptor?.realization?.policyRoot &&
          selectedDescriptor?.realization?.optionsSha256 === candidateDescriptor?.realization?.optionsSha256;
        if (
          sameInputs &&
          compareSemverText(
            selectedDescriptor?.realization?.compiler?.version,
            candidateDescriptor?.realization?.compiler?.version,
          ) > 0
        ) {
          return { pointer: current, changed: false, reason: "newer-compiler-preserved" };
        }
      }
      if (await atomicReplace(file, json(candidate))) await appendSelectionHistory(surfaceBase, candidate);
      return { pointer: candidate, changed: true, reason: current ? "advanced" : "initialized" };
    },
    options.lock,
  );
}

export async function quarantinePolicySurface(realizationRoot, details = {}, options = {}) {
  const parent = path.dirname(realizationRoot);
  const leaf = path.basename(realizationRoot);
  if (!REALIZATION_LEAF.test(leaf))
    throw new Error(`Refusing to quarantine unexpected realization path ${realizationRoot}`);
  const quarantine = path.join(parent, `.bad-${leaf}-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await (options.renameImpl ?? rename)(realizationRoot, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw contentionError(error, realizationRoot, "Policy-surface quarantine");
  }
  const record = {
    schemaVersion: 1,
    kind: "deherm.policy-surface-quarantine",
    realizationLeaf: leaf,
    reason: String(details.reason ?? "surface verification failed"),
    quarantinedAt: options.now?.() ?? Date.now(),
  };
  try {
    await writeFile(path.join(quarantine, ".quarantine.json"), json(record), { flag: "wx" });
  } catch (error) {
    throw contentionError(
      error,
      quarantine,
      "Policy-surface quarantine metadata write",
      "the quarantine directory remains recoverable and will be reported with a legacy reason",
    );
  }
  return quarantine;
}

export async function recordProjectSurfaceReference({
  cacheHome,
  projectRoot,
  revision,
  realization,
  now = Date.now(),
}) {
  if (!projectRoot || !REVISION.test(revision) || !DIGEST.test(realization?.realizationId ?? "")) return null;
  const canonicalProject = await realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const marker = path.join(canonicalProject, ".deherm", "cache", "policy-surface-reference.json");
  const reference = {
    schemaVersion: 1,
    kind: "deherm.project-policy-surface-reference",
    projectRoot: canonicalProject,
    defoldRevision: revision,
    realizationId: realization.realizationId,
    policyRoot: realization.policyRoot,
    updatedAt: now,
  };
  await atomicReplace(marker, json(reference));
  const home = path.resolve(cacheHome ?? defoldSurfaceCacheHome());
  const registry = path.join(home, "project-references", `${sha256(canonicalProject)}.json`);
  await atomicReplace(registry, json(reference));
  return { marker, registry, reference };
}

async function liveProjectReferences(cacheHome) {
  const root = path.join(cacheHome, "project-references");
  const entries = await readdir(root, { withFileTypes: true }).catch((error) =>
    error?.code === "ENOENT" ? [] : Promise.reject(error),
  );
  const live = [];
  const stale = [];
  for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    const reference = await readJson(file).catch(() => null);
    const marker = reference?.projectRoot
      ? path.join(reference.projectRoot, ".deherm", "cache", "policy-surface-reference.json")
      : null;
    const projectMarker = marker ? await readJson(marker).catch(() => null) : null;
    const gameProject = reference?.projectRoot
      ? await stat(path.join(reference.projectRoot, "game.project")).catch(() => null)
      : null;
    if (
      reference?.kind === "deherm.project-policy-surface-reference" &&
      REVISION.test(reference.defoldRevision ?? "") &&
      DIGEST.test(reference.realizationId ?? "") &&
      projectMarker?.realizationId === reference.realizationId &&
      projectMarker?.defoldRevision === reference.defoldRevision &&
      gameProject?.isFile()
    ) {
      live.push({ ...reference, registry: file, marker });
    } else {
      stale.push({ registry: file, reason: "project or matching project marker is absent" });
    }
  }
  return { live, stale };
}

async function treeBytes(root) {
  const information = await lstat(root).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (!information) return 0;
  if (information.isSymbolicLink()) return information.size;
  if (!information.isDirectory()) return information.size;
  let bytes = information.size;
  for (const entry of await readdir(root)) bytes += await treeBytes(path.join(root, entry));
  return bytes;
}

async function realizationIdentity(root) {
  const descriptor = await readJson(path.join(root, "surface.json")).catch(() => null);
  const realizationId = descriptor?.realization?.realizationId;
  return DIGEST.test(realizationId ?? "") ? descriptor.realization : null;
}

function newestFirst(left, right) {
  if (left.generation !== right.generation) return right.generation - left.generation;
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
  return compareCodeUnits(left.realizationId, right.realizationId);
}

async function inventoryRevision(surfaceBase, revision, liveReferences, options) {
  const parent = path.join(surfaceBase, "r");
  const entries = await readdir(parent, { withFileTypes: true }).catch((error) =>
    error?.code === "ENOENT" ? [] : Promise.reject(error),
  );
  const pointer = await readJson(path.join(surfaceBase, "current.json")).catch(() => null);
  const history = await readJson(path.join(surfaceBase, "selection-history.json")).catch(() => null);
  const generations = new Map(
    (history?.entries ?? []).map((entry) => [entry.realizationId, Number(entry.generation) || 0]),
  );
  const realizations = [];
  const quarantines = [];
  const blocked = [];
  for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const absolute = path.join(parent, entry.name);
    const information = await lstat(absolute);
    if (information.isSymbolicLink()) {
      blocked.push({ path: absolute, reason: "symbolic links are never reclaimed automatically" });
      continue;
    }
    if (!information.isDirectory()) continue;
    if (REALIZATION_LEAF.test(entry.name)) {
      const realization = await realizationIdentity(absolute);
      const realizationId = realization?.realizationId;
      if (!realizationId || realizationId.slice(0, 32) !== entry.name) {
        blocked.push({ path: absolute, reason: "directory identity is not authenticated by its descriptor" });
        continue;
      }
      realizations.push({
        path: absolute,
        leaf: entry.name,
        realizationId,
        realization,
        generation: generations.get(realizationId) ?? 0,
        mtimeMs: information.mtimeMs,
        bytes: await treeBytes(absolute),
        reasons: [],
      });
      continue;
    }
    const match = QUARANTINE.exec(entry.name);
    if (match) {
      const metadata = await readJson(path.join(absolute, ".quarantine.json")).catch(() => null);
      quarantines.push({
        path: absolute,
        realizationLeaf: match[1],
        reason: metadata?.reason ?? "legacy quarantine: verification failure was not recorded",
        quarantinedAt: Number(metadata?.quarantinedAt) || information.mtimeMs,
        bytes: await treeBytes(absolute),
      });
    }
  }

  const selectedId = validPointer(pointer, revision) ? pointer.realizationId : null;
  const referenced = new Set(
    liveReferences
      .filter((reference) => reference.defoldRevision === revision)
      .map((reference) => reference.realizationId),
  );
  for (const item of realizations) {
    if (item.realizationId === selectedId) item.reasons.push("current");
    if (referenced.has(item.realizationId)) item.reasons.push("live-project");
  }
  const rollbackCandidates = realizations.filter((item) => item.reasons.length === 0).sort(newestFirst);
  for (const item of rollbackCandidates.slice(0, options.rollbackWindow)) item.reasons.push("rollback-window");

  quarantines.sort((left, right) =>
    right.quarantinedAt !== left.quarantinedAt
      ? right.quarantinedAt - left.quarantinedAt
      : compareCodeUnits(left.path, right.path),
  );
  const retainedQuarantines = quarantines.slice(0, options.quarantineWindow);
  const reclaimableQuarantines = quarantines.slice(options.quarantineWindow);
  return {
    revision,
    surfaceBase,
    selected: selectedId,
    realizations,
    retained: realizations.filter((item) => item.reasons.length > 0),
    reclaimable: realizations.filter((item) => item.reasons.length === 0),
    quarantines,
    retainedQuarantines,
    reclaimableQuarantines,
    blocked,
  };
}

/** Build a deterministic, non-mutating retention report. */
export async function inspectPolicyCache(options = {}) {
  const cacheHome = path.resolve(options.cacheHome ?? defoldSurfaceCacheHome(options.env));
  const rollbackWindow = options.rollbackWindow ?? DEFAULT_ROLLBACK_WINDOW;
  const quarantineWindow = options.quarantineWindow ?? DEFAULT_QUARANTINE_WINDOW;
  if (!Number.isSafeInteger(rollbackWindow) || rollbackWindow < 0) throw new Error("rollbackWindow must be >= 0");
  if (!Number.isSafeInteger(quarantineWindow) || quarantineWindow < 0) throw new Error("quarantineWindow must be >= 0");
  const references = await liveProjectReferences(cacheHome);
  const surfaces = path.join(cacheHome, "surfaces");
  const entries = await readdir(surfaces, { withFileTypes: true }).catch((error) =>
    error?.code === "ENOENT" ? [] : Promise.reject(error),
  );
  const revisions = [];
  for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
    if (!entry.isDirectory() || !REVISION.test(entry.name)) continue;
    revisions.push(
      await inventoryRevision(path.join(surfaces, entry.name), entry.name, references.live, {
        rollbackWindow,
        quarantineWindow,
      }),
    );
  }
  const planned = revisions.flatMap((item) => [
    ...item.reclaimable.map((entry) => ({ kind: "realization", revision: item.revision, ...entry })),
    ...item.reclaimableQuarantines.map((entry) => ({ kind: "quarantine", revision: item.revision, ...entry })),
  ]);
  return {
    schemaVersion: 1,
    kind: "deherm.policy-cache-maintenance-report",
    mode: "dry-run",
    cacheHome,
    retention: { rollbackWindow, quarantineWindow },
    cacheBytes: await treeBytes(cacheHome),
    managedSurfaceBytes: revisions.reduce(
      (total, item) =>
        total +
        item.realizations.reduce((sum, entry) => sum + entry.bytes, 0) +
        item.quarantines.reduce((sum, entry) => sum + entry.bytes, 0),
      0,
    ),
    reclaimableBytes: planned.reduce((total, entry) => total + entry.bytes, 0),
    selected: revisions.flatMap((item) => {
      if (!item.selected) return [];
      const selected = item.realizations.find((entry) => entry.realizationId === item.selected);
      return [
        {
          defoldRevision: item.revision,
          realizationId: item.selected,
          policyRoot: selected?.realization?.policyRoot ?? null,
          compilerIdentity: selected?.realization?.compilerIdentity ?? null,
          optionsSha256: selected?.realization?.optionsSha256 ?? null,
          compilerVersion: selected?.realization?.compiler?.version ?? null,
        },
      ];
    }),
    retained: revisions.flatMap((item) =>
      item.retained.map((entry) => ({
        defoldRevision: item.revision,
        realizationId: entry.realizationId,
        reasons: entry.reasons,
        bytes: entry.bytes,
      })),
    ),
    quarantines: revisions.flatMap((item) =>
      item.quarantines.map((entry) => ({
        defoldRevision: item.revision,
        path: entry.path,
        reason: entry.reason,
        bytes: entry.bytes,
        retained: item.retainedQuarantines.includes(entry),
      })),
    ),
    plannedDeletions: planned.map((entry) => ({
      kind: entry.kind,
      defoldRevision: entry.revision,
      path: entry.path,
      bytes: entry.bytes,
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
    liveProjectReferences: references.live,
    staleProjectReferences: references.stale,
    blocked: revisions.flatMap((item) => item.blocked.map((entry) => ({ defoldRevision: item.revision, ...entry }))),
  };
}

/** Apply exactly the deletions named by a fresh report, returning per-path failures. */
export async function maintainPolicyCache(options = {}) {
  const report = await inspectPolicyCache(options);
  if (options.apply !== true) return report;
  await options.beforeApply?.(report);
  const deleted = [];
  const failures = [];
  const skipped = [];
  const revisions = [...new Set(report.plannedDeletions.map((entry) => entry.defoldRevision))].sort(compareCodeUnits);
  for (const revision of revisions) {
    const initial = report.plannedDeletions.filter((entry) => entry.defoldRevision === revision);
    const surfaceBase = path.join(report.cacheHome, "surfaces", revision);
    await withPolicyCacheLock(surfaceBase, async () => {
      // A writer may have advanced current.json after the report was printed.
      // Recompute retention while holding the same pointer lock and delete only
      // the intersection with the original plan.
      const fresh = await inspectPolicyCache(options);
      const stillReclaimable = new Set(
        fresh.plannedDeletions.filter((entry) => entry.defoldRevision === revision).map((entry) => entry.path),
      );
      for (const planned of initial) {
        if (!stillReclaimable.has(planned.path)) {
          skipped.push({ ...planned, reason: "retention changed after the dry-run report" });
          continue;
        }
        try {
          await (options.removeImpl ?? rm)(planned.path, { recursive: true });
          deleted.push(planned);
        } catch (error) {
          const actionable = contentionError(error, planned.path, "Policy-cache reclaim");
          failures.push({
            ...planned,
            code: actionable.code ?? error.code ?? "UNKNOWN",
            retryable: actionable.retryable === true,
            error: actionable.message,
          });
        }
      }
    });
  }
  return {
    ...report,
    mode: "apply",
    deleted,
    deletedBytes: deleted.reduce((total, entry) => total + entry.bytes, 0),
    skipped,
    failures,
    ok: failures.length === 0,
  };
}

export function formatPolicyCacheReport(report) {
  const lines = [
    `Policy cache: ${report.cacheHome}`,
    `Size: ${report.cacheBytes} byte(s); managed surfaces: ${report.managedSurfaceBytes} byte(s)`,
    `Selected: ${report.selected.length}; retained: ${report.retained.length}; quarantines: ${report.quarantines.length}`,
    `${report.mode === "apply" ? "Planned before apply" : "Dry run"}: ${report.plannedDeletions.length} deletion(s), ${report.reclaimableBytes} reclaimable byte(s)`,
  ];
  for (const entry of report.selected) lines.push(`  current ${entry.defoldRevision}: ${entry.realizationId}`);
  for (const entry of report.retained)
    lines.push(`  keep ${entry.defoldRevision}/${entry.realizationId}: ${entry.reasons.join(", ")} (${entry.bytes} B)`);
  for (const entry of report.quarantines)
    lines.push(`  ${entry.retained ? "keep" : "reclaim"} quarantine ${entry.path}: ${entry.reason} (${entry.bytes} B)`);
  for (const entry of report.plannedDeletions) lines.push(`  delete ${entry.kind} ${entry.path} (${entry.bytes} B)`);
  for (const entry of report.skipped ?? []) lines.push(`  kept ${entry.path}: ${entry.reason}`);
  for (const failure of report.failures ?? []) lines.push(`  retryable=${failure.retryable} ${failure.error}`);
  if (report.mode === "dry-run" && report.plannedDeletions.length > 0)
    lines.push("Run `deherm cache --apply` to apply this exact retention policy.");
  return lines.join("\n");
}
