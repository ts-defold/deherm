import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildDmSdkCallSymbolIndex } from "../packages/compiler/src/dmsdk-call-symbol-index.mjs";
import { materializeDmSdkUniversalReadyCorpus } from "../packages/compiler/src/dmsdk-universal-ready-corpus.mjs";
import { partitionDmSdkUniversalStaticExactVectors } from "../packages/compiler/src/dmsdk-universal-static-exact-applicability.mjs";
import {
  dmSdkUniversalCatalogSha256,
  dmSdkUniversalRecipes,
} from "../packages/compiler/src/generated/dmsdk-universal-recipes.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const shermes = args.get("--shermes");
const outputDirectory = args.get("--output-dir");
assert.ok(shermes, "--shermes is required");
assert.ok(outputDirectory, "--output-dir is required");

const catalog = {
  sourceHashes: { catalog: dmSdkUniversalCatalogSha256 },
  recipes: dmSdkUniversalRecipes,
};
const sdkIr = JSON.parse(await readFile("packages/bindings/generated/defold-sdk-ir.json", "utf8"));
const corpus = materializeDmSdkUniversalReadyCorpus(
  buildDmSdkCallSymbolIndex(sdkIr, catalog),
  catalog,
);
const { generated } = corpus;
const canonicalVectors = generated.verification.vectors;
const applicability = partitionDmSdkUniversalStaticExactVectors(canonicalVectors);
const executableRows = applicability.vectors.filter(({ disposition }) => disposition === "execute");
const vectors = executableRows.map(({ vectorIndex }) => canonicalVectors[vectorIndex]);
const plannedMaximumArgumentCount = Math.max(0, ...vectors.map(({ argumentCount }) => argumentCount));
const plannedArgumentWireTags = [...new Set(vectors.flatMap(({ wireArguments }) =>
  wireArguments.map(({ tag }) => tag)))].sort();
