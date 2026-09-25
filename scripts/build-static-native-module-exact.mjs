import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const shermes = args.get("--shermes");
const outputDirectory = args.get("--output-dir");
assert.ok(shermes, "--shermes is required");
assert.ok(outputDirectory, "--output-dir is required");

const lowLevelPath = "extensions/defold-webtransport/defold_webtransport/webtransport/static/NativeWebTransport.ts";
const lowLevel = (await readFile(lowLevelPath, "utf8")).replace(/^export /gmu, "");
const certificate = `[${Array.from({ length: 32 }, (_, index) => index).join(",")}]`;
const firstPoll = `[${new Array(64).fill(238).join(",")}]`;
const secondPoll = `[${new Array(64).fill(0).join(",")}]`;
const source = `${lowLevel}
const __report=$SHBuiltin.extern_c({include:"static_native_module_exact_fixture.h"},function deherm_static_native_module_exact_report(planned:c_uint,executed:c_uint,mismatches:c_uint):void{});
let executed:number=0,mismatches:number=0;
const certificate:Array<number>=${certificate};
const handle:number=NativeWebTransport.open("https://host/game/✓",certificate,64,8);++executed;if(handle!==73)++mismatches;
const state:number=NativeWebTransport.state(handle);++executed;if(state!==2)++mismatches;
const maximum:number=NativeWebTransport.maxDatagramBytes(handle);++executed;if(maximum!==1200)++mismatches;
let status:number=NativeWebTransport.openBidirectionalStream(handle,11);++executed;if(status!==0)++mismatches;
status=NativeWebTransport.openUnidirectionalStream(handle,12);++executed;if(status!==0)++mismatches;
status=NativeWebTransport.writeStream(handle,91,[9,8,7,6],true);++executed;if(status!==0)++mismatches;
status=NativeWebTransport.resetStream(handle,91,41);++executed;if(status!==0)++mismatches;
status=NativeWebTransport.stopSending(handle,91,42);++executed;if(status!==0)++mismatches;
status=NativeWebTransport.trySendDatagram(handle,[5,4,3]);++executed;if(status!==1)++mismatches;
const tooSmall:Array<number>=${firstPoll};
status=NativeWebTransport.poll(handle,tooSmall);if(status!==-4||tooSmall[20]!==3||tooSmall[28]!==1||tooSmall[40]!==238)++mismatches;
const output:Array<number>=${secondPoll};
status=NativeWebTransport.poll(handle,output);++executed;if(status!==0||output[0]!==3||output[4]!==1||output[12]!==11||output[16]!==91||output[20]!==3||output[28]!==1||output[32]!==170||output[34]!==204)++mismatches;
status=NativeWebTransport.close(handle,43,"done✓");++executed;if(status!==0)++mismatches;
status=NativeWebTransport.destroy(handle);++executed;if(status!==0)++mismatches;
__report(12,executed,mismatches);
class StaticNativeModuleExactApp{init():void{} final():void{}}
globalThis.__defoldAppV1=new StaticNativeModuleExactApp();
`;
const header = `#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void deherm_static_native_module_exact_report(uint32_t planned,uint32_t executed,uint32_t mismatches);
#ifdef __cplusplus
}
#endif
`;

await mkdir(outputDirectory, { recursive: true });
const inputPath = path.join(outputDirectory, "static-native-module-exact.ts");
const outputPath = path.join(outputDirectory, "static-native-module-exact.c");
const headerPath = path.join(outputDirectory, "static_native_module_exact_fixture.h");
await Promise.all([
  writeFile(inputPath, source),
  writeFile(headerPath, header),
]);
const result = spawnSync(shermes, [
  "-typed", "-strict", "-O", "-emit-c",
  "-exported-unit=deherm_static_native_module_exact", inputPath, "-o", outputPath,
], { cwd: process.cwd(), encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(`Static Hermes native-module exact-call unit emitted ${outputPath}`);
