import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefoldProject } from "../packages/cli/src/scaffold.mjs";

const revision = "a".repeat(40);

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scaffold-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writePolicyIndex(packageRoot, entries) {
  const generated = path.join(packageRoot, "packages", "bindings", "generated");
  await mkdir(generated, { recursive: true });
  await writeFile(path.join(generated, "defold-policy-index.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "deherm.policy.index",
    entries
  }, null, 2)}\n`);
}

test("scaffold default revision comes from the shipped policy index without generated script IR", async (t) => {
  const directory = await scratch(t);
  const packageRoot = path.join(directory, "package");
  const projectRoot = path.join(directory, "game");
  await writePolicyIndex(packageRoot, [{ defoldRevision: revision, policyRoot: "b".repeat(64) }]);

  const created = await createDefoldProject({
    directory: projectRoot,
    name: "Index-backed game",
    packageRoot
  });

  assert.equal(created.defoldRevision, revision);
  assert.match(await readFile(path.join(projectRoot, "game.project"), "utf8"), new RegExp(`defold_sdk = ${revision}`));
  await assert.rejects(
    readFile(path.join(packageRoot, "packages", "bindings", "generated", "defold-script-api-ir.json")),
    (error) => error?.code === "ENOENT"
  );
});

test("scaffold refuses an ambiguous packaged offline policy seed", async (t) => {
  const directory = await scratch(t);
  const packageRoot = path.join(directory, "package");
  await writePolicyIndex(packageRoot, [
    { defoldRevision: revision, policyRoot: "b".repeat(64) },
    { defoldRevision: "c".repeat(40), policyRoot: "d".repeat(64) }
  ]);

  await assert.rejects(
    createDefoldProject({ directory: path.join(directory, "game"), packageRoot }),
    /must contain exactly one offline policy entry; found 2/u
  );
});
