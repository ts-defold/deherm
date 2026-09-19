#!/usr/bin/env node
//
// Render the reviewed-policy audit as Markdown, for a CI job summary.
//
// The audit is written by the generators as they run - see
// `scripts/lib/revision-audit.mjs` for what the three classifications mean and
// why none of them is a failure. This script only formats it. It exits 0 on an
// empty or missing audit, because "nothing moved" and "no audit was produced"
// are both fine outcomes for a run that had nothing to report; a run that
// failed fails on its own, not on the shape of its report.

import { writeFileSync } from "node:fs";

import { readAudit, renderAuditSummary, REVISION_AUDIT_ENV } from "./lib/revision-audit.mjs";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};

const rows = readAudit(valueOf("audit") ?? process.env[REVISION_AUDIT_ENV] ?? undefined);
const markdown = renderAuditSummary(rows, {
  revision: valueOf("revision") ?? undefined,
  reviewed: valueOf("reviewed") ?? undefined
});

const out = valueOf("out");
if (out) writeFileSync(out, markdown);
else process.stdout.write(markdown);
