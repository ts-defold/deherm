import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { compileConformanceHarness, generateConformanceHarness, readConformanceReport } from "./conformance.mjs";
import { generateComponentProxies } from "../../compiler/src/component-proxy-generator.mjs";
import { discoverProjectRoots, findProjectRoot, inspectDefoldProject } from "./project.mjs";
import { installNativeExtension, typecheckGeneratedProject, verifyGeneratedProject, writeGeneratedProject } from "./generate.mjs";
import { createDefoldProject } from "./scaffold.mjs";
import { materializeDmSdkUsageFile } from "./dmsdk.mjs";
import { ingestNativeExtensionHeader, renderNativeExtensionBindings } from "../../compiler/src/native-extension-generator.mjs";

const help = `deherm <command> [options]

Commands:
  (no command) Launch the interactive project/dev TUI
  create       Scaffold a Defold + TypeScript project and generate its SDK
  doctor       Validate the project and report discoverable extension APIs
  extensions   List native extensions and their script API coverage
  generate     Write project inventory, TypeScript SDK, tsconfig, and VS Code setup
  materialize-dmsdk  Emit deterministic native provider C++ from a dmSDK usage document
  generate-extension-api  Parse a C header and emit native-extension IR, TypeScript, and C ABI glue
  typecheck    Type-check shared, game-object, GUI, and render TypeScript projects
  verify-generated  Verify packaged IR plus generated context/config output sentinels
  dev          Run the compiler/watch console; press p to launch or stop the built game
  conformance generate  Generate exhaustive API compile/runtime fixtures and a disposition plan
  conformance compile   Compile a generated shard and emit per-binding observations
  conformance report    Merge generated plans with independently captured observations

Options:
  --name <name>       Project title used by create
  --project <path>   Defold project directory or game.project
  --out-dir <path>   Generated directory relative to the project (default: .deherm)
  --defold-sdk <sha> Exact Defold engine SHA expected by generated API inputs
  --output <path>    Conformance harness output directory
  --usage <path>     dmSDK usage document for materialize-dmsdk
  --header <path>    Public C header for generate-extension-api
  --module <name>    C symbol prefix/module name for generate-extension-api
  --plan <path>      Conformance plan used by the report command
  --observation <path>  Observation JSON to merge; may be repeated
  --surface <name>   all, script, or dmsdk (default: all)
  --target <name>    Conformance runtime target (default: source dmSDK platform)
  --context <names>  Comma-separated available contexts; may be repeated
  --entry <path>     TypeScript game entry point for dev
  --watch <path>     Source tree watched by dev (default: entry directory)
  --build-dir <path> Compiled Defold resource root served to targets
  --build-server <url> Defold build service; omit to use Bob's standard service
  --service-port <n> Local Defold engine service port (default: 8001)
  --resource <path>  Generated typed bundle resource (default: /deherm/app.dehermc)
  --target <url>     For dev, a Defold engine service URL; may be repeated
  --once             Build one development generation and exit
  --headless         Use line-oriented output instead of the Rezi console
  --no-launch        Watch/build without automatically launching the local game
  --no-ttsc          Disable ttsc transforms for a diagnostic dev build
  --shard <i/n>      Stable zero-based shard selection (default: 0/1)
  --strict           Fail a report unless every required selected stage passed
  --check            Verify materialized output without writing it
  --force            Regenerate owned project outputs even when the input key is current
  --json             Print machine-readable JSON
  -h, --help         Show this help
`;

