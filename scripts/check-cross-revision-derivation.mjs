#!/usr/bin/env node
//
// Derive a DIFFERENT Defold revision and report everything that did not derive.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// This is a code-in, code-out generator. Defold changing its own source is the
// input to the job, so a generator that refuses because the input changed is
// broken, not careful. The trouble is that such a refusal is invisible at the
// pinned revision - by construction, every pinned assumption holds there - so
// they accumulated silently and were then discovered one per nightly run,
// weeks apart, each costing a round of hand-written code.
//
// Nothing in `pnpm check` could find them, because `pnpm check` generates the
// one revision every assumption was written against.
//
// So: derive a control revision that is deliberately NOT the pinned one, run
// every generator against it, and report the whole set at once. The first run
// of this found 18 of 28 script-generation steps refusing, reducible to three
// causes - which is a list a person can act on, unlike one error a fortnight.
//
// ── Why it does not stop at the first failure ──────────────────────────────
//
// `derive-revision.mjs` stops at the first refusing generator, which is right
// for a derivation that intends to ADOPT a result: a half-regenerated surface
// must not reach a pull request. It is exactly wrong for measuring how much
// does not derive. This runs every step regardless and collects all of them.
//
// ── The ratchet ───────────────────────────────────────────────────────────
//
// The baseline records how many steps refuse today. A change that makes more
// of them refuse fails this check with the new refusals named; a change that
// makes fewer prints the improvement and asks for the baseline to be lowered.
// The baseline only ever goes down, so "we will fix these" becomes a property
// the build enforces rather than an intention.

import { execFile } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { scriptGenerationSteps } from "./lib/script-generator-pipeline.mjs";
import { DERIVED_REVISION_ENV, CARRIED_REVIEW_LEDGER_ENV } from "./lib/reviewed-revision.mjs";
import { REVISION_AUDIT_ENV } from "./lib/revision-audit.mjs";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "packages", "bindings", "probes", "cross-revision-baseline.json");

/**
 * What a refusal is really about.
 *
 * Every refusal seen so far is one of these, and each has ONE fix that applies
 * everywhere it occurs - which is the point of classifying rather than listing.
 */
const CAUSES = [
  {
    id: "absent-source",
    test: /ENOENT|no such file/,
    fix: "Load cited Defold sources with loadReviewedSources, which withdraws the " +
      "ones a revision does not have instead of dying on the first. Defold 1.13.1 " +
      "has no bullet3d backend at all; that is not a broken review."
  },
  {
    id: "revision-stamp",
    test: /revisions? differs?|different Defold revision|revisions differ/i,
    fix: "The generator refuses when two of its inputs carry different defoldRevision " +
      "stamps. During a derivation that is transient - it means an earlier step in " +
      "the chain has not regenerated yet - so it must report which inputs disagree " +
      "rather than refuse."
  },
  {
    id: "pinned-census",
    test: /expected|census|no longer resolves|drifted|is stale/i,
    fix: "A count or hash recorded at the reviewed revision, asserted at another one. " +
      "Route it through expectReviewedCount: fatal in an ordinary generation, " +
      "reported inside a declared derivation."
  }
];

function classify(message) {
  return CAUSES.find(({ test }) => test.test(message))?.id ?? "unclassified";
}

async function main() {
  const argv = process.argv.slice(2);
  const workspace = argv.includes("--workspace")
    ? argv[argv.indexOf("--workspace") + 1]
    : path.join(root, "build", "cross-revision");
  const update = argv.includes("--update-baseline");

  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const revision = baseline.controlRevision;

  // A fresh derivation of the control revision. `--carry-reviews` is not
  // optional here: a control revision is by definition not the one the reviews
  // name, and the point is to measure the GENERATORS, not to rediscover that.
  await rm(workspace, { recursive: true, force: true });
  await run(process.execPath, [
    "scripts/derive-revision.mjs", "--revision", revision, "--workspace", workspace, "--carry-reviews"
  ], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch((error) => error);

  const env = {
    ...process.env,
    [DERIVED_REVISION_ENV]: revision,
    [CARRIED_REVIEW_LEDGER_ENV]: path.join(workspace, "carried-reviews.jsonl"),
    [REVISION_AUDIT_ENV]: path.join(workspace, "revision-audit.ndjson")
  };

  const refusals = [];
  for (const step of scriptGenerationSteps) {
    try {
      await run(process.execPath, [step.script], { cwd: workspace, env, maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      const text = `${error.stderr ?? ""}${error.stdout ?? ""}`;
      const message = (text.split("\n").find((line) => /^\s*(Error|AssertionError)/.test(line))
        ?? text.split("\n")[0] ?? "").trim();
      refusals.push({ step: step.script, cause: classify(message), message: message.slice(0, 300) });
    }
  }

  const byCause = new Map();
  for (const row of refusals) byCause.set(row.cause, [...(byCause.get(row.cause) ?? []), row]);

  const report = [];
  report.push(`Cross-revision derivation: Defold ${revision}`);
  report.push(`${scriptGenerationSteps.length} script-generation steps, ${refusals.length} refused ` +
    `(baseline ${baseline.refusingSteps}).`);
  report.push("");
  for (const cause of [...CAUSES.map(({ id }) => id), "unclassified"]) {
    const rows = byCause.get(cause) ?? [];
    if (!rows.length) continue;
    const fix = CAUSES.find(({ id }) => id === cause)?.fix
      ?? "Not one of the known causes. Read the message and decide whether it is a real " +
         "engine difference or another pinned assumption.";
    report.push(`## ${cause} (${rows.length})`);
    report.push("");
    report.push(fix);
    report.push("");
    for (const row of rows) report.push(`  ${row.step}\n      ${row.message}`);
    report.push("");
  }
  const text = report.join("\n");
  console.log(text);
  await writeFile(path.join(workspace, "cross-revision-report.md"), `${text}\n`);

  if (update) {
    await writeFile(baselinePath, `${JSON.stringify({
      ...baseline, refusingSteps: refusals.length, totalSteps: scriptGenerationSteps.length,
      refusalsByCause: Object.fromEntries([...byCause].map(([cause, rows]) => [cause, rows.length])),
      steps: refusals.map(({ step, cause }) => ({ step, cause })).sort((a, b) => a.step < b.step ? -1 : 1)
    }, null, 2)}\n`);
    console.log(`\nBaseline updated to ${refusals.length}.`);
    return;
  }

  if (refusals.length > baseline.refusingSteps) {
    const known = new Set(baseline.steps.map(({ step }) => step));
    const added = refusals.filter(({ step }) => !known.has(step));
    throw new Error(
      `${refusals.length} steps refuse to derive ${revision}, up from a baseline of ` +
      `${baseline.refusingSteps}.\nNewly refusing:\n` +
      added.map(({ step, message }) => `  ${step}\n      ${message}`).join("\n") +
      "\nA generator must not start depending on the pinned revision's shape."
    );
  }
  if (refusals.length < baseline.refusingSteps) {
    console.log(`\n${baseline.refusingSteps - refusals.length} fewer than the baseline. ` +
      "Lower it: node scripts/check-cross-revision-derivation.mjs --update-baseline");
  }
}

await main();
