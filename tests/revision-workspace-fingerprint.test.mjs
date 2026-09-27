import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRevisionWorkspace } from "../scripts/check-defold-revision-matrix.mjs";
import {
  makeRevisionWorkspaceMetadata,
  revisionProducerInputIdentity,
  writeRevisionWorkspaceMetadata
} from "../scripts/lib/revision-workspace-metadata.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";
const policyRoot = "a".repeat(64);
const packageVersion = "0.1.0";
const producerInput = Object.freeze({ algorithm: "sha256", sha256: "b".repeat(64), fileCount: 3 });
const lane = Object.freeze({ id: "historical", revision });

async function writeWorkspace(workspace, input = producerInput, compilerVersion = packageVersion) {
  const manifest = path.join(workspace, "packages/bindings/generated/defold-api-policy.json");
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, `${JSON.stringify({ defoldRevision: revision, policyRoot })}\n`);
  await writeRevisionWorkspaceMetadata(workspace, makeRevisionWorkspaceMetadata({
    revision, producerInput: input, packageVersion: compilerVersion, policyRoot, generator: { version: 1 }
  }));
}

test("producer input identity covers working-tree edits, additions, deletions, and symlink targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-producer-input-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  await symlink("first-target", path.join(root, "tracked-link"));
  execFileSync("git", ["add", ".gitignore", "tracked.txt", "tracked-link"], { cwd: root });

  const first = await revisionProducerInputIdentity(root);
  assert.deepEqual(await revisionProducerInputIdentity(root), first);

  await writeFile(path.join(root, "tracked.txt"), "two\n");
  const edited = await revisionProducerInputIdentity(root);
  assert.notEqual(edited.sha256, first.sha256);

  await writeFile(path.join(root, "new-generator.mjs"), "export {};\n");
  const added = await revisionProducerInputIdentity(root);
  assert.notEqual(added.sha256, edited.sha256);
  assert.equal(added.fileCount, edited.fileCount + 1);

  await rm(path.join(root, "tracked.txt"));
  const deleted = await revisionProducerInputIdentity(root);
  assert.notEqual(deleted.sha256, added.sha256);
  assert.equal(deleted.fileCount, added.fileCount);

  await rm(path.join(root, "tracked-link"));
  await symlink("second-target", path.join(root, "tracked-link"));
  const retargeted = await revisionProducerInputIdentity(root);
  assert.notEqual(retargeted.sha256, deleted.sha256);

  await writeFile(path.join(root, "ignored.txt"), "not an input\n");
  assert.deepEqual(await revisionProducerInputIdentity(root), retargeted);
});

test("a current historical workspace is reused only with its exact producer identity", async () => {
  const boundary = await mkdtemp(path.join(tmpdir(), "deherm-matrix-current-"));
  const workspace = path.join(boundary, "lane");
  await writeWorkspace(workspace);
  let called = false;
  const result = await ensureRevisionWorkspace(lane, workspace, {
    deriveMissing: true,
    producerInput,
    packageVersion,
    workspaceBoundary: boundary,
    derive: async () => { called = true; }
  });
  assert.deepEqual(result, { derived: false, reason: null });
  assert.equal(called, false);
});

test("a stale producer fingerprint is rejected unless derivation is requested", async () => {
  const boundary = await mkdtemp(path.join(tmpdir(), "deherm-matrix-reject-"));
  const workspace = path.join(boundary, "lane");
  await writeWorkspace(workspace, { ...producerInput, sha256: "c".repeat(64) });
  await assert.rejects(ensureRevisionWorkspace(lane, workspace, {
    deriveMissing: false, producerInput, packageVersion, workspaceBoundary: boundary
  }), /producer input fingerprint is stale.*--derive-missing/u);
});

test("a mismatched package/compiler identity cannot reuse an otherwise matching tree", async () => {
  const boundary = await mkdtemp(path.join(tmpdir(), "deherm-matrix-compiler-"));
  const workspace = path.join(boundary, "lane");
  await writeWorkspace(workspace, producerInput, "0.0.0-stale");
  await assert.rejects(ensureRevisionWorkspace(lane, workspace, {
    deriveMissing: false, producerInput, packageVersion, workspaceBoundary: boundary
  }), /current compiler identity is stale/u);
});

test("derive-missing replaces a stale lane and verifies the fresh metadata before reuse", async () => {
  const boundary = await mkdtemp(path.join(tmpdir(), "deherm-matrix-refresh-"));
  const workspace = path.join(boundary, "lane");
  await writeWorkspace(workspace, { ...producerInput, sha256: "d".repeat(64) });
  await writeFile(path.join(workspace, "stale-marker"), "old\n");
  const result = await ensureRevisionWorkspace(lane, workspace, {
    deriveMissing: true,
    producerInput,
    packageVersion,
    workspaceBoundary: boundary,
    derive: async (_lane, destination) => {
      await assert.rejects(readFile(path.join(destination, "stale-marker")), /ENOENT/u);
      await writeWorkspace(destination);
    }
  });
  assert.equal(result.derived, true);
  assert.equal(result.reason, "producer input fingerprint is stale");
});

test("a derivation callback cannot bless a workspace without matching metadata", async () => {
  const boundary = await mkdtemp(path.join(tmpdir(), "deherm-matrix-invalid-"));
  const workspace = path.join(boundary, "lane");
  await assert.rejects(ensureRevisionWorkspace(lane, workspace, {
    deriveMissing: true,
    producerInput,
    packageVersion,
    workspaceBoundary: boundary,
    derive: async (_lane, destination) => {
      const manifest = path.join(destination, "packages/bindings/generated/defold-api-policy.json");
      await mkdir(path.dirname(manifest), { recursive: true });
      await writeFile(manifest, `${JSON.stringify({ defoldRevision: revision, policyRoot })}\n`);
    }
  }), /fresh derivation produced a stale workspace \(derivation metadata is missing\)/u);
});
