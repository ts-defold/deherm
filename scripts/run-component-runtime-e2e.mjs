import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const executable = path.resolve(process.argv[2] ?? "build/native/defold-hermes-component-runtime-e2e");
const invocation = JSON.parse(await readFile("build/component-runtime-e2e/invocation.json", "utf8"));
const arguments_ = [invocation.bundle];
for (const component of invocation.components) {
  arguments_.push(component.componentId, component.schemaFingerprint);
}
const result = spawnSync(executable, arguments_, { cwd: process.cwd(), encoding: "utf8", stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
