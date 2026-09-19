#!/usr/bin/env node

// Does the whole chain still work, for every target we publish?
//
// Every stage of this project already has a check of its own, and each of them
// passes over a different slice: the generators check that their artifact is
// current, the artifact matrix checks that a library is where the manifest says,
// the policy site checks that a revision resolves. None of them asks the
// question a user asks, which is whether a déherm release plus a published
// policy plus the published artifacts plus Bob produce a game that builds.
//
// This is that question, asked once, per Defold bundle target.
//
// ── Fail closed, with a name ────────────────────────────────────────────────
//
// A target this run cannot exercise is DECLINED, never skipped. A decline
// carries the reason as data, read from the manifest that already decided it -
// `packages/toolchains/native-artifacts.json` says which targets are blocked
// and why, and `defold-bundle-targets.json` (derived from Defold's own
// build_input.yml) says which targets exist at all. A target that appears in one
// and not the other is a failure here rather than a row nobody printed: a Defold
// release that adds a bundle platform must break this gate, because the day it
// is added is the day nothing is built for it.
//
// ── What each stage actually proves ─────────────────────────────────────────
//
//   policy          a client resolves a revision through the published layout,
//                   verifies every object against its own path, and REFUSES a
//                   tampered one. Runs against a served copy on loopback.
//   host-tools      the published hermesc/shermes/dehermc archives download and
//                   every member matches the digest the shipped manifest pins.
//   target-archives the published libhermes.a for each target installs and
//                   matches its pinned digest.
//   scaffold        `deherm create` produces a complete project, extension and
//                   all, from nothing. This is a user's first command.
//   generate        the user's path: generate the SDK for the project and type
//                   check it with the shipped compiler.
//   bob             Bob builds the project for that target. Extender compiles
//                   the generated bindings and the extension against that
//                   target's real toolchain, so this is also the answer to "do
//                   the generated bindings compile for every target" - there is
//                   no separate compile stage, because a separate one would be
//                   compiling with something other than what ships the game.
//
// `--plan` prints the whole ledger and runs nothing, which is what makes the
// decline reasons reviewable without a network, a JDK or an hour.

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = Object.freeze({
  bundleTargets: "packages/toolchains/defold-bundle-targets.json",
  nativeArtifacts: "packages/toolchains/native-artifacts.json",
  releaseTags: "packages/toolchains/release-tags.json"
});

/**
 * Defold's hosted Extender.
 *
 * `scripts/bob.sh` defaults to `http://localhost:9010`, which is this
 * repository's own pinned Extender and a development convenience. A user has no
 * such thing: their Bob talks to Defold's hosted service, and that is what this
 * gate must exercise, because the question is whether OUR extension builds on
 * THEIR build server.
 */
export const defaultBuildServer = "https://build.defold.com";

/**
 * Where the gate scaffolds the project it exercises.
 *
 * A scratch project rather than one of the repository's own. `defold/` is a
 * hand-built spike whose `game.project` is not a déherm project at all - it
 * declares no `[script] shared_state` and no `defold_sdk`, and `deherm
 * generate` correctly refuses it - and `examples/war-battles-online` is a
 * committed example whose generated output is tracked, so generating into it
 * would make this gate rewrite reviewed files. `deherm create` is also the step
 * a user actually takes first, and it materialises the extension into the
 * project, so the result is a complete game that Bob can walk.
 *
 * `--project` points the gate at an existing project instead, which is how a
 * maintainer aims it at a real example.
 */
export const scratchProject = "build/end-to-end/project";

export const stageNames = Object.freeze(["policy", "host-tools", "target-archives", "scaffold", "generate", "bob"]);

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

/**
 * One row per declared bundle target, each either exercised or declined by name.
 *
 * Nothing here decides a reason of its own. `native-artifacts.json` carries a
 * glossary of what each status means and a machine-readable blocker for the
 * ones that cannot be produced; both are quoted rather than paraphrased, so a
 * reason that changes upstream changes here.
 */
