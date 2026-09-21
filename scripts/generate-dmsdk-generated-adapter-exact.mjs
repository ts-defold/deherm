#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildDmSdkCallSymbolIndex } from "../packages/compiler/src/dmsdk-call-symbol-index.mjs";
import {
  dmSdkGeneratedAdapterCorpusArtifacts,
  materializeDmSdkGeneratedAdapterCorpus,
} from "../packages/compiler/src/dmsdk-generated-adapter-corpus.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPaths = Object.freeze({
  arenaCString: "packages/bindings/generated/defold-dmsdk-arena-span-blockers.json",
  scalar: "packages/bindings/generated/defold-dmsdk-scalar-thunks.json",
  enumValue: "packages/bindings/generated/defold-dmsdk-enum-value-bindings.json",
  fixedDigest: "packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json",
  hashSpan: "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json",
  base64Span: "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json",
  xteaSpan: "packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json",
  astcProbe: "packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json",
  cstringValue: "packages/bindings/generated/defold-dmsdk-cstring-value-bindings.json",
});
const dispatchers = Object.freeze({
  arenaCString: "deherm_dmsdk_arena_cstring_dispatch",
  scalar: "deherm_dmsdk_scalar_dispatch",
  enumValue: "deherm_dmsdk_enum_dispatch",
  fixedDigest: "deherm_dmsdk_fixed_digest_dispatch",
  hashSpan: "deherm_dmsdk_hash_span_dispatch",
  base64Span: "deherm_dmsdk_base64_span_dispatch",
  xteaSpan: "deherm_dmsdk_xtea_span_dispatch",
  astcProbe: "deherm_dmsdk_astc_probe_dispatch",
  cstringValue: "deherm_dmsdk_cstring_value_dispatch",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function parseArguments(argv) {
  const options = { check: false, outRoot: repositoryRoot };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") options.check = true;
    else if (argv[index] === "--out-root") options.outRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function emitted(declaration) {
  return declaration.disposition === "generated" || declaration.emitted === true ||
    (typeof declaration.wrapper === "string" && Number.isSafeInteger(declaration.denseId ?? declaration.bindingId));
}

export async function buildDmSdkGeneratedAdapterExact({ root = repositoryRoot, outRoot = root, familyReportPaths = {} } = {}) {
  const effectiveReportPaths = { ...reportPaths, ...familyReportPaths };
  const [catalogSource, irSource, reports] = await Promise.all([
    readFile(path.join(root, "packages/bindings/generated/defold-dmsdk-universal-bindings.json"), "utf8"),
    readFile(path.join(root, "packages/bindings/generated/defold-sdk-ir.json"), "utf8"),
    Promise.all(Object.entries(effectiveReportPaths).map(async ([family, relative]) => {
      const source = await readFile(path.resolve(root, relative), "utf8");
      return [family, relative, source, JSON.parse(source)];
    })),
  ]);
  const productionCatalog = JSON.parse(catalogSource);
  const ir = JSON.parse(irSource);
  const routeByDeclaration = new Map();
  const declarationByFamilyId = new Map();
  for (const [family, , , report] of reports) {
    for (const declaration of [
      ...(report.declarations ?? []),
      ...(report.generatedDeclarations ?? []),
    ]) {
      if (!emitted(declaration)) continue;
      const id = declaration.denseId ?? declaration.bindingId;
      if (!Number.isSafeInteger(id)) throw new Error(`${declaration.id} has no family-local adapter id`);
      if (routeByDeclaration.has(declaration.id)) throw new Error(`${declaration.id} is owned by multiple callable adapter families`);
      const familyId = `${family}:${id}`;
      if (declarationByFamilyId.has(familyId)) {
        throw new Error(
          `${declaration.id} and ${declarationByFamilyId.get(familyId)} share callable adapter identity ${familyId}`
        );
      }
      declarationByFamilyId.set(familyId, declaration.id);
      routeByDeclaration.set(declaration.id, {
        family,
        id,
        dispatcher: dispatchers[family],
        callee: family === "arenaCString"
          ? declaration.symbol
          : declaration.wrapper ?? declaration.symbol,
        digestBytes: declaration.digestBytes ?? null,
        resultBits: declaration.resultBits ?? null,
        mode: declaration.mode ?? declaration.recipe?.kind ?? null,
      });
    }
  }
  const consumedRoutes = new Set();
  const recipes = productionCatalog.recipes.map((recipe) => {
    if (recipe.preferredLowering?.state !== "generated-adapter") return recipe;
    const route = routeByDeclaration.get(recipe.declarationId);
    if (!route) return recipe;
    if (route.family !== recipe.preferredLowering.family) {
      throw new Error(`${recipe.declarationId} family report disagrees with the production recipe`);
    }
    const production = recipe.preferredLowering.adapter;
    if (production?.applicability !== "callable") {
      throw new Error(`${recipe.declarationId} production adapter is not callable`);
    }
    if (production.kind === "family-dispatch") {
      if (production.id !== route.id || production.dispatcher !== route.dispatcher) {
        throw new Error(`${recipe.declarationId} production family-dispatch identity disagrees with its report`);
      }
    } else if (production.kind === "named-wrapper") {
      if (recipe.preferredLowering.wrapper !== route.callee) {
        throw new Error(`${recipe.declarationId} production named-wrapper identity disagrees with its report`);
      }
    } else {
      throw new Error(`${recipe.declarationId} has unsupported production adapter kind ${production.kind}`);
    }
    consumedRoutes.add(recipe.declarationId);
    return {
      ...recipe,
      preferredLowering: {
        ...recipe.preferredLowering,
        exactAdapter: {
          applicability: "callable",
          kind: "family-dispatch",
          id: route.id,
          dispatcher: route.dispatcher,
          callee: route.callee,
          digestBytes: route.digestBytes,
          resultBits: route.resultBits,
          mode: route.mode,
          blockers: [],
        },
      },
    };
  });
  const orphanRoutes = [...routeByDeclaration.keys()].filter((declarationId) => !consumedRoutes.has(declarationId));
  if (orphanRoutes.length) {
    throw new Error(
      `Callable adapter reports contain declarations absent from the generated-adapter recipe surface: ${orphanRoutes.join(", ")}`
    );
  }
  const exactCatalogSha256 = sha256(JSON.stringify(recipes));
  const exactCatalog = {
    ...productionCatalog,
    sourceHashes: { ...productionCatalog.sourceHashes, catalog: exactCatalogSha256 },
    recipes,
  };
  const index = buildDmSdkCallSymbolIndex(ir, exactCatalog);
  const corpus = materializeDmSdkGeneratedAdapterCorpus(index, exactCatalog);
  const { corpusSha256: _derivedCorpusSha256, ...corpusBody } = corpus.report;
  const reportBody = {
    ...corpusBody,
    productionCatalogSha256: productionCatalog.sourceHashes.catalog,
    exactCatalogSha256,
    sourceHashes: {
      productionCatalog: sha256(catalogSource),
      sdkIr: sha256(irSource),
      familyReports: Object.fromEntries(reports.map(([family, relative, source]) =>
        [family, { path: relative, sha256: sha256(source) }])),
    },
  };
  const report = { ...reportBody, corpusSha256: sha256(canonicalJson(reportBody)) };
  const outputs = new Map([
    [dmSdkGeneratedAdapterCorpusArtifacts.plan, `${JSON.stringify(report, null, 2)}\n`],
    [dmSdkGeneratedAdapterCorpusArtifacts.verificationSource, corpus.verificationSource],
    [dmSdkGeneratedAdapterCorpusArtifacts.jsiVerificationSource, corpus.jsiVerificationSource],
  ]);
  for (const [relative, contents] of outputs) {
    const target = path.join(outRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return { ...corpus, report };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.check) {
    const result = await buildDmSdkGeneratedAdapterExact({ outRoot: options.outRoot });
    process.stdout.write(`Generated ${result.report.generatedAdapterCount} dmSDK generated-adapter exact vectors from ${result.report.recipeCount} recipes.\n`);
    return result;
  }
  const temporary = path.join(options.outRoot, `.dmsdk-generated-adapter-exact-${process.pid}`);
  try {
    const result = await buildDmSdkGeneratedAdapterExact({ outRoot: temporary });
    for (const relative of Object.values(dmSdkGeneratedAdapterCorpusArtifacts)) {
      const [expected, actual] = await Promise.all([
        readFile(path.join(temporary, relative)),
        readFile(path.join(options.outRoot, relative)),
      ]);
      if (!expected.equals(actual)) throw new Error(`${relative} is stale`);
    }
    process.stdout.write(`Verified ${result.report.generatedAdapterCount} dmSDK generated-adapter exact vectors from ${result.report.recipeCount} recipes.\n`);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
