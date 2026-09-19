import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const shermes = args.get("--shermes");
const outputDirectory = args.get("--output-dir");
// The typed-native lane handed to the C emitter. Development compiles the
// complete lane on purpose; a release projection points this at its pruned
// re-render so the emitted C carries no symbol for an unreachable route.
const typedNativeSource = args.get("--typed-native-source")
  ?? "packages/static-hermes/src/generated/script-vmath.ts";
assert.ok(shermes, "--shermes is required");
assert.ok(outputDirectory, "--output-dir is required");

await mkdir(outputDirectory, { recursive: true });
const generatedFfi = await readFile("packages/static-hermes/src/generated/ffi.js", "utf8");
const generatedVmath = await readFile(typedNativeSource, "utf8");
const generatedUniversal = (await readFile("packages/static-hermes/src/generated/script-universal-value.ts", "utf8"))
  .replace(/^export \{.*\};$/m, "");
const universalReport = JSON.parse(await readFile("packages/bindings/generated/defold-script-universal-value-bindings.json", "utf8"));
const universalProbe = universalReport.bindings.find((binding) => binding.minimumArgumentCount <= 1 && binding.maximumArgumentCount >= 1 && binding.resultCount === 1 && !binding.shapeKinds.includes("callback"));
assert.ok(universalProbe, "Static Hermes universal probe needs a one-argument/one-result route");
const typedSource = `${generatedFfi}\n\nconst __ffi_deherm_static_probe_report = $SHBuiltin.extern_c(\n  {include: "defold_hermes/static_probe.h"},\n  function defold_hermes_static_probe_report(value: c_f64): void { throw 0; }\n);\n\n__ffi_deherm_static_probe_report(__ffi_ExampleMath_add(20, 22));\n`;
const typedInput = path.join(outputDirectory, "static-ffi.js");
const typedOutput = path.join(outputDirectory, "static-ffi.c");
const appOutput = path.join(outputDirectory, "static-app.c");
const vmathInput = path.join(outputDirectory, "static-vmath.ts");
const vmathOutput = path.join(outputDirectory, "static-vmath.c");
const universalInput = path.join(outputDirectory, "static-universal.ts");
const universalOutput = path.join(outputDirectory, "static-universal.c");
await writeFile(typedInput, typedSource);
await writeFile(vmathInput, `${generatedVmath}\n\nconst __ffi_deherm_static_vmath_report = $SHBuiltin.extern_c(\n  {include: "defold_hermes/static_probe.h"},\n  function defold_hermes_static_vmath_report(stage: c_u32, value: c_f64): void { throw 0; }\n);\n\n__ffi_deherm_static_vmath_report(1, vmathLengthVector3(3, 4, 12));\n__ffi_deherm_static_vmath_report(2, vmathLengthVector4(1, 2, 2, 4));\n__ffi_deherm_static_vmath_report(3, vmathLengthQuaternion(0, 0, 0, 1));\n__ffi_deherm_static_vmath_report(4, vmathProjectVector3Vector3(2, 4, 6, 1, 2, 3));\n__ffi_deherm_static_vmath_report(5, vmathLengthSqrVector3(3, 4, 12));\n__ffi_deherm_static_vmath_report(6, vmathLengthSqrVector4(1, 2, 3, 4));\n__ffi_deherm_static_vmath_report(7, vmathLengthSqrQuaternion(1, 2, 2, 0));\nlet projectZeroTargetRejected: number = 0;\ntry {\n  vmathProjectVector3Vector3(1, 2, 3, 0, 0, 0);\n} catch (error) {\n  projectZeroTargetRejected = 1;\n}\n__ffi_deherm_static_vmath_report(8, projectZeroTargetRejected);\n`);
const universalProbeSource = [
  generatedUniversal,
  "",
  `const __ffi_deherm_static_universal_report=$SHBuiltin.extern_c({include:"defold_hermes/static_probe.h"},function defold_hermes_static_universal_report(results:c_u32,recordEntries:c_u32):void{});`,
  `const __ffi_deherm_static_universal_value_report=$SHBuiltin.extern_c({include:"defold_hermes/static_probe.h"},function defold_hermes_static_universal_value_report(stage:c_u32,checksum:c_f64):void{});`,
  `let nestedValues:Array<DehermStaticValue>=[new DehermStaticBoolean(true),new DehermStaticNull()];`,
  `let matrixElements:Array<number>=[];`,
  `for(let element=0;element<16;++element)matrixElements.push(element+1);`,
  `let recordValues:Array<DehermStaticValue>=[new DehermStaticNumber(42),new DehermStaticString("basalt \\u2764"),new DehermStaticArray(nestedValues),new DehermStaticHandle(1,0,0,0x89abcdef,0x01234567),new DehermStaticDefoldValue(1,1,2,3,0),new DehermStaticMatrix4(matrixElements),new DehermStaticUrl(0x89abcdef,0x01234567,0,0,0xcafebabe,0xdeadbeef,0xff,0)];`,
  `let universalInputValues:Array<DehermStaticValue>=[new DehermStaticRecord(["scalar","text","array","hash","vector","matrix","url"],recordValues)];`,
  `let universalResults:Array<DehermStaticValue>=dispatchScriptUniversalValue(${universalProbe.stableId},universalInputValues);`,
  `__ffi_deherm_static_universal_report(universalResults.length,universalResults.length===1?universalResults[0].probeSize():0);`,
  // Each transparent Defold value record round-trips on its own so the reported
  // checksum proves the exact float32 and 64-bit lanes survived the typed frame.
  `let matrixResults:Array<DehermStaticValue>=dispatchScriptUniversalValue(${universalProbe.stableId},[new DehermStaticMatrix4(matrixElements)]);`,
  `__ffi_deherm_static_universal_value_report(1,matrixResults[0].probeChecksum());`,
  `let urlResults:Array<DehermStaticValue>=dispatchScriptUniversalValue(${universalProbe.stableId},[new DehermStaticUrl(0x89abcdef,0x01234567,0,0,0xcafebabe,0xdeadbeef,0xff,0)]);`,
  `__ffi_deherm_static_universal_value_report(2,urlResults[0].probeChecksum());`,
  `let hashResults:Array<DehermStaticValue>=dispatchScriptUniversalValue(${universalProbe.stableId},[new DehermStaticHandle(1,0,0,0x89abcdef,0x01234567)]);`,
  `__ffi_deherm_static_universal_value_report(3,hashResults[0].probeChecksum());`,
  `let vectorResults:Array<DehermStaticValue>=dispatchScriptUniversalValue(${universalProbe.stableId},[new DehermStaticDefoldValue(1,1.5,2.25,3.125,0)]);`,
  `__ffi_deherm_static_universal_value_report(4,vectorResults[0].probeChecksum());`,
  `__ffi_deherm_static_universal_value_report(5,matrixResults[0].probeSize()+urlResults[0].probeSize());`,
  ""
].join("\n");
await writeFile(universalInput, universalProbeSource);

function compile(arguments_) {
  const result = spawnSync(shermes, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

compile([
  "-typed", "-strict", "-O", "-emit-c",
  "-exported-unit=deherm_static_ffi",
  typedInput,
  "-o", typedOutput
]);
compile([
  "-fno-std-globals", "-parse-ts", "-typed", "-strict", "-O", "-emit-c",
  "-exported-unit=deherm_static_app",
  "packages/static-hermes/src/typed-app.ts",
  "-o", appOutput
]);
compile([
  "-typed", "-strict", "-O", "-emit-c",
  "-exported-unit=deherm_static_universal",
  universalInput,
  "-o", universalOutput
]);
compile([
  "-fno-std-globals", "-parse-ts", "-typed", "-strict", "-O", "-emit-c",
  "-exported-unit=deherm_static_vmath",
  vmathInput,
  "-o", vmathOutput
]);

const compatibilityOutput = path.join(outputDirectory, "static-compat-app.c");
compile([
  "-O", "-emit-c",
  "-exported-unit=deherm_static_compat_app",
  "dist/sample.js",
  "-o", compatibilityOutput
]);

console.log(`Static Hermes emitted sound-typed ABI/lifecycle/vmath/universal units and ${compatibilityOutput}`);
