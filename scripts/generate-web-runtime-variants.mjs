import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { renderWebRuntimeVariant } from "../packages/cli/src/toolchains.mjs";

const root = path.resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const files = [
  "component_bridge.js",
  "library_defold_hermes.js"
];

let changed = false;
for (const name of files) {
  const template = await readFile(
    path.join(root, "packages", "cli", "templates", "web-runtime", name),
    "utf8"
  );
  // The checked-in/package extension is release-safe for callers that invoke
  // Defold directly. Development tooling explicitly materializes debug before
  // a browser dev bundle.
  const expected = renderWebRuntimeVariant(template, "release");
  const destination = path.join(root, "defold", "defold_hermes", "lib", "web", name);
  const actual = await readFile(destination, "utf8").catch(() => null);
  if (actual === expected) continue;
  changed = true;
  if (!check) await writeFile(destination, expected);
}

if (check && changed) {
  throw new Error("Generated release browser runtime is stale; run pnpm generate:web-runtime-variants");
}
console.log(`Web runtime variants: ${check ? "checked" : changed ? "generated" : "current"} (${files.length} files)`);
