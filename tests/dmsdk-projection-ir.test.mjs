import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "..");
const reportPath = join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-projection-ir.json");

function run(args) {
  return execFileSync(process.execPath, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
}

test("dmSDK projection IR regenerates byte-for-byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-projection-"));
  try {
    const output = join(directory, "projection.json");
    run(["scripts/generate-dmsdk-projection-ir.mjs", "--output", output]);
    assert.equal(await readFile(output, "utf8"), await readFile(reportPath, "utf8"));
    run(["scripts/generate-dmsdk-projection-ir.mjs", "--output", output, "--check"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all 1,361 declarations have unique identities, provenance, shapes, and effects", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.coverage, {
    classifiedDeclarations: 1361,
    projectedDeclarations: 1361,
    uniqueSourceIds: 1361,
    uniqueProjectionIds: 1361,
    unprojectedDeclarations: 0,
    silentUnknowns: 0,
    generatedAdapters: 45,
    policyBlocked: 96,
    mechanicallyProjected: 1361,
    projectionGaps: 0,
    loweringPending: 1220,
  });
  assert.equal(report.rows.length, 1361);
  assert.equal(new Set(report.rows.map(({ id }) => id)).size, 1361);
  assert.equal(new Set(report.rows.map(({ projectionId }) => projectionId)).size, 1361);
  for (const row of report.rows) {
    assert.equal(row.id, row.provenance.sourceId);
    assert.match(row.projectionId, /^dmsdk-projection:[a-f0-9]{24}$/);
    assert.ok(row.provenance.header.startsWith("upstream/defold/"));
    assert.ok(row.provenance.line === null || Number.isInteger(row.provenance.line));
    assert.ok(row.signature.result.kind);
    assert.equal(row.signature.parameters.length, row.effects.direction.parameters.length);
    assert.deepEqual(Object.keys(row.effects), ["direction", "ownership", "lifetime", "context", "thread", "callbacks", "records", "templates", "spans", "availability"]);
    assert.ok(row.semanticTokensNeeded.includes("native-symbol-linkage"));
    assert.ok(row.semanticTokensNeeded.includes("call-thread-affinity"));
    assert.ok(row.semanticTokensNeeded.includes("target-feature-symbol-matrix"));
  }
});

test("unsupported nodes are explicit and cannot silently bypass semantic-token accounting", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  for (const row of report.rows) {
    const serialized = JSON.stringify(row.signature);
    if (serialized.includes('"kind":"unknown"')) {
      assert.ok(row.semanticTokensNeeded.includes("native-type-resolution"), row.id);
      assert.deepEqual(row.projection, { state: "generated", deterministic: true });
      assert.ok(["generated-adapter", "policy-blocked", "lowering-pending"].includes(row.loweringState));
      assert.equal("readiness" in row, false);
    }
    if (serialized.includes('"kind":"opaque"')) assert.ok(row.semanticTokensNeeded.includes("opaque-type-abi-contract"), row.id);
  }
  assert.equal(report.coverage.silentUnknowns, 0);
  assert.equal(report.constructorSummary.unknown ?? 0, 0, "all current native spellings should lower to a deliberate constructor");
  assert.ok(report.constructorSummary.opaque > 0);
  assert.equal(report.algebra.unknownPolicy.includes("no permissive fallback"), true);
});

test("representative compound signatures are compositional rather than signature allowlists", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const config = report.rows.find(({ symbol }) => symbol === "ConfigFileRegisterExtension");
  assert.ok(config);
  assert.equal(config.effects.callbacks.present, true);
  assert.equal(config.effects.callbacks.parameters.length, 5);
  assert.ok(config.signature.parameters.slice(3).every(({ type }) => type.kind === "callback"));

  const stringGetter = report.rows.find(({ symbol }) => symbol === "ConfigFileGetString");
  assert.ok(stringGetter);
  assert.equal(stringGetter.signature.result.kind, "cstring");
  assert.equal(stringGetter.effects.lifetime.result, "unspecified-requires-token");

  const templateMethod = report.rows.find((row) => row.symbol === "Back" && rowHasTypeParameter(row));
  assert.ok(templateMethod);
  assert.equal(templateMethod.effects.context.kind, "receiver");
  assert.equal(templateMethod.effects.templates.present, true);

  const returnedCallback = report.rows.find(({ symbol }) => symbol === "dm_lua_gethook");
  assert.equal(returnedCallback.effects.callbacks.present, true);
  assert.equal(returnedCallback.effects.callbacks.result, true);
  assert.equal(returnedCallback.effects.thread.callbacks, "unspecified-requires-token");

  const nestedCallback = report.rows.find(({ symbol }) => symbol === "dmWebServer::AddHandler");
  assert.equal(nestedCallback.effects.callbacks.present, true);
  assert.equal(nestedCallback.effects.callbacks.nestedOrOpaque, true);
});