export function parseArguments(argv) {
  const options = { command: argv.length === 0 ? "ui" : "doctor", json: false, observations: [], contexts: [], targets: [] };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) options.command = args.shift();
  if (options.command === "conformance" && args[0] && !args[0].startsWith("-")) options.action = args.shift();
  if (options.command === "create" && args[0] && !args[0].startsWith("-")) options.directory = args.shift();
  while (args.length) {
    const value = args.shift();
    if (value === "--json") options.json = true;
    else if (value === "--check" && options.command === "materialize-dmsdk") options.check = true;
    else if (value === "--strict") options.strict = true;
    else if (value === "--force") options.force = true;
    else if (value === "--once") options.once = true;
    else if (value === "--headless") options.headless = true;
    else if (value === "--no-launch") options.autoLaunch = false;
    else if (value === "--no-ttsc") options.useTtsc = false;
    else if (value === "-h" || value === "--help") options.help = true;
    else if (value === "--project") options.project = args.shift();
    else if (value === "--name") options.name = args.shift();
    else if (value === "--out-dir") options.outDir = args.shift();
    else if (value === "--defold-sdk") options.defoldSdk = args.shift();
    else if (value === "--output") options.output = args.shift();
    else if (value === "--usage") options.usage = args.shift();
    else if (value === "--header") options.header = args.shift();
    else if (value === "--module") options.module = args.shift();
    else if (value === "--plan") options.plan = args.shift();
    else if (value === "--observation") options.observations.push(args.shift());
    else if (value === "--surface") options.surface = args.shift();
    else if (value === "--target" && options.command === "dev") options.targets.push(args.shift());
    else if (value === "--target") options.target = args.shift();
    else if (value === "--context") options.contexts.push(...args.shift().split(",").map((item) => item.trim()).filter(Boolean));
    else if (value === "--shard") options.shard = args.shift();
    else if (value === "--entry") options.entry = args.shift();
    else if (value === "--watch") options.watchRoot = args.shift();
    else if (value === "--build-dir") options.buildDir = args.shift();
    else if (value === "--build-server") options.buildServer = args.shift();
    else if (value === "--service-port") options.servicePort = Number(args.shift());
    else if (value === "--resource") options.resourcePath = args.shift();
    else throw new Error(`Unknown option: ${value}`);
  }
  if (options.command === "dev" && !options.json && options.headless === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    options.headless = true;
  }
  if (options.servicePort !== undefined && (!Number.isSafeInteger(options.servicePort) || options.servicePort < 1 || options.servicePort > 65_535)) {
    throw new Error("--service-port must be an integer from 1 through 65535");
  }
  return options;
}

async function selectProjectFromTerminal(projects) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write("Multiple Defold projects were found:\n");
    projects.forEach((project, index) => process.stderr.write(`  ${index + 1}. ${path.relative(process.cwd(), project) || "."}\n`));
    const answer = await prompt.question("Choose a project number: ");
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || !projects[index]) throw new Error(`Invalid project selection: ${answer}`);
    return projects[index];
  } finally {
    prompt.close();
  }
}

