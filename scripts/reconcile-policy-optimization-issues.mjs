#!/usr/bin/env node

// Turn route-local specialization withdrawals into durable optimization work.
// The policy already contains the universal route; these issues never represent
// a support or publication gate. Rows are grouped by reviewed input so one
// engine refactor cannot create hundreds of per-route issues.

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const titlePrefix = "policy optimization: ";
const actionableReasons = new Set([
  "absent-registration",
  "stale-call-shapes",
  "stale-result-codec",
  "stale-source-anchor",
  "stale-specialization-evidence",
  "stale-terminal-anchor",
  "unreadable-signature",
  "unreviewed-handle-invalidator",
  "unreviewed-handle-producer",
  "withdrawn-handle-kind",
]);

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

function familyName(input) {
  return path.basename(input, path.extname(input));
}

export async function readOptimizationWithdrawals(reportsDirectory) {
  const names = await readdir(reportsDirectory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const rows = [];
  const observedFamilies = new Set();
  for (const name of names.filter((candidate) => candidate.endsWith(".audit.ndjson")).sort()) {
    const revision = name.slice(0, -".audit.ndjson".length);
    const text = await readFile(path.join(reportsDirectory, name), "utf8");
    for (const line of text.split(/\r?\n/u).filter(Boolean)) {
      const row = JSON.parse(line);
      if (typeof row.input === "string") observedFamilies.add(familyName(row.input));
      if (row.status !== "void" || !actionableReasons.has(row.reason) || typeof row.input !== "string") continue;
      rows.push({ ...row, revision });
    }
  }
  return { withdrawals: rows, observedFamilies };
}

function issueBody(input, rows, runUrl) {
  const byRevision = Map.groupBy(rows, ({ revision }) => revision);
  const details = [...byRevision]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([revision, revisionRows]) => [
      `### Defold \`${revision}\``,
      "",
      ...revisionRows
        .toSorted((left, right) => `${left.id}|${left.reason}`.localeCompare(`${right.id}|${right.reason}`))
        .map(({ id, reason, detail, unresolvedCodecs }) => {
          const suffix =
            detail ?? (unresolvedCodecs?.length ? `unresolved codecs: ${unresolvedCodecs.join(", ")}` : reason);
          return `- \`${id}\` — ${suffix}`;
        }),
      "",
    ])
    .join("\n");
  return [
    `The policy was published with universal routes, but the reviewed fast-path recipe in \`${input}\` did not apply to ${rows.length} route observation(s).`,
    "",
    "This is an optimization opportunity, not an API support gap or publication blocker.",
    "",
    details,
    `Run: ${runUrl}`,
  ].join("\n");
}

export function planPolicyOptimizationIssueReconciliation({
  existingIssues,
  withdrawals,
  observedFamilies,
  closeResolved,
  runUrl,
}) {
  const grouped = Map.groupBy(withdrawals, ({ input }) => input);
  const desired = new Map(
    [...grouped].map(([input, rows]) => [`${titlePrefix}${familyName(input)}`, issueBody(input, rows, runUrl)]),
  );
  const generated = existingIssues.filter(({ title }) => title.startsWith(titlePrefix));
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
      if (duplicate.state === "OPEN") actions.push({ kind: "close", number: duplicate.number });
    }
  }
  for (const issue of generated) {
    const family = issue.title.slice(titlePrefix.length);
    if (closeResolved && issue.state === "OPEN" && observedFamilies.has(family) && !desired.has(issue.title)) {
      actions.push({ kind: "close", number: issue.number });
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
      "A complete tracked-channel derivation no longer withdraws this optimization family.",
    ]);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const repository = args.repository ?? process.env.GITHUB_REPOSITORY;
  if (!repository || !args.reports || !args["run-url"]) {
    throw new Error(
      "Usage: reconcile-policy-optimization-issues --reports <dir> --run-url <url> [--repository owner/name]",
    );
  }
  const failures = args.failures
    ? await readFile(args.failures, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      })
    : "";
  const { withdrawals, observedFamilies } = await readOptimizationWithdrawals(args.reports);
  const { stdout } = await run(
    "gh",
    ["issue", "list", "--repo", repository, "--state", "all", "--limit", "200", "--json", "number,title,state"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const actions = planPolicyOptimizationIssueReconciliation({
    existingIssues: JSON.parse(stdout),
    withdrawals,
    observedFamilies,
    closeResolved: failures.trim().length === 0,
    runUrl: args["run-url"],
  });
  for (const action of actions) await applyAction(action, repository);
  console.log(`policy-optimization-issues: ${withdrawals.length} withdrawal(s), ${actions.length} action(s)`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
