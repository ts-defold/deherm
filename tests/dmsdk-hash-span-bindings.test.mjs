import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractHashSpanSemantics } from "../scripts/generate-dmsdk-hash-span-bindings.mjs";
import {
  assertGeneratedCppHasNoHeapOwnership,
  assertMixedIrProvenanceRejected,
  cc,
  cxx,
  generateAndCompareFamily,
  pinnedSdkRoot,
  repositoryRoot,
  run,
  sdkIncludeArgs,
} from "./helpers/dmsdk-binding-family.mjs";

const generator = "scripts/generate-dmsdk-hash-span-bindings.mjs";
const report = "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json";

test("hash-span generator is deterministic, census-derived, and policy complete", async () => {
  const current = await generateAndCompareFamily({ generator, report, tempPrefix: "deherm-dmsdk-hash-span-" });
  assert.deepEqual(current.coverage, {
    baselineRuntimePending: 1361,
    previouslyGeneratedAdapters: 43,
    discovered: 2,
    structurallyEligible: 2,
    emitted: 2,
    policyBlocked: 0,
    hostBehaviorVerified: 2,
    remainingWithoutGeneratedAdapters: 1316,
  });
  assert.deepEqual(
    current.declarations.map(({ resultBits, patternDecision }) => ({ resultBits, patternDecision })),
    [
      { resultBits: 32, patternDecision: "span.fixed-width-hash" },
      { resultBits: 64, patternDecision: "span.fixed-width-hash" },
    ],
  );
});

test("hash-span generation rejects mixed provenance", async () => {
  await assertMixedIrProvenanceRejected({
    generator,
    tempPrefix: "deherm-dmsdk-hash-span-drift-",
  });
});

test("hash-span semantics come from ABI shape rather than names or documentation", async () => {
  const ir = JSON.parse(await readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8"));
  const shapes = JSON.parse(
    await readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8"),
  );
  const policyText = await readFile(
    join(repositoryRoot, "packages/bindings/overrides/dmsdk-hash-span-bindings.json"),
    "utf8",
  );
  const policy = JSON.parse(policyText);
  assert.doesNotMatch(
    policyText,
    /candidateSelector|symbolPattern|hash\.h|"entries"|documentationContract|declaration|header|symbol/u,
  );
  const declarations = new Map(ir.declarations.map((item) => [item.id, item]));
  const selected = shapes.rows
    .map((candidate) => ({
      candidate,
      semantics: extractHashSpanSemantics(declarations.get(candidate.id), candidate, policy.recipe),
    }))
    .filter(({ semantics }) => semantics);
  assert.equal(selected.length, 2);
  for (const { candidate, semantics } of selected) {
    assert.equal(candidate.result.role, `scalar:u${semantics.resultBits}`);
    assert.equal(
      extractHashSpanSemantics(
        {
          ...declarations.get(candidate.id),
          name: "renamed",
          description: "",
          returnDescription: "",
          parameters: declarations.get(candidate.id).parameters.map((parameter) => ({
            ...parameter,
            name: "value",
            description: "",
          })),
        },
        candidate,
        policy.recipe,
      )?.resultBits,
      semantics.resultBits,
    );
  }
});

test("hash-span C ABI links to the packaged SDK, rejects invalid bounds, and matches Defold vectors", async (context) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    context.skip(
      `pinned packaged-library runtime harness requires arm64-macos, got ${process.arch}-${process.platform}`,
    );
    return;
  }
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-hash-span-host-"));
  try {
    const cObject = join(output, "header.o");
    run(cc, [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
      "-c",
      "native/dmsdk_hash_span_c_header_test.c",
      "-o",
      cObject,
    ]);
    const libraries = [
      join(pinnedSdkRoot, "lib/arm64-macos/libdlib.a"),
      join(pinnedSdkRoot, "lib/arm64-macos/libprofile_null.a"),
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      "-framework",
      "Foundation",
    ];
    const cExecutable = join(output, "c-abi");
    run(cxx, [
      "-std=c++17",
      ...sdkIncludeArgs(),
      "defold/defold_hermes/src/generated_dmsdk_hash_span.cpp",
      "defold/defold_hermes/src/generated_dmsdk_hash_span_runtime.cpp",
      cObject,
      ...libraries,
      "-o",
      cExecutable,
    ]);
    run(cExecutable, []);
    const executable = join(output, "host");
    run(cxx, [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...sdkIncludeArgs(),
      "defold/defold_hermes/src/generated_dmsdk_hash_span.cpp",
      "defold/defold_hermes/src/generated_dmsdk_hash_span_runtime.cpp",
      "native/dmsdk_hash_span_host_test.cpp",
      ...libraries,
      "-o",
      executable,
    ]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("hash-span generated C++ owns no heap allocation primitive", async () => {
  await assertGeneratedCppHasNoHeapOwnership(report);
});
