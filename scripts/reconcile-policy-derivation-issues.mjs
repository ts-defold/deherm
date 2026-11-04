#!/usr/bin/env node

// Keep derivation failures actionable. One generator/infrastructure stage gets
// one issue listing every affected tracked revision; it does not get one issue
// per revision. A listed revision leaves the issue only after a successful
// derivation or an authoritative observation that it is no longer tracked.

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
  if (/compile universal-ready production calls failed/u.test(log)) return "compile-universal-ready-production-calls";
  const stages = [...log.matchAll(/\b(scripts\/[A-Za-z0-9_./-]+\.mjs) failed:/gu)];
  return stages.at(-1)?.[1] ?? "unknown-derivation-stage";
}

export function blockerFromLog(log) {
  const compiler = [...log.matchAll(/^.*(?:fatal error:|error:).+$/gmu)]
    .map((match) => match[0].trim())
    .filter((line) => !line.startsWith("Error:"));
  if (compiler.length) return compiler.at(-1);
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
    .toSorted((left, right) => left.revision.localeCompare(right.revision) || left.channel.localeCompare(right.channel))
    .map(
      ({ channel, revision, version, blocker }) =>
        `- \`${channel}\` ${version} \`${revision}\`\n  - ${blocker.replace(/[\r\n]+/gu, " ")}`,
    )
    .join("\n");
  return [
    `Automated policy derivation stopped in \`${stage}\` for ${failures.length} tracked revision(s).`,
    "",
    rows,
    "",
    `Run: ${runUrl}`,
    "",
    "This is one generator/infrastructure blocker shared by the listed revisions, not one unproven API claim per revision. The usable accumulated policy store remains publishable. Each listed revision leaves this issue only after its derivation succeeds or an authoritative tracked-channel observation shows that it is no longer tracked.",
  ].join("\n");
}

function issueTitleForStage(stage) {
  const name = stage === "unknown-derivation-stage" ? stage : path.basename(stage, ".mjs");
  return `policy derivation: ${name}`;
}

