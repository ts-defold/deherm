import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ingestNativeExtensionHeader, renderNativeExtensionBindings } from "../packages/compiler/src/native-extension-generator.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixture = path.join(root, "tests/fixtures/native-extension/sample_extension.h");

test("arbitrary extension headers deterministically produce ABI IR, TypeScript, C glue, and explicit blockers", async () => {
  const first = ingestNativeExtensionHeader({ header: fixture, moduleName: "sample" });
  const second = ingestNativeExtensionHeader({ header: fixture, moduleName: "sample" });
  assert.deepEqual(first, second);
  assert.deepEqual(first.routes.map(({ symbol, disposition }) => [symbol, disposition]), [
    ["sample_accumulate", "generated-c-abi"], ["sample_apply", "generated-c-abi"],
    ["sample_label", "generated-c-abi"], ["sample_translate", "cataloged-needs-layout"],
  ]);
  assert.deepEqual(first.enums[0].values, [{ name: "SAMPLE_MODE_ADD", value: 0 }, { name: "SAMPLE_MODE_MULTIPLY", value: 1 }]);
  const generated = renderNativeExtensionBindings(first);
  assert.equal(generated.generatedRouteCount, 3);
  assert.equal(generated.blockedRouteCount, 1);
  assert.match(generated.typescript, /accumulate\(value:number,delta:number\):number/);
  assert.match(generated.typescript, /blocked: parameter-0:record:SamplePoint/);
  assert.match(generated.source, /deherm_ext_sample_dispatch/);

  const output = await mkdtemp(path.join(tmpdir(), "deherm-native-extension-"));
  try {
    const glue = path.join(output, "glue.cpp"), implementation = path.join(output, "implementation.cpp"), harness = path.join(output, "harness.cpp"), executable = path.join(output, "test");
    await writeFile(glue, generated.source);
    await writeFile(implementation, `#include <sample_extension.h>\nextern "C" uint32_t sample_accumulate(uint32_t value,int32_t delta){return value+delta;}\nextern "C" double sample_apply(double value,SampleMode mode){return mode==SAMPLE_MODE_MULTIPLY?value*2:value+2;}\nextern "C" const char* sample_label(SampleMode mode){return mode==SAMPLE_MODE_ADD?"add":"multiply";}\nextern "C" SamplePoint sample_translate(SamplePoint point,float x,float y){return {point.x+x,point.y+y};}\n`);
    await writeFile(harness, `#include <defold_hermes/generated_dmsdk_universal.h>\n#include <stdint.h>\n#include <string.h>\nextern "C" DehermDmSdkUniversalStatus deherm_ext_sample_dispatch(uint32_t,const DehermDmSdkUniversalValue*,uint32_t,DehermDmSdkUniversalValue*);\nint main(){DehermDmSdkUniversalValue a[2]={{7,0,DEHERM_DMSDK_UNIVERSAL_U64,0},{static_cast<uint64_t>(static_cast<int64_t>(-2)),0,DEHERM_DMSDK_UNIVERSAL_I64,0}},r={};if(deherm_ext_sample_dispatch(0,a,2,&r)!=DEHERM_DMSDK_UNIVERSAL_OK||r.payload!=5)return 1;double d=3.5;memcpy(&a[0].payload,&d,8);a[0].tag=DEHERM_DMSDK_UNIVERSAL_F64;a[1]={1,0,DEHERM_DMSDK_UNIVERSAL_I64,0};if(deherm_ext_sample_dispatch(1,a,2,&r)!=DEHERM_DMSDK_UNIVERSAL_OK)return 2;memcpy(&d,&r.payload,8);if(d!=7)return 3;if(deherm_ext_sample_dispatch(3,a,2,&r)!=DEHERM_DMSDK_UNIVERSAL_UNKNOWN_ID)return 4;return 0;}\n`);
    execFileSync(process.env.CXX ?? "clang++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${path.join(root, "defold/defold_hermes/include")}`, `-I${path.dirname(fixture)}`, glue, implementation, harness, "-o", executable], { cwd: root, stdio: "pipe" });
    execFileSync(executable, [], { stdio: "pipe" });
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("CLI exposes header-to-IR generation and reports layout blockers", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-native-extension-cli-"));
  try {
    const result = spawnSync(process.execPath, ["bin/deherm.mjs", "generate-extension-api", "--header", fixture, "--module", "sample", "--output", output, "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual({ generated: report.generatedRouteCount, blocked: report.blockedRouteCount }, { generated: 3, blocked: 1 });
    assert.equal(JSON.parse(await readFile(path.join(output, "extension.ir.json"), "utf8")).routes.length, 4);
    assert.match(await readFile(path.join(output, "sample_glue.cpp"), "utf8"), /deherm_ext_sample_dispatch/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
