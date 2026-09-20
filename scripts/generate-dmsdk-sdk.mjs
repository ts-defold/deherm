#!/usr/bin/env node

// Repository command shim. Shippable generator code lives in @deherm/generator.
export * from "../packages/compiler/src/sdk/dmsdk-sdk.mjs";

import { pathToFileURL } from "node:url";
import { runDmSdkGenerator } from "../packages/compiler/src/sdk/dmsdk-sdk.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDmSdkGenerator();
}
