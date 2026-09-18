import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

test("embedded Hermes executes the TypeScript bundle end to end", () => {
  const result = spawnSync(
    "build/native/defold-hermes-runner",
    ["dist/sample.js"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /host\.ready:hermes/);
  assert.match(result.stdout, /host\.log:info:init:hermes/);
  assert.match(result.stdout, /host\.log:info:module:42/);
  assert.match(result.stdout, /host\.log:info:final:ok/);
  assert.match(result.stdout, /defold-hermes:ok/);
});

test("generated TypeScript dmSDK scalar wrapper crosses JSI into the pinned Defold implementation", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-hermes-"));
  try {
    const entry = join(outputDirectory, "entry.ts");
    const bundle = join(outputDirectory, "entry.js");
    const scalarModule = resolve("packages/sdk/src/generated/dmsdk/scalar.ts");
    await writeFile(entry, [
      `import { endianSwap16U16, endianSwap64U64 } from ${JSON.stringify(scalarModule)};`,
      "globalThis.__defoldAppV1 = {",
      "  init() {",
      "    const result = endianSwap16U16(0x1234);",
      "    globalThis.__defoldHostV1.log('info', `dmsdk-scalar:${result.toString(16)}`);",
      "    const result64 = endianSwap64U64(0x0123456789abcdefn);",
      "    globalThis.__defoldHostV1.log('info', `dmsdk-scalar-u64:${result64.toString(16)}`);",
      "  }",
      "};",
      ""
    ].join("\n"));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: "iife", platform: "neutral" });
    const result = spawnSync(
      "build/native/defold-hermes-runner",
      [bundle],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /host\.log:info:dmsdk-scalar:3412/);
    assert.match(result.stdout, /host\.log:info:dmsdk-scalar-u64:efcdab8967452301/);
    assert.match(result.stdout, /defold-hermes:ok/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
