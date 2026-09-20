#!/usr/bin/env node

// Repository command shim. Policy derivation lives in @deherm/generator.
export * from "../packages/generator/src/policy/generate-api-policy.mjs";

import { pathToFileURL } from "node:url";
import { runApiPolicyGenerator } from "../packages/generator/src/policy/generate-api-policy.mjs";

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runApiPolicyGenerator();
}
