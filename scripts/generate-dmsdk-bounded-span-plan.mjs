#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildDmSdkBoundedSpanPlan,
  indexDmSdkBoundedSpanPlan,
} from "../packages/compiler/src/dmsdk-bounded-span-plan.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  sourceFacts: "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json",
  fixedDigest: "packages/bindings/overrides/dmsdk-fixed-digest-bindings.json",
  base64: "packages/bindings/overrides/dmsdk-base64-span-bindings.json",
  astc: "packages/bindings/overrides/dmsdk-astc-probe-bindings.json",
  xtea: "packages/bindings/overrides/dmsdk-xtea-span-bindings.json",
  hashSpan: "packages/bindings/overrides/dmsdk-hash-span-bindings.json",
});
const output = "packages/bindings/generated/defold-dmsdk-bounded-span-plan.json";

export async function generateDmSdkBoundedSpanPlan({ root = repositoryRoot, check = false } = {}) {
  const texts = Object.fromEntries(await Promise.all(
    Object.entries(sources).map(async ([key, source]) => [key, await readFile(resolve(root, source), "utf8")]),
  ));
  const plan = buildDmSdkBoundedSpanPlan({
    ir: JSON.parse(texts.ir),
    shapes: JSON.parse(texts.shapes),
    sourceFacts: JSON.parse(texts.sourceFacts),
    policies: {
      fixedDigest: JSON.parse(texts.fixedDigest),
      base64: JSON.parse(texts.base64),
      astc: JSON.parse(texts.astc),
      xtea: JSON.parse(texts.xtea),
      hashSpan: JSON.parse(texts.hashSpan),
    },
    texts,
  });
  indexDmSdkBoundedSpanPlan(plan, { revision: plan.defoldRevision });
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const destination = resolve(root, output);
  if (check) {
    if (await readFile(destination, "utf8") !== content) throw new Error(`${output} is stale`);
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  process.stdout.write(
    `${check ? "Verified" : "Generated"} one bounded-span plan: ${plan.coverage.selected} selected, ${plan.coverage.universalFallback} fallback.\n`,
  );
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  generateDmSdkBoundedSpanPlan({ check: process.argv.includes("--check") }).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
