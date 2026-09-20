import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { compileConformanceHarness, generateConformanceHarness, readConformanceReport } from "./conformance.mjs";
import { generateComponentProxies } from "../../compiler/src/component-proxy-generator.mjs";
import { writeProjectResourceSymbols, writeProjectRouteSymbolIndex } from "./resource-symbols.mjs";
import { discoverProjectRoots, findProjectRoot, inspectDefoldProject } from "./project.mjs";
import { installNativeExtension, typecheckGeneratedProject, verifyGeneratedProject, writeGeneratedProject } from "./generate.mjs";
import { createDefoldProject } from "./scaffold.mjs";
import { materializeDmSdkUsageFile } from "./dmsdk.mjs";
import { ingestNativeExtensionHeader, renderNativeExtensionBindings } from "../../compiler/src/native-extension-generator.mjs";

const help = `deherm <command> [options]

Commands:
  (no command) Launch the interactive project/dev TUI
  create       Scaffold a Defold + TypeScript project and generate its SDK
  doctor       Report host compilers, per-target Hermes archives, the project, and its extension APIs
  policy       Fetch, authenticate, and cache the Pages policy for the project's Defold revision
  extensions   List native extensions and their script API coverage
  generate     Write project inventory, TypeScript SDK, tsconfig, and VS Code setup
  materialize-dmsdk  Emit deterministic native provider C++ from a dmSDK usage document
  generate-extension-api  Parse a C header and emit native-extension IR, TypeScript, and C ABI glue
  typecheck    Type-check shared, game-object, GUI, and render TypeScript projects
  verify-generated  Verify packaged IR plus generated context/config output sentinels
  verify-bundle     Verify the bundle Bob will archive against the sources it was built from
  dev          Run the compiler/watch console; press p to launch or stop the built game
  bugs         Harvest engine/dev output into the deduplicated runtime bug pool
  conformance generate  Generate exhaustive API compile/runtime fixtures and a disposition plan
  conformance compile   Compile a generated shard and emit per-binding observations
  conformance report    Merge generated plans with independently captured observations

Options:
  --name <name>       Project title used by create
  --project <path>   Defold project directory or game.project
  --out-dir <path>   Generated directory relative to the project (default: .deherm)
  --defold-sdk <sha> Exact Defold engine SHA to generate for. Always wins over detection.
  --bob <path>       Bob jar interrogated for the project's engine SHA when nothing else names it
  --output <path>    Conformance harness output directory
  --usage <path>     dmSDK usage document for materialize-dmsdk
  --catalog <path>   Resolved dmSDK policy catalog (defaults to project .deherm/ir)
  --header <path>    Public C header for generate-extension-api
  --module <name>    C symbol prefix/module name for generate-extension-api
  --plan <path>      Conformance plan used by the report command
  --observation <path>  Observation JSON to merge; may be repeated
  --surface <name>   all, script, or dmsdk (default: all)
  --target <name>    Conformance runtime target (default: source dmSDK platform);
                     for doctor, the comma-separated Defold bundle target(s) you intend to ship
  --context <names>  Comma-separated available contexts; may be repeated
  --entry <path>     TypeScript game entry point for dev
  --watch <path>     Source tree watched by dev (default: entry directory)
  --build-dir <path> Compiled Defold resource root served to targets
  --build-server <url> Defold build service; omit to use Bob's standard service
  --service-port <n> Local Defold engine service port (default: 8001)
  --resource <path>  Generated typed bundle resource (default: /deherm/app.dehermc)
  --target <url>     For dev, a Defold engine service URL; may be repeated
  --web-bundle <path>   Packaged wasm-web bundle the dev HTML5 target serves
                        (default: the newest under <project>/build/bundle or ./build/bundle)
  --chrome <path>    Chrome binary the dev HTML5 target drives
  --browser-window   Run that Chrome with a window instead of headless
  --pool <path>      Runtime bug pool JSON (default: <project>/.deherm/dev/bug-pool.json)
  --session-log <path>  Session log harvested by bugs; may be repeated
  --transcript <path>   Packaged-run transcript harvested by bugs; may be repeated
  --no-harvest       Print the stored bug pool without reading new output
  --once             Build one development generation and exit
  --headless         Use line-oriented output instead of the Rezi console
  --no-launch        Watch/build without automatically launching the local game
  --web              Also launch the packaged HTML5 build in a headless browser
  --no-ttsc          Disable ttsc transforms for a diagnostic dev build
  --no-bytecode      Keep the development bundle as JavaScript (offline diagnostic)
  --shard <i/n>      Stable zero-based shard selection (default: 0/1)
  --strict           Fail a report unless every required selected stage passed
  --check            Verify materialized output without writing it
  --force            Regenerate owned project outputs even when the input key is current
  --recompute        For verify-bundle, re-bundle current sources to name the fingerprint they produce
  --allow-unbound    For verify-bundle, report an unrecorded or absent artifact without failing
  --json             Print machine-readable JSON
  -h, --help         Show this help
`;

