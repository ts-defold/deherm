import { build } from "esbuild";
import ttsc from "@ttsc/unplugin/esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { ensureBindingLoweringPlan } from "./ensure-binding-lowering-plan.mjs";
import { buildScriptRouteSymbolIndex } from "../packages/compiler/src/script-route-symbol-index.mjs";
import {
  bundleReachableStableIds,
  checkerReachableRoutes,
  crossCheckReachability,
  defoldApiUsageDocument
} from "./defold-api-reachability.mjs";

await ensureBindingLoweringPlan({ deepCheck: true });
const canonicalLoweringPlan = JSON.parse(await readFile("packages/bindings/generated/defold-binding-lowering-plan.json", "utf8"));
if (canonicalLoweringPlan.schemaVersion !== 2) {
  throw new Error(`JavaScript build requires canonical lowering-plan schema v2, got ${canonicalLoweringPlan.schemaVersion ?? "missing"}`);
}

// The checker needs one derived input to answer reachability in canonical
// identity: the join between the member paths it can resolve and the route IDs
// every later stage speaks. It is derived from authorities this build already
// validated, so it is written next to the build rather than checked in.
const scriptApiIr = JSON.parse(await readFile("packages/bindings/generated/defold-script-api-ir.json", "utf8"));
const routeIndex = buildScriptRouteSymbolIndex(scriptApiIr, canonicalLoweringPlan);
const ttscWorkingDirectory = "build/ttsc";
const routeIndexPath = `${ttscWorkingDirectory}/script-route-symbol-index.json`;
const apiUsagePath = `${ttscWorkingDirectory}/defold-api-usage.json`;
await mkdir(ttscWorkingDirectory, { recursive: true });
await writeFile(routeIndexPath, `${JSON.stringify(routeIndex, null, 2)}\n`);

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
  plugins: [ttsc({
    // One program, one manifest. Left to per-file discovery the bundled
    // entrypoints would resolve to several tsconfigs, and each program would
    // publish a manifest covering only the files it happened to own.
    project: path.resolve("tsconfig.json"),
    plugins: [{
      transform: path.resolve("packages/compiler/ttsc.mjs"),
      enabled: true,
      // This repository's own build is a development projection: it computes
      // reachability to report it and never prunes what it links.
      profile: "development",
      routeSymbols: path.resolve(routeIndexPath),
      apiUsage: path.resolve(apiUsagePath)
    }]
  })],
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

const usageManifest = JSON.parse(await readFile(apiUsagePath, "utf8"));
if (usageManifest.schemaVersion !== 1 || usageManifest.routeIndexSha256 !== routeIndex.indexSha256) {
  throw new Error("The ttsc Defold API usage manifest does not authenticate this build's route symbol index");
}

const symbolMap = JSON.parse(await readFile("packages/bindings/generated/symbol-map.json", "utf8"));
const symbolsBySource = new Map(symbolMap.symbols.map((symbol) => [symbol.source, symbol]));
const dynamicRegistry = "packages/sdk/src/registry.ts";

const reachabilityDisagreements = [];
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

  // The Defold API surface is resolved by the checker, not by the module graph:
  // `gui.getNode` and `gui.newPieNode` share a module, so module granularity
  // can only ever answer "the SDK is imported" and would retain all 913
  // emittable routes for every real game.
  const checkerRouteIds = checkerReachableRoutes(usageManifest, retainedInputs);
  const bundleStableIds = bundleReachableStableIds(await readFile(output, "utf8"));
  const crossCheck = crossCheckReachability({
    entryPoint: metadata.entryPoint,
    output,
    manifest: usageManifest,
    routeIndex,
    checkerRouteIds,
    bundleStableIds
  });
  if (crossCheck.status !== "agree") reachabilityDisagreements.push(crossCheck);
  const defoldApiUsage = defoldApiUsageDocument({
    entryPoint: metadata.entryPoint,
    output,
    manifest: usageManifest,
    routeIndex,
    checkerRouteIds,
    crossCheck
  });
  const defoldApiUsagePath = output.replace(/\.js$/, ".defold-api-usage.json");
  await writeFile(defoldApiUsagePath, `${JSON.stringify(defoldApiUsage, null, 2)}\n`);
  process.stdout.write(
    `reachability ${output}: ${checkerRouteIds.length}/${routeIndex.routeCount} Defold routes` +
    `${usageManifest.dynamicAccess ? " (dynamic access declared; release retains the complete surface)" : ""}\n`
  );
}

if (reachabilityDisagreements.length > 0) {
  const detail = reachabilityDisagreements
    .flatMap(({ disagreements }) => disagreements.map((line) => `  - ${line}`))
    .join("\n");
  throw new Error(
    "The ttsc symbol set and the bundler module graph disagree about what this build reaches.\n" +
    "Two independent derivations differing means one is wrong; a release projection built from\n" +
    "either would be unsound.\n" + detail
  );
}

await mkdir("defold/deherm", { recursive: true });
await copyFile(defoldAppPath, "defold/deherm/app.dehermc");
await copyFile(`${defoldAppPath}.map`, "defold/deherm/app.dehermc.map");
