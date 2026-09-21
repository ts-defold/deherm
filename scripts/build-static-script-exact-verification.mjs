import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  materializeStaticScriptExactVectors,
  parseStaticScriptExactValue,
} from "../packages/compiler/src/script-static-exact-verification.mjs";
import { renderStaticHermes } from "./generate-script-universal-value-bindings.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const shermes = args.get("--shermes");
const outputDirectory = args.get("--output-dir");
assert.ok(shermes, "--shermes is required");
assert.ok(outputDirectory, "--output-dir is required");

const recording = JSON.parse(await readFile(
  "packages/bindings/generated/defold-script-recording-engine.json", "utf8"));
const layouts = JSON.parse(await readFile(
  "packages/bindings/generated/defold-value-layouts.json", "utf8"));
const { report, vectors } = materializeStaticScriptExactVectors(recording);
const staticTransport = renderStaticHermes(layouts, { verification: true })
  .replace(/^export \{.*\};$/m, "");

function shapeExpression(shapeIndex, specification) {
  const value = parseStaticScriptExactValue(recording, shapeIndex, specification);
  switch (value.kind) {
    case "boolean": return `new DehermStaticBoolean(${value.value ? "true" : "false"})`;
    case "number": return `new DehermStaticNumber(${JSON.stringify(value.value)})`;
    case "string": return `new DehermStaticString(${JSON.stringify(value.value)})`;
    case "hash": return `new DehermStaticHandle(1,0,0,${value.low},${value.high})`;
    case "url": return `new DehermStaticUrl(${value.halves.join(",")})`;
    case "vector3": return `new DehermStaticDefoldValue(1,${value.lanes.join(",")},0)`;
    case "vector4": return `new DehermStaticDefoldValue(2,${value.lanes.join(",")})`;
    case "quaternion": return `new DehermStaticDefoldValue(3,${value.lanes.join(",")})`;
    case "matrix4": return `new DehermStaticMatrix4([${value.lanes.join(",")}])`;
    default: throw new Error(`Static Hermes exact runner cannot construct ${value.kind}`);
  }
}

function shapePredicate(shapeIndex, specification, expression) {
  const value = parseStaticScriptExactValue(recording, shapeIndex, specification);
  switch (value.kind) {
    case "boolean":
      return `${expression}.exactTag()===2&&${expression}.exactNumber(0)===${value.value ? 1 : 0}`;
    case "number":
      return `${expression}.exactTag()===3&&${expression}.exactNumber(0)===${JSON.stringify(value.value)}`;
    case "string":
      return `${expression}.exactTag()===4&&${expression}.exactString()===${JSON.stringify(value.value)}`;
    case "hash":
      return `${expression}.exactTag()===5&&${expression}.exactNumber(0)===1&&${expression}.exactNumber(1)===0&&${expression}.exactNumber(2)===0&&${expression}.exactNumber(3)===${value.low}&&${expression}.exactNumber(4)===${value.high}`;
    case "url":
      return `${expression}.exactTag()===8&&${value.halves.map((half, index) =>
        `${expression}.exactNumber(${index})===${half}`).join("&&")}`;
    case "vector3":
    case "vector4":
    case "quaternion": {
      const kind = value.kind === "vector3" ? 1 : value.kind === "vector4" ? 2 : 3;
      const lanes = value.kind === "vector3" ? [...value.lanes, 0] : value.lanes;
      return `${expression}.exactTag()===6&&${expression}.exactNumber(0)===${kind}&&${lanes.map((lane, index) =>
        `${expression}.exactNumber(${index + 1})===${lane}`).join("&&")}`;
    }
    case "matrix4":
      return `${expression}.exactTag()===7&&${value.lanes.map((lane, index) =>
        `${expression}.exactNumber(${index})===${lane}`).join("&&")}`;
    default: throw new Error(`Static Hermes exact runner cannot compare ${value.kind}`);
  }
}

