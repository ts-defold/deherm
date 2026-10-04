import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectLuaBridgeFacts, renderLuaBridgeOutputs } from "../packages/compiler/src/lua-bridge-output-emitter.mjs";

export const validateLuaSchema = projectLuaBridgeFacts;

export function generateLuaArtifacts(input) {
  const facts = projectLuaBridgeFacts(input);
  return renderLuaBridgeOutputs(facts);
}

async function main() {
  const check = process.argv.includes("--check");
  const root = new URL("../", import.meta.url);
  const schema = JSON.parse(await readFile(new URL("packages/bindings/lua-compat.json", root), "utf8"));
  for (const [path, source] of generateLuaArtifacts(schema)) {
    const output = new URL(path, root);
    if (check) {
      assert.equal(await readFile(output, "utf8"), source, `${path} is stale`);
    } else {
      await mkdir(dirname(fileURLToPath(output)), { recursive: true });
      await writeFile(output, source);
    }
  }
  console.log(`Lua bridge generation ${check ? "check passed" : "completed"}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
