import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildComponentRegistry } from "./build-component-registry.mjs";

const projectRoot = path.resolve("build/component-runtime-e2e/project");
const outputRoot = path.resolve("build/component-runtime-e2e/bundle");
await rm(path.resolve("build/component-runtime-e2e"), { recursive: true, force: true });
await mkdir(projectRoot, { recursive: true });
await cp(path.resolve("tests/fixtures/component-runtime"), projectRoot, { recursive: true });
const result = await buildComponentRegistry({ projectRoot, outputRoot });
const byContext = new Map(result.manifest.components.map((component) => [component.contextKind, component]));
const contexts = ["game-object", "gui-scene", "render-instance+graphics"];
for (const context of contexts) if (!byContext.has(context)) throw new Error(`E2E fixture has no ${context} component`);
const invocation = {
  schemaVersion: 1,
  bundle: path.join(outputRoot, "components.js"),
  components: contexts.map((context) => {
    const component = byContext.get(context);
    return { context, componentId: component.componentId, schemaFingerprint: component.schemaFingerprint };
  })
};
await writeFile(
  path.resolve("build/component-runtime-e2e/invocation.json"),
  `${JSON.stringify(invocation, null, 2)}\n`
);
// Ensure the bundle was materialized before the native target is launched.
await readFile(invocation.bundle);
console.log(`component-runtime-e2e bundle:${result.cacheHit ? "current" : "generated"}:components=${contexts.length}`);
