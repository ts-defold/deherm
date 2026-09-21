import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generate, loadInputs } from "../scripts/generate-dmsdk-arena-span-blockers.mjs";

const root = new URL("../", import.meta.url);
const repositoryRoot = fileURLToPath(root);

function withJson(text, mutate) {
  const value = JSON.parse(text);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("arena-span census deterministically promotes bounded cstring arenas and preserves blockers", async () => {
  execFileSync(process.execPath, ["scripts/generate-dmsdk-arena-span-blockers.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
  const report = JSON.parse(await readFile(
    new URL("packages/bindings/generated/defold-dmsdk-arena-span-blockers.json", root),
    "utf8"
  ));
  assert.deepEqual(report.coverage, {
    arenaSpanCensus: 79,
    coveredByPriorWaves: 14,
    generatedCStringArena: 5,
    blocked: 60,
    executableAdaptersEmitted: 5,
    exactCallTwinsEmitted: 5,
    overlap: 0,
    unaccounted: 0
  });
  assert.deepEqual(report.partitionSummary, {
    "handle-provenance-or-engine-context": 33,
    "opaque-byte-pointee-unit-or-lifetime": 4,
    "record-layout-or-borrowed-record-lifetime": 17,
    "template-element-layout-or-specialization": 6
  });
  const priorIds = new Set(report.coveredByPriorWaves.map(({ id }) => id));
  const blockedIds = new Set(report.declarations.map(({ id }) => id));
  assert.equal(priorIds.size, 14);
  const generatedIds = new Set(report.generatedDeclarations.map(({ id }) => id));
  assert.equal(generatedIds.size, 5);
  assert.equal(blockedIds.size, 60);
  assert.equal([...priorIds].some((id) => blockedIds.has(id)), false);
  assert.equal([...priorIds].some((id) => generatedIds.has(id)), false);
  assert.equal([...generatedIds].some((id) => blockedIds.has(id)), false);
  assert.equal(Object.values(report.partitionSummary).reduce((sum, count) => sum + count, 0), 60);
  assert.deepEqual(report.generatedDeclarations.map(({ recipe }) => recipe.kind), [
    "canonical-path", "error-string", "trimmed-string", "uri-encode", "canonical-path"
  ]);
  for (const declaration of report.generatedDeclarations) {
    assert.equal(declaration.disposition, "generated");
    assert.equal(declaration.preferredLowering, true);
    assert.equal(declaration.universalFallback, "retained-usage-materialized-recipe");
    assert.equal(declaration.stages.generated, "production-and-exact-from-one-recipe");
    assert.ok(declaration.sourceEvidence.length > 0);
    assert.equal(declaration.symbolEvidence.path, "packages/bindings/generated/defold-dmsdk-symbol-evidence.json");
    assert.ok(declaration.symbolEvidence.linkage === "header-only" ||
      (declaration.symbolEvidence.linkage === "external" && declaration.symbolEvidence.availability === "all-targets-all-variants"));
  }
  assert.match(report.sourceHashes.symbolEvidence, /^[0-9a-f]{64}$/u);
  for (const declaration of report.declarations) {
    assert.equal(declaration.disposition, "blocked");
    assert.equal(declaration.stages.generated, "not-applicable");
    assert.equal(declaration.stages.runtime, "not-claimed");
    assert.equal(declaration.stages.allocation, "not-claimed");
  }
});

test("arena cstring production and exact twins compile, and exact vectors execute", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-arena-cstring-"));
  const repository = repositoryRoot;
  const sdk = path.join(repository, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
  const compiler = process.env.CXX || "clang++";
  const cCompiler = process.env.CC || "clang";
  const includes = [`-I${path.join(repository, "defold/defold_hermes/include")}`, "-isystem", path.join(sdk, "sdk/include"), "-isystem", path.join(sdk, "include")];
  try {
    const cHeader = path.join(directory, "header.c");
    await writeFile(cHeader, "#include <defold_hermes/generated_dmsdk_arena_cstring.h>\nint main(void){return DEHERM_DMSDK_ARENA_CSTRING_MAX_INPUT==UINT32_C(4095)?0:1;}\n");
    execFileSync(cCompiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${path.join(repository, "defold/defold_hermes/include")}`, "-c", cHeader, "-o", path.join(directory, "header.o")], { cwd: repository, stdio: "pipe" });
    execFileSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...includes, "-c", "defold/defold_hermes/src/generated_dmsdk_arena_cstring.cpp", "-o", path.join(directory, "production.o")], { cwd: repository, stdio: "pipe" });
    const main = path.join(directory, "main.cpp");
    await writeFile(main, "extern \"C\" int deherm_dmsdk_arena_cstring_exact_verify(void);\nint main(){return deherm_dmsdk_arena_cstring_exact_verify();}\n");
    const executable = path.join(directory, process.platform === "win32" ? "exact.exe" : "exact");
    const sanitizerFlags = process.platform === "win32" ? [] : ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"];
    execFileSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...sanitizerFlags, ...includes, "tests/fixtures/generated_dmsdk_arena_cstring_exact.cpp", main, "-o", executable], { cwd: repository, stdio: "pipe" });
    execFileSync(executable, [], { cwd: repository, stdio: "pipe", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
    const allocationMain = path.join(directory, "allocation.cpp");
    await writeFile(allocationMain, `
#include <defold_hermes/generated_dmsdk_arena_cstring.h>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <new>
static uint64_t allocations=0;static bool tracking=false;
void* operator new(std::size_t size){if(tracking)++allocations;if(void* value=std::malloc(size))return value;throw std::bad_alloc();}
void operator delete(void* value)noexcept{std::free(value);}void operator delete(void* value,std::size_t)noexcept{std::free(value);}
extern "C" DehermDmSdkArenaCStringStatus deherm_dmsdk_arena_cstring_exact_dispatch(uint16_t,const uint8_t*,uint32_t,uint64_t,char*,uint32_t,DehermDmSdkArenaCStringResult*);
int main(){const char input[]="arena_0";char output[64]{};DehermDmSdkArenaCStringResult result{};
if(deherm_dmsdk_arena_cstring_exact_dispatch(0,reinterpret_cast<const uint8_t*>(input),7,0,output,64,&result)!=DEHERM_DMSDK_ARENA_CSTRING_OK)return 1;
tracking=true;for(uint32_t i=0;i<UINT32_C(100000);++i){std::memset(output,0,sizeof(output));result={};if(deherm_dmsdk_arena_cstring_exact_dispatch(0,reinterpret_cast<const uint8_t*>(input),7,0,output,64,&result)!=DEHERM_DMSDK_ARENA_CSTRING_OK||std::strcmp(output,"result_0")!=0)return 2;}tracking=false;return allocations==0?0:3;}
`);
    const allocationExecutable = path.join(directory, process.platform === "win32" ? "allocation.exe" : "allocation");
    execFileSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", ...sanitizerFlags, ...includes, "tests/fixtures/generated_dmsdk_arena_cstring_exact.cpp", allocationMain, "-o", allocationExecutable], { cwd: repository, stdio: "pipe" });
    execFileSync(allocationExecutable, [], { cwd: repository, stdio: "pipe", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("arena cstring generation is clean-room deterministic and allocation bounded", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-arena-cstring-generation-"));
  try {
    execFileSync(process.execPath, ["scripts/generate-dmsdk-arena-span-blockers.mjs", "--output-root", directory], { cwd: root, stdio: "pipe" });
    const report = JSON.parse(await readFile(new URL("packages/bindings/generated/defold-dmsdk-arena-span-blockers.json", root), "utf8"));
    for (const artifact of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-arena-span-blockers.json"]) {
      assert.equal(await readFile(path.join(directory, artifact), "utf8"), await readFile(new URL(artifact, root), "utf8"), artifact);
    }
    for (const artifact of report.artifacts.filter((name) => name.endsWith(".cpp"))) {
      const source = await readFile(new URL(artifact, root), "utf8");
      assert.doesNotMatch(source, /\b(?:new|delete|malloc|calloc|realloc|free)\b/);
      assert.match(source, /thread_local char gInput/);
      assert.match(source, /gActive/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("arena-span blocker generator rejects schema, revision, provenance, and duplicate drift", async () => {
  const inputs = await loadInputs();
  assert.throws(() => generate({
    ...inputs,
    policyText: withJson(inputs.policyText, (policy) => { policy.schemaVersion = 2; })
  }), /schemaVersion must be 1/);
  assert.throws(() => generate({
    ...inputs,
    policyText: withJson(inputs.policyText, (policy) => { policy.defoldRevision = "0".repeat(40); })
  }), /was reviewed against Defold .* but .* is being generated/);
  assert.throws(() => generate({
    ...inputs,
    shapesText: withJson(inputs.shapesText, (shapes) => { shapes.sourceHashes.ir = "0".repeat(64); })
  }), /IR hash does not match ABI-shape census provenance/);
  assert.throws(() => generate({
    ...inputs,
    shapesText: withJson(inputs.shapesText, (shapes) => { shapes.rows.push(structuredClone(shapes.rows[0])); })
  }), /contains duplicate/);
  assert.throws(() => generate({
    ...inputs,
    symbolEvidenceText: withJson(inputs.symbolEvidenceText, (evidence) => { evidence.defoldRevision = "0".repeat(40); })
  }), /symbol evidence is invalid or revision-mismatched/);
  const generatedId = generate(inputs).report.generatedDeclarations[0].id;
  assert.throws(() => generate({
    ...inputs,
    symbolEvidenceText: withJson(inputs.symbolEvidenceText, (evidence) => {
      evidence.declarations[generatedId].availability = "target-subset";
    })
  }), /native symbol is not available in every target and build variant/);
});

test("arena-span blocker policy must exactly name generated prior-wave symbols", async () => {
  const inputs = await loadInputs();
  assert.throws(() => generate({
    ...inputs,
    policyText: withJson(inputs.policyText, (policy) => { policy.coveredByPriorWaves.pop(); })
  }), /does not exactly match generated prior-wave symbols/);
  const priorWaveTexts = new Map(inputs.priorWaveTexts);
  const [path, text] = priorWaveTexts.entries().next().value;
  priorWaveTexts.set(path, withJson(text, (report) => { report.sourceHashes.shapes = "0".repeat(64); }));
  assert.throws(() => generate({ ...inputs, priorWaveTexts }), /ABI-shape provenance drifted/);
});
