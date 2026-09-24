import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { generateComponentProxies } from "../packages/compiler/src/component-proxy-generator.mjs";
import {
  generateScriptSpecialCallVerification,
  renderScriptSpecialCallVerificationHeader
} from "../packages/compiler/src/script-special-call-verification.mjs";
import { generateArtifacts } from "../scripts/generate-bindings.mjs";
import { generateLuaArtifacts } from "../scripts/generate-lua-bridge.mjs";

async function json(relative) {
  return JSON.parse(await readFile(new URL(`../${relative}`, import.meta.url), "utf8"));
}

const [accounting, moduleSchema, luaSchema] = await Promise.all([
  json("packages/bindings/generated/defold-script-api-accounting.json"),
  json("packages/bindings/modules.json"),
  json("packages/bindings/lua-compat.json")
]);
const componentPolicy = await json("packages/bindings/generated/defold-component-proxy-contract.json");
const report = generateScriptSpecialCallVerification({ accounting, moduleSchema, luaSchema, componentPolicy });

test("special-call report is a total inventory partition of compiler and module routes", () => {
  const compilerIds = accounting.rows
    .filter(({ category }) => category === "component-property-compiler")
    .map(({ id }) => id)
    .sort();
  const moduleIds = accounting.rows
    .filter(({ category }) => category === "separate-module")
    .map(({ id }) => id)
    .sort();
  assert.deepEqual(report.compilerIntrinsics.map(({ id }) => id).sort(), compilerIds);
  assert.deepEqual(report.separateModules.map(({ id }) => id).sort(), moduleIds);
  assert.equal(report.counts.total, compilerIds.length + moduleIds.length);
  assert.equal(report.counts.componentPropertyCompiler, 8);
  assert.equal(report.counts.separateModule, 3);
  assert.match(report.reportSha256, /^[0-9a-f]{64}$/);
});

test("every compiler-intrinsic vector emits its exact Lua declaration", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "deherm-property-vectors-"));
  try {
    const properties = report.compilerIntrinsics
      .map(({ propertyName, authoringExpression }) => `    ${propertyName}: ${authoringExpression},`)
      .join("\n");
    await writeFile(path.join(projectRoot, "vectors.script.ts"), [
      'import { defineComponent, property } from "@ts-defold/deherm/component";',
      "export default defineComponent({",
      "  properties: {",
      properties,
      "  },",
      "});",
      ""
    ].join("\n"));
    await mkdir(path.join(projectRoot, "node_modules", "@ts-defold"), { recursive: true });
    await generateComponentProxies({ projectRoot, componentPolicy });
    const proxy = await readFile(path.join(projectRoot, "vectors.script"), "utf8");
    for (const vector of report.compilerIntrinsics) {
      assert.match(proxy, new RegExp(vector.expectedLua.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), vector.id);
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the same timer rows select the Lua, JSI, Static Hermes, and browser call programs", () => {
  const bindings = generateArtifacts(moduleSchema);
  const lua = generateLuaArtifacts(luaSchema)
    .get("defold/defold_hermes/src/generated_lua_bridge.cpp");
  const jsi = bindings.get("defold/defold_hermes/src/generated_jsi.cpp");
  const staticHermes = bindings.get("packages/static-hermes/src/generated/ffi.js");
  const browser = bindings.get("defold/defold_hermes/lib/web/generated_modules.js");
  for (const vector of report.separateModules) {
    const luaBlock = lua.slice(lua.indexOf(`bool timer${vector.function[0].toUpperCase()}${vector.function.slice(1)}(`));
    assert.match(luaBlock, new RegExp(`call\\.invoke\\(${vector.parameters.length}, 1\\)`), vector.id);
    assert.match(jsi, new RegExp(`${vector.cSymbol}\\(${vector.cAbiArguments.map((name) =>
      name.startsWith("callback_") ? `callback_handle\\.${name.slice("callback_".length)}` : ".+?"
    ).join(", ")}\\)`), vector.id);
    assert.match(staticHermes, new RegExp(`function ${vector.cSymbol}\\(`), vector.id);
    assert.match(browser, new RegExp(`_${vector.cSymbol}\\(`), vector.id);
  }
  const header = renderScriptSpecialCallVerificationHeader({ accounting, moduleSchema, luaSchema, componentPolicy });
  assert.match(header, /DEHERM_VERIFY_TIMER_DELAY_CALLBACK_RUNTIME UINT32_C\(2166572391\)/);
  assert.match(header, /DEHERM_VERIFY_TIMER_DELAY_C_ABI_ARITY UINT32_C\(6\)/);
});

test("module and Lua schemas cannot drift independently", () => {
  const drifted = structuredClone(luaSchema);
  drifted.modules[0].functions[0].parameters.reverse();
  assert.throws(
    () => generateScriptSpecialCallVerification({ accounting, moduleSchema, luaSchema: drifted, componentPolicy }),
    /module and Lua parameter schemas differ/
  );
});