const plannedResultWireTags = [...new Set(vectors.map(({ result }) => result.fakeReturn.tag))].sort();
const prefix = (index) => `deherm_exact_vector_${executableRows[index].vectorIndex}`;
const switchExpression = (expression) => vectors.map((_, index) => `case ${index}:return ${expression(index)};`).join("");
const fixtureHeader = `#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
uint32_t deherm_static_dmsdk_exact_vector_count(void);
uint32_t deherm_static_dmsdk_exact_corpus_vector_count(void);
uint32_t deherm_static_dmsdk_exact_blocked_vector_count(void);
uint32_t deherm_static_dmsdk_exact_planned_maximum_argument_count(void);
uint32_t deherm_static_dmsdk_exact_planned_argument_tag_mask(void);
uint32_t deherm_static_dmsdk_exact_planned_result_tag_mask(void);
uint32_t deherm_static_dmsdk_exact_vector_id(uint32_t vector);
uint32_t deherm_static_dmsdk_exact_argument_count(uint32_t vector);
uint32_t deherm_static_dmsdk_exact_argument_payload_low(uint32_t vector,uint32_t slot);
uint32_t deherm_static_dmsdk_exact_argument_payload_high(uint32_t vector,uint32_t slot);
uint32_t deherm_static_dmsdk_exact_argument_auxiliary_low(uint32_t vector,uint32_t slot);
uint32_t deherm_static_dmsdk_exact_argument_auxiliary_high(uint32_t vector,uint32_t slot);
uint32_t deherm_static_dmsdk_exact_argument_tag(uint32_t vector,uint32_t slot);
uint32_t deherm_static_dmsdk_exact_argument_type_id(uint32_t vector,uint32_t slot);
uint32_t deherm_static_dmsdk_exact_result_payload_low(uint32_t vector);
uint32_t deherm_static_dmsdk_exact_result_payload_high(uint32_t vector);
uint32_t deherm_static_dmsdk_exact_result_auxiliary_low(uint32_t vector);
uint32_t deherm_static_dmsdk_exact_result_auxiliary_high(uint32_t vector);
uint32_t deherm_static_dmsdk_exact_result_tag(uint32_t vector);
uint32_t deherm_static_dmsdk_exact_result_type_id(uint32_t vector);
void deherm_static_dmsdk_exact_report(uint32_t planned,uint32_t applicable,uint32_t executed,uint32_t mismatches,uint32_t maximum_argument_count,uint32_t argument_tag_mask,uint32_t result_tag_mask);
#ifdef __cplusplus
}
#endif
`;
const fieldAccessor = (name, expression) => `extern "C" uint32_t deherm_static_dmsdk_exact_argument_${name}(uint32_t vector,uint32_t slot){switch(vector){${switchExpression((index) => `slot<UINT32_C(${vectors[index].argumentCount})?static_cast<uint32_t>(${prefix(index)}_arguments[slot].${expression}):UINT32_MAX`)}default:return UINT32_MAX;}}`;
const resultTag = {
  void: "DEHERM_DMSDK_UNIVERSAL_VOID",
  bool: "DEHERM_DMSDK_UNIVERSAL_BOOL",
  i64: "DEHERM_DMSDK_UNIVERSAL_I64",
  u64: "DEHERM_DMSDK_UNIVERSAL_U64",
  f64: "DEHERM_DMSDK_UNIVERSAL_F64",
  address: "DEHERM_DMSDK_UNIVERSAL_ADDRESS",
  memory: "DEHERM_DMSDK_UNIVERSAL_MEMORY",
  callback: "DEHERM_DMSDK_UNIVERSAL_CALLBACK",
  "native-value": "DEHERM_DMSDK_UNIVERSAL_NATIVE_VALUE",
};
const wireTagNumber = {
  void: 0, bool: 1, i64: 2, u64: 3, f64: 4,
  address: 5, memory: 6, callback: 7, "native-value": 8,
};
const wireTagMask = (tags) => tags.reduce((mask, tag) => {
  assert.ok(Number.isSafeInteger(wireTagNumber[tag]), `Static exact runner has no numeric wire tag for ${tag}`);
  return mask | (1 << wireTagNumber[tag]);
}, 0) >>> 0;
const plannedArgumentTagMask = wireTagMask(plannedArgumentWireTags);
const plannedResultTagMask = wireTagMask(plannedResultWireTags);
const expectedAddressExpression = (cell, index) => {
  if (cell.fixture === "cstring") return `${prefix(index)}_return_cstring`;
  if (cell.fixture === "value-object") return `&${prefix(index)}_return_reference`;
  if (cell.fixture === "aligned-address-token") return `&${prefix(index)}_return_address`;
  return null;
};
const expectedResultCase = (vector, index) => {
  const cell = vector.result.fakeReturn;
  const tag = resultTag[cell.tag];
  assert.ok(tag, `vector ${index} result needs a known wire tag`);
  const statements = [`result.tag=${tag};`];
  if (cell.tag === "bool" || cell.tag === "u64") statements.push(`result.payload=UINT64_C(${cell.value});`);
  else if (cell.tag === "i64") statements.push(`result.payload=static_cast<uint64_t>(INT64_C(${cell.value}));`);
  else if (cell.tag === "f64") statements.push(`{const double value=${Number(cell.value).toFixed(2)};memcpy(&result.payload,&value,sizeof(value));}`);
  else if (cell.tag === "address") {
    const expression = expectedAddressExpression(cell, index);
    statements.push(expression
      ? `result.payload=static_cast<uint64_t>(reinterpret_cast<uintptr_t>(${expression}));`
      : `result.payload=UINT64_C(${cell.value});`);
  }
  return `case ${index}:{${statements.join("")}return result;}`;
};
const resultFieldAccessor = (name, expression) => `extern "C" uint32_t deherm_static_dmsdk_exact_result_${name}(uint32_t vector){const DehermDmSdkUniversalValue result=deherm_static_dmsdk_exact_expected_result(vector);return static_cast<uint32_t>(${expression});}`;
const fixtureSource = `${generated.verificationSource}
#include "static_dmsdk_exact_fixture.h"
static DehermDmSdkUniversalValue deherm_static_dmsdk_exact_expected_result(uint32_t vector){DehermDmSdkUniversalValue result{};switch(vector){${vectors.map(expectedResultCase).join("")}default:result.tag=UINT32_MAX;return result;}}
extern "C" uint32_t deherm_static_dmsdk_exact_vector_count(void){return UINT32_C(${vectors.length});}
extern "C" uint32_t deherm_static_dmsdk_exact_corpus_vector_count(void){return UINT32_C(${applicability.vectorCount});}
extern "C" uint32_t deherm_static_dmsdk_exact_blocked_vector_count(void){return UINT32_C(${applicability.blockedVectorCount});}
extern "C" uint32_t deherm_static_dmsdk_exact_planned_maximum_argument_count(void){return UINT32_C(${plannedMaximumArgumentCount});}
extern "C" uint32_t deherm_static_dmsdk_exact_planned_argument_tag_mask(void){return UINT32_C(${plannedArgumentTagMask});}
extern "C" uint32_t deherm_static_dmsdk_exact_planned_result_tag_mask(void){return UINT32_C(${plannedResultTagMask});}
extern "C" uint32_t deherm_static_dmsdk_exact_vector_id(uint32_t vector){switch(vector){${switchExpression((index) => `UINT32_C(${vectors[index].numericId})`)}default:return UINT32_MAX;}}
extern "C" uint32_t deherm_static_dmsdk_exact_argument_count(uint32_t vector){switch(vector){${switchExpression((index) => `UINT32_C(${vectors[index].argumentCount})`)}default:return UINT32_MAX;}}
${fieldAccessor("payload_low", "payload")}
${fieldAccessor("payload_high", "payload>>32u")}
${fieldAccessor("auxiliary_low", "auxiliary")}
${fieldAccessor("auxiliary_high", "auxiliary>>32u")}
${fieldAccessor("tag", "tag")}
${fieldAccessor("type_id", "type_id")}
${resultFieldAccessor("payload_low", "result.payload")}
${resultFieldAccessor("payload_high", "result.payload>>32u")}
${resultFieldAccessor("auxiliary_low", "result.auxiliary")}
${resultFieldAccessor("auxiliary_high", "result.auxiliary>>32u")}
${resultFieldAccessor("tag", "result.tag")}
${resultFieldAccessor("type_id", "result.type_id")}
`;

