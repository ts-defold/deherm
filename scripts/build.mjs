import { build } from "esbuild";
import ttsc from "@ttsc/unplugin/esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const result = await build({
  entryPoints: {
    sample: "sample/src/main.ts",
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
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
  logLevel: "info",
  metafile: true
});

const symbolMap = JSON.parse(await readFile("bindings/generated/symbol-map.json", "utf8"));
const symbolsBySource = new Map(symbolMap.symbols.map((symbol) => [symbol.source, symbol]));
const dynamicRegistry = "packages/sdk/src/registry.ts";

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
}

await mkdir("defold/defold_hermes_app", { recursive: true });
await copyFile("dist/sample.js", "defold/defold_hermes_app/app.js");
