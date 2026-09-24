import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOB_TOOLING_IGNORE_ENTRIES,
  BOB_MANAGED_IGNORE_BEGIN,
  BOB_MANAGED_IGNORE_END,
  discoverBobAuthoringIgnoreEntries,
  reconcileBobProjectBoundary
} from "../packages/cli/src/bob-project-boundary.mjs";

function managedEntries(source) {
  const lines = source.trim().split("\n");
  const begin = lines.indexOf(BOB_MANAGED_IGNORE_BEGIN);
  const end = lines.indexOf(BOB_MANAGED_IGNORE_END);
  assert.ok(begin >= 0 && end > begin, "managed Bob exclusion block is present");
  return lines.slice(begin + 1, end);
}

test("the Bob boundary excludes only invariant tooling trees and preserves authored rules", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bob-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".defignore"), [
    "this line is intentionally ignored by Defold",
    "/reference",
    "/node_modules/",
    "/node_modules",
    "/old-generated-unit",
    ""
  ].join("\n"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.script.ts"), "export default {};\n");
  await writeFile(path.join(root, "src", "main.script"), "-- generated proxy\n");

  const first = await reconcileBobProjectBoundary({
    projectRoot: root,
    includeEntries: ["/target-generated-unit"],
    excludeEntries: ["/old-generated-unit"]
  });
  assert.equal(first.changed, true);
  const source = await readFile(path.join(root, ".defignore"), "utf8");
  assert.deepEqual(source.slice(0, source.indexOf(BOB_MANAGED_IGNORE_BEGIN)).trim().split("\n"), [
    "this line is intentionally ignored by Defold",
    "/reference"
  ]);
  assert.deepEqual(managedEntries(source), [
    ...BOB_TOOLING_IGNORE_ENTRIES,
    "/src/main.script.ts",
    "/target-generated-unit"
  ]);
  assert.ok(!managedEntries(source).includes("/src/main.script"), "generated Defold proxy remains visible to Bob");

  const second = await reconcileBobProjectBoundary({
    projectRoot: root,
    includeEntries: ["/target-generated-unit"],
    excludeEntries: ["/old-generated-unit"]
  });
  assert.equal(second.changed, false);
});

test("the Bob boundary discovers exact TypeScript inputs without excluding their resource directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bob-sources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "shared"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "fake"), { recursive: true });
  await writeFile(path.join(root, "src", "controller.script.ts"), "");
  await writeFile(path.join(root, "src", "controller.script"), "");
  await writeFile(path.join(root, "src", "shared", "math.ts"), "");
  await writeFile(path.join(root, "src", "shared", "hud.tsx"), "");
  await writeFile(path.join(root, "src", "shared", "worker.mts"), "");
  await writeFile(path.join(root, "src", "shared", "legacy.cts"), "");
  await writeFile(path.join(root, "src", "shared", "runtime.js"), "");
  await writeFile(path.join(root, "node_modules", "fake", "poison.ts"), "");

  assert.deepEqual(await discoverBobAuthoringIgnoreEntries(root), [
    "/src/controller.script.ts",
    "/src/shared/hud.tsx",
    "/src/shared/legacy.cts",
    "/src/shared/math.ts",
    "/src/shared/worker.mts"
  ]);
});

test("the Bob boundary replaces its managed block and removes stale generated exclusions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bob-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".defignore"), [
    "/authored-rule",
    "",
    BOB_MANAGED_IGNORE_BEGIN,
    "/stale.ts",
    "/stale-generated-extension",
    BOB_MANAGED_IGNORE_END,
    ""
  ].join("\n"));

  await reconcileBobProjectBoundary({ projectRoot: root, discoverAuthoringSources: false });
  const source = await readFile(path.join(root, ".defignore"), "utf8");
  assert.match(source, /^\/authored-rule$/mu);
  assert.ok(!source.includes("/stale.ts"));
  assert.ok(!source.includes("/stale-generated-extension"));
  assert.deepEqual(managedEntries(source), BOB_TOOLING_IGNORE_ENTRIES);
});

test("explicit Defold custom resources remain visible through the default boundary", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bob-custom-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "runtime.ts"), "export const shipped = true;\n");
  await writeFile(path.join(root, "game.project"), "[project]\ncustom_resources = /src/runtime.ts, /README.md\n");

  const result = await reconcileBobProjectBoundary({ projectRoot: root });
  assert.deepEqual(result.customResources, ["/README.md", "/src/runtime.ts"]);
  const entries = managedEntries(await readFile(path.join(root, ".defignore"), "utf8"));
  assert.ok(!entries.includes("/src/runtime.ts"));
  assert.ok(!entries.includes("/README.md"));
  assert.ok(entries.includes("/node_modules"));
});
test("the Bob boundary refuses the project root and contradictory managed entries", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bob-boundary-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    reconcileBobProjectBoundary({ projectRoot: root, includeEntries: ["/"] }),
    /cannot ignore the project root/u
  );
  await assert.rejects(
    reconcileBobProjectBoundary({
      projectRoot: root,
      includeEntries: ["/generated"],
      excludeEntries: ["/generated/"]
    }),
    /both required and removed/u
  );
});
