import path from "node:path";

import { inspectDefoldProject } from "./project.mjs";
import { writeGeneratedProject } from "./generate.mjs";

const help = `defold-hermes <command> [options]

Commands:
  doctor       Validate the project and report discoverable extension APIs
  extensions   List native extensions and their script API coverage
  generate     Write project inventory, TypeScript SDK, tsconfig, and VS Code setup

Options:
  --project <path>   Defold project directory or game.project
  --out-dir <path>   Generated directory relative to the project (default: .defold-hermes)
  --defold-sdk <sha> Exact Defold engine SHA expected by generated API inputs
  --json             Print machine-readable JSON
  -h, --help         Show this help
`;

function parseArguments(argv) {
  const options = { command: "doctor", json: false };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) options.command = args.shift();
  while (args.length) {
    const value = args.shift();
    if (value === "--json") options.json = true;
    else if (value === "-h" || value === "--help") options.help = true;
    else if (value === "--project") options.project = args.shift();
    else if (value === "--out-dir") options.outDir = args.shift();
    else if (value === "--defold-sdk") options.defoldSdk = args.shift();
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function printExtensions(inventory) {
  if (!inventory.extensions.length) {
    console.log("No native extensions found.");
    return;
  }
  for (const extension of inventory.extensions) {
    const moduleCount = extension.scriptApis.reduce((count, api) => count + api.declarations.length, 0);
    console.log(`${extension.name}  ${extension.kind}  ${extension.bindingStatus}  ${moduleCount} script module(s)  ${extension.publicHeaders.length} public header(s)  ${extension.manifestPath}`);
  }
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help || options.command === "help") {
    console.log(help);
    return 0;
  }
  const inventory = await inspectDefoldProject({ project: options.project });
  if (options.command === "extensions") {
    if (options.json) console.log(JSON.stringify(inventory, null, 2));
    else printExtensions(inventory);
    return inventory.diagnostics.some(({ severity }) => severity === "error") ? 1 : 0;
  }
  if (options.command === "generate") {
    if (options.defoldSdk && !/^[a-f0-9]{40}$/i.test(options.defoldSdk)) throw new Error("--defold-sdk must be a 40-character SHA");
    const output = await writeGeneratedProject(inventory, options.outDir, { defoldSdk: options.defoldSdk });
    if (options.json) console.log(JSON.stringify({ ...output, summary: inventory.summary }, null, 2));
    else {
      console.log(`Generated extension inventory, types, and ${output.moduleCount} SDK module(s) in ${path.relative(process.cwd(), output.root) || "."}`);
      console.log(`Pinned Defold API: ${output.defoldRevision}`);
      if (output.created.tsconfig) console.log("Created tsconfig.json extending tsconfig.defold-hermes.json");
      else console.log("Kept existing tsconfig.json; extend tsconfig.defold-hermes.json from your project config");
    }
    return inventory.diagnostics.some(({ severity }) => severity === "error") ? 1 : 0;
  }
  if (options.command === "doctor") {
    const ok = !inventory.diagnostics.some(({ severity }) => severity === "error");
    const summary = inventory.summary;
    console.log(`${ok ? "ok" : "!!"} project: ${inventory.projectRoot}`);
    console.log(`ok extensions: ${summary.localExtensions} local, ${summary.dependencyExtensions} dependency`);
    console.log(`ok script APIs: ${summary.scriptApiFiles} file(s), ${summary.scriptModules} module declaration(s)`);
    console.log(`ok native APIs: ${summary.publicHeaders} public header(s), ${summary.extensionsRequiringNativeSchema} schema(s) required`);
    if (summary.extensionsWithoutApiMetadata) {
      console.log(`-- metadata: ${summary.extensionsWithoutApiMetadata} extension(s) expose no discoverable API metadata`);
    }
    for (const diagnostic of inventory.diagnostics) {
      console.log(`${diagnostic.severity === "error" ? "!!" : "--"} ${diagnostic.path}: ${diagnostic.message}`);
    }
    return ok ? 0 : 1;
  }
  throw new Error(`Unknown command: ${options.command}\n\n${help}`);
}
