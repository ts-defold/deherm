#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as buildJavaScript } from "esbuild";

import { buildDmSdkCallSymbolIndex } from "../packages/compiler/src/dmsdk-call-symbol-index.mjs";
import { materializeDmSdkUniversalReadyCorpus } from "../packages/compiler/src/dmsdk-universal-ready-corpus.mjs";
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
const sdkIrPath = path.join(root, "packages/bindings/generated/defold-sdk-ir.json");
const universalRuntimePath = path.join(root, "defold/defold_hermes/src/generated_dmsdk_universal.cpp");
const universalIncludePath = path.join(root, "defold/defold_hermes/include");
const dlibIncludePath = path.join(root, "upstream/defold/engine/dlib/src");
const browserArenaPath = path.join(root, "packages/sdk/src/generated/dmsdk/browser-arena.ts");
const universalReportPath = path.join(root, "packages/bindings/generated/defold-dmsdk-universal-bindings.json");
const supportedBrowserWireTags = new Set(["void", "bool", "i64", "u64", "f64", "address"]);

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

export function materializeBrowserExactVectors() {
  const catalog = {
    sourceHashes: { catalog: dmSdkUniversalCatalogSha256 },
    recipes: dmSdkUniversalRecipes,
  };
  const sdkIr = JSON.parse(readFileSync(sdkIrPath, "utf8"));
  const corpus = materializeDmSdkUniversalReadyCorpus(
    buildDmSdkCallSymbolIndex(sdkIr, catalog),
    catalog,
  );
  const materialized = corpus.generated;
  return {
    materialized,
    corpus,
    applicability: classifyBrowserExactVectors(materialized.verification),
  };
}

