import assert from "node:assert/strict";
import path from "node:path";

export function assertRetainedNpmCandidate(proof, { archive, commit, digest, repositoryRoot }) {
  assert.equal(proof?.kind, "deherm.npm-clean-consumer-proof", "candidate has no pack-only proof");
  assert.ok(proof.stages?.includes("archive-retained"), "candidate was not retained by the pack stage");
  assert.equal(proof.commit, commit, "candidate was packed from a different commit");
  assert.equal(
    path.resolve(repositoryRoot, proof.tarball),
    path.resolve(archive),
    "candidate differs from the packed proof",
  );
  assert.equal(proof.tarballSha256, digest, "candidate tarball bytes differ from the packed proof");
}
