// What moved in Defold between the revision a policy was reviewed at and the
// revision being generated - as a report, not as a refusal.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// A reviewed override under `packages/bindings/overrides/` pins, for each
// Defold source file it cites, that file's SHA-256 and the exact text anchors
// the review rests on. The generators used to assert the SHA-256 and throw when
// it moved. That is the wrong shape for what this project is:
//
//   Defold editing its own C++ between 1.13.0 and 1.13.1 is the expected
//   outcome. We are the authoritative generator FOR that change. A moved file
//   is the input to our job, not a failure of it.
//
// The thing that is actually load-bearing is the ABI: the signature, the
// layout, the handle semantics a binding is emitted against. When the ABI
// moves, the correct response is a DIFFERENT POLICY ENTRY for that revision -
// so we know how to emit code for it, and so a policy can be added, removed or
// swapped per version - and never a blocked release.
//
// So a source hash is demoted to what it honestly is: a change detector, whose
// output is an audit line. This module is where those lines go. CI renders them
// into a job summary; a reviewer reads the summary and decides what to
// re-review. Nothing here ever throws because of what Defold did to its own
// source.
//
// ── The three classifications, and what each one MEANS for policy ──────────
//
//   holds - the file hashes to what the review recorded. The reviewed entry
//           applies to this revision unchanged.
//
//   moved - the hash differs and every anchor is still present. The review's
//           subject survived; its surroundings changed. The entry applies, and
//           the audit carries the new hash so the pin can be restated for this
//           revision. This is the ordinary case across a Defold release and it
//           is not a problem.
//
//   void  - an anchor the review rests on is gone (or the file is). The review
//           cannot speak for this revision. The entry is WITHDRAWN for this
//           revision - the affected routes degrade to unreviewed rather than
//           being emitted on evidence that no longer exists. That degradation
//           is a policy difference between two revisions, which is exactly what
//           a per-revision policy store is for. It is still not a build
//           failure, and it is still not a reason to refuse a release; it is a
//           queued piece of review work, reported by name.
//
// `void` is deliberately the only classification that changes what we emit,
// because it is the only one where the evidence for emitting is gone.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where audit lines are appended. Set by CI; defaulted so it is never unset. */
export const REVISION_AUDIT_ENV = "DEHERM_REVISION_AUDIT";

const DEFAULT_AUDIT = path.join("build", "revision-audit.ndjson");

/** Classifications, weakest evidence last. */
export const HOLDS = "holds";
export const MOVED = "moved";
export const VOID = "void";

function auditPath(env) {
  return env[REVISION_AUDIT_ENV] || DEFAULT_AUDIT;
}

/**
 * Record one audit line.
 *
 * Appending is best-effort by design. An audit is a report; a report that
 * cannot be written is a lost report, not a failed build. The previous
 * behaviour - refusing to proceed when the ledger path was unset - turned the
 * reporting mechanism itself into another gate, which is the thing this module
 * exists to remove.
 */
export function recordAudit(row, env = process.env) {
  const target = auditPath(env);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
  } catch {
    // Intentionally silent: see above.
  }
  return row;
}

/**
 * Classify one reviewed claim against the source actually present.
 *
 * Pure: it decides, it does not record and it does not throw. `observeReviewedSource`
 * in `reviewed-revision.mjs` is the recording wrapper the generators call.
 *
 * @param {string|null} source  the file's text at the revision being generated, or
 *                              null when the file is gone
 * @param {{sha256: string, anchors?: string[], source?: string}} evidence
 */
export function classifyReviewedSource(source, evidence) {
  const anchors = evidence.anchors ?? [];
  if (source === null || source === undefined) {
    return { status: VOID, reason: "absent", observed: null, anchorsHeld: 0, anchorsLost: [...anchors] };
  }
  const observed = createHash("sha256").update(source).digest("hex");
  const lost = anchors.filter((anchor) => !source.includes(anchor));
  if (lost.length) {
    return {
      status: VOID,
      reason: observed === evidence.sha256 ? "anchor" : "content",
      observed,
      anchorsHeld: anchors.length - lost.length,
      anchorsLost: lost
    };
  }
  if (observed === evidence.sha256) {
    return { status: HOLDS, reason: "identical", observed, anchorsHeld: anchors.length, anchorsLost: [] };
  }
  return { status: MOVED, reason: "content", observed, anchorsHeld: anchors.length, anchorsLost: [] };
}

/**
 * Read an audit file back, one row per claim.
 *
 * A missing file is an empty audit, not an error. Rows are deduplicated on
 * `input|id` keeping the last, because a derivation runs a chain of generators
 * and several of them observe the same reviewed source: without this the
 * summary would count one moved file once per generator that read it.
 */
export function readAudit(target = auditPath(process.env)) {
  let text;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    return [];
  }
  const byClaim = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    byClaim.set(`${row.input}|${row.id}`, row);
  }
  return [...byClaim.values()];
}

/**
 * Render an audit as GitHub-flavoured Markdown for a job summary.
 *
 * The summary leads with the counts, because the number a reader wants first is
 * "did anything stop applying" - the `void` count - and NOT the number of files
 * Defold touched, which across a release is expected to be large.
 */
export function renderAuditSummary(rows, { revision, reviewed } = {}) {
  const byStatus = { [HOLDS]: [], [MOVED]: [], [VOID]: [] };
  for (const row of rows) (byStatus[row.status] ?? (byStatus[row.status] = [])).push(row);

  const lines = [];
  lines.push("## Reviewed-policy audit");
  lines.push("");
  if (revision) {
    lines.push(`Generated against Defold \`${revision}\`` +
      (reviewed && reviewed !== revision ? `, reviewed at \`${reviewed}\`.` : "."));
    lines.push("");
  }
  lines.push(`| | claims | meaning |`);
  lines.push(`| --- | ---: | --- |`);
  lines.push(`| holds | ${byStatus[HOLDS].length} | file unchanged since review |`);
  lines.push(`| moved | ${byStatus[MOVED].length} | file changed, every reviewed anchor still present - policy applies, pin restated |`);
  lines.push(`| void | ${byStatus[VOID].length} | reviewed anchor gone - policy withdrawn for this revision, re-review queued |`);
  lines.push("");

  if (byStatus[VOID].length) {
    lines.push("### Withdrawn for this revision");
    lines.push("");
    lines.push("These are the only entries that changed what was emitted. Each is a queued review.");
    lines.push("");
    for (const row of byStatus[VOID]) {
      lines.push(`- \`${row.id ?? row.input}\` — ${row.source ?? "?"} (${row.reason})`);
      for (const anchor of row.anchorsLost ?? []) lines.push(`  - lost anchor: \`${anchor}\``);
    }
    lines.push("");
  }

  if (byStatus[MOVED].length) {
    lines.push("<details><summary>Moved files (policy still applies)</summary>");
    lines.push("");
    for (const row of byStatus[MOVED]) {
      lines.push(`- \`${row.id ?? row.input}\` — ${row.source ?? "?"}`);
      lines.push(`  - reviewed \`${String(row.reviewedSha ?? "").slice(0, 12)}\` → observed \`${String(row.observed ?? "").slice(0, 12)}\``);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (!byStatus[VOID].length) {
    lines.push("No reviewed policy was withdrawn. Every entry applies to this revision.");
  }
  return `${lines.join("\n")}\n`;
}
