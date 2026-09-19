// Reviewed inputs, and the revision their review was performed against.
//
// A hand-authored policy under `packages/bindings/overrides/` is *reviewed
// evidence*: a person read the engine's C source at one Defold revision and
// wrote down what they found. Every such file therefore names the revision it
// was reviewed against, and every generator that consumes one has always
// refused to generate for a different revision.
//
// That refusal is correct for ordinary generation and it is what `pnpm check`
// relies on. It is also what made deriving *another* revision impossible: the
// nightly repins `upstream.lock`, regenerates the surface, and the first
// generator to read a reviewed override refuses, because the override still
// names the pinned revision. See `.agents/docs/decisions/layered-api-policy-cache.md`
// ("The nightly job").
//
// ── What this module changes, and what it deliberately does not ────────────
//
// It does not delete the comparison and it does not compare against something
// weaker. The comparison is still "the reviewed revision against the revision
// BEING GENERATED", and in every ordinary generation an inequality is still a
// hard failure with both revisions named.
//
// The one thing it adds is that a *declared derivation* of one named revision -
// `scripts/derive-revision.mjs`, which works in a scratch workspace and never
// in the committed tree - may CARRY a review forward, and carrying is:
//
//   * opt-in, per invocation (`--carry-reviews`);
//   * scoped to exactly one revision, named in the environment, so a stale
//     export cannot silently license a different derivation;
//   * recorded, to a ledger the derivation reports and a reviewer reads; and
//   * never a substitute for the substantive checks. Each of these generators
//     re-verifies its reviewed input against the revision being derived - the
//     anchors of every cited Defold source file, the expected route and feature
//     censuses, the membership of every reviewed route id in the mechanically
//     discovered one. Those run unchanged and are strictly stronger than a
//     string comparison: they read that revision's bytes.
//
// ── What a moved source file is, and is not ────────────────────────────────
//
// It is NOT a failure. A cited Defold file whose bytes changed is the ordinary
// outcome of a Defold release, and generating for that change is this project's
// entire job. A changed hash means a new policy entry for that revision, so we
// know how to emit code for it and can add, remove or swap an entry per
// version. It never blocks a release. `observeReviewedSource` below therefore
// classifies and reports rather than throwing, and `scripts/lib/revision-audit.mjs`
// explains the three classifications and what each does to what we emit.

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { MOVED, VOID, classifyReviewedSource, recordAudit } from "./revision-audit.mjs";

const REVISION = /^[0-9a-f]{40}$/;

/** The revision a declared derivation is deriving, if this process is inside one. */
export const DERIVED_REVISION_ENV = "DEHERM_DERIVED_REVISION";

/** Where a carried review is recorded. A carry with nowhere to be recorded is refused. */
export const CARRIED_REVIEW_LEDGER_ENV = "DEHERM_CARRIED_REVIEW_LEDGER";

export function isDefoldRevision(value) {
  return typeof value === "string" && REVISION.test(value);
}

/**
 * The revision this process was told it is deriving, or null for an ordinary
 * generation. A malformed value is an error rather than a silent "not deriving":
 * "nothing to carry" and "could not tell" must not look the same.
 */
export function declaredDerivation(env = process.env) {
  const value = env[DERIVED_REVISION_ENV];
  if (value === undefined || value === "") return null;
  if (!isDefoldRevision(value)) {
    throw new Error(`${DERIVED_REVISION_ENV} is not a Defold revision: ${value}`);
  }
  return value;
}

/**
 * Assert that a reviewed input speaks for the revision being generated.
 *
 * @param {object} options
 * @param {string} options.input      repository-relative path of the reviewed file
 * @param {string} options.reviewed   the revision the file says it was reviewed against
 * @param {string} options.derived    the revision being generated, taken from a DERIVED
 *                                    input (the imported IR, or `upstream.lock`) and never
 *                                    from the reviewed file itself
 * @param {string} [options.detail]   what the reviewed file decides, for the message
 * @returns {{carried: boolean, input: string, reviewed: string, derived: string}}
 */