export function parseArguments(argv) {
  const options = {
    command: argv.length === 0 ? "ui" : "doctor",
    json: false,
    observations: [],
    contexts: [],
    targets: [],
    transcripts: [],
    sessionLogs: []
  };
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
    else if (value === "--recompute") options.recompute = true;
    else if (value === "--allow-unbound") options.allowUnbound = true;
    else if (value === "--once") options.once = true;
    else if (value === "--headless") options.headless = true;
    else if (value === "--no-launch") options.autoLaunch = false;
    // Launch the HTML5 target with the session rather than on the `w` intent,
    // so a non-interactive run can drive the browser edit loop too.
    else if (value === "--web") options.web = true;
    else if (value === "--no-ttsc") options.useTtsc = false;
    else if (value === "--no-bytecode") options.bytecode = false;
    else if (value === "--no-harvest") options.harvest = false;
    else if (value === "--pool") options.pool = args.shift();
    else if (value === "--session-log") options.sessionLogs.push(args.shift());
    else if (value === "--transcript") options.transcripts.push(args.shift());
    else if (value === "-h" || value === "--help") options.help = true;
    else if (value === "--project") options.project = args.shift();
    else if (value === "--name") options.name = args.shift();
    else if (value === "--out-dir") options.outDir = args.shift();
    else if (value === "--defold-sdk") options.defoldSdk = args.shift();
    else if (value === "--bob") options.bob = args.shift();
    else if (value === "--output") options.output = args.shift();
    else if (value === "--usage") options.usage = args.shift();
    else if (value === "--catalog") options.catalog = args.shift();
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
    // The HTML5 target of a dev session. The bundle is produced by a wasm-web
    // Bob build; this names where it landed when it is not where Bob usually
    // puts it, and which browser to drive.
    else if (value === "--web-bundle") options.webBundle = args.shift();
    else if (value === "--chrome") options.chrome = args.shift();
    else if (value === "--browser-window") options.browserHeadless = false;
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
  if (!inventory.extensions.length) console.log("No native extensions found.");
  for (const extension of inventory.extensions) {
    const moduleCount = extension.scriptApis.reduce((count, api) => count + api.declarations.length, 0);
    console.log(`${extension.name}  ${extension.kind}  ${extension.bindingStatus}  ${moduleCount} script module(s)  ${extension.publicHeaders.length} public header(s)  ${extension.manifestPath}`);
  }
  // Discovery is rooted at ext.manifest, so a resolved dependency without one
  // contributes nothing. Saying so is the difference between "no bindings" and
  // "nothing was there".
  for (const archive of inventory.dependencyArchivesWithoutManifest ?? []) {
    console.log(`--  dependency  no-ext-manifest  ${archive.files} file(s), ${archive.luaModules} Lua module(s)  ${archive.archive}`);
  }
}

