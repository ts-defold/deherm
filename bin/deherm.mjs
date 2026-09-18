#!/usr/bin/env node
import { run } from "../packages/cli/src/cli.mjs";

try {
  process.exitCode = await run();
} catch (error) {
  console.error(`deherm: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
