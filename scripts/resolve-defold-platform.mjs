#!/usr/bin/env node

// Print the two platform identities consumed by one Bob build. The mapping is
// generated from Defold's Platform.java; this adapter contains no platform
// allowlist and accepts either spelling as input.

import { resolveDefoldPlatform } from "../packages/cli/src/toolchains.mjs";

const input = process.argv[2];
if (!input) throw new Error("Usage: resolve-defold-platform.mjs <bob-or-extender-platform>");
const { extenderTarget, bobPlatform } = await resolveDefoldPlatform(input);
process.stdout.write(`${extenderTarget}\t${bobPlatform}\n`);