const executions = vectors.map((vector, vectorIndex) => {
  const arguments_ = vector.argumentShapes.map((shape, slot) =>
    shapeExpression(shape, vector.argumentValues[slot]));
  const predicates = vector.resultShapes.map((shape, slot) =>
    shapePredicate(shape, vector.resultValues[slot], `results${vectorIndex}[${slot}]`));
  return `let results${vectorIndex}:Array<DehermStaticValue>=dispatchScriptUniversalValue(${vector.stableId},[${arguments_.join(",")}]);if(results${vectorIndex}.length!==${vector.resultShapes.length}${predicates.length ? `||!(${predicates.join("&&")})` : ""})++mismatches;++executed;`;
}).join("\n");

const runnerSource = `${staticTransport}
const __staticScriptExactReport=$SHBuiltin.extern_c({include:"static_script_exact_fixture.h"},function deherm_static_script_exact_report(planned:c_uint,executed:c_uint,mismatches:c_uint):void{});
let executed:number=0,mismatches:number=0;
${executions}
__staticScriptExactReport(${vectors.length},executed,mismatches);
class DehermStaticScriptExactApp { init():void{} final():void{} }
globalThis.__defoldAppV1=new DehermStaticScriptExactApp();
`;

const header = `#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
uint32_t deherm_static_script_exact_vector_count(void);
uint32_t deherm_static_script_exact_route_index(uint32_t vector);
uint32_t deherm_static_script_exact_stable_id(uint32_t vector);
uint32_t deherm_static_script_exact_argument_count(uint32_t vector);
const char* deherm_static_script_exact_expected_arguments(uint32_t vector);
const char* deherm_static_script_exact_route_id(uint32_t vector);
void deherm_static_script_exact_report(uint32_t planned,uint32_t executed,uint32_t mismatches);
#ifdef __cplusplus
}
#endif
`;
const switchRows = (expression) => vectors.map((vector, index) =>
  `case UINT32_C(${index}):return ${expression(vector)};`).join("");
const fixture = `#include "static_script_exact_fixture.h"
#include <cstdint>
extern "C" uint32_t deherm_static_script_exact_vector_count(void){return UINT32_C(${vectors.length});}
extern "C" uint32_t deherm_static_script_exact_route_index(uint32_t vector){switch(vector){${switchRows((vector) => `UINT32_C(${vector.routeIndex})`)}default:return UINT32_MAX;}}
extern "C" uint32_t deherm_static_script_exact_stable_id(uint32_t vector){switch(vector){${switchRows((vector) => `UINT32_C(${vector.stableId})`)}default:return UINT32_MAX;}}
extern "C" uint32_t deherm_static_script_exact_argument_count(uint32_t vector){switch(vector){${switchRows((vector) => `UINT32_C(${vector.argumentShapes.length})`)}default:return UINT32_MAX;}}
extern "C" const char* deherm_static_script_exact_expected_arguments(uint32_t vector){switch(vector){${switchRows((vector) => JSON.stringify(vector.argumentValues.join(" ")))}default:return "";}}
extern "C" const char* deherm_static_script_exact_route_id(uint32_t vector){switch(vector){${switchRows((vector) => JSON.stringify(vector.id))}default:return "";}}
`;

await mkdir(outputDirectory, { recursive: true });
const headerPath = path.join(outputDirectory, "static_script_exact_fixture.h");
const fixturePath = path.join(outputDirectory, "static_script_exact_fixture.cpp");
const inputPath = path.join(outputDirectory, "static-script-exact.ts");
const outputPath = path.join(outputDirectory, "static-script-exact.c");
const evidencePath = path.join(outputDirectory, "static-script-exact-evidence.json");
await Promise.all([
  writeFile(headerPath, header),
  writeFile(fixturePath, fixture),
  writeFile(inputPath, runnerSource),
  writeFile(evidencePath, `${JSON.stringify({ ...report, vectors }, null, 2)}\n`),
]);
const result = spawnSync(shermes, [
  "-typed", "-strict", "-O", "-emit-c",
  "-exported-unit=deherm_static_script_exact", inputPath, "-o", outputPath,
], { cwd: process.cwd(), encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(`Static Hermes script exact-call unit emitted ${outputPath}`);
