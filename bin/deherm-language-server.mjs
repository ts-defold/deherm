#!/usr/bin/env node
import path from "node:path";

import { runLanguageServer } from "../packages/cli/src/lsp/server.mjs";
import { findProjectRoot } from "../packages/cli/src/project.mjs";

const projectIndex = process.argv.indexOf("--project");
const project = projectIndex >= 0 ? process.argv[projectIndex + 1] : undefined;

try {
  const projectRoot = await findProjectRoot(process.cwd(), project);
  process.exitCode = await runLanguageServer({ projectRoot });
} catch (error) {
  console.error(`deherm-language-server: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
