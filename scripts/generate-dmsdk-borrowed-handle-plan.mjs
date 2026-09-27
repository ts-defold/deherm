#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildDmSdkBorrowedHandlePlan,
  indexDmSdkBorrowedHandlePlan,
} from "../packages/compiler/src/dmsdk-borrowed-handle-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  policy: "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json",
});
const output = "packages/bindings/generated/defold-dmsdk-borrowed-handle-plan.json";

export async function generateDmSdkBorrowedHandlePlan({ root: outputRoot = root, check = false } = {}) {
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([key, source]) => [key, await readFile(resolve(outputRoot, source), "utf8")]),
    ),
  );
  const inputs = {
    texts,
    ir: JSON.parse(texts.ir),
    shapes: JSON.parse(texts.shapes),
    projection: JSON.parse(texts.projection),
    policy: JSON.parse(texts.policy),
  };
  const plan = buildDmSdkBorrowedHandlePlan(inputs);
  indexDmSdkBorrowedHandlePlan(plan, inputs);
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const destination = resolve(outputRoot, output);
  if (check) {
    if ((await readFile(destination, "utf8")) !== content) throw new Error(`${output} is stale`);
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  process.stdout.write(
    `${check ? "Verified" : "Generated"} one borrowed-handle plan: ${plan.coverage.selected} selected, ${plan.coverage.universalFallback} fallback.\n`,
  );
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  generateDmSdkBorrowedHandlePlan({ check: process.argv.includes("--check") }).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