const staticTransport = (await readFile("packages/static-hermes/src/generated/dmsdk-universal.ts", "utf8"))
  .replaceAll("export ", "");
const extern = (name, parameters) => `const __${name}=$SHBuiltin.extern_c({include:"static_dmsdk_exact_fixture.h"},function deherm_static_dmsdk_exact_${name}(${parameters}):c_uint{throw 0;});`;
const runnerSource = `${staticTransport}
${extern("vector_count", "")}
${extern("corpus_vector_count", "")}
${extern("vector_id", "vector:c_uint")}
${extern("argument_count", "vector:c_uint")}
${extern("argument_payload_low", "vector:c_uint,slot:c_uint")}
${extern("argument_payload_high", "vector:c_uint,slot:c_uint")}
${extern("argument_auxiliary_low", "vector:c_uint,slot:c_uint")}
${extern("argument_auxiliary_high", "vector:c_uint,slot:c_uint")}
${extern("argument_tag", "vector:c_uint,slot:c_uint")}
${extern("argument_type_id", "vector:c_uint,slot:c_uint")}
${extern("result_payload_low", "vector:c_uint")}
${extern("result_payload_high", "vector:c_uint")}
${extern("result_auxiliary_low", "vector:c_uint")}
${extern("result_auxiliary_high", "vector:c_uint")}
${extern("result_tag", "vector:c_uint")}
${extern("result_type_id", "vector:c_uint")}
const __exactReport=$SHBuiltin.extern_c({include:"static_dmsdk_exact_fixture.h"},function deherm_static_dmsdk_exact_report(planned:c_uint,applicable:c_uint,executed:c_uint,mismatches:c_uint,maximumArgumentCount:c_uint,argumentTagMask:c_uint,resultTagMask:c_uint):void{});
let plannedVectorCount:number=__corpus_vector_count();
let applicableVectorCount:number=__vector_count();
let executedVectorCount:number=0,mismatches:number=0,maximumArgumentCount:number=0,argumentTagMask:number=0,resultTagMask:number=0;
for(let vector=0;vector<applicableVectorCount;++vector){let count:number=__argument_count(vector);if(count>maximumArgumentCount)maximumArgumentCount=count;let cells:Array<DehermStaticDmSdkCell>=[];for(let slot=0;slot<count;++slot){let tag:number=__argument_tag(vector,slot);argumentTagMask=argumentTagMask|(1<<tag);cells.push(new DehermStaticDmSdkCell(__argument_payload_low(vector,slot),__argument_payload_high(vector,slot),__argument_auxiliary_low(vector,slot),__argument_auxiliary_high(vector,slot),tag,__argument_type_id(vector,slot)));}let result=dispatchDmSdkUniversalFrame(__vector_id(vector),cells);let expectedResultTag:number=__result_tag(vector);resultTagMask=resultTagMask|(1<<expectedResultTag);if(result.payloadLow!==__result_payload_low(vector)||result.payloadHigh!==__result_payload_high(vector)||result.auxiliaryLow!==__result_auxiliary_low(vector)||result.auxiliaryHigh!==__result_auxiliary_high(vector)||result.tag!==expectedResultTag||result.typeId!==__result_type_id(vector))++mismatches;++executedVectorCount;}
__exactReport(plannedVectorCount,applicableVectorCount,executedVectorCount,mismatches,maximumArgumentCount,argumentTagMask,resultTagMask);
class DehermStaticDmSdkExactApp { init():void{} final():void{} }
globalThis.__defoldAppV1=new DehermStaticDmSdkExactApp();
`;

