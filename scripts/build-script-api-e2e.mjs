import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("build", { recursive: true });
await build({
  entryPoints: ["tests/fixtures/script-api-e2e.ts"],
  bundle: true,
  format: "iife",
  platform: "neutral",
  target: "es2020",
  outfile: "build/script-api-e2e.js",
  sourcemap: false
});
