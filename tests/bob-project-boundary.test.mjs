import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOB_TOOLING_IGNORE_ENTRIES,
  reconcileBobProjectBoundary
} from "../packages/cli/src/bob-project-boundary.mjs";

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

  const first = await reconcileBobProjectBoundary({
    projectRoot: root,
    includeEntries: ["/target-generated-unit"],
    excludeEntries: ["/old-generated-unit"]
  });
  assert.equal(first.changed, true);
  assert.deepEqual((await readFile(path.join(root, ".defignore"), "utf8")).trim().split("\n"), [
    "this line is intentionally ignored by Defold",
    "/reference",
    "/node_modules",
    ...BOB_TOOLING_IGNORE_ENTRIES.slice(1),
    "/target-generated-unit"
  ]);

  const second = await reconcileBobProjectBoundary({
    projectRoot: root,
    includeEntries: ["/target-generated-unit"],
    excludeEntries: ["/old-generated-unit"]
  });
  assert.equal(second.changed, false);
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
