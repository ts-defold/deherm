// What every reviewed input claims about the pinned Defold sources, in one list.
//
// A hand-authored policy under `packages/bindings/overrides/` records, for each
// Defold source file it was reviewed against, that file's SHA-256 and the exact
// text anchors the review depends on. Each consuming generator re-checks its own
// claims and stops at the first that fails, which is right for generation and
// useless for deciding whether a NEW revision can be derived at all: it reports
// one moved file and says nothing about the other forty.
//
// This module reads those claims without running any generator, so a derivation
// can say up front, for one revision, exactly which reviews still hold and which
// do not. That list is the queue of real review work
// `.agents/docs/decisions/layered-api-policy-cache.md` calls the load-bearing
// part - "refusals are what stops a later generation from guessing".
//
// The shape is discovered rather than enumerated per file: a reviewed claim is
// any object carrying a `sha256` beside a `path` or a `source`. New reviewed
// inputs therefore join this census by being written in the shape every existing
// one already uses, instead of by being added to a list somebody must remember.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const OVERRIDES = "packages/bindings/overrides";
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Where a reviewed claim's path points, relative to the repository root. */
export function evidencePath(value) {
  const normalized = String(value).replaceAll("\\", "/");
  if (normalized.split("/").includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`Reviewed evidence path escapes the repository: ${value}`);
  }
  return normalized.startsWith("upstream/") ? normalized : `upstream/defold/${normalized}`;
}

/** Every `{file, path, sha256, anchors}` claim a reviewed input makes. */
export function reviewedClaims(input, document) {
  const claims = [];
  const visit = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${trail}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const target = node.path ?? node.source;
    if (SHA256.test(node.sha256 ?? "") && typeof target === "string") {
      claims.push({
        input,
        at: trail,
        id: node.id ?? node.key ?? null,
        file: evidencePath(target),
        sha256: node.sha256,
        anchors: Array.isArray(node.anchors) ? node.anchors : []
      });
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${trail}.${key}`);
  };
  visit(document, "");
  return claims;
}

/**
 * Check every reviewed claim in a tree against the Defold checkout it holds.
 *
 * `holds` is a claim whose file is present, hashes to what the review recorded
 * and still contains every anchor. Anything else is reported with the reason,
 * and is a review that has to be redone before this revision can be derived.
 */
export async function auditReviewedEvidence(treeRoot) {
  const directory = path.join(treeRoot, OVERRIDES);
  const inputs = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const cache = new Map();
  const holds = [];
  const drifted = [];
  for (const name of inputs) {
    const input = `${OVERRIDES}/${name}`;
    const document = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    for (const claim of reviewedClaims(input, document)) {
      let text = cache.get(claim.file);
      if (text === undefined) {
        text = await readFile(path.join(treeRoot, claim.file), "utf8").catch(() => null);
        cache.set(claim.file, text);
      }
      if (text === null) {
        drifted.push({ ...claim, reason: "absent", observed: null });
        continue;
      }
      const observed = sha256(text);
      if (observed !== claim.sha256) {
        // An anchor that still holds in a moved file is worth reporting: it says
        // the review's subject survived and only its surroundings changed, which
        // is a much smaller re-review than one whose anchors are gone too.
        const surviving = claim.anchors.filter((anchor) => text.includes(anchor));
        drifted.push({
          ...claim,
          reason: "content",
          observed,
          anchorsHeld: surviving.length,
          anchorsLost: claim.anchors.filter((anchor) => !text.includes(anchor))
        });
        continue;
      }
      const lost = claim.anchors.filter((anchor) => !text.includes(anchor));
      if (lost.length) {
        drifted.push({ ...claim, reason: "anchor", observed, anchorsHeld: claim.anchors.length - lost.length, anchorsLost: lost });
        continue;
      }
      holds.push(claim);
    }
  }
  const byInput = {};
  for (const row of drifted) byInput[row.input] = (byInput[row.input] ?? 0) + 1;
  return {
    inputCount: inputs.length,
    claimCount: holds.length + drifted.length,
    fileCount: cache.size,
    holds,
    drifted,
    driftedByInput: Object.fromEntries(Object.entries(byInput).sort(([left], [right]) => left < right ? -1 : 1))
  };
}
