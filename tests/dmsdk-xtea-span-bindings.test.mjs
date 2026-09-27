import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { extractXteaSpanSemantics } from "../scripts/generate-dmsdk-xtea-span-bindings.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  sdk = join(root, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk"),
  run = (c, a) => execFileSync(c, a, { cwd: root, encoding: "utf8", stdio: "pipe" }),
  inc = [
    `-I${join(root, "defold/defold_hermes/include")}`,
    "-isystem",
    join(sdk, "sdk/include"),
    "-isystem",
    join(sdk, "include"),
  ];
test("xtea generation is deterministic and evidence-bound", async () => {
  const o = await mkdtemp(join(tmpdir(), "deherm-xtea-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-xtea-span-bindings.mjs", "--out-root", o]);
    const r = JSON.parse(
      await readFile(join(root, "packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json"), "utf8"),
    );
    assert.deepEqual(r.coverage, {
      baselineRuntimePending: 1361,
      discovered: 2,
      structurallyEligible: 2,
      emitted: 2,
      policyBlocked: 0,
      hostBehaviorVerified: 2,
      remainingWithoutGeneratedAdapters: 1318,
    });
    assert.equal(r.declarations.length, 2);
    assert.equal(r.fallbackAudit.count, 0);
    assert.equal(Object.keys(r.artifactHashes).length, r.artifacts.length);
    for (const d of r.declarations) {
      assert.equal(typeof d.bindingId, "number");
      assert.equal(d.patternDecision, "span.in-place-keyed-transform");
      assert.equal(d.evidence.semanticSource, "revision-ir-abi+identifier-grammar+stable-format-recipe");
      assert.equal(d.stages.runtime, "packaged-sdk-host-behavior-test");
    }
    for (const f of [...r.artifacts, "packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json"])
      assert.equal(await readFile(join(o, f), "utf8"), await readFile(join(root, f), "utf8"));
  } finally {
    await rm(o, { recursive: true, force: true });
  }
});
test("xtea span derives callable enum tokens and modes without route allowlists", async () => {
  const ir = JSON.parse(await readFile(join(root, "packages/bindings/generated/defold-sdk-ir.json"), "utf8"));
  const shapes = JSON.parse(
    await readFile(join(root, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8"),
  );
  const policyText = await readFile(join(root, "packages/bindings/overrides/dmsdk-xtea-span-bindings.json"), "utf8");
  const policy = JSON.parse(policyText);
  assert.doesNotMatch(policyText, /documentationContract|description|candidateSelector|crypt\.h|"entries"|"symbols"/u);
  const enums = new Map(ir.declarations.filter(({ kind }) => kind === "enum").map((item) => [item.name, item]));
  const declarations = new Map(ir.declarations.map((item) => [item.id, item]));
  const candidates = shapes.rows.filter(
    ({ shape }) =>
      shape ===
      "enum:dmCrypt::Result(value:enum:dmCrypt::Algorithm,inout:pointer:scalar:u8,value:scalar:u32,in:pointer:scalar:u8,value:scalar:u32)",
  );
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    const declaration = declarations.get(candidate.id);
    const semantics = extractXteaSpanSemantics(declaration, candidate, enums, policy.recipe);
    assert.ok(semantics, candidate.id);
    assert.match(semantics.algorithmExpression, /::ALGORITHM_XTEA$/u);
    assert.match(semantics.successExpression, /::RESULT_OK$/u);
    assert.ok(
      extractXteaSpanSemantics(
        {
          ...declaration,
          description: "",
          returnDescription: "",
          parameters: declaration.parameters.map((parameter) => ({ ...parameter, description: "" })),
        },
        candidate,
        enums,
        policy.recipe,
      ),
    );
    assert.equal(
      extractXteaSpanSemantics({ ...declaration, name: "dmCrypt::Transform" }, candidate, enums, policy.recipe),
      null,
    );
  }
});
test("xtea packaged link, bounds, behavior, and warmed allocation gate", async () => {
  const o = await mkdtemp(join(tmpdir(), "deherm-xtea-host-"));
  try {
    const exe = join(o, "host");
    run(process.env.CXX || "clang++", [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...inc,
      "defold/defold_hermes/src/generated_dmsdk_xtea_span_crypt.cpp",
      "defold/defold_hermes/src/generated_dmsdk_xtea_span_runtime.cpp",
      "native/dmsdk_xtea_span_host_test.cpp",
      join(sdk, "lib/arm64-macos/libdlib.a"),
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      "-framework",
      "Foundation",
      "-o",
      exe,
    ]);
    run(exe, []);
  } finally {
    await rm(o, { recursive: true, force: true });
  }
});
test("xtea glue has no heap primitive", async () => {
  for (const f of [
    "defold/defold_hermes/src/generated_dmsdk_xtea_span_crypt.cpp",
    "defold/defold_hermes/src/generated_dmsdk_xtea_span_runtime.cpp",
  ])
    assert.doesNotMatch(await readFile(join(root, f), "utf8"), /\b(?:new|delete|malloc|calloc|realloc|free)\b/);
});
