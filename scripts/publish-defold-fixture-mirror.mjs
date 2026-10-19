#!/usr/bin/env node

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { defoldFixtureCoordinates } from "./ensure-defold-fixture.mjs";
import { defoldLicenseAssets, fileSha256, publishDefoldMirror } from "./publish-defold-bob-mirror.mjs";

export async function publishDefoldFixtureMirror({ workspace, target, run, verifyDownload }) {
  const inputs = await Promise.all(["ref-doc", "defold-sdk"].map((kind) => defoldFixtureCoordinates(kind, workspace)));
  const expectedAssets = await defoldLicenseAssets(workspace);
  for (const input of inputs) {
    const actual = await fileSha256(input.file);
    if (actual !== input.sha256)
      throw new Error(`${input.asset} input digest mismatch: expected ${input.sha256}, got ${actual}`);
    const content = `${input.sha256}  ${input.asset}\n`;
    expectedAssets.push(
      { name: input.asset, file: input.file, digest: actual, size: (await stat(input.file)).size },
      {
        name: `${input.asset}.sha256`,
        content,
        digest: createHash("sha256").update(content).digest("hex"),
        size: Buffer.byteLength(content),
      },
    );
  }
  const notes = `Pinned Defold ${inputs[0].revision} contributor/CI test inputs. Consumer code generation uses policy objects and does not download these archives. Defold license and notices are attached.`;
  return publishDefoldMirror({
    tag: inputs[0].tag,
    target,
    expectedAssets,
    run,
    verifyDownload,
    title: `Defold test inputs ${inputs[0].revision.slice(0, 12)}`,
    notes,
    verifiedNotes: `${notes}\n\n${inputs.map((input) => `Verified public download ${input.asset} SHA-256: ${input.sha256}`).join("\n")}`,
    downloads: inputs.map((input) => ({ url: input.mirrorUrl, digest: input.sha256 })),
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const workspace = process.argv[process.argv.indexOf("--workspace") + 1];
  if (!process.argv.includes("--workspace") || !workspace)
    throw new Error("Usage: publish-defold-fixture-mirror.mjs --workspace <path>");
  console.log(await publishDefoldFixtureMirror({ workspace, target: process.env.GITHUB_SHA }));
}