// `deherm doctor` has to answer one question: can this host build a bundle for
// the targets the user intends to ship? That is two independent matrices - the
// host compilers that run here, and the per-target Hermes archives Bob uploads
// to Extender - plus the project itself. Reporting only the project would leave
// a user to discover a missing Android archive from an Extender link error.
async function runDoctor(options) {
  const { hostCompilerReport } = await import("./host-compilers.mjs");
  const { nativeArtifactReport } = await import("./toolchains.mjs");
  const requested = options.target
    ? options.target.split(",").map((value) => value.trim()).filter(Boolean)
    : null;

  let inventory = null;
  let projectError = null;
  try {
    inventory = await inspectDefoldProject({
      project: options.project,
      selectProject: !options.json && process.stdin.isTTY && process.stdout.isTTY ? selectProjectFromTerminal : undefined,
      requireDehermRuntime: true
    });
  } catch (error) {
    // A user asking what their toolchain can build should get that answer even
    // outside a project, so the missing project is a reported finding rather
    // than a thrown one.
    projectError = error instanceof Error ? error.message : String(error);
  }

  const hosts = await hostCompilerReport();
  const artifacts = await nativeArtifactReport(inventory?.projectRoot);
  const unknownTargets = (requested ?? []).filter((target) => !artifacts.targets.some((row) => row.target === target));
  const selected = artifacts.targets.filter((row) => !requested || requested.includes(row.target));
  const currentHost = hosts.hosts.find((host) => host.current);
  const failures = [];
  // Every host tool is reported by name. A rolled-up "host compilers" failure
  // would say this host cannot build without saying which of the three is
  // missing, and the three come from different builders: hermesc and shermes
  // are LLVM built per architecture, dehermc is pure Go cross-compiled for
  // every host at once. Which one is absent decides what the user does next.
  for (const tool of Object.values(currentHost?.tools ?? {})) {
    if (!tool.ok) failures.push(`${tool.tool} (${hosts.currentHost}): ${tool.detail}`);
  }
  if (!currentHost) failures.push(`host tools: no record for ${hosts.currentHost}`);
  else if (!Object.keys(currentHost.tools ?? {}).length) failures.push(`host tools: ${currentHost.detail}`);
  for (const target of unknownTargets) {
    failures.push(`--target ${target} is not a Defold bundle target declared by ${artifacts.source}`);
  }
  if (requested) {
    for (const row of selected) {
      if (!row.ok) failures.push(`${row.target}: ${row.detail}`);
      else if (row.project && !row.project.ok) failures.push(`${row.target}: ${row.project.detail}`);
    }
  }
  const projectErrors = inventory?.diagnostics.filter(({ severity }) => severity === "error") ?? [];

  if (options.json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      ok: failures.length === 0 && !projectErrors.length && !projectError,
      project: inventory ? { root: inventory.projectRoot, summary: inventory.summary, diagnostics: inventory.diagnostics } : { error: projectError },
      hostCompilers: hosts,
      bundleTargets: { ...artifacts, requested, unknownTargets },
      failures
    }, null, 2));
    return failures.length || projectErrors.length || projectError ? 1 : 0;
  }

  // This host's three tools, each on its own line with its own reason. The
  // other hosts are information, not the question the user asked, so they stay
  // one line each - but that line still names the tools that are missing.
  if (!currentHost || !Object.keys(currentHost.tools ?? {}).length) {
    console.log(`!! host tools ${hosts.currentHost} (this host): ${currentHost?.status ?? "unknown-host"} ${currentHost?.detail ?? ""}`.trimEnd());
  } else {
    for (const tool of Object.values(currentHost.tools)) {
      console.log(`${tool.ok ? "ok" : "!!"} ${tool.tool} ${hosts.currentHost} (this host): ${tool.status} ${tool.detail}`);
    }
  }
  for (const host of hosts.hosts) {
    if (host.current) continue;
    const missing = host.missing ?? [];
    console.log(`${host.ok ? "ok" : "--"} host tools ${host.host}: ${host.status}${missing.length ? ` missing ${missing.join(", ")}` : ` ${host.detail}`}`);
  }
  for (const row of selected) {
    // Without an explicit --target, a target the user is not shipping is
    // information, not a failure; with one, it is the question they asked.
    const severity = row.ok ? "ok" : requested ? "!!" : "--";
    console.log(`${severity} target ${row.target}: ${row.status} ${row.detail}`);
    if (row.project && !row.project.ok) console.log(`${requested ? "!!" : "--"}   project extension: ${row.project.detail}`);
  }
  for (const target of unknownTargets) {
    console.log(`!! target ${target}: not a Defold bundle target declared by ${artifacts.source}`);
  }
  if (!inventory) {
    console.log(`-- project: ${projectError}`);
    return failures.length ? 1 : 0;
  }

  const summary = inventory.summary;
  console.log(`${projectErrors.length ? "!!" : "ok"} project: ${inventory.projectRoot}`);
  console.log(`ok extensions: ${summary.localExtensions} local, ${summary.dependencyExtensions} dependency`);
  console.log(`ok script APIs: ${summary.scriptApiFiles} file(s), ${summary.scriptModules} module declaration(s)`);
  console.log(`ok native APIs: ${summary.publicHeaders} public header(s), ${summary.extensionsRequiringNativeSchema} schema(s) required`);
  if (summary.extensionsWithoutApiMetadata) {
    console.log(`-- metadata: ${summary.extensionsWithoutApiMetadata} extension(s) expose no discoverable API metadata`);
  }
  if (summary.dependencyArchivesWithoutManifest) {
    console.log(`-- dependencies: ${summary.dependencyArchivesWithoutManifest} resolved archive(s) declare no ext.manifest and contribute no bindings`);
  }
  for (const diagnostic of inventory.diagnostics) {
    console.log(`${diagnostic.severity === "error" ? "!!" : "--"} ${diagnostic.path}: ${diagnostic.message}`);
  }
  return failures.length || projectErrors.length ? 1 : 0;
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
      catalog: options.catalog,
      project: options.project,
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
    await writeGeneratedProject(inventory, options.outDir, { defoldSdk: options.defoldSdk, bob: options.bob });
    await installNativeExtension(inventory.projectRoot);
    await generateComponentProxies({ projectRoot: inventory.projectRoot, outputRoot: inventory.projectRoot });
    const snapshot = await runDevSession(options);
    if (options.once && options.json) console.log(JSON.stringify({ schemaVersion: 1, snapshot }, null, 2));
    return snapshot.phase === "failed" ? 1 : 0;
  }
  if (options.command === "bugs") {
    // The pool reports how déherm itself behaved during real runs. It is a
    // reporting surface, never a gate, so it always exits 0; promoting a pool
    // entry into conformance or completion evidence is a category error.
    const {
      bugPoolDocument, defaultBugPoolFile, formatBugPool, harvestBugPool, readBugPool
    } = await import("./dev/bug-pool.mjs");
    const projectRoot = await findProjectRoot(process.cwd(), options.project).catch(() => path.resolve(options.project ?? process.cwd()));
    const poolFile = path.resolve(options.pool ?? defaultBugPoolFile(projectRoot));
    const result = options.harvest === false
      ? { poolFile, sources: [], document: bugPoolDocument(await readBugPool(poolFile)) }
      : await harvestBugPool({
        projectRoot,
        poolFile,
        sessionLogs: options.sessionLogs.length ? options.sessionLogs : undefined,
        transcripts: options.transcripts
      });
    if (options.json) console.log(JSON.stringify({ schemaVersion: 1, poolFile: result.poolFile, sources: result.sources, ...result.document }, null, 2));
    else console.log(formatBugPool(result.document, { cwd: process.cwd(), poolFile: result.poolFile }));
    return 0;
  }
  if (options.command === "doctor") return await runDoctor(options);
  if (options.command === "policy") {
    const { assertResolvedDefoldRevision, resolveDefoldRevision } = await import("./defold-revision.mjs");
    const { resolvePublishedPolicy } = await import("./policy-client.mjs");
    const packageRoot = path.resolve(import.meta.dirname, "../../..");
    const projectRoot = options.project
      ? await findProjectRoot(process.cwd(), options.project)
      : await findProjectRoot(process.cwd()).catch(() => null);
    const resolution = await resolveDefoldRevision({
      projectRoot: projectRoot ?? process.cwd(),
      explicit: options.defoldSdk,
      bob: options.bob
    });
    const revision = assertResolvedDefoldRevision(resolution);
    const index = JSON.parse(await readFile(path.join(packageRoot, "packages", "bindings", "generated", "defold-policy-index.json"), "utf8"));
    const result = await resolvePublishedPolicy(revision, { index });
    const summary = {
      schemaVersion: 1,
      defoldRevision: result.revision,
      policyRoot: result.entry.policyRoot,
      generator: result.entry.generator,
      namespaces: Object.keys(result.policy.subtrees).filter((name) => !name.startsWith("@")).length,
      objects: result.objects.size,
      written: result.written,
      cacheRoot: result.cacheRoot,
      source: result.source,
      revisionSource: resolution.source
    };
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`Verified Defold ${summary.defoldRevision} -> policy ${summary.policyRoot.slice(0, 12)}`);
      console.log(`${summary.namespaces} namespaces, ${summary.objects} authenticated objects; ${summary.written} cache file(s) written`);
      console.log(`Cache: ${summary.cacheRoot}`);
      if (result.surface) console.log(`Surface: ${result.surface.outputRoot} (${result.surface.written.length} file(s) updated)`);
    }
    return 0;
  }
  if (options.command === "verify-bundle") {
    // The pre-Bob gate. It never inspects the extension inventory or regenerates
    // anything, so it stays usable on a build server that only ever runs Bob,
    // and it costs a hash of the files the recorded build read.
    const {
      formatBuildArtifactReport, recomputeBundleFingerprint, summarizeBuildArtifacts, verifyProjectBuildArtifacts
    } = await import("./build-artifacts.mjs");
    const projectRoot = await findProjectRoot(process.cwd(), options.project);
    const result = await verifyProjectBuildArtifacts(projectRoot, { requireBinding: options.allowUnbound !== true });
    if (options.recompute) {
      for (const entry of result.entries) {
        if (entry.kind !== "bundle" || !entry.build?.entryPoint) continue;
        try {
          const { fingerprint } = await recomputeBundleFingerprint(projectRoot, entry);
          entry.fingerprint = { ...entry.fingerprint, fromCurrentSources: fingerprint };
          // The cheap check is conservative: it fails on any source change,
          // including one the bundler discards. A rebuild of the current
          // sources that produces the artifact already on disk answers the
          // question the gate actually asks, so it clears the failure.
          if (fingerprint === entry.fingerprint.onDisk && ["stale-sources", "artifact-replaced"].includes(entry.status)) {
            entry.status = "equivalent-rebuild";
            entry.severity = "warn";
          }
        } catch (error) {
          entry.recomputeError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    if (options.recompute) summarizeBuildArtifacts(result);
    if (options.json) console.log(JSON.stringify({ schemaVersion: 1, ...result }, null, 2));
    else {
      console.log(`${result.ok ? "ok" : "!!"} build artifacts in ${path.relative(process.cwd(), projectRoot) || "."}: ${result.status}`);
      for (const line of formatBuildArtifactReport(result)) console.log(line);
    }
    return result.ok ? 0 : 1;
  }
  const inventory = await inspectDefoldProject({
    project: options.project,
    selectProject: !options.json && process.stdin.isTTY && process.stdout.isTTY ? selectProjectFromTerminal : undefined,
    requireDehermRuntime: options.command === "generate"
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
    const output = await writeGeneratedProject(inventory, options.outDir, { defoldSdk: options.defoldSdk, bob: options.bob, force: options.force });
    const nativeExtension = await installNativeExtension(inventory.projectRoot, { force: options.force });
    const components = await generateComponentProxies({ projectRoot: inventory.projectRoot, outputRoot: inventory.projectRoot });
    const componentCount = components.manifest.components.length;
    const resourceSymbols = await writeProjectResourceSymbols(inventory.projectRoot, output.root);
    // The checker resolves Defold reachability against this index. Development
    // still links the complete surface; the index only lets the compiler report
    // what a release build would retain.
    const routeSymbols = await writeProjectRouteSymbolIndex(output.root);
    if (options.json) console.log(JSON.stringify({ ...output, nativeExtension, componentCount, resourceSymbols: { resources: resourceSymbols.table.resourceCount }, routeSymbols: { routes: routeSymbols.index.routeCount }, summary: inventory.summary }, null, 2));
    else {
      console.log(`${output.cached ? "Current" : "Generated"} extension inventory, types, and ${output.moduleCount} SDK module(s) in ${path.relative(process.cwd(), output.root) || "."}`);
      console.log(`${nativeExtension.installed ? "Installed" : "Current"} native extension in ${path.relative(process.cwd(), nativeExtension.root) || "."}`);
      console.log(`Generated ${componentCount} TypeScript component proxy resource(s)`);
      if (output.projection?.blocked) {
        console.log(`-- extension projection: ${output.projection.blocked} of ${output.projection.members} .script_api member(s) failed closed; see ${path.join(path.relative(process.cwd(), output.root) || ".", "bindings.ir.json")}`);
        for (const [code, count] of Object.entries(output.projection.blockerCodes)) console.log(`   ${code}: ${count}`);
      }
      console.log(`Indexed ${resourceSymbols.table.resourceCount} Defold resource(s) for compile-time name resolution`);
      console.log(`Indexed ${routeSymbols.index.routeCount} Defold route(s) for compile-time reachability`);
      for (const diagnostic of output.revisionDiagnostics ?? []) {
        console.log(`-- Defold revision: ${diagnostic.message}`);
      }
      console.log(`Defold API: ${output.defoldRevision} (resolved from ${output.defoldResolution?.source ?? "unknown"}; surface layer ${output.defoldSurfaceLayer ?? "unknown"})`);
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
      console.log(`ok Defold API: ${result.defoldRevision} (resolved from ${result.defoldResolution?.source ?? "unknown"})`);
      const { formatBuildArtifactReport } = await import("./build-artifacts.mjs");
      for (const line of formatBuildArtifactReport(result.buildArtifacts)) console.log(line);
      if (!result.buildArtifacts.ok) {
        console.log("   Run 'deherm verify-bundle' before Bob to gate a build on this.");
      }
    }
    return result.buildArtifacts.ok ? 0 : 1;
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
  throw new Error(`Unknown command: ${options.command}\n\n${help}`);
}
