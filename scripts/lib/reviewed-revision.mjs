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
//     SHA-256 and anchors of every cited Defold source file, the expected route
//     and feature censuses, the membership of every reviewed route id in the
//     mechanically discovered one. Those run unchanged and are strictly
//     stronger than a string comparison: they read that revision's bytes.
//
// A revision whose declared surface did not move therefore derives cleanly and
// says so; one that moved fails on the substance, which is the failure a
// reviewer wants, rather than on a string that says nothing about what changed.

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

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

  const ledger = env[CARRIED_REVIEW_LEDGER_ENV];
  if (!ledger) {
    throw new Error(
      `${input}: carrying a review from ${reviewed} to ${derived} requires ` +
      `${CARRIED_REVIEW_LEDGER_ENV}, so the carry can be reported. It is not set.`
    );
  }
  const record = { input, reviewed, derived, ...(detail ? { detail } : {}) };
  appendFileSync(ledger, `${JSON.stringify(record)}\n`);
  return { carried: true, ...record };
}

/**
 * A reviewed input's claim about ONE Defold source file, checked correctly.
 *
 * The rule the generators had was `assert.equal(sha256(source), pinned)`, which
 * demands the file be byte-identical to when it was read. Across revisions that
 * can only fail: we are the authoritative generator, and Defold editing its own
 * source between 1.13.0 and 1.13.1 is the expected outcome, not an error. Worse,
 * the SHA was asserted BEFORE the anchors, so the check that carries the actual
 * evidence never ran.
 *
 * The two records answer different questions. `anchors` are the exact text the
 * reviewer's conclusion rests on - for box2d-body, the instance-generation field
 * and the validity guard. `sha256` only detects that the file moved at all.
 * Losing an anchor means the review is void. A changed hash with every anchor
 * intact means the review's subject survived and its surroundings moved, which
 * is not a reason to refuse.
 *
 * So anchors are unconditional, and the hash is a detector whose meaning depends
 * on what is being generated:
 *
 *   * generating for the reviewed revision - a drift is real staleness in this
 *     tree and stays a hard failure, which is what `pnpm check` relies on;
 *   * deriving a declared different revision - a drift is recorded to the carry
 *     ledger and reported, because that is the census the job exists to produce.
 */
export function assertReviewedSource({ input, id, source, evidence, reviewed, derived, env = process.env }) {
  const lost = (evidence.anchors ?? []).filter((anchor) => !source.includes(anchor));
  if (lost.length) {
    throw new Error(
      `${input}: ${id} no longer holds at ${derived}. ` +
      `${lost.length} of ${evidence.anchors.length} reviewed anchors are gone from ` +
      `${evidence.source}:\n  ${lost.join("\n  ")}\n` +
      "The review rested on those lines, so it cannot speak for this revision. Re-review it.");
  }

  const observed = createHash("sha256").update(source).digest("hex");
  if (observed === evidence.sha256) return { drifted: false, id, observed };

  const derivation = declaredDerivation(env);
  if (derivation !== derived || reviewed === derived) {
    throw new Error(
      `${input}: ${id} source hash drifted for ${evidence.source}\n` +
      `  reviewed ${evidence.sha256}\n  observed ${observed}\n` +
      "Every reviewed anchor still holds, so the review's subject survived; the pinned hash " +
      "is stale. Update it, or derive another revision with scripts/derive-revision.mjs.");
  }

  const ledger = env[CARRIED_REVIEW_LEDGER_ENV];
  if (!ledger) {
    throw new Error(`${input}: ${id} drifted while deriving ${derived}, but ${CARRIED_REVIEW_LEDGER_ENV} is not set to record it.`);
  }
  appendFileSync(ledger, `${JSON.stringify({
    input, id, source: evidence.source, reviewed: evidence.sha256, observed, derived,
    anchorsHeld: (evidence.anchors ?? []).length
  })}\n`);
  return { drifted: true, id, observed };
}
