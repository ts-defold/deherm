import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefoldProject } from "../packages/cli/src/scaffold.mjs";
import {
  BOB_MANAGED_IGNORE_BEGIN,
  BOB_MANAGED_IGNORE_END,
  BOB_TOOLING_IGNORE_ENTRIES,
} from "../packages/cli/src/bob-project-boundary.mjs";

const revision = "a".repeat(40);

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-scaffold-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const locator = {
  schemaVersion: 1,
  kind: "deherm.policy.publication-locator",
  base: {},
  channels: ["stable", "beta"],
  channelInfoUrl: "https://example.invalid/{channel}/info.json",
  entries: [],
};

test("scaffold resolves its default from Defold's moving stable channel, not a packaged revision", async (t) => {
  const directory = await scratch(t);
  const projectRoot = path.join(directory, "game");
  const requests = [];

  const created = await createDefoldProject({
    directory: projectRoot,
    name: "Index-backed game",
    policyLocator: locator,
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ sha1: revision, version: "1.11.0" }) };
    },
  });

  assert.equal(created.defoldRevision, revision);
  assert.deepEqual(requests, ["https://example.invalid/stable/info.json"]);
  assert.match(await readFile(path.join(projectRoot, "game.project"), "utf8"), new RegExp(`defold_sdk = ${revision}`));
  const defignore = (await readFile(path.join(projectRoot, ".defignore"), "utf8")).trim().split("\n");
  assert.equal(defignore[0], BOB_MANAGED_IGNORE_BEGIN);
  assert.equal(defignore.at(-1), BOB_MANAGED_IGNORE_END);
  assert.deepEqual(defignore.slice(1, -1), [...BOB_TOOLING_IGNORE_ENTRIES, "/src/main.script.ts"]);
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(manifest.scripts.lint, "oxlint .");
  assert.equal(manifest.scripts["format:check"], "oxfmt --check .");
  assert.equal(manifest.scripts.check, "pnpm lint && pnpm format:check && pnpm typecheck && pnpm verify");
  assert.equal(manifest.devDependencies.oxlint, "^1.85.0");
  assert.equal(manifest.devDependencies.oxfmt, "^0.70.0");
  const lint = JSON.parse(await readFile(path.join(projectRoot, ".oxlintrc.json"), "utf8"));
  const format = JSON.parse(await readFile(path.join(projectRoot, ".oxfmtrc.json"), "utf8"));
  assert.equal(lint.categories.correctness, "error");
  assert.equal(lint.options.denyWarnings, true);
  assert.equal(format.printWidth, 120);
  assert.equal(format.sortPackageJson, false);
});

test("an explicit scaffold revision is authoritative and requires no channel lookup", async (t) => {
  const directory = await scratch(t);
  let fetched = false;
  const projectRoot = path.join(directory, "game");

  const created = await createDefoldProject({
    directory: projectRoot,
    defoldRevision: revision,
    policyLocator: locator,
    fetchImpl: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(created.defoldRevision, revision);
  assert.equal(fetched, false);
  assert.match(await readFile(path.join(projectRoot, "game.project"), "utf8"), new RegExp(`defold_sdk = ${revision}`));
});
