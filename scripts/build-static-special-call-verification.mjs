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

const [ffi, verification] = await Promise.all([
  readFile("packages/static-hermes/src/generated/ffi.js", "utf8"),
  readFile("packages/bindings/generated/defold-script-special-call-verification.json", "utf8")
    .then(JSON.parse)
]);
const timers = new Map(verification.separateModules
  .filter(({ module }) => module === "Timer")
  .map((vector) => [vector.function, vector]));
assert.deepEqual([...timers.keys()].sort(), ["cancel", "delay", "trigger"]);
const literal = (value) => typeof value === "boolean" ? (value ? "1" : "0") : String(value);
const invocation = (name) => {
  const vector = timers.get(name);
  return `__ffi_${vector.module}_${vector.function}(${vector.staticCAbiSamples.map(literal).join(",")})`;
};
const source = [
  ffi,
  "",
  "const __ffi_deherm_static_timer_report = $SHBuiltin.extern_c(",
  '  {include: "defold_hermes/static_probe.h"},',
  "  function defold_hermes_static_timer_report(stage: c_u32, value: c_f64): void { throw 0; }",
  ");",
  `__ffi_deherm_static_timer_report(1,${invocation("delay")});`,
  `__ffi_deherm_static_timer_report(2,${invocation("cancel")});`,
  `__ffi_deherm_static_timer_report(3,${invocation("trigger")});`,
  "class DehermStaticSpecialCallApp { init() {} final() {} }",
  "globalThis.__defoldAppV1 = new DehermStaticSpecialCallApp();",
  ""
].join("\n");

await mkdir(outputDirectory, { recursive: true });
const input = path.join(outputDirectory, "static-special-call.js");
const output = path.join(outputDirectory, "static-special-call.c");
await writeFile(input, source);
const result = spawnSync(shermes, [
  "-typed", "-strict", "-O", "-emit-c",
  "-exported-unit=deherm_static_special_call",
  input,
  "-o", output
], { cwd: process.cwd(), encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(`Static Hermes special-call unit emitted ${output}`);