async function scaffoldProject(options) {
  const packageRoot = path.resolve(import.meta.dirname, "../../..");
  const packageVersion = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;
  const scaffold = await createDefoldProject({
    directory: options.directory,
    name: options.name,
    packageVersion
  });
  const inventory = await inspectDefoldProject({ project: scaffold.projectRoot });
  const generated = await writeGeneratedProject(inventory, options.outDir, { force: true });
  const nativeExtension = await installNativeExtension(scaffold.projectRoot, { force: true });
  const components = await generateComponentProxies({ projectRoot: scaffold.projectRoot, outputRoot: scaffold.projectRoot });
  return {
    ...scaffold,
    generatedRoot: generated.root,
    nativeExtensionRoot: nativeExtension.root,
    componentCount: components.manifest.components.length
  };
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
  if (options.command === "ui") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("The base déherm TUI requires an interactive terminal. Use 'deherm --help' or an explicit command in non-interactive environments.");
    }
    const { runLauncherTui } = await import("./dev/tui.mjs");
    const action = await runLauncherTui({ cwd: process.cwd(), projects: await discoverProjectRoots(process.cwd()) });
    if (action.type === "quit") return 0;
    if (action.type === "create") {
      const created = await scaffoldProject({ directory: path.resolve(process.cwd(), action.directory) });
      console.log(`Created ${created.name} in ${created.projectRoot}`);
      options.command = "dev";
      options.project = created.projectRoot;
    } else {
      options.command = action.type;
      options.project = action.project;
    }
  }
  if (options.command === "create") {
    const created = await scaffoldProject(options);
    if (options.json) console.log(JSON.stringify({ schemaVersion: 1, ...created }, null, 2));
    else {
      console.log(`Created ${created.name} in ${created.projectRoot}`);
      console.log(`Generated SDK in ${created.generatedRoot} and ${created.componentCount} component proxy/proxies`);
      console.log(`Next: cd ${path.relative(process.cwd(), created.projectRoot) || "."} && pnpm install && pnpm dev`);
    }
    return 0;
  }
  if (options.command === "materialize-dmsdk") {
    const result = await materializeDmSdkUsageFile({
      usage: options.usage,
      output: options.output,
      check: options.check,
    });
    if (options.json) console.log(JSON.stringify({ schemaVersion: 1, ...result }, null, 2));
    else console.log(`${result.checked ? "Verified" : "Materialized"} ${result.materializedCount} dmSDK declaration(s) in ${path.relative(process.cwd(), result.output) || "."}; install with ${result.provider.install}()`);
    return 0;
  }
  if (options.command === "generate-extension-api") {
    if (!options.header || !options.module || !options.output) throw new Error("generate-extension-api requires --header, --module, and --output <directory>");
    const ir = ingestNativeExtensionHeader({ header: options.header, moduleName: options.module });
    const generated = renderNativeExtensionBindings(ir);
    const output = path.resolve(options.output);
    await mkdir(output, { recursive: true });
    await Promise.all([
      writeFile(path.join(output, "extension.ir.json"), `${JSON.stringify(ir, null, 2)}\n`),
      writeFile(path.join(output, `${ir.module}.ts`), generated.typescript),
      writeFile(path.join(output, `${ir.module}_glue.cpp`), generated.source),
    ]);
    const result = { output, module: ir.module, routeCount: ir.routes.length, generatedRouteCount: generated.generatedRouteCount, blockedRouteCount: generated.blockedRouteCount };
    if (options.json) console.log(JSON.stringify({ schemaVersion: 1, ...result }, null, 2));
    else console.log(`Generated ${result.generatedRouteCount}/${result.routeCount} native extension route(s) in ${path.relative(process.cwd(), output) || "."}; ${result.blockedRouteCount} need layout policy`);
    return result.blockedRouteCount ? 2 : 0;
  }
  if (options.command === "conformance") {
    if (options.action === "generate") {
      const output = await generateConformanceHarness({
        output: options.output,
        surface: options.surface,
        target: options.target,
        contexts: options.contexts,
        shard: options.shard
      });
      const summary = {
        root: output.root,
        planId: output.plan.planId,
        target: output.plan.target,
        contexts: output.plan.contexts,
        shard: output.plan.shard,
        selectedCaseCount: output.plan.selectedCaseCount,
        summary: output.plan.summary,
        files: output.files
      };
      if (options.json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`Generated ${summary.selectedCaseCount} conformance case(s) in ${path.relative(process.cwd(), output.root) || "."}`);
        console.log(`Plan ${summary.planId}; target ${summary.target}; shard ${summary.shard.index}/${summary.shard.count}`);
        console.log(`Compile ${summary.summary.compile["compile-only"] ?? 0}; linked ${summary.summary.link.linked ?? 0}; executable ${summary.summary.runtime.executable ?? 0}; runtime-skipped ${summary.summary.runtime["skipped-with-reason"] ?? 0}`);
      }
      return 0;
    }
    if (options.action === "compile") {
      if (!options.plan) throw new Error("conformance compile requires --plan <path>");
      const result = await compileConformanceHarness(options.plan, options.output);
      const summary = {
        output: result.output,
        passed: result.passed,
        status: result.status,
        caseCount: result.observation.results.length
      };
      if (options.json) console.log(JSON.stringify(summary, null, 2));
      else console.log(`${result.passed ? "ok" : "!!"} compiled ${summary.caseCount} conformance case(s); observation ${path.relative(process.cwd(), result.output)}`);
      if (!result.passed && result.stderr) console.error(result.stderr.trim());
      if (!result.passed && result.stdout) console.error(result.stdout.trim());
      return result.passed ? 0 : 1;
    }
    if (options.action === "report") {
      if (!options.plan) throw new Error("conformance report requires --plan <path>");
      const report = await readConformanceReport(options.plan, options.observations);
      if (options.output) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
        await writeFile(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`);
      }
      if (options.json || !options.output) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Conformance report ${report.planId}: ${report.observationCount} observed stage(s), ${report.caseCount} case(s)`);
        console.log(`Compile passed ${report.summary.compile.passed ?? 0}; link passed ${report.summary.link.passed ?? 0}; runtime passed ${report.summary.runtime.passed ?? 0}; semantic passed ${report.summary.semantic.passed ?? 0}`);
        console.log(`${report.strictPass ? "ok" : "!!"} strict gate: ${report.strictFailures.length} missing or failed required stage(s)`);
      }
      return options.strict && !report.strictPass ? 1 : 0;
    }
    throw new Error(`Unknown conformance action: ${options.action ?? "<missing>"}; expected generate, compile, or report`);
  }
  if (options.command === "dev") {
    // Keep doctor/generate/conformance usable without loading the heavier dev
    // compiler and terminal stack. This also keeps `deherm --help` portable.
    const { runDevSession } = await import("./dev/session.mjs");
    if (!options.project && !options.entry) {
      options.project = await findProjectRoot(process.cwd(), undefined, {
        select: !options.json && process.stdin.isTTY && process.stdout.isTTY ? selectProjectFromTerminal : undefined
      });
    }
    options.project = await findProjectRoot(process.cwd(), options.project ?? options.entry);
    const inventory = await inspectDefoldProject({ project: options.project, requireDehermRuntime: true });
    const errors = inventory.diagnostics.filter(({ severity }) => severity === "error");
    if (errors.length) {
      throw new Error(`Defold project configuration is not ready for déherm dev:\n${errors.map(({ path, message }) => `- ${path}: ${message}`).join("\n")}`);
    }
    await writeGeneratedProject(inventory, options.outDir);
    await installNativeExtension(inventory.projectRoot);
    await generateComponentProxies({ projectRoot: inventory.projectRoot, outputRoot: inventory.projectRoot });
    const snapshot = await runDevSession(options);
    if (options.once && options.json) console.log(JSON.stringify({ schemaVersion: 1, snapshot }, null, 2));
    return snapshot.phase === "failed" ? 1 : 0;
  }
  const inventory = await inspectDefoldProject({
    project: options.project,
    selectProject: !options.json && process.stdin.isTTY && process.stdout.isTTY ? selectProjectFromTerminal : undefined,
    requireDehermRuntime: options.command === "generate" || options.command === "doctor"
  });
  if (options.command === "extensions") {
    if (options.json) console.log(JSON.stringify(inventory, null, 2));
    else printExtensions(inventory);
    return inventory.diagnostics.some(({ severity }) => severity === "error") ? 1 : 0;
  }
  if (options.command === "generate") {
    if (options.defoldSdk && !/^[a-f0-9]{40}$/i.test(options.defoldSdk)) throw new Error("--defold-sdk must be a 40-character SHA");
    const errors = inventory.diagnostics.filter(({ severity }) => severity === "error");
    if (errors.length) {
      throw new Error(`Defold project configuration is not ready for déherm:\n${errors.map(({ path, message }) => `- ${path}: ${message}`).join("\n")}`);
    }
    const output = await writeGeneratedProject(inventory, options.outDir, { defoldSdk: options.defoldSdk, force: options.force });
    const nativeExtension = await installNativeExtension(inventory.projectRoot, { force: options.force });
    const components = await generateComponentProxies({ projectRoot: inventory.projectRoot, outputRoot: inventory.projectRoot });
    const componentCount = components.manifest.components.length;
    if (options.json) console.log(JSON.stringify({ ...output, nativeExtension, componentCount, summary: inventory.summary }, null, 2));
    else {
      console.log(`${output.cached ? "Current" : "Generated"} extension inventory, types, and ${output.moduleCount} SDK module(s) in ${path.relative(process.cwd(), output.root) || "."}`);
      console.log(`${nativeExtension.installed ? "Installed" : "Current"} native extension in ${path.relative(process.cwd(), nativeExtension.root) || "."}`);
      console.log(`Generated ${componentCount} TypeScript component proxy resource(s)`);
      console.log(`Pinned Defold API: ${output.defoldRevision}`);
      if (output.created.tsconfig) console.log("Created tsconfig.json referencing all generated TypeScript context projects");
      else if (output.migrated.tsconfig) console.log("Migrated the legacy generated tsconfig.json to TypeScript project references");
      else console.log("Kept existing tsconfig.json; run 'deherm typecheck' to check every generated context project");
    }
    return inventory.diagnostics.some(({ severity }) => severity === "error") ? 1 : 0;
  }
  if (options.command === "verify-generated") {
    const result = await verifyGeneratedProject(inventory.projectRoot, options.outDir);
    const components = await generateComponentProxies({ projectRoot: inventory.projectRoot, outputRoot: inventory.projectRoot, check: true });
    const componentCount = components.manifest.components.length;
    if (options.json) console.log(JSON.stringify({ ...result, componentCount }, null, 2));
    else {
      console.log(`ok generated project: ${result.checkedFiles} verified IR and generated-output sentinel(s)`);
      console.log(`ok component proxies: ${componentCount} generated resource(s)`);
      console.log(`ok lowering plan: ${result.planSha256}`);
      console.log(`ok Defold API: ${result.defoldRevision}`);
    }
    return 0;
  }
  if (options.command === "typecheck") {
    const result = await typecheckGeneratedProject(inventory.projectRoot);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.passed) {
      console.log("ok TypeScript contexts: shared, game-object, GUI, render");
    } else {
      if (result.stdout.trim()) console.error(result.stdout.trimEnd());
      if (result.stderr.trim()) console.error(result.stderr.trimEnd());
    }
    return result.passed ? 0 : 1;
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
