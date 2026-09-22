import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await rm(path.join(root, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, "src", "extension.ts")],
  outfile: path.join(root, "dist", "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: true,
  sourcemap: false,
  external: ["vscode"],
  logLevel: "info"
});
