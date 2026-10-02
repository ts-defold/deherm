#!/usr/bin/env node

// Keep derivation failures actionable. One generator/infrastructure stage gets
// one issue listing every affected tracked revision; it does not get one issue
// per revision. Generated issues disappear when a complete tracked-channel run
// no longer reproduces them.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const generatedTitlePrefixes = Object.freeze(["policy: unproven Defold ", "policy derivation: "]);

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument sequence at ${key ?? "end"}`);
    values[key.slice(2)] = value;
  }
  return values;
}

export function stageFromLog(log) {
  const summary = /blocked by generator at (scripts\/[A-Za-z0-9_./-]+\.mjs)\b/gu.exec(log);
  if (summary) return summary[1];
  const stages = [...log.matchAll(/\b(scripts\/[A-Za-z0-9_./-]+\.mjs) failed:/gu)];
  return stages.at(-1)?.[1] ?? "unknown-derivation-stage";
}

export function blockerFromLog(log) {
  const errors = [...log.matchAll(/^Error:\s+(.+)$/gmu)].map((match) => match[1].trim());
  return errors.at(-1) ?? log.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? "No error message was captured.";
}

export async function readDerivationFailures({ failuresPath, reportsDirectory }) {
  const text = await readFile(failuresPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const failures = [];
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const [channel, revision, version = "unknown"] = line.split("\t");
    const log = await readFile(path.join(reportsDirectory, `${revision}.log`), "utf8");
    failures.push({ channel, revision, version, stage: stageFromLog(log), blocker: blockerFromLog(log) });
  }
  return failures;
}

function issueBody(stage, failures, runUrl) {
  const rows = failures
    .toSorted((left, right) => left.revision.localeCompare(right.revision))
    .map(
      ({ channel, revision, version, blocker }) =>
        `- \`${channel}\` ${version} \`${revision}\`\n  - ${blocker.replaceAll("\n", " ")}`,
    )
    .join("\n");
  return [
    `Automated policy derivation stopped in \`${stage}\` for ${failures.length} tracked revision(s).`,
    "",
    rows,
    "",
    `Run: ${runUrl}`,
    "",
    "This is one generator/infrastructure blocker shared by the listed revisions, not one unproven API claim per revision. The usable accumulated policy store remains publishable, and this issue closes automatically after a complete tracked-channel derivation no longer reproduces the stage failure.",
  ].join("\n");
}

export function planPolicyDerivationIssueReconciliation({ existingIssues, failures, runUrl }) {
  const grouped = Map.groupBy(failures, (failure) => failure.stage);
  const desired = new Map(
    [...grouped].map(([stage, rows]) => {
      const name = stage === "unknown-derivation-stage" ? stage : path.basename(stage, ".mjs");
      const title = `policy derivation: ${name}`;
      return [title, issueBody(stage, rows, runUrl)];
    }),
  );
  const generated = existingIssues.filter(({ title }) =>
    generatedTitlePrefixes.some((prefix) => title.startsWith(prefix)),
  );
  const actions = [];
  for (const [title, body] of desired) {
    const matches = generated
      .filter((issue) => issue.title === title)
      .toSorted((left, right) => left.number - right.number);
    const issue = matches[0];
    if (!issue) actions.push({ kind: "create", title, body });
    else {
      if (issue.state !== "OPEN") actions.push({ kind: "reopen", number: issue.number });
      actions.push({ kind: "edit", number: issue.number, body });
    }
    for (const duplicate of matches.slice(1)) {
      if (duplicate.state === "OPEN") actions.push({ kind: "close", number: duplicate.number, stale: true });
    }
  }
  for (const issue of generated) {
    if (issue.state === "OPEN" && !desired.has(issue.title)) {
      actions.push({ kind: "close", number: issue.number, stale: true });
    }
  }
  return actions;
}

async function applyAction(action, repository) {
  const repo = ["--repo", repository];
  if (action.kind === "create") {
    await run("gh", ["issue", "create", ...repo, "--title", action.title, "--body", action.body]);
  } else if (action.kind === "reopen") {
    await run("gh", ["issue", "reopen", String(action.number), ...repo]);
  } else if (action.kind === "edit") {
    await run("gh", ["issue", "edit", String(action.number), ...repo, "--body", action.body]);
  } else if (action.kind === "close") {
    await run("gh", [
      "issue",
      "close",
      String(action.number),
      ...repo,
      "--reason",
      "completed",
      "--comment",
      "A complete tracked-channel policy derivation no longer reproduces this generated blocker, or the affected revision is no longer tracked. Closing the stale automated issue.",
    ]);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const repository = args.repository ?? process.env.GITHUB_REPOSITORY;
  if (!repository || !args.failures || !args.reports || !args["run-url"]) {
    throw new Error(
      "Usage: reconcile-policy-derivation-issues --failures <tsv> --reports <dir> --run-url <url> [--repository owner/name]",
    );
  }
  const failures = await readDerivationFailures({
    failuresPath: args.failures,
    reportsDirectory: args.reports,
  });
  const { stdout } = await run(
    "gh",
    ["issue", "list", "--repo", repository, "--state", "all", "--limit", "200", "--json", "number,title,state"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: JSON.parse(stdout),
    failures,
    runUrl: args["run-url"],
  });
  for (const action of actions) await applyAction(action, repository);
  console.log(`policy-derivation-issues: ${failures.length} failure(s), ${actions.length} reconciliation action(s)`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
