import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildClassification, FAMILY_CATALOG } from "../scripts/classify-dmsdk-bindings.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const irPath = join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json");
const generatedPath = join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-binding-patterns.json");

async function fixtures() {
  const ir = JSON.parse(await readFile(irPath, "utf8"));
  const generated = JSON.parse(await readFile(generatedPath, "utf8"));
  return { ir, generated };
}

function findBinding(classification, symbol, predicate = () => true) {
  const binding = classification.bindings.find((candidate) => candidate.symbol === symbol && predicate(candidate));
  assert.ok(binding, `missing classified binding for ${symbol}`);
  return binding;
}

test("classifies every emitted raw dmSDK call exactly once", async () => {
  const { ir, generated } = await fixtures();
  const pending = ir.declarations.filter((declaration) => declaration.disposition === "generated-raw-call");

  assert.equal(pending.length, 1361);
  assert.equal(generated.coverage.runtimePendingCount, pending.length);
  assert.equal(generated.coverage.classifiedCount, pending.length);
  assert.equal(new Set(generated.bindings.map((binding) => binding.id)).size, pending.length);
  assert.deepEqual(
    new Set(generated.bindings.map((binding) => binding.id)),
    new Set(pending.map((declaration) => declaration.id)),
  );

  const primaryTotal = Object.values(generated.primaryFamilySummary)
    .reduce((sum, family) => sum + family.count, 0);
  assert.equal(primaryTotal, pending.length);
  for (const binding of generated.bindings) {
    assert.ok(FAMILY_CATALOG[binding.primaryFamily], `${binding.id} has an unknown primary family`);
    assert.ok(binding.families.includes(binding.primaryFamily), `${binding.id} lost its primary family trait`);
    assert.ok(binding.blockers.length > 0, `${binding.id} has no explicit blocker`);
  }
});

test("keeps classification separate from implementation and conformance coverage", async () => {
  const { ir, generated } = await fixtures();
  assert.equal(ir.runtimeImplementedCount, 0);
  assert.deepEqual(generated.coverage, {
    runtimePendingCount: 1361,
    classifiedCount: 1361,
    nativeAdapterGeneratedCount: 0,
    compiledCount: 0,
    linkedCount: 0,
    conformantCount: 0,
    note: "Classification is code-generation planning metadata. It is not evidence that a binding adapter was generated, compiled, linked, executed, or conformance-tested.",
  });
  assert.equal(generated.provenanceCaveats.diagnosticHeaderCount, 35);
});

test("classifies representative ABI and codegen families", async () => {
  const { generated } = await fixtures();

  assert.ok(findBinding(generated, "EndianSwap16").families.includes("scalar-direct"));
  assert.ok(findBinding(generated, "dmBuffer::Destroy").families.includes("enum-handle"));
  assert.ok(findBinding(generated, "dmDDF::LoadMessage", (binding) => binding.signature.includes("void **"))
    .families.includes("pointer-span"));
  assert.ok(findBinding(generated, "dmBuffer::Create").families.includes("out-param"));
  assert.ok(findBinding(generated, "dmTransform::Apply").families.includes("record-reference"));
  assert.ok(findBinding(generated, "ConfigFileRegisterExtension").families.includes("callback"));
  assert.ok(findBinding(generated, "dmSnPrintf").families.includes("variadic"));
  assert.ok(findBinding(generated, "dmDDF::LoadMessage", (binding) => binding.kind === "function-template")
    .families.includes("template-opaque"));
  assert.ok(findBinding(generated, "dmConnectionPool::Params::Params").families.includes("constructor"));
  assert.ok(findBinding(generated, "dmMutex::ScopedLock::~ScopedLock").families.includes("destructor"));
  assert.ok(findBinding(generated, "dmArray::dmArray::Capacity").families.includes("method"));
  assert.ok(findBinding(generated, "dmGraphics::GetNativeiOSUIView").families.includes("platform-gated"));
});

test("locks the current family census", async () => {
  const { generated } = await fixtures();
  assert.deepEqual(
    Object.fromEntries(Object.entries(generated.primaryFamilySummary).map(([name, summary]) => [name, summary.count])),
    {
      callback: 93,
      constructor: 54,
      destructor: 8,
      "enum-handle": 380,
      method: 56,
      "out-param": 103,
      "platform-gated": 42,
      pointer: 436,
      "pointer-span": 44,
      "record-reference": 37,
      "scalar-direct": 31,
      "template-opaque": 70,
      variadic: 7,
    },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(generated.traitFamilySummary).map(([name, summary]) => [name, summary.count])),
    {
      callback: 95,
      constructor: 57,
      destructor: 8,
      "enum-handle": 862,
      method: 102,
      "out-param": 118,
      "platform-gated": 42,
      pointer: 693,
      "pointer-span": 87,
      "record-reference": 86,
      "scalar-direct": 31,
      "template-opaque": 70,
      variadic: 7,
    },
  );
});

test("regeneration is deterministic and the checked-in classification is current", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-patterns-"));
  const output = join(temporaryDirectory, "patterns.json");
  try {
    execFileSync(process.execPath, [
      "scripts/classify-dmsdk-bindings.mjs",
      "--input", irPath,
      "--output", output,
    ], { cwd: repositoryRoot, stdio: "pipe" });
    assert.equal(await readFile(output, "utf8"), await readFile(generatedPath, "utf8"));

    execFileSync(process.execPath, [
      "scripts/classify-dmsdk-bindings.mjs",
      "--input", irPath,
      "--output", generatedPath,
      "--check",
    ], { cwd: repositoryRoot, stdio: "pipe" });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the in-memory classifier matches the generated artifact", async () => {
  const { ir, generated } = await fixtures();
  assert.deepEqual(buildClassification(ir), generated);
});
