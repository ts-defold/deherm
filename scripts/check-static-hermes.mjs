import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outputDir = await mkdtemp(join(tmpdir(), "defold-hermes-static-"));
try {
  const result = spawnSync(
    "build/native/bin/shermes",
    [
      "-typed",
      "-strict",
      "-emit-c",
      "packages/static-hermes/src/generated/ffi.js",
      "-o",
      join(outputDir, "ffi.c")
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  console.log("Static Hermes accepted the generated typed C ABI declarations");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
