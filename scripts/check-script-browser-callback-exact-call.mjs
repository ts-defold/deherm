#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveBrowserExactPrerequisites,
} from "./check-dmsdk-browser-exact-call.mjs";
export { resolveBrowserExactPrerequisites } from "./check-dmsdk-browser-exact-call.mjs";
import {
  defaultChromeBinary,
  openBundlePage,
  waitFor,
} from "../packages/cli/src/dev/browser-host.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-script-recording-engine.json");
const browserBootstrapPath = path.join(root, "defold/defold_hermes/lib/web/library_defold_hermes.js");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function extractProductionCallbackRegistry(source) {
  const property = "$DEFOLD_HERMES_WEB_CALLBACKS";
  const start = source.indexOf(property);
  if (start < 0) throw new Error(`production browser bootstrap has no ${property}`);
  const objectStart = source.indexOf("{", start);
  if (objectStart < 0) throw new Error(`production browser callback registry has no object body`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let objectEnd = -1;
  for (let index = objectStart; index < source.length; ++index) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "{") ++depth;
    else if (character === "}" && --depth === 0) { objectEnd = index + 1; break; }
  }
  if (objectEnd < 0) throw new Error(`production browser callback registry object is unterminated`);
  const propertySource = source.slice(start, objectEnd);
  const releaseStart = source.indexOf("defoldHermesWebReleaseCallback__deps");
  const releaseFunction = source.indexOf("defoldHermesWebReleaseCallback:", releaseStart);
  const releaseObjectStart = source.indexOf("{", releaseFunction);
  if (releaseStart < 0 || releaseFunction < 0 || releaseObjectStart < 0) {
    throw new Error("production browser bootstrap has no callback release trampoline");
  }
  depth = 0; quote = ""; escaped = false;
  let releaseEnd = -1;
  for (let index = releaseObjectStart; index < source.length; ++index) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "{") ++depth;
    else if (character === "}" && --depth === 0) { releaseEnd = index + 1; break; }
  }
  if (releaseEnd < 0) throw new Error("production browser callback release trampoline is unterminated");
  const releaseSource = source.slice(releaseStart, releaseEnd);
  return `// Extracted byte-for-byte from library_defold_hermes.js for the isolated exact-call link.\n` +
    `var LibraryDehermExactCallbackRegistry = {\n  ${propertySource},\n  ${releaseSource}\n};\n` +
    `autoAddDeps(LibraryDehermExactCallbackRegistry, '$DEFOLD_HERMES_WEB_CALLBACKS');\n` +
    `addToLibrary(LibraryDehermExactCallbackRegistry);\n`;
}

export async function materializeScriptBrowserCallbackExactVectors() {
  const reportText = await readFile(reportPath, "utf8");
  const report = JSON.parse(reportText);
  const target = report.applicabilityCatalog.targets.indexOf("browser-wasm");
  if (target < 0) throw new Error("script recording catalog has no browser-wasm target");
  const lanes = new Map(report.applicabilityCatalog.lanes.map((lane) => [lane.id, lane]));
  const contracts = new Map(report.exactVectorCatalog.vectors.map((vector) => [vector.id, vector]));
  const vectors = report.routes.flatMap((route) => {
    const lane = lanes.get(route.applicability[target]);
    if (lane?.status !== "exercise") return [];
    const override = route.exactVector.laneOverride;
    if (lane.lane === "browser-wasm-callback-registry" && override?.lane !== lane.lane) {
      throw new Error(`${route.id} has callback applicability without a callback exact vector`);
    }
    return [{
      id: route.id,
      stableId: route.stableId,
      lane: lane.lane,
      callbackSlots: override?.callbackSlots ?? [],
      callbackInvocation: override?.callbackInvocation ?? null,
      lifecycle: override?.lifecycle ?? null,
      contract: contracts.get(route.exactVector.contract),
    }];
  });
  if (vectors.length !== report.summary.browserExact.routeCount) {
    throw new Error(`browser exact vector census drifted: ${vectors.length}`);
  }
  return {
    report,
    vectors,
    manifestSha256: sha256(JSON.stringify(vectors)),
    reportSha256: sha256(reportText),
  };
}

