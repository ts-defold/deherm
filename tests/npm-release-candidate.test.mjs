import assert from "node:assert/strict";
import test from "node:test";

import { assertNpmReleaseCandidateEvidence } from "../scripts/check-npm-release-candidate.mjs";

const commit = "a".repeat(40);
const version = "1.2.3";
const tarballSha256 = "b".repeat(64);
const bundles = [{ target: "wasm-web" }, { target: "x86_64-linux" }];
const consumer = {
  kind: "deherm.npm-clean-consumer-proof",
  commit,
  version,
  sourceClean: true,
  tarball: "build/npm-release-candidate/deherm.tgz",
  tarballSha256,
  bundles,
  stages: ["bob-bundled"],
};
const snake = { kind: "deherm.npm-snake-consumer-proof", tarballSha256, bundles, stages: ["bob-bundled"] };

test("release evidence accepts two isolated builds of one exact candidate", () => {
  const result = assertNpmReleaseCandidateEvidence({ consumer, snake, commit, version });
  assert.equal(result.tarballSha256, tarballSha256);
  assert.deepEqual(result.targets, ["wasm-web", "x86_64-linux"]);
});

test("release evidence rejects stale commits, differing archives, and incomplete target proof", () => {
  const evidence = (overrides = {}) => ({ consumer, snake, commit, version, ...overrides });
  assert.throws(
    () => assertNpmReleaseCandidateEvidence(evidence({ commit: "c".repeat(40) })),
    /different source commit/u,
  );
  assert.throws(
    () => assertNpmReleaseCandidateEvidence(evidence({ snake: { ...snake, tarballSha256: "c".repeat(64) } })),
    /different archives/u,
  );
  assert.throws(
    () => assertNpmReleaseCandidateEvidence(evidence({ snake: { ...snake, bundles: bundles.slice(0, 1) } })),
    /both targets/u,
  );
  assert.throws(
    () => assertNpmReleaseCandidateEvidence(evidence({ consumer: { ...consumer, sourceClean: false } })),
    /dirty/u,
  );
});
