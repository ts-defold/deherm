import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveCStringContracts } from "../scripts/generate-dmsdk-cstring-value-bindings.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const reportPath=path.join(root,"bindings/generated/defold-dmsdk-cstring-value-bindings.json");
const sdk=path.join(root,"upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const cxx=process.env.CXX||"clang++";const cc=process.env.CC||"clang";
const run=(command,args,options={})=>execFileSync(command,args,{cwd:root,encoding:"utf8",stdio:"pipe",...options});
const privateDefine="-DDEHERM_ENABLE_PRIVATE_DMSDK_CSTRING_VALUE=1";
const includes=[privateDefine,`-I${path.join(root,"defold/defold_hermes/include")}`,"-isystem",path.join(sdk,"sdk/include"),"-isystem",path.join(sdk,"include")];

test("C-string/value selection is exhaustive, mechanical, and fail-closed",async()=>{
  const report=JSON.parse(await readFile(reportPath,"utf8"));
  assert.deepEqual(report.coverage,{candidates:20,generated:14,blocked:6,nativeAbiGenerated:14,headerObjectCompiled:0,pinnedEngineLinked:0,stubAbiLinkedAndRuntimeTested:0,nativeDynamicHermesAdapterGenerated:14,nativeStaticHermesDirectMemoryAbiGenerated:14,browserDirectMemoryDescriptorGenerated:14,allTargetConformant:0});
  assert.equal(report.declarations.length,20);assert.equal(new Set(report.declarations.map(({id})=>id)).size,20);
  assert.equal(new Set(report.declarations.map(({projectionId})=>projectionId)).size,20);
  assert.equal(new Set(report.declarations.map(({stableId})=>stableId)).size,20);
  assert.equal(report.declarations.filter(({disposition})=>disposition==="generated").length,14);
  assert.equal(report.declarations.filter(({disposition})=>disposition==="blocked").length,6);
  assert.match(report.selector,/independent of lowering\/evidence disposition/);
  const generator=await readFile(path.join(root,"scripts/generate-dmsdk-cstring-value-bindings.mjs"),"utf8");
  assert.doesNotMatch(generator,/row\.loweringState/);
  assert.doesNotMatch(generator,/symbol\.includes\(/);
  for(const row of report.declarations){assert.match(row.id,/^dmsdk:/);assert.match(row.projectionId,/^dmsdk-projection:/);if(row.disposition==="blocked")assert.ok(row.blocker);}
  for(const row of report.declarations.filter(({disposition})=>disposition==="generated")){
    assert.ok(row.stringContract?.id,row.id);
    if(row.stringContract.input){assert.equal(row.stringContract.input.nullability,"non-null");assert.equal(row.stringContract.input.encoding,"js-string-utf8-no-embedded-nul");}
    if(row.stringContract.result)assert.equal(row.stringContract.result.encoding,"native-null-terminated-bytes-decoded-as-utf8");
  }
  assert.equal(report.coverage.headerObjectCompiled,0);assert.equal(report.coverage.stubAbiLinkedAndRuntimeTested,0);assert.equal(report.coverage.pinnedEngineLinked,0);assert.equal(report.coverage.allTargetConformant,0);
});

test("C-string semantic contracts fail closed on unresolved rows, overlap, and declaration drift",async()=>{
  const [report,projection,policy]=await Promise.all([
    readFile(reportPath,"utf8").then(JSON.parse),
    readFile(path.join(root,"bindings/generated/defold-dmsdk-projection-ir.json"),"utf8").then(JSON.parse),
    readFile(path.join(root,"bindings/overrides/dmsdk-cstring-value-bindings.json"),"utf8").then(JSON.parse)
  ]);
  const ids=new Set(report.declarations.map(({id})=>id));
  const candidates=projection.rows.filter(({id})=>ids.has(id));

  const unresolved=structuredClone(policy);
  unresolved.stringContractRules=unresolved.stringContractRules.filter(({id})=>id!=="hash-input-js-utf8");
  const unresolvedRows=resolveCStringContracts(candidates,unresolved);
  assert.equal(unresolvedRows.filter(({rule})=>rule?.id==="cstring-semantic-contract-unresolved").length,2);

  const overlap=structuredClone(policy);
  overlap.stringContractRules.push({...structuredClone(overlap.stringContractRules[0]),id:"overlapping-contract"});
  assert.throws(()=>resolveCStringContracts(candidates,overlap),/overlapping C-string contract rules/);

  const drift=structuredClone(policy);
  drift.stringContractRules[0].declarationIds[0]="dmsdk:removed-or-renamed-declaration";
  assert.throws(()=>resolveCStringContracts(candidates,drift),/contract declaration drifted or is not a candidate/);

  const unsupported=structuredClone(policy);
  unsupported.inputContractTokens.encoding=["unchecked-native-bytes"];
  unsupported.stringContractRules.find(({input})=>input).input.encoding="unchecked-native-bytes";
  assert.throws(()=>resolveCStringContracts(candidates,unsupported),/token catalog differs from generator capabilities/);
});

test("selected value algebra and generated storage are exact and census-derived",async()=>{
  const [report,projection]=await Promise.all([readFile(reportPath,"utf8").then(JSON.parse),readFile(path.join(root,"bindings/generated/defold-dmsdk-projection-ir.json"),"utf8").then(JSON.parse)]);
  const selected=report.declarations.map(({id})=>projection.rows.find((row)=>row.id===id));
  assert.equal(selected.filter(Boolean).length,20);
  for(const row of selected){
    const result=row.signature.result;
    assert.ok(result.kind==="void"||result.kind==="enum"||result.kind==="cstring"||(result.kind==="scalar"&&["bool","i32","u32","u64"].includes(result.name)),row.id);
    for(const {type} of row.signature.parameters)assert.ok(type.kind==="cstring"||type.kind==="enum"||(type.kind==="scalar"&&["u32","u64"].includes(type.name)),row.id);
  }
  const generated=selected.filter((row)=>report.declarations.find(({id})=>id===row.id).disposition==="generated");
  const strings=Math.max(1,...generated.map((row)=>row.signature.parameters.filter(({type})=>type.kind==="cstring").length));
  const scalars=Math.max(1,...generated.map((row)=>row.signature.parameters.filter(({type})=>type.kind!=="cstring").length));
  assert.deepEqual(report.abi.storage,{strings,scalars});
  assert.match(report.abi.enumInput,/exact declared-value membership/);
  assert.deepEqual(report.abi.enumDomains["dmBuffer::Result"].at(-1),{name:"dmBuffer::RESULT_METADATA_MISSING",value:11});
  assert.ok(!report.abi.enumDomains["dmBuffer::ValueType"].some(({name})=>name.endsWith("MAX_VALUE_TYPE_COUNT")));
  assert.match(report.abi.output,/capacity == required is too small/);
  const [native,jsi,runtime,header,browser]=await Promise.all([
    readFile(path.join(root,"defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp"),"utf8"),
    readFile(path.join(root,"defold/defold_hermes/src/generated_dmsdk_cstring_value_jsi.cpp"),"utf8"),
    readFile(path.join(root,"defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp"),"utf8"),
    readFile(path.join(root,"defold/defold_hermes/include/defold_hermes/generated_dmsdk_cstring_value.h"),"utf8"),
    readFile(path.join(root,"defold/defold_hermes/lib/web/generated_dmsdk_cstring_value.js"),"utf8")
  ]);
  assert.match(native,new RegExp(`native_strings\\[${strings}\\]`));assert.match(jsi,new RegExp(`encoded\\[${strings}\\]`));assert.match(jsi,new RegExp(`scalars\\[${scalars}\\]`));
  assert.match(native,/!native_result&&!descriptor\.nullable_result/);
  assert.match(native,/bool decode_dmBuffer__Result/);
  assert.match(native,/value==static_cast<Underlying>\(dmBuffer::RESULT_METADATA_MISSING\)/);
  assert.doesNotMatch(native,/\*output=static_cast<Enum>/);
  assert.match(header,/DEHERM_DMSDK_CSTRING_UNEXPECTED_NULL_RESULT=9/);
  assert.match(jsi,/isString\(\).*\.utf8\(runtime\)/s);
  assert.match(jsi,/dmSDK non-null C-string result was absent/);
  assert.match(jsi,/case DEHERM_DMSDK_CSTRING_SCALAR_RANGE:return "scalar or enum outside generated domain"/);
  assert.doesNotMatch(jsi,/dmSDK C-string dispatch failed/);
  assert.match(runtime,/DEHERM_DMSDK_CSTRING_EMBEDDED_NUL/);
  assert.match(browser,/outputLayout:Object\.freeze\(\{scalarBytes:8,requiredBytes:4,presentBytes:1,capacityIncludesTrailingNul:true\}\)/);
  assert.match(browser,/scalarKinds:Object\.freeze\(\["enum:dmBuffer::Result"\]\),resultKind:"cstring",resultLaneBytes:1,nullableResult:false/);
  assert.match(browser,/resultKind:"cstring",resultLaneBytes:1,nullableResult:true/);
});

test("canonical target plan keeps staged wrappers private until runtime backends emit",async()=>{
  const [report,plan,barrel,installer,cmake,native,runtime,staticHermes]=await Promise.all([
    readFile(reportPath,"utf8").then(JSON.parse),readFile(path.join(root,"bindings/generated/defold-binding-lowering-plan.json"),"utf8").then(JSON.parse),
    readFile(path.join(root,"packages/sdk/src/generated/dmsdk/index.ts"),"utf8"),readFile(path.join(root,"defold/defold_hermes/src/generated_jsi.cpp"),"utf8"),readFile(path.join(root,"CMakeLists.txt"),"utf8"),
    readFile(path.join(root,"defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp"),"utf8"),readFile(path.join(root,"defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp"),"utf8"),readFile(path.join(root,"packages/static-hermes/src/generated/dmsdk-cstring-value.ts"),"utf8")
  ]);
  for(const declaration of report.declarations.filter(({disposition})=>disposition==="generated")){
    const unit=plan.units.find(({identity})=>identity.id===declaration.id);assert.ok(unit,declaration.id);
    assert.equal(unit.backends.typescriptSdk.selection,"emit");
    for(const target of ["dynamicHermesJsi","staticHermesCAbi","browserWasmHost"])assert.notEqual(unit.backends[target].selection,"emit",`${declaration.id}:${target}`);
    assert.match(declaration.targetDisposition.nativeDynamicHermes,/staged-private/);
  }
  assert.doesNotMatch(barrel,/cstring-value/);assert.doesNotMatch(installer,/installDmSdkCStringValueModule/);
  const productionRuntime=cmake.slice(cmake.indexOf("add_library(defold-hermes-runtime"),cmake.indexOf("add_executable(defold-hermes-runner"));
  assert.doesNotMatch(productionRuntime,/generated_dmsdk_cstring_value/);
  assert.match(native,/DEHERM_ENABLE_PRIVATE_DMSDK_CSTRING_VALUE/);assert.match(runtime,/DEHERM_ENABLE_PRIVATE_DMSDK_CSTRING_VALUE/);
  assert.match(staticHermes,/\):c_uint/);assert.doesNotMatch(staticHermes,/\):c_uchar/);
});