export function assertReviewedRevision({ input, reviewed, derived, detail, env = process.env }) {
  if (!isDefoldRevision(derived)) {
    throw new Error(`${input}: the revision being generated is not a Defold revision: ${derived}`);
  }
  if (!isDefoldRevision(reviewed)) {
    throw new Error(`${input}: does not name the Defold revision it was reviewed against: ${reviewed}`);
  }
  if (reviewed === derived) return { carried: false, input, reviewed, derived };

  const derivation = declaredDerivation(env);
  if (derivation !== derived) {
    throw new Error(
      `${input} was reviewed against Defold ${reviewed}, but ${derived} is being generated` +
      (detail ? ` (${detail})` : "") + ".\n" +
      "A reviewed input speaks only for the revision it was read at. Re-review it against the " +
      "revision being generated, or derive that revision with " +
      `"node scripts/derive-revision.mjs --revision ${derived} --carry-reviews", which derives ` +
      "into a scratch workspace and records every carried review for a reviewer."
    );
  }

  // The carry is recorded, always - to the ledger when a derivation named one,
  // and to the revision audit regardless. An unset ledger used to be fatal here,
  // which made the reporting mechanism itself into a gate. A carry that cannot
  // be written to the ledger is a thinner report, not a failed derivation.
  const record = { input, reviewed, derived, ...(detail ? { detail } : {}) };
  const ledger = env[CARRIED_REVIEW_LEDGER_ENV];
  if (ledger) {
    try {
      appendFileSync(ledger, `${JSON.stringify(record)}\n`);
    } catch {
      // See above.
    }
  }
  recordAudit({ ...record, id: input, status: "carried", reason: "revision" }, env);
  return { carried: true, ...record };
}

/**
 * A reviewed input's claim about ONE Defold source file, observed.
 *
 * This used to be an assertion: `sha256(source) === evidence.sha256`, or throw.
 * It is not one any more, and the reason is the whole design of this project.
 *
 * We are the authoritative generator for what changes between Defold revisions.
 * Defold editing its own C++ between 1.13.0 and 1.13.1 is the input to that
 * job, not a failure of it. A changed source hash is a NEW POLICY ENTRY for
 * that revision - so we know how to emit code for it, and so an entry can be
 * added, removed or swapped per version - and it never blocks a release.
 *
 * What the two records mean is unchanged, and it is worth restating because the
 * old code had them backwards. `anchors` are the exact text the reviewer's
 * conclusion rests on. `sha256` only detects that the file moved at all. The
 * old code asserted the hash BEFORE the anchors, so the record carrying the
 * actual evidence never ran: any Defold revision that touched anything in the
 * file aborted first.
 *
 * So: this classifies, records an audit line, and returns. It does not throw.
 * The caller reads `status` and decides what to emit:
 *
 *   holds / moved - the reviewed entry applies to this revision. `moved` also
 *                   carries the observed hash so the pin can be restated.
 *   void          - an anchor is gone, so the evidence for emitting is gone.
 *                   The caller withdraws that entry for this revision and the
 *                   affected routes degrade to unreviewed. That is a policy
 *                   difference between revisions, reported by name in the CI
 *                   summary as queued review work - not a build failure.
 *
 * @returns {{status: string, reason: string, observed: string|null,
 *            anchorsHeld: number, anchorsLost: string[], id: string}}
 */
export function observeReviewedSource({ input, id, source, evidence, reviewed, derived, env = process.env }) {
  const verdict = classifyReviewedSource(source, evidence);
  // Every observation is recorded, `holds` included. An audit that only carried
  // what moved could report "3 moved" without the denominator that makes 3
  // readable, and could not tell "nothing moved" apart from "nothing ran".
  {
    recordAudit({
      input,
      id,
      source: evidence.source ?? evidence.path ?? null,
      status: verdict.status,
      reason: verdict.reason,
      reviewedSha: evidence.sha256,
      observed: verdict.observed,
      anchorsHeld: verdict.anchorsHeld,
      anchorsLost: verdict.anchorsLost,
      reviewed,
      derived
    }, env);
  }
  return { ...verdict, id };
}

/**
 * Load every Defold source a reviewed input cites, tolerating the ones that are
 * not there.
 *
 * A generator that opens each cited path with a bare `readFile` dies with ENOENT
 * on the first source a revision does not have - which for Defold 1.13.1 is the
 * whole `bullet3d` backend, present on `dev` and absent from stable. That is not
 * a broken generator or a broken review; it is a backend that revision did not
 * ship, and the right response is to withdraw the entries resting on it and
 * carry on.
 *
 * Returns the texts that loaded, and the set of cited paths that are withdrawn
 * for this revision - absent, or present with a reviewed anchor gone. Callers
 * drop the routes those paths support. Every outcome is audited.
 *
 * @param {object} options
 * @param {string} options.input     repository-relative path of the reviewed file
 * @param {string} options.defoldRoot  path to `upstream/defold`
 * @param {Array<{path?: string, source?: string, sha256: string, anchors?: string[]}>} options.evidence
 * @returns {Promise<{texts: Map<string, string>, withdrawn: Set<string>, verdicts: object[]}>}
 */
