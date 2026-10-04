import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectPolicyCache,
  maintainPolicyCache,
  quarantinePolicySurface,
  recordProjectSurfaceReference,
  selectPolicySurface,
} from "../packages/cli/src/policy-cache-maintenance.mjs";

const revision = "1".repeat(40);

function pointer(realizationId, policyRoot = "f".repeat(64)) {
  return {
    schemaVersion: 1,
    kind: "deherm.materialized-defold-surface-pointer",
    defoldRevision: revision,
    realizationId,
    policyRoot,
  };
}

async function writeRealization(surfaceBase, realizationId, options = {}) {
  const root = path.join(surfaceBase, "r", realizationId.slice(0, 32));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "surface.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      kind: "deherm.materialized-defold-surface",
      defoldRevision: revision,
      policyRoot: options.policyRoot ?? "f".repeat(64),
      realization: {
        schemaVersion: 1,
        kind: "deherm.policy-surface-realization",
        realizationId,
        policyRoot: options.policyRoot ?? "f".repeat(64),
        optionsSha256: options.optionsSha256 ?? "e".repeat(64),
        compiler: { version: options.version ?? "0.1.0" },
      },
    })}\n`,
  );
  await writeFile(path.join(root, "payload"), options.payload ?? realizationId);
  return root;
}

test("cache maintenance retains current, live-project, rollback, and the newest quarantine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-cache-maintenance-"));
  const cacheHome = path.join(root, "cache");
  const surfaceBase = path.join(cacheHome, "surfaces", revision);
  const ids = ["a", "b", "c", "d", "e", "6"].map((character) => character.repeat(64));
  const roots = [];
  for (const id of ids) roots.push(await writeRealization(surfaceBase, id));
  await writeFile(path.join(surfaceBase, "current.json"), `${JSON.stringify(pointer(ids[3]))}\n`);
  await writeFile(
    path.join(surfaceBase, "selection-history.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "deherm.policy-surface-selection-history",
      defoldRevision: revision,
      generation: 4,
      entries: ids.slice(0, 4).map((realizationId, index) => ({
        generation: index + 1,
        realizationId,
        policyRoot: "f".repeat(64),
      })),
    })}\n`,
  );

  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "game.project"), "[project]\n");
  await recordProjectSurfaceReference({
    cacheHome,
    projectRoot,
    revision,
    realization: { realizationId: ids[1], policyRoot: "f".repeat(64) },
    now: 1,
  });

  await quarantinePolicySurface(roots[4], { reason: "first corrupt SDK" }, { now: () => 10 });
  await quarantinePolicySurface(roots[5], { reason: "second corrupt SDK" }, { now: () => 20 });
  const report = await inspectPolicyCache({ cacheHome, rollbackWindow: 1, quarantineWindow: 1 });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.selected[0].realizationId, ids[3]);
  assert.deepEqual(Object.fromEntries(report.retained.map((entry) => [entry.realizationId, entry.reasons])), {
    [ids[1]]: ["live-project"],
    [ids[2]]: ["rollback-window"],
    [ids[3]]: ["current"],
  });
  assert.equal(report.quarantines.length, 2);
  assert.equal(report.quarantines.filter((entry) => entry.retained).length, 1);
  assert.match(report.quarantines.find((entry) => !entry.retained).reason, /first corrupt SDK/u);
  assert.deepEqual(report.plannedDeletions.map((entry) => entry.kind).sort(), ["quarantine", "realization"]);
  assert.ok(report.cacheBytes >= report.managedSurfaceBytes);
  assert.ok(report.reclaimableBytes > 0);
  assert.ok((await stat(roots[0])).isDirectory(), "a dry run must not mutate the cache");

  const applied = await maintainPolicyCache({
    cacheHome,
    rollbackWindow: 1,
    quarantineWindow: 1,
    apply: true,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.deleted.length, 2);
  await assert.rejects(stat(roots[0]), { code: "ENOENT" });
  assert.ok((await stat(roots[1])).isDirectory());
  assert.ok((await stat(roots[2])).isDirectory());
  assert.ok((await stat(roots[3])).isDirectory());
});