test("C-string/value artifacts regenerate deterministically",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"deherm-cstring-generate-"));
  try{run(process.execPath,["scripts/generate-dmsdk-cstring-value-bindings.mjs","--output-root",directory]);const report=JSON.parse(await readFile(reportPath,"utf8"));for(const artifact of [...report.artifacts,"bindings/generated/defold-dmsdk-cstring-value-bindings.json"])assert.equal(await readFile(path.join(directory,artifact),"utf8"),await readFile(path.join(root,artifact),"utf8"),artifact);}finally{await rm(directory,{recursive:true,force:true});}
});

test("generated sources compile against the complete pinned SDK",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"deherm-cstring-objects-"));
  try{for(const [index,source] of ["defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp","defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp","defold/defold_hermes/src/generated_dmsdk_cstring_value_jsi.cpp"].entries())run(cxx,["-std=c++17","-Wall","-Wextra","-Werror","-pedantic",...includes,`-I${path.join(root,"upstream/hermes/API")}`,"-c",source,"-o",path.join(directory,`${index}.o`)]);}finally{await rm(directory,{recursive:true,force:true});}
});

test("public ABI is C-compatible and codec runtime is reentrant with zero warmed C++ allocations",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"deherm-cstring-runtime-"));
  try{
    const cSource=path.join(directory,"caller.c");const cObject=path.join(directory,"caller.o");
    await writeFile(cSource,"#include <stdint.h>\n#include <defold_hermes/generated_dmsdk_cstring_value.h>\n_Static_assert(sizeof(DehermDmSdkCStringStatus)==sizeof(uint32_t),\"status width\");\nint probe(void){DehermDmSdkCStringView v={0,0};return (int)v.length;}\n");
    run(cc,["-std=c11","-Wall","-Wextra","-Werror","-pedantic",...includes,"-c",cSource,"-o",cObject]);
    const executable=path.join(directory,"runtime");run(cxx,["-std=c++17","-Wall","-Wextra","-Werror","-pedantic",...includes,"defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp","defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp","native/dmsdk_cstring_value_test.cpp","-o",executable]);
    assert.equal(run(executable,[]).trim(),"dmsdk-cstring-value:ok");
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("generated C ABI contains no explicit heap allocation",async()=>{
  for(const source of ["defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp","defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp"]){const content=await readFile(path.join(root,source),"utf8");assert.doesNotMatch(content,/\b(?:new|delete|malloc|calloc|realloc|free)\b/,source);}
});
