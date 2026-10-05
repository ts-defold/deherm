import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractXteaSpanSemantics } from "../scripts/generate-dmsdk-xtea-span-bindings.mjs";
import {
  assertGeneratedCppHasNoHeapOwnership,
  cxx,
  generateAndCompareFamily,
  pinnedSdkRoot as sdk,
  repositoryRoot as root,
  run,
  sdkIncludeArgs,
} from "./helpers/dmsdk-binding-family.mjs";

const generator = "scripts/generate-dmsdk-xtea-span-bindings.mjs";
const report = "packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json";
test("xtea generation is deterministic and evidence-bound", async () => {
  const current = await generateAndCompareFamily({ generator, report, tempPrefix: "deherm-xtea-" });
  assert.deepEqual(current.coverage, {
    baselineRuntimePending: 1361,
    discovered: 2,
    structurallyEligible: 2,
    emitted: 2,
    policyBlocked: 0,
    hostBehaviorVerified: 2,
    remainingWithoutGeneratedAdapters: 1318,
  });
  assert.equal(current.declarations.length, 2);
  assert.equal(current.fallbackAudit.count, 0);
  assert.equal(Object.keys(current.artifactHashes).length, current.artifacts.length);
  for (const declaration of current.declarations) {
    assert.equal(typeof declaration.bindingId, "number");
    assert.equal(declaration.patternDecision, "span.in-place-keyed-transform");
    assert.equal(declaration.evidence.semanticSource, "revision-implementation-ast+abi-shape");
    assert.equal(declaration.stages.runtime, "packaged-sdk-host-behavior-test");
  }
});
test("xtea span derives bounds and results from implementation dataflow without route allowlists", async () => {
  const [ir, shapes, sourceFacts] = await Promise.all([
    readFile(join(root, "packages/bindings/generated/defold-sdk-ir.json"), "utf8").then(JSON.parse),
    readFile(join(root, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8").then(JSON.parse),
    readFile(join(root, "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const policyText = await readFile(join(root, "packages/bindings/overrides/dmsdk-xtea-span-bindings.json"), "utf8");
  const policy = JSON.parse(policyText);
  assert.doesNotMatch(policyText, /documentationContract|description|candidateSelector|crypt\.h|"entries"|"symbols"/u);
  const enums = new Map(ir.declarations.filter(({ kind }) => kind === "enum").map((item) => [item.name, item]));
  const declarations = new Map(ir.declarations.map((item) => [item.id, item]));
  const factsById = new Map(sourceFacts.declarations.map((entry) => [entry.declarationId, entry]));
  const candidates = shapes.rows.filter(
    ({ shape }) =>
      shape ===
      "enum:dmCrypt::Result(value:enum:dmCrypt::Algorithm,inout:pointer:scalar:u8,value:scalar:u32,in:pointer:scalar:u8,value:scalar:u32)",
  );
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    const declaration = declarations.get(candidate.id);
    const facts = factsById.get(candidate.id);
    const semantics = extractXteaSpanSemantics(declaration, candidate, enums, policy.recipe, facts);
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
        facts,
      ),
    );
    assert.ok(
      extractXteaSpanSemantics({ ...declaration, name: "dmCrypt::Transform" }, candidate, enums, policy.recipe, facts),
    );
    assert.equal(extractXteaSpanSemantics(declaration, candidate, enums, policy.recipe, { definitions: [] }), null);
  }
});
test("xtea packaged link, bounds, behavior, and warmed allocation gate", async (context) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    context.skip(
      `pinned packaged-library runtime harness requires arm64-macos, got ${process.arch}-${process.platform}`,
    );
    return;
  }
  const o = await mkdtemp(join(tmpdir(), "deherm-xtea-host-"));
  try {
    const exe = join(o, "host");
    run(cxx, [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...sdkIncludeArgs(),
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
  await assertGeneratedCppHasNoHeapOwnership(report);
});
