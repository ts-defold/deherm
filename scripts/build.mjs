import { build } from "esbuild";
import ttsc from "@ttsc/unplugin/esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { ensureBindingLoweringPlan } from "./ensure-binding-lowering-plan.mjs";

await ensureBindingLoweringPlan({ deepCheck: true });
const canonicalLoweringPlan = JSON.parse(await readFile("bindings/generated/defold-binding-lowering-plan.json", "utf8"));
if (canonicalLoweringPlan.schemaVersion !== 2) {
  throw new Error(`JavaScript build requires canonical lowering-plan schema v2, got ${canonicalLoweringPlan.schemaVersion ?? "missing"}`);
}

const pendingFingerprint = "0".repeat(64);

const result = await build({
  entryPoints: {
    sample: "examples/runtime-smoke/src/standalone.ts",
    "defold-app": "examples/runtime-smoke/src/main.ts",
    "binding-benchmark": "benchmarks/binding.ts",
    "web-host": "packages/web-adapter/src/host.ts",
    "web-runner": "packages/web-adapter/src/runner.ts"
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  platform: "neutral",
  target: "es2020",
  plugins: [ttsc()],
  define: {
    __DEFOLD_HERMES_BUILD_FINGERPRINT__: JSON.stringify(pendingFingerprint)
  },
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
  logLevel: "info",
  metafile: true
});

const defoldAppPath = "dist/defold-app.js";
const defoldAppWithPlaceholder = await readFile(defoldAppPath, "utf8");
const placeholderOccurrences = defoldAppWithPlaceholder.split(pendingFingerprint).length - 1;
if (placeholderOccurrences !== 1) {
  throw new Error(`Expected one Defold runtime fingerprint placeholder, found ${placeholderOccurrences}`);
}
const defoldAppFingerprint = createHash("sha256")
  .update(defoldAppWithPlaceholder)
  .digest("hex");
await writeFile(
  defoldAppPath,
  defoldAppWithPlaceholder.replace(pendingFingerprint, defoldAppFingerprint)
);

const symbolMap = JSON.parse(await readFile("bindings/generated/symbol-map.json", "utf8"));
const symbolsBySource = new Map(symbolMap.symbols.map((symbol) => [symbol.source, symbol]));
const dynamicRegistry = "packages/sdk/src/registry.ts";
const canonicalBindingRoots = [
  "packages/sdk/src/generated/script/",
  "packages/sdk/src/generated/dmsdk/"
];

for (const [output, metadata] of Object.entries(result.metafile.outputs)) {
  if (!metadata.entryPoint || path.extname(output) !== ".js") continue;
  const retainedInputs = new Set(Object.entries(metadata.inputs)
    .filter(([, contribution]) => contribution.bytesInOutput > 0)
    .map(([input]) => input));
  const dynamicAccess = retainedInputs.has(dynamicRegistry);
  const symbols = dynamicAccess
    ? symbolMap.symbols
    : [...retainedInputs]
        .map((input) => symbolsBySource.get(input))
        .filter(Boolean)
        .sort((left, right) => left.id.localeCompare(right.id));
  const manifest = {
    schemaVersion: 1,
    entryPoint: metadata.entryPoint,
    output,
    dynamicAccess,
    symbols
  };
  const usagePath = output.replace(/\.js$/, ".usage.json");
  await writeFile(usagePath, `${JSON.stringify(manifest, null, 2)}\n`);

  const usesCanonicalBindings = [...retainedInputs].some((input) =>
    canonicalBindingRoots.some((root) => input.startsWith(root))
  );
  const defoldApiUsage = {
    schemaVersion: 1,
    dynamicAccess: usesCanonicalBindings,
    symbols: []
  };
  const defoldApiUsagePath = output.replace(/\.js$/, ".defold-api-usage.json");
  await writeFile(defoldApiUsagePath, `${JSON.stringify(defoldApiUsage, null, 2)}\n`);
}

await mkdir("defold/deherm", { recursive: true });
await copyFile(defoldAppPath, "defold/deherm/app.dehermc");
await copyFile(`${defoldAppPath}.map`, "defold/deherm/app.dehermc.map");
