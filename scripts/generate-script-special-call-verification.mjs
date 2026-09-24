#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  renderScriptSpecialCallVerification,
  renderScriptSpecialCallVerificationHeader
} from "../packages/compiler/src/script-special-call-verification.mjs";

const root = new URL("../", import.meta.url);
const output = new URL("packages/bindings/generated/defold-script-special-call-verification.json", root);
const headerOutput = new URL("defold/defold_hermes/include/defold_hermes/generated_script_special_call_verification.h", root);

async function json(relative) {
  return JSON.parse(await readFile(new URL(relative, root), "utf8"));
}

export async function generate() {
  const [accounting, moduleSchema, luaSchema, componentPolicy] = await Promise.all([
    json("packages/bindings/generated/defold-script-api-accounting.json"),
    json("packages/bindings/modules.json"),
    json("packages/bindings/lua-compat.json"),
    json("packages/bindings/generated/defold-component-proxy-contract.json")
  ]);
  const inputs = { accounting, moduleSchema, luaSchema, componentPolicy };
  return {
    report: renderScriptSpecialCallVerification(inputs),
    header: renderScriptSpecialCallVerificationHeader(inputs)
  };
}

async function main() {
  const source = await generate();
  if (process.argv.includes("--check")) {
    assert.equal(await readFile(output, "utf8"), source.report,
      "packages/bindings/generated/defold-script-special-call-verification.json is stale");
    assert.equal(await readFile(headerOutput, "utf8"), source.header,
      "defold/defold_hermes/include/defold_hermes/generated_script_special_call_verification.h is stale");
  } else {
    await Promise.all([
      writeFile(output, source.report),
      writeFile(headerOutput, source.header)
    ]);
  }
  console.log(`Script special-call verification ${process.argv.includes("--check") ? "check passed" : "generated"}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