export function buildLedger({ bundleTargets, artifacts, releaseTags }) {
  const declared = bundleTargets.targets.map((entry) => entry.target);
  const manifest = artifacts.targets ?? {};
  const glossary = artifacts.statuses ?? {};
  const published = new Set(Object.keys(releaseTags.families?.["native-artifacts"]?.assets ?? {}));

  const rows = [];
  const problems = [];

  for (const target of [...declared].sort()) {
    const entry = manifest[target];
    if (!entry) {
      problems.push(
        `${target}: ${paths.bundleTargets} declares this bundle target and ${paths.nativeArtifacts} does not. ` +
        "Nothing is built, published or exercised for it, and this gate will not invent a reason for that."
      );
      continue;
    }
    const base = {
      target,
      group: bundleTargets.targets.find((item) => item.target === target)?.group ?? null,
      status: entry.status,
      builder: entry.builder ?? null,
      published: published.has(target)
    };
    if (entry.status === "retired-upstream") {
      rows.push({ ...base, disposition: "declined", reason: glossary[entry.status] ?? entry.status });
      continue;
    }
    if (entry.status === "blocked") {
      const blocker = entry.blocker ?? {};
      if (!blocker.code || !blocker.reason) {
        problems.push(`${target}: status "blocked" with no machine-readable blocker in ${paths.nativeArtifacts}`);
        continue;
      }
      rows.push({ ...base, disposition: "declined", reason: `${blocker.code}: ${blocker.reason}` });
      continue;
    }
    rows.push({
      ...base,
      disposition: "exercise",
      // A web target links Emscripten sources rather than a Hermes archive, so
      // the archive stage has nothing to install for it. Saying so here keeps
      // the stage itself from having to know about platform groups.
      archiveStage: entry.status === "vendored-source"
        ? { disposition: "declined", reason: glossary["vendored-source"] ?? "links a source artifact" }
        : { disposition: "exercise" }
    });
  }

  for (const target of Object.keys(manifest).sort()) {
    if (!declared.includes(target)) {
      problems.push(`${target}: ${paths.nativeArtifacts} carries this target and ${paths.bundleTargets} does not declare it`);
    }
  }

  return { rows, problems };
}

export async function readLedger() {
  const [bundleTargets, artifacts, releaseTags] = await Promise.all([
    readJson(paths.bundleTargets),
    readJson(paths.nativeArtifacts),
    readJson(paths.releaseTags)
  ]);
  return { ...buildLedger({ bundleTargets, artifacts, releaseTags }), defoldRevision: artifacts.defoldRevision };
}

// ── Stages ──────────────────────────────────────────────────────────────────

async function node(script, args = [], options = {}) {
  return run(process.execPath, [script, ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024, ...options });
}

const stages = {
  async policy() {
    const { stdout } = await node("scripts/check-policy-site-resolution.mjs");
    return { detail: stdout.trim().split("\n").at(-1) ?? "resolved" };
  },

  async "host-tools"() {
    const { ensureHostFamily } = await import("../packages/cli/src/ensure-host-tool.mjs");
    const host = `${process.platform}-${process.arch}`;
    const detail = [];
    for (const family of ["hermes-host", "dehermc"]) {
      const result = await ensureHostFamily(family, host);
      detail.push(`${family}@${result.tag} ${result.cached ? "cached" : "fetched"} (${result.members.length} member(s))`);
    }
    return { detail: `${host}: ${detail.join("; ")}` };
  },

  async "target-archives"(context) {
    const wanted = context.rows.filter((row) => row.disposition === "exercise" && row.archiveStage.disposition === "exercise");
    // `--partial` installs what the release actually carries and reports the
    // rest, which is what lets one incomplete release be a named per-target
    // failure below instead of one opaque error for the whole matrix.
    await node("scripts/manage-native-artifacts.mjs", ["pull", "--partial"]).catch((error) => {
      throw new Error(`could not pull the published target archives: ${error.message}`);
    });
    const { stdout } = await node("scripts/manage-native-artifacts.mjs", ["verify", "--json"]);
    const report = JSON.parse(stdout);
    const byTarget = new Map(report.targets.map((row) => [row.target, row]));
    const failures = [];
    for (const row of wanted) {
      const observed = byTarget.get(row.target);
      if (!observed) failures.push(`${row.target}: the artifact matrix reported no row`);
      else if (observed.invalid) failures.push(`${row.target}: ${observed.detail}`);
      else if (observed.status !== "vendored") failures.push(`${row.target}: ${observed.status} (${observed.detail})`);
      else context.targetResult(row.target, "target-archives", { detail: observed.detail });
    }
    if (failures.length) throw new Error(failures.join("\n"));
    return { detail: `${wanted.length} target archive(s) installed and digest-verified` };
  },

  async scaffold(context) {
    if (context.projectWasGiven) {
      return { detail: `using the given project ${context.project}; nothing scaffolded` };
    }
    // `deherm create` refuses a non-empty directory, which is the behaviour a
    // user wants and the opposite of what a repeatable gate wants.
    await rm(path.join(root, context.project), { recursive: true, force: true });
    const { stdout } = await node("bin/deherm.mjs", ["create", context.project, "--name", "deherm end to end"]);
    return { detail: stdout.trim().split("\n")[0] ?? `created ${context.project}` };
  },

  async generate(context) {
    await node("bin/deherm.mjs", ["generate", "--project", context.project]);
    const { stdout } = await node("bin/deherm.mjs", ["typecheck", "--project", context.project]);
    return { detail: stdout.trim().split("\n").at(-1) ?? "generated and type checked" };
  },

  async bob(context) {
    const failures = [];
    for (const row of context.rows.filter((item) => item.disposition === "exercise")) {
      try {
        await run(path.join(root, "scripts", "bob.sh"), ["build"], {
          cwd: root,
          maxBuffer: 256 * 1024 * 1024,
          env: {
            ...process.env,
            DEFOLD_HERMES_PLATFORM: row.target,
            DEFOLD_HERMES_PROJECT: context.project,
            DEFOLD_HERMES_BUILD_SERVER: context.buildServer,
            DEFOLD_HERMES_ALLOW_REMOTE_BUILD: "1"
          }
        });
        context.targetResult(row.target, "bob", { detail: `built against ${context.buildServer}` });
      } catch (error) {
        const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim().split("\n").slice(-8).join("\n");
        failures.push(`${row.target}:\n${output || error.message}`);
      }
    }
    if (failures.length) throw new Error(failures.join("\n\n"));
    return { detail: `${context.rows.filter((item) => item.disposition === "exercise").length} target(s) built` };
  }
};