export async function loadReviewedSources({ input, defoldRoot, evidence, reviewed, derived, env = process.env }) {
  const texts = new Map();
  const withdrawn = new Set();
  const verdicts = [];
  for (const record of evidence) {
    const relative = record.path ?? record.source;
    const text = await readFile(join(defoldRoot, relative), "utf8").catch(() => null);
    const verdict = observeReviewedSource({
      input, id: `${relative}`, source: text, evidence: record, reviewed, derived, env
    });
    verdicts.push(verdict);
    if (verdict.status === VOID) withdrawn.add(relative);
    else texts.set(relative, text);
  }
  return { texts, withdrawn, verdicts };
}

/**
 * A reviewed census count, checked where it means something.
 *
 * A reviewed input records expectations like "there are 145 registered
 * box2d-v2 routes", and generators carry the same shape as bare literals -
 * `if (bindings.length !== 90)`. Those numbers are evidence: a person counted
 * them at one revision.
 *
 * In an ORDINARY generation a disagreement is a real regression in this tree
 * and stays a hard failure. It is most of what `pnpm check` is for, and nothing
 * here weakens it.
 *
 * Inside a DECLARED DERIVATION of another revision the same comparison says
 * only that Defold changed, which is the thing the derivation exists to
 * measure. Asserting it there turned every engine change into a refusal:
 * deriving 1.13.1 stopped at "Expected 90 scalar bindings, got 117", where 117
 * is not an error but the answer. So there the count becomes an observation and
 * the difference is reported.
 *
 * The derivation is declared in the environment rather than inferred from a
 * policy field, because most reviewed inputs do not carry a revision and the
 * one place that does know is the process that set out to derive.
 *
 * @returns {{agreed: boolean, expected: number, observed: number}}
 */
export function expectReviewedCount({ input, label, expected, observed, env = process.env }) {
  if (expected === observed) return { agreed: true, expected, observed };
  const derived = declaredDerivation(env);
  if (!derived) {
    throw new Error(
      `${input}: ${label} expected ${expected}, found ${observed}. ` +
      "This is an ordinary generation, so nothing about Defold moved and this is a regression in this tree."
    );
  }
  recordAudit({ input, id: label, status: MOVED, reason: "census", expected, observed, derived }, env);
  return { agreed: false, expected, observed };
}

/**
 * Two derived artifacts, checked to describe the SAME Defold revision.
 *
 * ── Why this one stays fatal, inside a derivation as well as outside ───────
 *
 * Every other pinned assumption in this module is demoted when a derivation is
 * declared, because it compares a REVIEW against a revision and a difference
 * there is the measurement. This one is not that. It compares two artifacts
 * this repository derived, and a difference says they describe different
 * revisions of Defold. Joining them - accounting rows from one revision onto an
 * IR from another - does not produce a degraded surface, it produces a wrong
 * one, stamped with whichever revision the generator happened to read first.
 *
 * Inside a derivation such a mismatch is not a property of Defold at all. The
 * chain runs in the order `scriptGenerationSteps` declares, which is a
 * topological order: by the time a step runs, everything it consumes has
 * already regenerated. So a stamp that still names the pinned revision means
 * exactly one thing - the step that writes it REFUSED earlier in this same run -
 * and that refusal is already reported by name. Continuing here would bury the
 * real refusal under a pile of derived nonsense and put a corrupt surface in
 * front of `--adopt`.
 *
 * What was wrong with it was the message. "inputs use different Defold
 * revisions" tells a reader neither which input disagrees nor that the fix is
 * somewhere else entirely. So this names each artifact and its stamp, and says
 * where to look.
 *
 * @param {object} options
 * @param {string} options.label    what the generator is producing, for the message
 * @param {Array<{path: string, revision: string}>} options.inputs
 *        every derived input, in the order the generator reads them. The first
 *        is treated as the revision being generated.
 */
export function expectSameRevision({ label, inputs }) {
  const [reference, ...rest] = inputs;
  const disagreeing = rest.filter(({ revision }) => revision !== reference.revision);
  if (!disagreeing.length) return reference.revision;
  throw new Error(
    `${label} inputs use different Defold revisions.\n` +
    `  ${reference.path}: ${reference.revision}\n` +
    disagreeing.map(({ path, revision }) => `  ${path}: ${revision}`).join("\n") + "\n" +
    "These are artifacts this repository derives, not reviews: one describes a different " +
    "Defold revision from the other, and emitting a surface from both would join rows " +
    "across revisions. Inside a declared derivation the chain regenerates in dependency " +
    "order, so a stamp naming the wrong revision means the step that writes it refused " +
    "earlier in this run - fix that refusal rather than this comparison."
  );
}
