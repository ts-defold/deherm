#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildDmSdkValuePlan, indexDmSdkValuePlan } from "../packages/compiler/src/dmsdk-value-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  scalar: "packages/bindings/overrides/dmsdk-scalar-thunks.json",
  enumValue: "packages/bindings/overrides/dmsdk-enum-value-bindings.json",
  namedScalar: "packages/bindings/overrides/dmsdk-named-scalar-policies.json",
});
const output = "packages/bindings/generated/defold-dmsdk-value-plan.json";

export async function generateDmSdkValuePlan({ root: outputRoot = root, check = false } = {}) {
  const texts = Object.fromEntries(await Promise.all(
    Object.entries(sources).map(async ([key, source]) => [key, await readFile(resolve(outputRoot, source), "utf8")]),
  ));
  const plan = buildDmSdkValuePlan({
    ir: JSON.parse(texts.ir),
    shapes: JSON.parse(texts.shapes),
    policies: {
      scalar: JSON.parse(texts.scalar),
      enumValue: JSON.parse(texts.enumValue),
      namedScalar: JSON.parse(texts.namedScalar),
    },
    texts,
  });
  indexDmSdkValuePlan(plan, { revision: plan.defoldRevision });
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const destination = resolve(outputRoot, output);
  if (check) {
    if (await readFile(destination, "utf8") !== content) throw new Error(`${output} is stale`);
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  process.stdout.write(
    `${check ? "Verified" : "Generated"} one value plan: ${plan.coverage.selected} selected, ${plan.coverage.universalFallback} fallback.\n`,
  );
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  generateDmSdkValuePlan({ check: process.argv.includes("--check") }).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