export function classifyBrowserExactVectors(verification) {
  const maxArguments = JSON.parse(readFileSync(universalReportPath, "utf8")).abi.maxArguments;
  const vectors = verification.vectors.map((vector) => {
    const reasons = [];
    if (vector.argumentCount > maxArguments) {
      reasons.push({
        code: "browser-arena-arity-exceeds-generated-maximum",
        argumentCount: vector.argumentCount,
        maximum: maxArguments,
      });
    }
    for (const argument of vector.wireArguments) {
      if (!supportedBrowserWireTags.has(argument.tag)) {
        reasons.push({ code: "browser-arena-unsupported-argument-tag", slot: argument.slot, tag: argument.tag });
      }
      if (argument.tag === "address" && argument.fixture &&
          !["cstring", "aligned-address-token", "aligned-receiver-storage", "value-object"].includes(argument.fixture)) {
        reasons.push({ code: "browser-arena-unsupported-address-fixture", slot: argument.slot, fixture: argument.fixture });
      }
    }
    const resultTag = vector.result.fakeReturn.tag;
    if (!supportedBrowserWireTags.has(resultTag)) {
      reasons.push({ code: "browser-arena-unsupported-result-tag", tag: resultTag });
    }
    return {
      declarationId: vector.declarationId,
      numericId: vector.numericId,
      vectorSha256: vector.vectorSha256,
      argumentCount: vector.argumentCount,
      wireTags: vector.wireArguments.map(({ tag }) => tag),
      resultTag,
      applicable: reasons.length === 0,
      reasons,
    };
  });
  const applicable = vectors.filter((vector) => vector.applicable);
  const unsupported = vectors.filter((vector) => !vector.applicable);
  const reasonCounts = {};
  for (const vector of unsupported) {
    for (const reason of vector.reasons) reasonCounts[reason.code] = (reasonCounts[reason.code] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    source: "deherm-dmsdk-browser-arena-applicability",
    maximumArgumentCount: maxArguments,
    vectorCount: vectors.length,
    applicableCount: applicable.length,
    unsupportedCount: unsupported.length,
    reasonCounts,
    vectors,
    manifestSha256: sha256(JSON.stringify(vectors)),
  };
}

export function browserSupportSource(materialized) {
  const { verification } = materialized;
  const fixtureCases = verification.vectors.flatMap((vector, index) => {
    const slots = vector.wireArguments
      .filter(({ fixture }) => fixture && fixture !== "cstring")
      .map(({ slot }) => `case UINT32_C(${slot}):return static_cast<uint32_t>(deherm_exact_vector_${index}_arguments[${slot}].payload);`)
      .join("");
    return slots ? `case UINT32_C(${vector.numericId}):switch(slot){${slots}default:return 0;}` : [];
  }).join("");
  const resultCases = verification.vectors.flatMap((vector, index) => {
    const fixture = vector.result.fakeReturn.fixture;
    if (!fixture) return [];
    const suffix = fixture === "cstring" ? "return_cstring" :
      fixture === "value-object" ? "return_reference" : "return_address";
    const expression = fixture === "cstring"
      ? `deherm_exact_vector_${index}_${suffix}`
      : `&deherm_exact_vector_${index}_${suffix}`;
    return `case UINT32_C(${vector.numericId}):return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(${expression}));`;
  }).join("");
  const cstringCases = verification.vectors.flatMap((vector, index) => {
    const slots = vector.wireArguments.filter(({ fixture }) => fixture === "cstring").map(({ slot }) => slot);
    if (!slots.length) return [];
    const checks = slots.map((slot) =>
      `if(arguments[${slot}].tag!=DEHERM_DMSDK_UNIVERSAL_ADDRESS||arguments[${slot}].payload==0||` +
      `arguments[${slot}].auxiliary!=deherm_exact_vector_${index}_arguments[${slot}].auxiliary||` +
      `std::strcmp(reinterpret_cast<const char*>(static_cast<uintptr_t>(arguments[${slot}].payload)),` +
      `reinterpret_cast<const char*>(static_cast<uintptr_t>(deherm_exact_vector_${index}_arguments[${slot}].payload)))!=0)return UINT32_C(3);`
    ).join("");
    const adopt = slots.map((slot) =>
      `deherm_exact_vector_${index}_arguments[${slot}].payload=arguments[${slot}].payload;`
    ).join("");
    return `case UINT32_C(${vector.numericId}):if(argument_count!=UINT32_C(${vector.argumentCount}))return UINT32_C(2);${checks}${adopt}return 0;`;
  }).join("");
  return `
#include <cstring>
extern "C" int deherm_dmsdk_browser_exact_prepare(void){
 const int status=${verification.driver.function}();
 ${verification.observations.reset}();
 return status;
}
extern "C" uint32_t deherm_dmsdk_browser_exact_fixture(uint32_t id,uint32_t slot){switch(id){${fixtureCases}default:return 0;}}
extern "C" uint32_t deherm_dmsdk_browser_exact_result_fixture(uint32_t id){switch(id){${resultCases}default:return 0;}}
extern "C" uint32_t deherm_dmsdk_browser_exact_preflight(uint32_t id,const DehermDmSdkUniversalValue* arguments,uint32_t argument_count){
 if(argument_count&&arguments==nullptr)return UINT32_C(1);
 switch(id){${cstringCases}default:return 0;}
}
`;
}

export function browserRunnerSource({ materialized, applicability, moduleFile }) {
  const applicableIds = new Set(applicability.vectors.filter(({ applicable }) => applicable).map(({ numericId }) => numericId));
  const vectors = materialized.verification.vectors.filter(({ numericId }) => applicableIds.has(numericId)).map((vector, index) => ({
    index,
    declarationId: vector.declarationId,
    numericId: vector.numericId,
    argumentCount: vector.argumentCount,
    wireArguments: vector.wireArguments,
    result: vector.result.fakeReturn,
    vectorSha256: vector.vectorSha256,
  }));
  return `
import createExactModule from ${JSON.stringify(`./${moduleFile}`)};
import { createBrowserDmSdkUniversalBridge } from ${JSON.stringify(browserArenaPath)};

const vectors=${JSON.stringify(vectors)};
const catalogSha256=${JSON.stringify(dmSdkUniversalCatalogSha256)};
const successPrefix="DEHERM_BROWSER_DMSDK_ARENA_EXACT_OK ";
const failurePrefix="DEHERM_BROWSER_DMSDK_ARENA_EXACT_FAIL ";
const maximumActiveBytes=65536;

function argumentValue(module,vector,argument){
 switch(argument.tag){
  case"void":return undefined;
  case"bool":return Boolean(argument.value);
  case"i64":return{kind:"i64",value:BigInt(argument.value)};
  case"u64":return{kind:"u64",value:BigInt(argument.value)};
  case"f64":return argument.value;
  case"address":
   if(argument.fixture==="cstring")return argument.value;
   if(argument.fixture){const value=module._deherm_dmsdk_browser_exact_fixture(vector.numericId,argument.slot);if(!value)throw new Error("missing browser address fixture for "+vector.declarationId+" slot "+argument.slot);return{kind:"address",value:BigInt(value)};}
   return{kind:"address",value:BigInt(argument.value)};
  default:throw new Error("unsupported browser argument tag "+argument.tag);
 }
}

function expectedResult(module,vector){
 const result=vector.result;
 switch(result.tag){
  case"void":return undefined;
  case"bool":return Boolean(result.value);
  case"i64":case"u64":return BigInt(result.value);
  case"f64":return result.value;
  case"address":return{kind:"address",value:BigInt(result.fixture?module._deherm_dmsdk_browser_exact_result_fixture(vector.numericId):result.value)};
  default:throw new Error("unsupported browser result tag "+result.tag);
 }
}

function sameResult(actual,expected){
 if(actual===expected)return true;
 return actual&&expected&&actual.kind===expected.kind&&actual.value===expected.value&&actual.typeId===expected.typeId;
}

try{
 const module=await createExactModule();
 if(!(module.wasmMemory instanceof WebAssembly.Memory)||module.wasmMemory.buffer!==module.HEAPU8?.buffer)throw new Error("Emscripten WebAssembly.Memory is unavailable");
 const preparation=module._deherm_dmsdk_browser_exact_prepare();
 if(preparation!==0)throw new Error("generated fixture preparation failed with status "+preparation);
 const active=[],observations=[];
 let allocatedBytes=0,allocationCount=0,releaseCount=0,peakActiveBytes=0;
 const memory=module.wasmMemory;
 const transport={
  memory,
  catalogSha256,
  allocate(byteLength,alignment){
   if(!Number.isInteger(byteLength)||byteLength<=0||byteLength>maximumActiveBytes)throw new RangeError("unbounded browser scratch allocation");
   if(allocatedBytes+byteLength>maximumActiveBytes)throw new RangeError("browser scratch capacity exceeded");
   const address=module._malloc(byteLength);
   if(!address||address%alignment!==0){if(address)module._free(address);throw new Error("Emscripten scratch alignment failure");}
   active.push([address,byteLength,alignment]);allocatedBytes+=byteLength;allocationCount+=1;peakActiveBytes=Math.max(peakActiveBytes,allocatedBytes);
   return address;
  },
  release(address,byteLength,alignment){
   const expected=active.pop();
   if(!expected||expected[0]!==address||expected[1]!==byteLength||expected[2]!==alignment)throw new Error("browser scratch release order mismatch");
   module.HEAPU8.fill(0,address,address+byteLength);module._free(address);allocatedBytes-=byteLength;releaseCount+=1;
  },
  dispatch(id,argumentsAddress,argumentCount,resultAddress){
   const preflight=module._deherm_dmsdk_browser_exact_preflight(id,argumentsAddress,argumentCount);
   if(preflight!==0)throw new Error("browser vector preflight failed with status "+preflight+" for id "+id);
   return module._deherm_dmsdk_universal_dispatch(id,argumentsAddress,argumentCount,resultAddress);
  }
 };
 const bridge=createBrowserDmSdkUniversalBridge(transport);
 for(const vector of vectors){
  const actual=bridge.call(vector.numericId,vector.wireArguments.map((argument)=>argumentValue(module,vector,argument)));
  const expected=expectedResult(module,vector);
  const calls=module._${materialized.verification.observations.calls}(vector.numericId);
  const failures=module._${materialized.verification.observations.failures}(vector.numericId);
  if(calls!==1||failures!==0||!sameResult(actual,expected))throw new Error(JSON.stringify({declarationId:vector.declarationId,numericId:vector.numericId,calls,failures,actual,expected},(_,value)=>typeof value==="bigint"?value.toString()+"n":value));
  if(active.length||allocatedBytes!==0)throw new Error("browser scratch leaked after "+vector.declarationId);
  observations.push({numericId:vector.numericId,vectorSha256:vector.vectorSha256,calls,failures,resultTag:vector.result.tag});
 }
 if(allocationCount!==releaseCount)throw new Error("browser scratch allocation/release imbalance");
 console.log(successPrefix+JSON.stringify({vectorCount:vectors.length,observationCount:observations.length,allocationCount,releaseCount,peakActiveBytes,reverseRelease:true,liveEmscriptenHeap:true}));
}catch(error){console.error(failurePrefix+(error?.stack??String(error)));}
`;
}

export async function buildBrowserExactModule({ output, prerequisites }) {
  const { materialized, corpus, applicability } = materializeBrowserExactVectors();
  const moduleFile = "dmsdk-exact-module.mjs";
  const runnerFile = "dmsdk-exact-runner.mjs";
  const marker = `DEHERM_BROWSER_DMSDK_ARENA_EXACT_OK `;
  await mkdir(output, { recursive: true });
  const verificationPath = path.join(output, "dmsdk-exact.verify.cpp");
  const harnessPath = path.join(output, "dmsdk-exact.browser.cpp");
  const htmlPath = path.join(output, "index.html");
  const modulePath = path.join(output, moduleFile);
  const runnerSourcePath = path.join(output, "dmsdk-exact-runner.ts");
  const runnerPath = path.join(output, runnerFile);
  await Promise.all([
    writeFile(verificationPath, `${materialized.verificationSource}${browserSupportSource(materialized)}`),
    writeFile(harnessPath, "int main(){return 0;}\n"),
    writeFile(runnerSourcePath, browserRunnerSource({ materialized, applicability, moduleFile })),
    writeFile(path.join(output, "dmsdk-exact.verify.json"), `${JSON.stringify({
      ...materialized.verification,
      browserArenaApplicability: applicability,
    }, null, 2)}\n`),
  ]);
  await mkdir(prerequisites.emCache, { recursive: true });
  const defoldRevision = lockValue("DEFOLD_REV");
  const sdkRoot = path.join(root, "upstream/extender/server/app/sdk", defoldRevision, "defoldsdk");
  execFileSync(prerequisites.emxx, [
    "-std=c++17",
    "-O2",
    "-sASSERTIONS=1",
    "-sENVIRONMENT=web",
    "-sEXIT_RUNTIME=0",
    "-sFILESYSTEM=0",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORT_NAME=createDehermDmSdkExactModule",
    `-sEXPORTED_RUNTIME_METHODS=${JSON.stringify(["wasmMemory"])}`,
    `-sEXPORTED_FUNCTIONS=${JSON.stringify([
      "_malloc",
      "_free",
      "_deherm_dmsdk_universal_dispatch",
      `_${materialized.verification.observations.calls}`,
      `_${materialized.verification.observations.failures}`,
      "_deherm_dmsdk_browser_exact_prepare",
      "_deherm_dmsdk_browser_exact_fixture",
      "_deherm_dmsdk_browser_exact_result_fixture",
      "_deherm_dmsdk_browser_exact_preflight",
    ])}`,
    `-I${universalIncludePath}`,
    "-isystem", dlibIncludePath,
    "-isystem", path.join(sdkRoot, "sdk/include"),
    "-isystem", path.join(sdkRoot, "include"),
    "-isystem", path.join(sdkRoot, "ext/include"),
    "-DDLIB_LOG_DOMAIN=\"deherm\"",
    universalRuntimePath,
    verificationPath,
    harnessPath,
    "-o",
    modulePath,
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
  await buildJavaScript({
    entryPoints: [runnerSourcePath],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: runnerPath,
    external: [`./${moduleFile}`],
    logLevel: "silent",
  });
  await writeFile(htmlPath, `<!doctype html>\n<meta charset="utf-8">\n<link rel="icon" href="data:,">\n<title>déherm dmSDK browser arena exact call</title>\n<pre id="output"></pre>\n<script type="module" src="./${runnerFile}"></script>\n`);
  const wasmPath = path.join(output, "dmsdk-exact-module.wasm");
  for (const artifact of [htmlPath, modulePath, runnerPath, wasmPath]) {
    if (!existsSync(artifact)) throw new Error(`Emscripten did not emit ${artifact}`);
  }
  return {
    output,
    marker,
    materialized,
    corpus,
    applicability,
    artifacts: {
      html: { path: htmlPath, sha256: sha256(await readFile(htmlPath)) },
      emscriptenJavascript: { path: modulePath, sha256: sha256(await readFile(modulePath)) },
      arenaRunner: { path: runnerPath, sha256: sha256(await readFile(runnerPath)) },
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
      const successLine = await waitFor(() => {
        const marker = page.client.transcript.find((line) => line.includes(built.marker));
        if (marker) return marker;
        const explicitFailure = page.client.transcript.find((line) => line.includes("DEHERM_BROWSER_DMSDK_ARENA_EXACT_FAIL"));
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
      }, { timeoutMs: options.runtimeTimeoutMs ?? 30_000, what: "the real browser arena exact-call marker" });
      if (page.client.failures.length) {
        throw new Error(`browser dmSDK exact-call page failures: ${JSON.stringify(page.client.failures)}`);
      }
      const markerIndex = successLine.indexOf(built.marker);
      const runtime = JSON.parse(successLine.slice(markerIndex + built.marker.length));
      assertBrowserExactRuntime(runtime, built.applicability);
      return {
        schemaVersion: 2,
        lane: "browser-wasm-javascript-arena-exact-call",
        realWasmModule: true,
        memoryGrowthEnabled: true,
        productionJavaScriptArena: true,
        commonDispatcher: "deherm_dmsdk_universal_dispatch",
        mockMemory: false,
        embind: false,
        ccall: false,
        cwrap: false,
        catalogSha256: dmSdkUniversalCatalogSha256,
        verificationManifestSha256: built.materialized.verification.manifestSha256,
        applicabilityManifestSha256: built.applicability.manifestSha256,
        vectorCount: built.applicability.vectorCount,
        applicableCount: built.applicability.applicableCount,
        unsupportedCount: built.applicability.unsupportedCount,
        unsupportedReasonCounts: built.applicability.reasonCounts,
        unsupported: built.applicability.vectors.filter(({ applicable }) => !applicable),
        runtime,
        vectors: built.applicability.vectors.map(({ declarationId, numericId, vectorSha256, applicable, reasons }) =>
          ({ declarationId, numericId, vectorSha256, applicable, reasons })),
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

export function assertBrowserExactRuntime(runtime, applicability) {
  const expected = applicability.applicableCount;
  const violations = [];
  const exactInteger = (name, value, wanted) => {
    if (!Number.isSafeInteger(value) || value !== wanted) violations.push({ name, expected: wanted, actual: value });
  };
  exactInteger("runtime.vectorCount", runtime?.vectorCount, expected);
  exactInteger("runtime.observationCount", runtime?.observationCount, expected);
  if (!Number.isSafeInteger(runtime?.allocationCount) || runtime.allocationCount < 0) {
    violations.push({ name: "runtime.allocationCount", expected: "non-negative safe integer", actual: runtime?.allocationCount });
  }
  if (!Number.isSafeInteger(runtime?.releaseCount) || runtime.releaseCount !== runtime?.allocationCount) {
    violations.push({ name: "runtime.releaseCount", expected: runtime?.allocationCount, actual: runtime?.releaseCount });
  }
  if (!Number.isSafeInteger(runtime?.peakActiveBytes) || runtime.peakActiveBytes < 0 || runtime.peakActiveBytes > 65_536) {
    violations.push({ name: "runtime.peakActiveBytes", expected: "integer in [0, 65536]", actual: runtime?.peakActiveBytes });
  }
  if (runtime?.reverseRelease !== true) violations.push({ name: "runtime.reverseRelease", expected: true, actual: runtime?.reverseRelease });
  if (runtime?.liveEmscriptenHeap !== true) violations.push({ name: "runtime.liveEmscriptenHeap", expected: true, actual: runtime?.liveEmscriptenHeap });
  if (violations.length) {
    const error = new Error(`browser dmSDK exact-call runtime evidence disagrees with its applicability partition:\n${JSON.stringify(violations, null, 2)}`);
    error.code = "DEHERM_BROWSER_EXACT_RUNTIME_MISMATCH";
    error.violations = violations;
    throw error;
  }
  return runtime;
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