test("source support types preserve nested enums, variadics, and target-dependent handles", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const steppedVertexDeclaration = report.rows.find(({ symbol, signature }) =>
    symbol === "dmGraphics::NewVertexStreamDeclaration" && signature.parameters.length === 2);
  assert.deepEqual(steppedVertexDeclaration.signature.parameters[1].type, {
    kind: "enum",
    name: "dmGraphics::VertexStepFunction",
    width: "unspecified",
    domain: "declared-values",
  });

  const renderConstant = report.rows.find(({ symbol }) => symbol === "dmRender::SetConstantType");
  assert.equal(renderConstant.signature.parameters[1].type.kind, "enum");
  assert.equal(renderConstant.signature.parameters[1].type.name,
    "dmRenderDDF::MaterialDesc::ConstantType");

  const vulkanImage = report.rows.find(({ symbol }) => symbol === "dmGraphics::VulkanGetImage");
  assert.equal(vulkanImage.signature.result.kind, "handle");
  assert.equal(vulkanImage.signature.result.representation.targetDependent, true);
  assert.equal(vulkanImage.signature.result.representation.targetTypes["arm64-osx"],
    "struct VkImage_T *");
  assert.equal(vulkanImage.signature.result.representation.targetTypes["wasm-web"], "uint64_t");

  const variadics = report.rows.filter(({ signature }) => signature.variadic);
  assert.equal(variadics.length, 7);
  assert.ok(variadics.every(({ semanticTokensNeeded }) =>
    semanticTokensNeeded.includes("typed-nonvariadic-facade")));
});

test("reconciles generated adapters and policy gates while projecting every pending lowering", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.loweringSummary, {
    "generated-adapter": 45,
    "policy-blocked": 96,
    "lowering-pending": 1220
  });
  const hash = report.rows.find(({ symbol }) => symbol === "dmHashBuffer64");
  assert.equal(hash.lowering.state, "generated-adapter");
  assert.equal(hash.lowering.family, "hashSpan");
  assert.equal(hash.loweringState, "generated-adapter");

  const tls = report.rows.find(({ symbol }) => symbol === "dmThread::AllocTls");
  assert.equal(tls.lowering.state, "policy-blocked");
  assert.equal(tls.lowering.family, "namedScalar");
  assert.equal(tls.loweringState, "policy-blocked");

  const pending = report.rows.find(({ symbol }) => symbol === "dmSocket::GetFD");
  assert.equal(pending.projection.state, "generated");
  assert.equal(pending.lowering.state, "lowering-pending");
  assert.equal(pending.loweringState, "lowering-pending");
});

function rowHasTypeParameter(row) {
  return JSON.stringify(row?.signature ?? {}).includes('"kind":"type-parameter"');
}

test("constructor and effect summaries account for the complete projection", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const knownConstructors = new Set(report.algebra.valueConstructors);
  assert.ok(Object.keys(report.constructorSummary).every((constructor) => knownConstructors.has(constructor)));
  assert.ok(report.effectSummary.callbacks > 0);
  assert.ok(report.effectSummary.records > 0);
  assert.ok(report.effectSummary.templates > 0);
  assert.ok(report.effectSummary.spans > 0);
  assert.ok(report.effectSummary.receiverBound > 0);
  assert.deepEqual(report.loweringStateSummary, report.loweringSummary);
  assert.equal(report.semanticTokenSummary["native-symbol-linkage"], 1361);
});
