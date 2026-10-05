import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const pinnedSdkRoot = path.join(
  repositoryRoot,
  "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk",
);
export const cxx = process.env.CXX || "clang++";
export const cc = process.env.CC || "clang";

export function run(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
}

export function sdkIncludeArgs(...extra) {
  return [
    `-I${path.join(repositoryRoot, "defold/defold_hermes/include")}`,
    "-isystem",
    path.join(pinnedSdkRoot, "sdk/include"),
    "-isystem",
    path.join(pinnedSdkRoot, "include"),
    ...extra,
  ];
}

export async function generateAndCompareFamily({ generator, report, tempPrefix }) {
  const output = await mkdtemp(path.join(tmpdir(), tempPrefix));
  try {
    run(process.execPath, [generator, "--out-root", output]);
    const current = JSON.parse(await readFile(path.join(repositoryRoot, report), "utf8"));
    for (const artifact of [...current.artifacts, report]) {
      assert.equal(
        await readFile(path.join(output, artifact), "utf8"),
        await readFile(path.join(repositoryRoot, artifact), "utf8"),
        artifact,
      );
    }
    run(process.execPath, [generator, "--out-root", output, "--check"]);
    return current;
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

export async function assertMixedIrProvenanceRejected({ generator, tempPrefix }) {
  const output = await mkdtemp(path.join(tmpdir(), tempPrefix));
  try {
    const irPath = path.join(output, "ir.json");
    await writeFile(
      irPath,
      `${await readFile(path.join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8")}\n`,
    );
    assert.throws(
      () => run(process.execPath, [generator, "--ir", irPath, "--out-root", path.join(output, "out")]),
      /IR hash does not match ABI-shape census provenance/,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

export async function assertGeneratedCppHasNoHeapOwnership(report) {
  const current = JSON.parse(await readFile(path.join(repositoryRoot, report), "utf8"));
  for (const artifact of current.artifacts.filter((entry) => entry.endsWith(".cpp"))) {
    assert.doesNotMatch(
      await readFile(path.join(repositoryRoot, artifact), "utf8"),
      /\b(?:new|delete|malloc|calloc|realloc|free)\b/,
      artifact,
    );
  }
}
