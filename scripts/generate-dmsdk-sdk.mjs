#!/usr/bin/env node

// Repository command shim. Source ingestion stays in the private generator package.
export * from "../packages/generator/src/sdk/dmsdk-sdk.mjs";

import { pathToFileURL } from "node:url";
import { runDmSdkGenerator } from "../packages/generator/src/sdk/dmsdk-sdk.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDmSdkGenerator();
}
