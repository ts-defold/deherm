#!/usr/bin/env node

// Bootstrap the revision-derived script IR and types before runtime-profile
// availability exists. The full SDK pass runs again after availability is
// generated and owns constants/modules, which prevents a previous Defold
// revision's profile catalog from becoming an input to the new revision.

import { runScriptSdkGenerator } from "../packages/compiler/src/sdk/script-sdk.mjs";

await runScriptSdkGenerator({ semanticOnly: true });
