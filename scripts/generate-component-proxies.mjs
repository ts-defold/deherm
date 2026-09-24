#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverComponentSources,
  generateComponentProxies,
  loadComponentProxyPolicy
} from "./lib/component-proxy-generator.mjs";

function parseArguments(argv) {
  const options = { check: false, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--project") options.project = argv[++index];
    else if (argument === "--output-root") options.outputRoot = argv[++index];
    else if (argument === "--input") options.files.push(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const projectRoot = path.resolve(options.project ?? process.cwd());
  const sourceFiles = options.files.length
    ? options.files.map((file) => path.resolve(projectRoot, file))
    : await discoverComponentSources(projectRoot);
  const result = await generateComponentProxies({
    projectRoot,
    sourceFiles,
    outputRoot: options.outputRoot ? path.resolve(options.outputRoot) : projectRoot,
    check: options.check,
    componentPolicy: await loadComponentProxyPolicy(path.join(projectRoot, ".deherm", "ir", "defold-component-proxy-contract.json"))
  });
  const mode = options.check ? "fresh" : "generated";
  console.log(`Component proxies ${mode}: ${result.manifest.components.length} component(s)`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
