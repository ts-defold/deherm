import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { attachPublicSdkFacts, buildUniversalDmSdkBindings } from "../scripts/generate-dmsdk-universal-bindings.mjs";
import { createDefoldSdkExtractionManifest } from "../scripts/lib/defold-sdk-extraction-manifest.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";
const archiveSha256 = "ab".repeat(32);
const recipe = Object.freeze({
  declarationId: "dmsdk:Visible",
  include: "dmsdk/test.h",
  invocation: { kind: "direct-function", nativeSymbol: "Visible", member: null },
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-public-sdk-"));
  const sdkRoot = path.join(root, "upstream", "extender", "server", "app", "sdk", revision, "defoldsdk");
  await Promise.all([
    mkdir(path.join(sdkRoot, "sdk", "include", "dmsdk"), { recursive: true }),
    mkdir(path.join(sdkRoot, "include"), { recursive: true }),
    mkdir(path.join(sdkRoot, "ext", "include"), { recursive: true }),
  ]);
  await writeFile(
    path.join(root, "upstream.lock"),
    [
      `DEFOLD_REV=${revision}`,
      `DEFOLD_SDK_URL=https://d.defold.com/archive/${revision}/engine/defoldsdk.zip`,
      `DEFOLD_SDK_SHA256=${archiveSha256}`,
      "",
    ].join("\n"),
  );
  return { root, sdkRoot };
}

async function authenticateExtraction(sdkRoot, manifestArchiveSha256 = archiveSha256) {
  const manifest = await createDefoldSdkExtractionManifest({ sdkRoot, archiveSha256: manifestArchiveSha256 });
  await writeFile(path.join(sdkRoot, ".deherm-sdk-sha256"), `${archiveSha256}\n`);
  return manifest;
}

test("public SDK facts require a digest-authenticated complete extraction", async () => {
  const { root, sdkRoot } = await fixture();
  try {
    await writeFile(path.join(sdkRoot, "sdk", "include", "dmsdk", "test.h"), "void Visible();\n");
    await assert.rejects(attachPublicSdkFacts(root, revision, [recipe]), /no readable digest sentinel/u);
    await writeFile(path.join(sdkRoot, ".deherm-sdk-sha256"), `${"cd".repeat(32)}\n`);
    await assert.rejects(attachPublicSdkFacts(root, revision, [recipe]), /extraction digest is .* expected/u);
    await writeFile(path.join(sdkRoot, ".deherm-sdk-sha256"), `${archiveSha256}\n`);
    await assert.rejects(attachPublicSdkFacts(root, revision, [recipe]), /no readable archive manifest/u);
    await createDefoldSdkExtractionManifest({ sdkRoot, archiveSha256 });
    await rm(path.join(sdkRoot, "sdk", "include"), { recursive: true });
    await assert.rejects(attachPublicSdkFacts(root, revision, [recipe]), /missing public include root/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an authenticated SDK records an absent recipe header as an explicit negative fact", async () => {
  const { root, sdkRoot } = await fixture();
  try {
    await authenticateExtraction(sdkRoot);
    const result = await attachPublicSdkFacts(root, revision, [recipe]);
    assert.deepEqual(result.recipes[0].publicSdk, {
      header: "dmsdk/test.h",
      callable: false,
      reason: "public-sdk-header-absent",
    });
    assert.deepEqual(result.provenance.requiredHeaders, [{ header: "dmsdk/test.h", state: "absent" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-ENOENT recipe-header read failure aborts instead of becoming negative evidence", async () => {
  const { root, sdkRoot } = await fixture();
  try {
    await authenticateExtraction(sdkRoot);
    await mkdir(path.join(sdkRoot, "sdk", "include", "dmsdk", "test.h"));
    await assert.rejects(attachPublicSdkFacts(root, revision, [recipe]), /no readable required header dmsdk\/test\.h/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a present archive member deleted from the SDK cache is not misclassified as absent", async () => {
  const { root, sdkRoot } = await fixture();
  const header = path.join(sdkRoot, "sdk", "include", "dmsdk", "test.h");
  try {
    await writeFile(header, "void Visible();\n");
    await authenticateExtraction(sdkRoot);
    await rm(header);
    await assert.rejects(attachPublicSdkFacts(root, revision, [recipe]), /cache deleted archive member sdk\/include\/dmsdk\/test\.h/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a present archive member modified in the SDK cache is rejected", async () => {
  const { root, sdkRoot } = await fixture();
  const header = path.join(sdkRoot, "sdk", "include", "dmsdk", "test.h");
  try {
    await writeFile(header, "void Visible();\n");
    await authenticateExtraction(sdkRoot);
    await writeFile(header, "void Changed();\n");
    await assert.rejects(attachPublicSdkFacts(root, revision, [recipe]), /cache modified archive member sdk\/include\/dmsdk\/test\.h/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the extraction manifest must authenticate the pinned archive digest", async () => {
  const { root, sdkRoot } = await fixture();
  try {
    await createDefoldSdkExtractionManifest({ sdkRoot, archiveSha256: "cd".repeat(32) });
    await writeFile(path.join(sdkRoot, ".deherm-sdk-sha256"), `${archiveSha256}\n`);
    await assert.rejects(attachPublicSdkFacts(root, revision, [recipe]), /manifest authenticates archive .* expected/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public SDK facts carry revision, archive, and consumed-header provenance", async () => {
  const { root, sdkRoot } = await fixture();
  try {
    await writeFile(path.join(sdkRoot, "sdk", "include", "dmsdk", "test.h"), "void Visible();\n");
    await authenticateExtraction(sdkRoot);
    const result = await attachPublicSdkFacts(root, revision, [recipe]);
    assert.deepEqual(result.recipes[0].publicSdk, {
      header: "dmsdk/test.h",
      callable: true,
      reason: "public-sdk-declaration-visible",
    });
    assert.equal(result.provenance.revision, revision);
    assert.equal(result.provenance.archiveSha256, archiveSha256);
    assert.equal(result.provenance.archiveUrl, `https://d.defold.com/archive/${revision}/engine/defoldsdk.zip`);
    assert.equal(result.provenance.requiredHeaderCount, 1);
    assert.deepEqual(result.provenance.requiredHeaders, [
      {
        header: "dmsdk/test.h",
        state: "present",
        sha256: "15e51088c99cc145f4bf4d3e63c07bcc500bdad0e417148c30f77545819cb9a2",
      },
    ]);
    assert.match(result.provenance.requiredHeadersSha256, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the universal report source provenance authenticates the consumed SDK extraction", async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), "deherm-public-sdk-report-"));
  try {
    const report = await buildUniversalDmSdkBindings({ outRoot });
    assert.equal(report.sourceHashes.publicSdk.revision, report.defoldRevision);
    assert.equal(report.sourceHashes.publicSdk.archiveSha256.length, 64);
    assert.ok(report.sourceHashes.publicSdk.requiredHeaderCount > 0);
    assert.equal(
      report.sourceHashes.publicSdk.requiredHeaders.length,
      report.sourceHashes.publicSdk.requiredHeaderCount,
    );
    assert.equal(report.sourceHashes.publicSdk.requiredHeadersSha256.length, 64);
    assert.equal(report.sourceHashes.aggregate.length, 64);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});
