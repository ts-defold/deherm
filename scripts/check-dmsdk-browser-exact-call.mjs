#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { materializeDmSdkUsages } from "../packages/compiler/src/dmsdk-universal-materializer.mjs";
import {
  dmSdkUniversalCatalogSha256,
  dmSdkUniversalRecipes,
} from "../packages/compiler/src/generated/dmsdk-universal-recipes.mjs";
import {
  defaultChromeBinary,
  openBundlePage,
  waitFor,
} from "../packages/cli/src/dev/browser-host.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyReportPath = path.join(root, "packages/bindings/generated/defold-dmsdk-universal-bindings.json");
const universalRuntimePath = path.join(root, "defold/defold_hermes/src/generated_dmsdk_universal.cpp");
const universalIncludePath = path.join(root, "defold/defold_hermes/include");
const dlibIncludePath = path.join(root, "upstream/defold/engine/dlib/src");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lockValue(name) {
  const lock = readFileSync(path.join(root, "upstream.lock"), "utf8");
  const match = lock.match(new RegExp(`^${name}=(.+)$`, "mu"));
  if (!match) throw new Error(`browser dmSDK exact-call prerequisite missing: ${name} is not pinned in upstream.lock`);
  return match[1].trim();
}

function executableVersion(executable, argumentsList) {
  const result = spawnSync(executable, argumentsList, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function resolveBrowserExactPrerequisites(environment = process.env) {
  const emsdkVersion = lockValue("EMSDK_VERSION");
  const emsdkRevision = lockValue("EMSDK_REV");
  const emsdkRoot = path.resolve(environment.DEHERM_EMSDK_ROOT
    ?? path.join(root, "upstream/extender/platformsdk", `emsdk-${emsdkVersion}`));
  const emxx = path.join(emsdkRoot, "upstream/emscripten/em++");
  const emConfig = path.join(emsdkRoot, ".emscripten");
  const emCache = environment.EM_CACHE
    ?? path.join(root, "upstream/extender/platformsdk", `emcache_${emsdkVersion}`);
  const chrome = environment.DEHERM_CHROME
    ?? environment.DEFOLD_HERMES_CHROME
    ?? defaultChromeBinary;
  const blockers = [];
  const actualEmsdkRevision = executableVersion("git", ["-C", emsdkRoot, "rev-parse", "HEAD"]);
  if (actualEmsdkRevision !== emsdkRevision) {
    blockers.push({
      code: "pinned-emscripten-revision-mismatch",
      expectedRevision: emsdkRevision,
      actualRevision: actualEmsdkRevision,
      path: emsdkRoot,
      remediation: "Run pnpm bootstrap:emsdk to materialize the pinned Emscripten revision.",
    });
  }
  const emxxVersion = existsSync(emxx) ? executableVersion(emxx, ["--version"]) : null;
  const versionPattern = new RegExp(`(?:^|\\s)${emsdkVersion.replaceAll(".", "\\.")}(?:\\s|$)`);
  if (!emxxVersion || !versionPattern.test(emxxVersion)) {
    blockers.push({
      code: "pinned-emscripten-unavailable",
      expectedVersion: emsdkVersion,
      path: emxx,
      remediation: "Run pnpm bootstrap:emsdk before the browser exact-call gate.",
    });
  }
  if (!existsSync(emConfig)) {
    blockers.push({
      code: "pinned-emscripten-config-unavailable",
      path: emConfig,
      remediation: "Run pnpm bootstrap:emsdk to activate the pinned Emscripten SDK.",
    });
  }
  const chromeVersion = executableVersion(chrome, ["--version"]);
  if (!chromeVersion) {
    blockers.push({
      code: "real-browser-unavailable",
      path: chrome,
      remediation: "Set DEHERM_CHROME to a Chrome or Chromium executable.",
    });
  }
  return {
    schemaVersion: 1,
    emsdkVersion,
    emsdkRevision,
    actualEmsdkRevision,
    emsdkRoot,
    emxx,
    emxxVersion,
    emConfig,
    emCache,
    chrome,
    chromeVersion,
    blockers,
  };
}

function uniqueRecipe(recipes, symbol, predicate = () => true) {
  const matches = recipes.filter((recipe) => recipe.symbol === symbol && predicate(recipe));
  if (matches.length !== 1) {
    throw new Error(`browser dmSDK exact-call fixture expected one ${symbol} recipe, found ${matches.length}`);
  }
  return matches[0];
}

export function materializeBrowserExactVectors() {
  const policy = JSON.parse(readFileSync(policyReportPath, "utf8"));
  const selections = [
    {
      recipe: uniqueRecipe(policy.recipes, "dmEndian::ToNetwork", (recipe) =>
        recipe.abi.parameters[0]?.nativeType === "uint32_t"),
      wrapper: "deherm_browser_exact_endian_u32",
    },
    {
      recipe: uniqueRecipe(policy.recipes, "dmTrigLookup::Cos"),
      wrapper: "deherm_browser_exact_cos_f32",
    },
    {
      recipe: uniqueRecipe(policy.recipes, "dmUtf8::IsWhiteSpace"),
      wrapper: "deherm_browser_exact_utf8_whitespace",
    },
    {
      recipe: uniqueRecipe(policy.recipes, "dmHashString32"),
      wrapper: "deherm_browser_exact_hash_string32",
    },
  ];
  const usages = selections.map(({ recipe, wrapper }) => ({
    declarationId: recipe.declarationId,
    wrapper,
    acknowledgements: recipe.preferredLowering.state === "generated-adapter"
      ? {
          generatedAdapterBypass: {
            reason: "exercise the generated universal fallback in a real browser Wasm module",
            evidence: "the Emscripten module executes its generated recording callee and observation assertions",
          },
        }
      : undefined,
  }));
  const materialized = materializeDmSdkUsages(usages, {
    catalog: {
      sourceHashes: { catalog: dmSdkUniversalCatalogSha256 },
      recipes: dmSdkUniversalRecipes,
    },
    catalogSha256: dmSdkUniversalCatalogSha256,
    providerName: "deherm_browser_exact_provider",
    installName: "deherm_browser_exact_install",
  });
  return { materialized, selections };
}

function browserHarness(materialized) {
  const marker = `DEHERM_BROWSER_DMSDK_EXACT_OK ${materialized.verification.manifestSha256} ${materialized.verification.vectorCount}`;
  return {
    marker,
    source: `#include <stdio.h>\n` +
      `extern "C" int ${materialized.verification.driver.function}(void);\n` +
      `int main(){const int status=${materialized.verification.driver.function}();` +
      `if(status){printf("DEHERM_BROWSER_DMSDK_EXACT_FAIL %d\\n",status);return status;}` +
      `printf(${JSON.stringify(`${marker}\n`)});return 0;}\n`,
  };
}

export async function buildBrowserExactModule({ output, prerequisites }) {
  const { materialized, selections } = materializeBrowserExactVectors();
  const harness = browserHarness(materialized);
  await mkdir(output, { recursive: true });
  const verificationPath = path.join(output, "dmsdk-exact.verify.cpp");
  const harnessPath = path.join(output, "dmsdk-exact.browser.cpp");
  const htmlPath = path.join(output, "index.html");
  await Promise.all([
    writeFile(verificationPath, materialized.verificationSource),
    writeFile(harnessPath, harness.source),
    writeFile(path.join(output, "dmsdk-exact.verify.json"), `${JSON.stringify(materialized.verification, null, 2)}\n`),
  ]);
  await mkdir(prerequisites.emCache, { recursive: true });
  execFileSync(prerequisites.emxx, [
    "-std=c++17",
    "-O2",
    "-sASSERTIONS=1",
    "-sENVIRONMENT=web",
    "-sEXIT_RUNTIME=1",
    "-sFILESYSTEM=0",
    `-I${universalIncludePath}`,
    `-I${dlibIncludePath}`,
    universalRuntimePath,
    verificationPath,
    harnessPath,
    "-o",
    htmlPath,
  ], {
    cwd: root,
    env: {
      ...process.env,
      EM_CONFIG: prerequisites.emConfig,
      EM_CACHE: prerequisites.emCache,
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
  });
  const emittedHtml = await readFile(htmlPath, "utf8");
  if (!emittedHtml.includes("</head>")) {
    throw new Error("Emscripten HTML shell does not contain a head element");
  }
  await writeFile(
    htmlPath,
    emittedHtml.replace("</head>", '<link rel="icon" href="data:,">\n</head>'),
  );
  const wasmPath = path.join(output, "index.wasm");
  const jsPath = path.join(output, "index.js");
  for (const artifact of [htmlPath, jsPath, wasmPath]) {
    if (!existsSync(artifact)) throw new Error(`Emscripten did not emit ${artifact}`);
  }
  return {
    output,
    marker: harness.marker,
    materialized,
    selections,
    artifacts: {
      html: { path: htmlPath, sha256: sha256(await readFile(htmlPath)) },
      javascript: { path: jsPath, sha256: sha256(await readFile(jsPath)) },
      wasm: { path: wasmPath, sha256: sha256(await readFile(wasmPath)) },
    },
  };
}

export async function runBrowserExactCall(options = {}) {
  const prerequisites = resolveBrowserExactPrerequisites(options.environment);
  if (prerequisites.blockers.length) {
    const error = new Error(`browser dmSDK exact-call prerequisites failed:\n${JSON.stringify(prerequisites.blockers, null, 2)}`);
    error.code = "DEHERM_BROWSER_EXACT_PREREQUISITE";
    error.blockers = prerequisites.blockers;
    throw error;
  }
  const ownedOutput = !options.output;
  const output = path.resolve(options.output ?? await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-browser-exact.")));
  try {
    const built = await buildBrowserExactModule({ output, prerequisites });
    const page = await openBundlePage({
      bundleDirectory: output,
      chromeBinary: prerequisites.chrome,
      browserTimeoutMs: options.browserTimeoutMs ?? 30_000,
      serverTimeoutMs: options.serverTimeoutMs ?? 15_000,
      // Chrome can still finish a cache-directory rename after its process
      // exits. Keep ownership here so cleanup can use bounded ENOTEMPTY retries
      // instead of making successful Wasm evidence flaky.
      keepProfile: true,
    });
    try {
      await waitFor(() => {
        const marker = page.client.transcript.find((line) => line.includes(built.marker));
        if (marker) return marker;
        const explicitFailure = page.client.transcript.find((line) => line.includes("DEHERM_BROWSER_DMSDK_EXACT_FAIL"));
        if (explicitFailure) {
          const error = new Error(explicitFailure);
          error.fatal = true;
          throw error;
        }
        if (page.client.failures.length) {
          const error = new Error(JSON.stringify(page.client.failures));
          error.fatal = true;
          throw error;
        }
        return false;
      }, { timeoutMs: options.runtimeTimeoutMs ?? 30_000, what: "the real Wasm exact-call marker" });
      if (page.client.failures.length) {
        throw new Error(`browser dmSDK exact-call page failures: ${JSON.stringify(page.client.failures)}`);
      }
      return {
        schemaVersion: 1,
        lane: "browser-wasm-emscripten-exact-call",
        realWasmModule: true,
        mockMemory: false,
        catalogSha256: dmSdkUniversalCatalogSha256,
        verificationManifestSha256: built.materialized.verification.manifestSha256,
        vectorCount: built.materialized.verification.vectorCount,
        vectors: built.materialized.verification.vectors.map(({ declarationId, numericId, vectorSha256 }) =>
          ({ declarationId, numericId, vectorSha256 })),
        toolchain: {
          emscripten: prerequisites.emsdkVersion,
          emsdkRevision: prerequisites.actualEmsdkRevision,
          emxx: prerequisites.emxxVersion.split("\n")[0],
          emxxLauncherSha256: sha256(await readFile(prerequisites.emxx)),
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
  const argumentsList = process.argv.slice(2);
  const outputIndex = argumentsList.indexOf("--output");
  const output = outputIndex === -1 ? undefined : argumentsList[outputIndex + 1];
  if (outputIndex !== -1 && !output) throw new Error("--output requires a directory");
  const report = await runBrowserExactCall({
    output,
    keepOutput: argumentsList.includes("--keep-output") || Boolean(output),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