// ── Reporting ───────────────────────────────────────────────────────────────

function renderLedger(rows) {
  const width = Math.max(...rows.map((row) => row.target.length));
  return rows.map((row) => {
    const name = row.target.padEnd(width);
    if (row.disposition === "declined") return `  -- ${name}  not exercised: ${row.reason}`;
    const notes = [row.published ? "published" : "unpublished", row.status];
    if (row.archiveStage.disposition === "declined") notes.push(`no archive: ${row.archiveStage.reason}`);
    return `  ** ${name}  exercise (${notes.join(", ")})`;
  }).join("\n");
}

export async function main(argv) {
  const requested = [];
  const only = [];
  let json = false;
  let plan = false;
  let project = scratchProject;
  let projectWasGiven = false;
  let buildServer = process.env.DEFOLD_HERMES_BUILD_SERVER ?? defaultBuildServer;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") json = true;
    else if (value === "--plan") plan = true;
    else if (value === "--project") { project = argv[++index]; projectWasGiven = true; }
    else if (value === "--build-server") buildServer = argv[++index];
    else if (value === "--stage") requested.push(argv[++index]);
    else if (value === "--target") only.push(argv[++index]);
    else throw new Error(`Unknown argument ${value}`);
  }
  for (const name of requested) {
    if (!stageNames.includes(name)) throw new Error(`Unknown stage ${name}; declared stages are ${stageNames.join(", ")}`);
  }
  const selected = requested.length ? requested : stageNames;

  const { rows: everyRow, problems, defoldRevision } = await readLedger();
  // `--target` narrows which rows the per-target stages act on. It never hides a
  // row: the ledger printed below is still the whole declared matrix, so a run
  // that covers one target says so instead of looking complete.
  for (const target of only) {
    if (!everyRow.some((row) => row.target === target)) {
      throw new Error(`No declared bundle target ${target}; declared targets are ${everyRow.map((row) => row.target).join(", ")}`);
    }
  }
  const rows = only.length ? everyRow.filter((row) => only.includes(row.target)) : everyRow;
  const targetResults = new Map();
  const context = {
    rows,
    project,
    projectWasGiven,
    buildServer,
    targetResult(target, stage, result) {
      if (!targetResults.has(target)) targetResults.set(target, {});
      targetResults.get(target)[stage] = result;
    }
  };

  const report = {
    schemaVersion: 1,
    kind: "deherm.end-to-end-gate",
    defoldRevision,
    buildServer,
    project,
    onlyTargets: only.length ? only : null,
    stages: [],
    targets: everyRow,
    problems
  };

  if (!json) {
    console.log(`déherm end-to-end gate - Defold ${defoldRevision}, project ${project}, build server ${buildServer}`);
    console.log(renderLedger(everyRow));
    if (only.length) console.log(`  (this run acts on ${only.join(", ")} only)`);
  }

  if (!plan) {
    for (const name of selected) {
      const started = Date.now();
      try {
        const result = await stages[name](context);
        report.stages.push({ stage: name, status: "passed", seconds: Math.round((Date.now() - started) / 100) / 10, ...result });
        if (!json) console.log(`ok   ${name}: ${result.detail}`);
      } catch (error) {
        report.stages.push({ stage: name, status: "failed", seconds: Math.round((Date.now() - started) / 100) / 10, detail: error.message });
        if (!json) console.error(`FAIL ${name}:\n${error.message}`);
      }
    }
  }
  for (const [target, results] of targetResults) {
    const row = report.targets.find((item) => item.target === target);
    if (row) row.results = results;
  }

  const failed = report.stages.filter((stage) => stage.status === "failed");
  report.status = problems.length || failed.length ? "failed" : plan ? "planned" : "passed";
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const problem of problems) console.error(`FAIL ledger: ${problem}`);
    const exercised = rows.filter((row) => row.disposition === "exercise").length;
    const declared = everyRow.length;
    console.log(
      `${report.status}: ${exercised} of ${declared} declared bundle target(s) exercised` +
      `${only.length ? ` (narrowed to ${only.join(", ")})` : ""}, ` +
      `${everyRow.length - everyRow.filter((row) => row.disposition === "exercise").length} declined with a named reason, ` +
      `${failed.length} stage(s) failed`
    );
  }
  return report.status === "failed" ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
