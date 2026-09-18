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
assert.ok(shermes, "--shermes is required");
assert.ok(outputDirectory, "--output-dir is required");

await mkdir(outputDirectory, { recursive: true });
const generatedFfi = await readFile("packages/static-hermes/src/generated/ffi.js", "utf8");
const generatedVmath = await readFile("packages/static-hermes/src/generated/script-vmath.ts", "utf8");
const typedSource = `${generatedFfi}\n\nconst __ffi_deherm_static_probe_report = $SHBuiltin.extern_c(\n  {include: "defold_hermes/static_probe.h"},\n  function defold_hermes_static_probe_report(value: c_f64): void { throw 0; }\n);\n\n__ffi_deherm_static_probe_report(__ffi_ExampleMath_add(20, 22));\n`;
const typedInput = path.join(outputDirectory, "static-ffi.js");
const typedOutput = path.join(outputDirectory, "static-ffi.c");
const appOutput = path.join(outputDirectory, "static-app.c");
const vmathInput = path.join(outputDirectory, "static-vmath.ts");
const vmathOutput = path.join(outputDirectory, "static-vmath.c");
await writeFile(typedInput, typedSource);
await writeFile(vmathInput, `${generatedVmath}\n\nconst __ffi_deherm_static_vmath_report = $SHBuiltin.extern_c(\n  {include: "defold_hermes/static_probe.h"},\n  function defold_hermes_static_vmath_report(stage: c_u32, value: c_f64): void { throw 0; }\n);\n\n__ffi_deherm_static_vmath_report(1, vmathLengthVector3(3, 4, 12));\n__ffi_deherm_static_vmath_report(2, vmathLengthVector4(1, 2, 2, 4));\n__ffi_deherm_static_vmath_report(3, vmathLengthQuaternion(0, 0, 0, 1));\n__ffi_deherm_static_vmath_report(4, vmathProjectVector3Vector3(2, 4, 6, 1, 2, 3));\n__ffi_deherm_static_vmath_report(5, vmathLengthSqrVector3(3, 4, 12));\n__ffi_deherm_static_vmath_report(6, vmathLengthSqrVector4(1, 2, 3, 4));\n__ffi_deherm_static_vmath_report(7, vmathLengthSqrQuaternion(1, 2, 2, 0));\nlet projectZeroTargetRejected: number = 0;\ntry {\n  vmathProjectVector3Vector3(1, 2, 3, 0, 0, 0);\n} catch (error) {\n  projectZeroTargetRejected = 1;\n}\n__ffi_deherm_static_vmath_report(8, projectZeroTargetRejected);\n`);

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

console.log(`Static Hermes emitted sound-typed ABI/lifecycle/vmath units and ${compatibilityOutput}`);
