#!/usr/bin/env node

// Repository command shim. Shippable generator code lives in @deherm/generator.
export * from "../packages/generator/src/sdk/script-sdk.mjs";

import { pathToFileURL } from "node:url";
import { runScriptSdkGenerator } from "../packages/generator/src/sdk/script-sdk.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runScriptSdkGenerator();
}
