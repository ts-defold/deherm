import { pathToFileURL } from "node:url";

export * from "../packages/compiler/src/generate-binding-lowering-plan.mjs";
import { run } from "../packages/compiler/src/generate-binding-lowering-plan.mjs";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
