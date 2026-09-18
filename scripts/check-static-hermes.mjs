import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outputDir = await mkdtemp(join(tmpdir(), "defold-hermes-static-"));
try {
  function runShermes(output, extraArguments = []) {
    const result = spawnSync("build/native/bin/shermes", [
      "-typed",
      "-strict",
      "-emit-c",
      ...extraArguments,
      "packages/static-hermes/src/generated/ffi.js",
      "-o",
      output
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  runShermes(join(outputDir, "ffi.c"));
  const exportedPath = join(outputDir, "ffi-exported.c");
  runShermes(exportedPath, ["-exported-unit=deherm_app"]);
  const exported = await readFile(exportedPath, "utf8");
  assert.match(exported, /#define CREATE_THIS_UNIT sh_export_deherm_app/);
  assert.match(exported, /SHUnit \*CREATE_THIS_UNIT\(void\)/);
  assert.doesNotMatch(exported, /\bint\s+main\s*\(/);
  console.log("Static Hermes accepted the typed C ABI and emitted library-shaped sh_export_deherm_app without main");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