export async function buildScriptBrowserCallbackExactModule({ output, prerequisites }) {
  const materialized = await materializeScriptBrowserCallbackExactVectors();
  await mkdir(output, { recursive: true });
  await mkdir(prerequisites.emCache, { recursive: true });
  const htmlPath = path.join(output, "index.html");
  const callbackRegistryPath = path.join(output, "production_callback_registry.js");
  const runtimeLifecyclePath = path.join(output, "runtime_lifecycle.js");
  const callbackRegistry = extractProductionCallbackRegistry(await readFile(browserBootstrapPath, "utf8"));
  await writeFile(callbackRegistryPath, callbackRegistry);
  await writeFile(runtimeLifecyclePath,
    "var Module = typeof Module === 'object' ? Module : {};\n" +
    "Module.onExit = function(status) { console.log('DEHERM_SCRIPT_BROWSER_EXACT_EXIT status=' + status); };\n");
  execFileSync(prerequisites.emxx, [
    "-std=c++17",
    "-O2",
    "-DDM_PLATFORM_HTML5",
    "-sASSERTIONS=1",
    "-sENVIRONMENT=web",
    "-sEXIT_RUNTIME=1",
    "-sFILESYSTEM=0",
    `-I${path.join(root, "defold/defold_hermes/include")}`,
    `-I${path.join(root, "tests/fixtures")}`,
    path.join(root, "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp"),
    path.join(root, "defold/defold_hermes/src/generated_script_universal_value_capi.cpp"),
    path.join(root, "defold/defold_hermes/src/script_bridge_capi.cpp"),
    path.join(root, "tests/fixtures/generated_script_recording_tables.cpp"),
    path.join(root, "tests/fixtures/generated_script_recording_provider.cpp"),
    path.join(root, "tests/fixtures/generated_script_recording_browser_callback_driver.cpp"),
    "--js-library", callbackRegistryPath,
    "--pre-js", runtimeLifecyclePath,
    "--js-library", path.join(root, "defold/defold_hermes/lib/web/generated_script_universal_value.js"),
    "--js-library", path.join(root, "tests/fixtures/generated_script_recording_browser_callback_driver.js"),
    "-o", htmlPath,
  ], {
    cwd: root,
    env: { ...process.env, EM_CONFIG: prerequisites.emConfig, EM_CACHE: prerequisites.emCache },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
  });
  const emittedHtml = await readFile(htmlPath, "utf8");
  await writeFile(htmlPath, emittedHtml.replace("</head>", '<link rel="icon" href="data:,">\n</head>'));
  const artifacts = {};
  for (const [name, file] of [["html", "index.html"], ["javascript", "index.js"], ["wasm", "index.wasm"]]) {
    const artifact = path.join(output, file);
    if (!existsSync(artifact)) throw new Error(`Emscripten did not emit ${artifact}`);
    artifacts[name] = { path: artifact, sha256: sha256(await readFile(artifact)) };
  }
  return { ...materialized, callbackRegistrySha256: sha256(callbackRegistry), artifacts };
}

export async function runScriptBrowserCallbackExactCall(options = {}) {
  const environment = {
    ...options.environment,
    DEHERM_CHROME: options.environment?.DEHERM_CHROME ?? options.environment?.DEFOLD_HERMES_CHROME ?? defaultChromeBinary,
  };
  const prerequisites = resolveBrowserExactPrerequisites(environment);
  if (prerequisites.blockers.length) {
    const error = new Error(`browser script callback exact-call prerequisites failed:\n${JSON.stringify(prerequisites.blockers, null, 2)}`);
    error.code = "DEHERM_SCRIPT_BROWSER_CALLBACK_EXACT_PREREQUISITE";
    error.blockers = prerequisites.blockers;
    throw error;
  }
  const ownedOutput = !options.output;
  const output = path.resolve(options.output ?? await mkdtemp(path.join(tmpdir(), "deherm-script-browser-callback-exact.")));
  try {
    const built = await buildScriptBrowserCallbackExactModule({ output, prerequisites });
    const marker = `DEHERM_SCRIPT_BROWSER_EXACT_OK routes=${built.vectors.length}`;
    const page = await openBundlePage({
      bundleDirectory: output,
      chromeBinary: prerequisites.chrome,
      browserTimeoutMs: options.browserTimeoutMs ?? 30_000,
      serverTimeoutMs: options.serverTimeoutMs ?? 15_000,
      keepProfile: true,
    });
    try {
      await waitFor(() => {
        const failure = page.client.transcript.find((line) => line.includes("DEHERM_SCRIPT_BROWSER_EXACT_FAIL"));
        if (failure || page.client.failures.length) {
          const error = new Error(failure ?? JSON.stringify(page.client.failures));
          error.fatal = true;
          throw error;
        }
        const successes = page.client.transcript.filter((line) => line.startsWith(marker));
        if (successes.length > 1) {
          const error = new Error(`browser exact-call emitted ${successes.length} success records`);
          error.fatal = true;
          throw error;
        }
        const exited = page.client.transcript.includes("DEHERM_SCRIPT_BROWSER_EXACT_EXIT status=0");
        if (successes.length === 1 && exited) return successes[0];
        return false;
      }, { timeoutMs: options.runtimeTimeoutMs ?? 30_000, what: "the real script callback Wasm marker" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const lateFailure = page.client.transcript.find((line) => line.includes("DEHERM_SCRIPT_BROWSER_EXACT_FAIL"));
      if (lateFailure || page.client.failures.length) throw new Error(lateFailure ?? JSON.stringify(page.client.failures));
      return {
        schema: "deherm-script-browser-exact-result/v1",
        lane: "browser-wasm",
        realWasmModule: true,
        mockMemory: false,
        routeCount: built.vectors.length,
        directMemoryRouteCount: built.vectors.filter((vector) => vector.lane === "browser-wasm-direct-memory").length,
        callbackRouteCount: built.vectors.filter((vector) => vector.lane === "browser-wasm-callback-registry").length,
        callbackCount: built.vectors.reduce((count, vector) => count + vector.callbackSlots.length, 0),
        manifestSha256: built.manifestSha256,
        reportSha256: built.reportSha256,
        callbackRegistrySha256: built.callbackRegistrySha256,
        toolchain: {
          emscripten: prerequisites.emsdkVersion,
          emsdkRevision: prerequisites.actualEmsdkRevision,
          browser: prerequisites.chromeVersion.split("\n")[0],
        },
        artifacts: Object.fromEntries(Object.entries(built.artifacts).map(([name, artifact]) =>
          [name, { sha256: artifact.sha256 }])),
        transcript: page.client.transcript,
      };
    } finally {
      await page.close();
      await rm(page.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } finally {
    if (ownedOutput && options.keepOutput !== true) await rm(output, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
  const report = await runScriptBrowserCallbackExactCall({
    output,
    keepOutput: args.includes("--keep-output") || Boolean(output),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