test("pointer coordination refuses stale online, offline, and older-package regressions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-cache-pointer-"));
  const surfaceBase = path.join(root, "surfaces", revision);
  const oldId = "a".repeat(64);
  const currentId = "b".repeat(64);
  const olderPackageId = "c".repeat(64);
  await writeRealization(surfaceBase, oldId, { policyRoot: "1".repeat(64), version: "0.1.0" });
  await writeRealization(surfaceBase, currentId, { policyRoot: "2".repeat(64), version: "0.2.0" });
  await writeRealization(surfaceBase, olderPackageId, { policyRoot: "2".repeat(64), version: "0.1.0" });

  await selectPolicySurface(surfaceBase, pointer(currentId, "2".repeat(64)), { revalidate: async () => {} });
  await assert.rejects(
    selectPolicySurface(surfaceBase, pointer(oldId, "1".repeat(64)), {
      revalidate: async () => {
        const error = new Error("publication advanced");
        error.code = "DEHERM_POLICY_SELECTION_STALE";
        throw error;
      },
    }),
    /publication advanced/u,
  );
  const offline = await selectPolicySurface(surfaceBase, pointer(oldId, "1".repeat(64)), { offline: true });
  assert.equal(offline.reason, "offline-preserved-current");
  const older = await selectPolicySurface(surfaceBase, pointer(olderPackageId, "2".repeat(64)), {
    revalidate: async () => {},
  });
  assert.equal(older.reason, "newer-compiler-preserved");
  const selected = JSON.parse(await readFile(path.join(surfaceBase, "current.json"), "utf8"));
  assert.equal(selected.realizationId, currentId);
});

test("concurrent pointer writers serialize and preserve a complete pointer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-cache-pointer-race-"));
  const surfaceBase = path.join(root, "surfaces", revision);
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  await writeRealization(surfaceBase, first, { policyRoot: "1".repeat(64) });
  await writeRealization(surfaceBase, second, { policyRoot: "2".repeat(64) });
  await Promise.all([
    selectPolicySurface(surfaceBase, pointer(first, "1".repeat(64)), {
      revalidate: async () => new Promise((resolve) => setTimeout(resolve, 20)),
    }),
    selectPolicySurface(surfaceBase, pointer(second, "2".repeat(64)), { revalidate: async () => {} }),
  ]);
  const selected = JSON.parse(await readFile(path.join(surfaceBase, "current.json"), "utf8"));
  assert.ok([first, second].includes(selected.realizationId));
  const history = JSON.parse(await readFile(path.join(surfaceBase, "selection-history.json"), "utf8"));
  assert.equal(history.entries.at(-1).realizationId, selected.realizationId);
});

test("apply rechecks retention under the pointer lock before deleting a reported path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-cache-apply-race-"));
  const surfaceBase = path.join(root, "surfaces", revision);
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const firstRoot = await writeRealization(surfaceBase, first, { policyRoot: "1".repeat(64) });
  await writeRealization(surfaceBase, second, { policyRoot: "2".repeat(64) });
  await writeFile(path.join(surfaceBase, "current.json"), `${JSON.stringify(pointer(second, "2".repeat(64)))}\n`);
  const result = await maintainPolicyCache({
    cacheHome: root,
    rollbackWindow: 0,
    quarantineWindow: 0,
    apply: true,
    beforeApply: async (report) => {
      assert.equal(report.plannedDeletions[0].path, firstRoot);
      await writeFile(path.join(surfaceBase, "current.json"), `${JSON.stringify(pointer(first, "1".repeat(64)))}\n`);
    },
  });
  assert.equal(result.deleted.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /retention changed/u);
  assert.ok((await stat(firstRoot)).isDirectory());
});

test("Windows-style sharing violations are actionable and retryable without mutating the realization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-cache-sharing-"));
  const surfaceBase = path.join(root, "surfaces", revision);
  const realizationRoot = await writeRealization(surfaceBase, "a".repeat(64));
  await assert.rejects(
    quarantinePolicySurface(
      realizationRoot,
      { reason: "corrupt" },
      {
        renameImpl: async () => {
          const error = new Error("file in use");
          error.code = "EPERM";
          throw error;
        },
      },
    ),
    (error) => {
      assert.equal(error.code, "DEHERM_CACHE_SHARING_VIOLATION");
      assert.equal(error.retryable, true);
      assert.match(error.message, /Close the Defold\/editor process[\s\S]*retry/u);
      return true;
    },
  );
  assert.ok((await stat(realizationRoot)).isDirectory());

  await writeFile(path.join(surfaceBase, "current.json"), `${JSON.stringify(pointer("b".repeat(64)))}\n`);
  const report = await maintainPolicyCache({
    cacheHome: root,
    rollbackWindow: 0,
    quarantineWindow: 0,
    apply: true,
    removeImpl: async () => {
      const error = new Error("file in use");
      error.code = "EBUSY";
      throw error;
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "DEHERM_CACHE_SHARING_VIOLATION");
  assert.equal(report.failures[0].retryable, true);
});
