import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractBase64SpanSemantics } from "../scripts/generate-dmsdk-base64-span-bindings.mjs";
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

const generator = "scripts/generate-dmsdk-base64-span-bindings.mjs";
const report = "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json";

test("base64-span generator is deterministic, census-derived, and policy complete", async () => {
  const current = await generateAndCompareFamily({ generator, report, tempPrefix: "deherm-dmsdk-base64-span-" });
  assert.deepEqual(current.coverage, {
    baselineRuntimePending: 1361,
    discovered: 2,
    structurallyEligible: 2,
    emitted: 2,
    policyBlocked: 0,
    hostBehaviorVerified: 2,
    remainingWithoutGeneratedAdapters: 1322,
  });
  assert.equal(current.fallbackAudit.count, 0);
  assert.deepEqual(
    current.declarations.map(({ mode, patternDecision }) => ({ mode, patternDecision })),
    [
      { mode: "decode", patternDecision: "span.bounded-byte-transform" },
      { mode: "encode", patternDecision: "span.bounded-byte-transform" },
    ],
  );
});

test("base64-span generator rejects mixed provenance", async () => {
  await assertMixedIrProvenanceRejected({
    generator,
    tempPrefix: "deherm-dmsdk-base64-span-drift-",
  });
});

test("base64-span semantics come from implementation dataflow plus ABI, not names or documentation prose", async () => {
  const [ir, shapes, sourceFacts] = await Promise.all([
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const policyText = await readFile(
    join(repositoryRoot, "packages/bindings/overrides/dmsdk-base64-span-bindings.json"),
    "utf8",
  );
  const policy = JSON.parse(policyText);
  assert.doesNotMatch(
    policyText,
    /documentationContract|description|symbolPrefix|candidateSelector|crypt\.h|"entries"/u,
  );
  const declarations = ir.declarations.filter(({ name }) => /Base64(?:Encode|Decode)$/u.test(name));
  const factsById = new Map(sourceFacts.declarations.map((entry) => [entry.declarationId, entry]));
  assert.equal(declarations.length, 2);
  for (const declaration of declarations) {
    const candidate = shapes.rows.find(({ id }) => id === declaration.id);
    const facts = factsById.get(declaration.id);
    const semantics = extractBase64SpanSemantics(declaration, candidate, policy.recipe, facts);
    assert.ok(semantics, declaration.id);
    assert.equal(semantics.mode, declaration.name.endsWith("Encode") ? "encode" : "decode");
    assert.equal(semantics.requirePaddedInput, false);
    assert.equal(
      semantics.evidence.unpaddedInput,
      declaration.name.endsWith("Decode") ? "accepted-by-padding-adapter" : "not-applicable",
    );
    assert.ok(
      extractBase64SpanSemantics(
        {
          ...declaration,
          description: "",
          returnDescription: "",
          parameters: declaration.parameters.map((parameter) => ({ ...parameter, description: "" })),
        },
        candidate,
        policy.recipe,
        facts,
      ),
    );
    assert.ok(
      extractBase64SpanSemantics({ ...declaration, name: "dmCrypt::Transform" }, candidate, policy.recipe, facts),
    );
    assert.equal(extractBase64SpanSemantics(declaration, candidate, policy.recipe, { definitions: [] }), null);
  }
});

test("base64 C ABI links, preserves native acceptance, and observes zero warmed C++ operator new calls", async (context) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    context.skip(
      `pinned packaged-library runtime harness requires arm64-macos, got ${process.arch}-${process.platform}`,
    );
    return;
  }
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-base64-span-host-"));
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
      "native/dmsdk_base64_span_c_header_test.c",
      "-o",
      cObject,
    ]);
    const libraries = [
      join(pinnedSdkRoot, "lib/arm64-macos/libdlib.a"),
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
      "defold/defold_hermes/src/generated_dmsdk_base64_span_crypt.cpp",
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
      "defold/defold_hermes/src/generated_dmsdk_base64_span_crypt.cpp",
      "defold/defold_hermes/src/generated_dmsdk_base64_span_runtime.cpp",
      "native/dmsdk_base64_span_host_test.cpp",
      ...libraries,
      "-o",
      executable,
    ]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("base64 generated C++ has no heap ownership primitive", async () => {
  await assertGeneratedCppHasNoHeapOwnership(report);
});