const issueRowPattern = /^- `([^`\r\n]+)` ([^`\r\n]+) `([^`\r\n]+)`\r?\n  - ([^\r\n]*)$/gmu;

function stageFromIssue(issue) {
  if (typeof issue.body !== "string") return null;
  const firstLine = issue.body.split(/\r?\n/u, 1)[0];
  const summary = /^Automated policy derivation stopped in `([^`]+)` for (\d+) tracked revision\(s\)\.$/u.exec(
    firstLine,
  );
  return summary && issueTitleForStage(summary[1]) === issue.title ? summary[1] : null;
}

function parseIssueRows(issue) {
  const stage = stageFromIssue(issue);
  if (!stage) return null;
  const firstLine = issue.body.split(/\r?\n/u, 1)[0];
  const count = Number(
    /^Automated policy derivation stopped in `[^`]+` for (\d+) tracked revision\(s\)\.$/u.exec(firstLine)?.[1],
  );
  const rows = [...issue.body.matchAll(issueRowPattern)].map((match) => ({
    channel: match[1],
    version: match[2],
    revision: match[3],
    blocker: match[4],
  }));
  return rows.length === count ? rows : null;
}

function normalizedScope(scope) {
  if (scope === undefined || scope === null) return null;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError("Policy derivation scope must be an object.");
  }
  if (!Array.isArray(scope.examinedRevisions)) {
    throw new TypeError("Policy derivation scope must include an examinedRevisions array.");
  }
  if (scope.trackedRevisions !== null && !Array.isArray(scope.trackedRevisions)) {
    throw new TypeError("Policy derivation scope trackedRevisions must be an array or null.");
  }
  const normalizeRevisions = (revisions, label) =>
    revisions.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new TypeError(`Policy derivation scope ${label}[${index}] must be an object.`);
      }
      for (const key of ["channel", "revision", "version"]) {
        if (typeof row[key] !== "string" || row[key].length === 0) {
          throw new TypeError(`Policy derivation scope ${label}[${index}].${key} must be a non-empty string.`);
        }
      }
      return { channel: row.channel, revision: row.revision, version: row.version };
    });
  return {
    trackedRevisions:
      scope.trackedRevisions === null ? null : normalizeRevisions(scope.trackedRevisions, "trackedRevisions"),
    examinedRevisions: normalizeRevisions(scope.examinedRevisions, "examinedRevisions"),
  };
}

function revisionKey({ channel, revision }) {
  return `${revision}\u0000${channel}`;
}

function mergedIssueRows(issues) {
  const rows = new Map();
  for (const issue of issues
    .filter(({ state }) => state === "OPEN")
    .toSorted((left, right) => left.number - right.number)) {
    for (const row of parseIssueRows(issue) ?? []) {
      const key = revisionKey(row);
      if (!rows.has(key)) rows.set(key, row);
    }
  }
  return [...rows.values()].toSorted(
    (left, right) => left.revision.localeCompare(right.revision) || left.channel.localeCompare(right.channel),
  );
}

function isResolvedRevision(revision, successfulRevisions, trackedRevisions) {
  return successfulRevisions.has(revision) || (trackedRevisions !== null && !trackedRevisions.has(revision));
}

function legacyIssueRevision(title) {
  const match = /^policy: unproven Defold ([0-9a-f]{40})$/u.exec(title);
  return match?.[1] ?? null;
}

export function planPolicyDerivationIssueReconciliation({ existingIssues, failures, runUrl, scope }) {
  const normalized = normalizedScope(scope);
  const failuresByStage = Map.groupBy(failures, ({ stage }) => stage);
  const desired = new Map(
    [...failuresByStage].map(([stage, rows]) => [issueTitleForStage(stage), { stage, failures: rows }]),
  );
  const generated = existingIssues.filter(({ title }) =>
    generatedTitlePrefixes.some((prefix) => title.startsWith(prefix)),
  );
  const issuesByTitle = Map.groupBy(
    generated.filter(({ title }) => title.startsWith("policy derivation: ")),
    ({ title }) => title,
  );
  const stageTitles = new Set([...issuesByTitle.keys(), ...desired.keys()]);
  const actions = [];
  const failedRevisions = new Set(failures.map(({ revision }) => revision));
  const successfulRevisions = new Set(
    (normalized?.examinedRevisions ?? [])
      .filter(({ revision }) => !failedRevisions.has(revision))
      .map(({ revision }) => revision),
  );
  const trackedRevisions =
    normalized?.trackedRevisions === null || normalized === null
      ? null
      : new Set(normalized.trackedRevisions.map(({ revision }) => revision));

  for (const title of stageTitles) {
    const current = desired.get(title);
    const currentFailures = current?.failures ?? [];
    const matches = (issuesByTitle.get(title) ?? []).toSorted((left, right) => left.number - right.number);
    const managedMatches = matches.filter((issue) => parseIssueRows(issue) !== null);
    if (matches.length > 0 && managedMatches.length === 0) {
      if (current) actions.push({ kind: "create", title, body: issueBody(current.stage, current.failures, runUrl) });
      continue;
    }

    const existingRows = mergedIssueRows(managedMatches);
    const currentFailureRevisions = new Set(currentFailures.map(({ revision }) => revision));
    const retainedRows = existingRows.filter(
      ({ revision }) =>
        !isResolvedRevision(revision, successfulRevisions, trackedRevisions) && !currentFailureRevisions.has(revision),
    );
    const rowsByKey = new Map(retainedRows.map((row) => [revisionKey(row), row]));
    for (const failure of currentFailures) rowsByKey.set(revisionKey(failure), failure);
    const rows = [...rowsByKey.values()].toSorted(
      (left, right) => left.revision.localeCompare(right.revision) || left.channel.localeCompare(right.channel),
    );

    if (rows.length === 0) {
      if (normalized && managedMatches.length > 0 && existingRows.length > 0) {
        for (const issue of managedMatches) {
          if (issue.state === "OPEN") actions.push({ kind: "close", number: issue.number, stale: true });
        }
      }
      continue;
    }

    const stage = current?.stage ?? stageFromIssue(managedMatches[0]);
    if (!managedMatches.length) {
      actions.push({ kind: "create", title, body: issueBody(stage, rows, runUrl) });
      continue;
    }

    const openManagedMatches = managedMatches.filter(({ state }) => state === "OPEN");
    const primary = openManagedMatches[0] ?? (current ? managedMatches[0] : undefined);
    if (!primary) continue;
    const body = issueBody(stage, rows, runUrl);
    const rowsChanged = JSON.stringify(rows) !== JSON.stringify(existingRows);
    if (current || (normalized && rowsChanged)) {
      if (primary.state !== "OPEN" && current) actions.push({ kind: "reopen", number: primary.number });
      if (primary.state === "OPEN" || current) actions.push({ kind: "edit", number: primary.number, body });
    }
    if (current) {
      for (const duplicate of openManagedMatches.slice(1)) {
        actions.push({ kind: "close", number: duplicate.number, stale: true, mergedInto: primary.number });
      }
    }
  }

  if (normalized) {
    for (const issue of generated.filter(({ title }) => title.startsWith("policy: unproven Defold "))) {
      const revision = legacyIssueRevision(issue.title);
      if (revision && issue.state === "OPEN" && isResolvedRevision(revision, successfulRevisions, trackedRevisions)) {
        actions.push({ kind: "close", number: issue.number, stale: true });
      }
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
    const comment = action.mergedInto
      ? `Duplicate generated issue; its unresolved revision rows were merged into issue #${action.mergedInto}.`
      : "Every listed revision was either derived successfully or is absent from the authoritative tracked channel scope. Closing the stale automated issue.";
    await run("gh", ["issue", "close", String(action.number), ...repo, "--reason", "completed", "--comment", comment]);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const repository = args.repository ?? process.env.GITHUB_REPOSITORY;
  if (!repository || !args.failures || !args.reports || !args["run-url"]) {
    throw new Error(
      "Usage: reconcile-policy-derivation-issues --failures <tsv> --reports <dir> --run-url <url> [--scope <json>] [--repository owner/name]",
    );
  }
  const failures = await readDerivationFailures({
    failuresPath: args.failures,
    reportsDirectory: args.reports,
  });
  const scope = args.scope === undefined ? undefined : JSON.parse(await readFile(args.scope, "utf8"));
  const { stdout } = await run(
    "gh",
    ["issue", "list", "--repo", repository, "--state", "all", "--limit", "200", "--json", "number,title,state,body"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: JSON.parse(stdout),
    failures,
    runUrl: args["run-url"],
    scope,
  });
  for (const action of actions) await applyAction(action, repository);
  console.log(`policy-derivation-issues: ${failures.length} failure(s), ${actions.length} reconciliation action(s)`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