await mkdir(outputDirectory, { recursive: true });
const headerPath = path.join(outputDirectory, "static_dmsdk_exact_fixture.h");
const sourcePath = path.join(outputDirectory, "static_dmsdk_exact_fixture.cpp");
const inputPath = path.join(outputDirectory, "static-dmsdk-exact.ts");
const outputPath = path.join(outputDirectory, "static-dmsdk-exact.c");
const evidencePath = path.join(outputDirectory, "static-dmsdk-exact-evidence.json");
await Promise.all([
  writeFile(headerPath, fixtureHeader),
  writeFile(sourcePath, fixtureSource),
  writeFile(inputPath, runnerSource),
  writeFile(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    transport: "static-hermes-c-abi-bounded-frame",
    corpusSha256: corpus.report.corpusSha256,
    verificationManifestSha256: generated.verification.manifestSha256,
    plannedVectorCount: applicability.vectorCount,
    applicableVectorCount: applicability.applicableVectorCount,
    blockedVectorCount: applicability.blockedVectorCount,
    plannedExecutionVectorCount: vectors.length,
    plannedExecutionVectorSha256: vectors.map(({ vectorSha256 }) => vectorSha256),
    plannedMaximumArgumentCount,
    plannedArgumentWireTags,
    plannedResultWireTags,
    runtimeReport: {
      executedVectorCount: "reported-by-sound-typed-runner",
      maximumExercisedArgumentCount: "reported-by-sound-typed-runner",
      exercisedArgumentWireTagMask: "reported-by-sound-typed-runner",
      exercisedResultWireTagMask: "reported-by-sound-typed-runner",
    },
    applicability,
    evidenceBoundary: "The emitted sound-typed Static Hermes unit copies every applicable generator-owned exact vector cell into DehermDmSdkUniversalStaticFrame/v1, dispatches through the production bounded C ABI, observes the generated exact wrapper and recording fake callee, and compares all six returned wire-cell fields plus exact call/failure observations with generator-owned native expectations. Applicability is derived only from the compiler-owned frame capacity and wire-tag capability; every canonical vector remains in the report with either execute or blocked-capability disposition and machine-readable blockers. The native exact driver runs first to initialize address-bearing fixtures, including C-string result identity checked by Static Hermes; observations are reset before Static Hermes runs. This does not execute Defold implementation semantics or prove retained handle/callback ownership lifecycles.",
  }, null, 2)}\n`),
]);
const result = spawnSync(shermes, ["-typed", "-strict", "-O", "-emit-c", "-exported-unit=deherm_static_dmsdk_exact", inputPath, "-o", outputPath], { cwd: process.cwd(), encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(`Static Hermes dmSDK exact-call unit emitted ${outputPath}`);
