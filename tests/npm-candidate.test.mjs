import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import { assertRetainedNpmCandidate } from "../scripts/lib/npm-candidate.mjs";

const root = path.resolve(import.meta.dirname, "..");
const archive = path.join(root, "build/npm-release-candidate/deherm.tgz");
const proof = {
  kind: "deherm.npm-clean-consumer-proof",
  commit: "a".repeat(40),
  tarball: "build/npm-release-candidate/deherm.tgz",
  tarballSha256: "b".repeat(64),
  stages: ["packed", "archive-retained"],
};
const selected = { archive, commit: proof.commit, digest: proof.tarballSha256, repositoryRoot: root };

test("release candidate proof binds the exact retained tarball, source commit, and bytes", () => {
  assert.doesNotThrow(() => assertRetainedNpmCandidate(proof, selected));
  assert.throws(() => assertRetainedNpmCandidate({ ...proof, commit: "c".repeat(40) }, selected), /different commit/u);
  assert.throws(
    () => assertRetainedNpmCandidate({ ...proof, tarballSha256: "c".repeat(64) }, selected),
    /bytes differ/u,
  );
  assert.throws(() => assertRetainedNpmCandidate({ ...proof, tarball: "another.tgz" }, selected), /differs/u);
  assert.throws(() => assertRetainedNpmCandidate({ ...proof, stages: ["packed"] }, selected), /not retained/u);
});

test("release workflow gives Snake and the isolated consumer one packed archive", async () => {
  const workflow = YAML.parse(await readFile(path.join(root, ".github/workflows/npm-release-candidate.yml"), "utf8"));
  const steps = workflow.jobs["clean-consumer"].steps;
  const snake = steps.find((step) => step.name?.startsWith("Compile a real Snake"));
  const consumer = steps.find((step) => step.name?.startsWith("Prove tarball installation"));
  assert.match(snake.run, /require\("\.\/build\/npm-consumer-proof\.json"\)\.tarball/u);
  assert.match(consumer.run, /require\("\.\/build\/npm-consumer-proof\.json"\)\.tarball/u);
  assert.match(consumer.run, /prove-npm-consumer\.mjs --candidate "\$archive"/u);
  assert.doesNotMatch(snake.run, /0\.1\.0\.tgz/u);
});
