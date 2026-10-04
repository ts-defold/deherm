#!/usr/bin/env node

// Generates the named-scalar dmSDK C ABI from source-resolved scalar aliases.
// One recipe owns the public wrapper, raw-cell dispatcher, and exact-call twin.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { indexDmSdkValuePlan } from "../packages/compiler/src/dmsdk-value-plan.mjs";
import {
  createDmSdkNamedScalarRecipeFacts,
  DMSDK_NAMED_SCALAR_RECIPE_FACTS_NAME,
  renderDmSdkNamedScalarOutputs,
} from "../packages/compiler/src/dmsdk-named-scalar-output-emitter.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultIrPath = "packages/bindings/generated/defold-sdk-ir.json";
const defaultShapesPath = "packages/bindings/generated/defold-dmsdk-abi-shapes.json";
const defaultValuePlanPath = "packages/bindings/generated/defold-dmsdk-value-plan.json";
const defaultSymbolEvidencePath = "packages/bindings/generated/defold-dmsdk-symbol-evidence.json";
const defaultPolicyPath = "packages/bindings/overrides/dmsdk-named-scalar-policies.json";
const outputReportPath = "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json";
const outputPaths = Object.freeze({
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar.h",
  runtimeHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_runtime.h",
  jsiHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_jsi.hpp",
  runtime: "defold/defold_hermes/src/generated_dmsdk_named_scalar_runtime.cpp",
  jsi: "defold/defold_hermes/src/generated_dmsdk_named_scalar_jsi.cpp",
  exact: "tests/fixtures/generated_dmsdk_named_scalar_exact_verification.cpp",
  typescript: "packages/sdk/src/generated/dmsdk/named-scalar.ts",
});

const builtinTypes = Object.freeze({
  void: Object.freeze({ c: "void", lane: "void" }),
  bool: Object.freeze({ c: "uint8_t", lane: "bool" }),
  int: Object.freeze({ c: "int32_t", lane: "i32" }),
  int32_t: Object.freeze({ c: "int32_t", lane: "i32" }),
  uint32_t: Object.freeze({ c: "uint32_t", lane: "u32" }),
  int64_t: Object.freeze({ c: "int64_t", lane: "i64" }),
  uint64_t: Object.freeze({ c: "uint64_t", lane: "u64" }),
  uintptr_t: Object.freeze({ c: "uintptr_t", lane: "usize" }),
  float: Object.freeze({ c: "float", lane: "f32" }),
  double: Object.freeze({ c: "double", lane: "f64" }),
});
const digest = (content) => createHash("sha256").update(content).digest("hex");
export const orderedBlockingReasons = ({ symbolBlocker = null, resultBlocker = null, parameterBlockers = [] }) => [
  ...new Set([symbolBlocker, resultBlocker, ...parameterBlockers].filter(Boolean)),
];
const normalizedInputPath = (input) => {
  const absolute = resolve(repositoryRoot, input);
  const repositoryRelative = relative(repositoryRoot, absolute).replaceAll("\\", "/");
  return repositoryRelative && repositoryRelative !== ".." && !repositoryRelative.startsWith("../")
    ? repositoryRelative
    : absolute.replaceAll("\\", "/");
};
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};

function parseArguments(argv) {
  const options = {
    outRoot: repositoryRoot,
    irPath: defaultIrPath,
    shapesPath: defaultShapesPath,
    valuePlanPath: defaultValuePlanPath,
    symbolEvidencePath: defaultSymbolEvidencePath,
    policyPath: defaultPolicyPath,
    check: false,
  };
  for (let index = 0; index < argv.length; ++index) {
    if (argv[index] === "--check") options.check = true;
    else if (argv[index] === "--out-root") options.outRoot = resolve(argv[++index]);
    else if (argv[index] === "--ir") options.irPath = resolve(argv[++index]);
    else if (argv[index] === "--shapes") options.shapesPath = resolve(argv[++index]);
    else if (argv[index] === "--value-plan") options.valuePlanPath = resolve(argv[++index]);
    else if (argv[index] === "--symbol-evidence") options.symbolEvidencePath = resolve(argv[++index]);
    else if (argv[index] === "--policy") options.policyPath = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function snakeCase(value) {
  return value
    .replace(/::/g, "_")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function wrapperName(declaration) {
  return `deherm_dmsdk_named_scalar_${snakeCase(declaration.name)}`;
}

function declarationEvidence(content, declaration) {
  const lines = content.split(/\r?\n/);
  if (Number.isSafeInteger(declaration.line) && declaration.line > 0 && declaration.line <= lines.length) {
    return { line: declaration.line, text: lines[declaration.line - 1].trim(), source: "ir-source-location" };
  }
  return { line: 0, text: null, source: "preprocessor-expanded-ir" };
}

function includeFor(header) {
  const marker = "/dmsdk/";
  const index = header.indexOf(marker);
  if (index < 0) throw new Error(`No public dmSDK include path in ${header}`);
  return `dmsdk/${header.slice(index + marker.length)}`;
}

function leaf(value) {
  return String(value).split("::").at(-1);
}

function buildTypeIndex(ir) {
  const exact = new Map();
  const leaves = new Map();
  for (const declaration of ir.declarations) {
    if (declaration.kind !== "type-alias" || !declaration.name) continue;
    exact.set(declaration.name, declaration);
    const matches = leaves.get(leaf(declaration.name)) ?? [];
    matches.push(declaration);
    leaves.set(leaf(declaration.name), matches);
  }
  return { exact, leaves };
}

function resolveTypeAlias(type, symbol, index) {
  const clean = String(type)
    .replace(/\b(?:const|volatile|enum|struct|class)\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (index.exact.has(clean)) return index.exact.get(clean);
  const namespace = String(symbol).split("::").slice(0, -1).join("::");
  if (namespace && index.exact.has(`${namespace}::${clean}`)) return index.exact.get(`${namespace}::${clean}`);
  const matches = index.leaves.get(leaf(clean)) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

async function aliasEvidence(alias, evidenceCache) {
  let cached = evidenceCache.get(alias.header);
  if (!cached) {
    const content = await readFile(resolve(repositoryRoot, alias.header), "utf8");
    cached = { content, sha256: digest(content), lines: content.split(/\r?\n/u) };
    evidenceCache.set(alias.header, cached);
  }
  if (!Number.isSafeInteger(alias.line) || alias.line <= 0 || alias.line > cached.lines.length)
    throw new Error(`${alias.id}: type-alias source location is invalid`);
  return {
    declarationId: alias.id,
    path: alias.header,
    line: alias.line,
    text: cached.lines[alias.line - 1].trim(),
    sha256: cached.sha256,
  };
}

async function typeSpec(type, role, declaration, index, evidenceCache, seen = new Set()) {
  const expectedLane = role.startsWith("scalar:") ? role.slice("scalar:".length) : null;
  const builtin = builtinTypes[type];
  if (builtin) {
    if (builtin.lane !== expectedLane) return { blocked: `scalar-role-mismatch:${type}:${role}` };
    return { ...builtin, source: type, underlying: type, native: type, evidence: null };
  }
  const alias = resolveTypeAlias(type, declaration.name, index);
  if (!alias || seen.has(alias.id)) return { blocked: `unknown-native-scalar:${type}` };
  const nextSeen = new Set(seen).add(alias.id);
  const resolved = await typeSpec(alias.type, role, alias, index, evidenceCache, nextSeen);
  if (resolved.blocked) return resolved;
  return {
    ...resolved,
    source: type,
    underlying: alias.type,
    native: alias.name,
    evidence: await aliasEvidence(alias, evidenceCache),
  };
}

function sentinel(spec, id, position, result = false) {
  const seed = (result ? 7000 : 3000) + id * 17 + position;
  if (spec.lane === "bool") return { native: "true", raw: "UINT64_C(1)" };
  if (spec.lane === "i32") return { native: `-${seed}`, raw: `static_cast<uint64_t>(INT64_C(-${seed}))` };
  if (spec.lane === "i64")
    return { native: `INT64_C(-${4294967296 + seed})`, raw: `static_cast<uint64_t>(INT64_C(-${4294967296 + seed}))` };
  if (spec.lane === "u32") return { native: `UINT32_C(${seed})`, raw: `UINT64_C(${seed})` };
  if (spec.lane === "u64") return { native: `UINT64_C(${4294967296 + seed})`, raw: `UINT64_C(${4294967296 + seed})` };
  if (spec.lane === "usize") return { native: `static_cast<uintptr_t>(${seed})`, raw: `UINT64_C(${seed})` };
  if (spec.lane === "f32")
    return {
      native: `${100 + id + position + (result ? 0.75 : 0.25)}f`,
      raw: `pack_f32(${100 + id + position + (result ? 0.75 : 0.25)}f)`,
    };
  if (spec.lane === "f64")
    return {
      native: `${200 + id + position + (result ? 0.875 : 0.375)}`,
      raw: `pack_f64(${200 + id + position + (result ? 0.875 : 0.375)})`,
    };
  return { native: "", raw: "UINT64_C(0)" };
}

function fakeDefinition(entry) {
  const parameters = entry.parameters.map((parameter, position) => `${parameter.native} a${position}`).join(", ");
  const checks = entry.parameters
    .map((parameter, position) => {
      const expected = sentinel(parameter, entry.bindingId, position).native;
      return `if(a${position}!=static_cast<${parameter.native}>(${expected}))++g_failures[${entry.bindingId}];`;
    })
    .join("");
  let returned = "";
  if (entry.result.lane !== "void") {
    const expected = sentinel(entry.result, entry.bindingId, 0, true).native;
    returned = `return static_cast<${entry.result.native}>(${expected});`;
  }
  return `${entry.result.native} ${entry.symbol}(${parameters}){++g_calls[${entry.bindingId}];${checks}${returned}}`;
}

function renderExact(entries) {
  const includes = [...new Set(entries.map(({ include }) => include))]
    .sort()
    .map((include) => `#include <${include}>`)
    .join("\n");
  const checks = entries
    .map((entry) => {
      const argumentsList = entry.parameters.map(
        (parameter, position) => sentinel(parameter, entry.bindingId, position).raw,
      );
      const result = sentinel(entry.result, entry.bindingId, 0, true).raw;
      return `  {uint64_t arguments[2]={${argumentsList.join(",") || "UINT64_C(0)"}};uint64_t output=UINT64_C(0xffff);if(deherm_dmsdk_named_scalar_dispatch(UINT16_C(${entry.bindingId}),arguments,UINT32_C(${argumentsList.length}),&output)!=DEHERM_DMSDK_NAMED_SCALAR_OK)return ${entry.bindingId + 100};if(g_calls[${entry.bindingId}]!=UINT32_C(1)||g_failures[${entry.bindingId}]!=UINT32_C(0)||output!=${entry.result.lane === "void" ? "UINT64_C(0)" : result})return ${entry.bindingId + 200};}`;
    })
    .join("\n");
  const descriptorChecks = entries
    .map(
      (entry) =>
        `  if(deherm_dmsdk_named_scalar_descriptors()[${entry.bindingId}].id!=UINT16_C(${entry.bindingId})||strcmp(deherm_dmsdk_named_scalar_descriptors()[${entry.bindingId}].declaration_id,${JSON.stringify(entry.declarationId)})!=0)return ${entry.bindingId + 300};`,
    )
    .join("\n");
  const rejectionChecks = entries
    .flatMap((entry) =>
      entry.parameters.map((parameter, position) => {
        const invalid = {
          bool: "UINT64_C(2)",
          i32: "UINT64_C(0x00000000ffffffff)",
          u32: "UINT64_C(0x100000000)",
          f32: "UINT64_C(0x100000000)",
          usize: "UINT64_MAX",
        }[parameter.lane];
        if (!invalid) return "";
        const argumentsList = entry.parameters.map((value, index) =>
          index === position ? invalid : sentinel(value, entry.bindingId, index).raw,
        );
        const check = `  {uint64_t arguments[2]={${argumentsList.join(",")}};uint64_t output=UINT64_C(0xfeed);const uint32_t calls=g_calls[${entry.bindingId}];if(deherm_dmsdk_named_scalar_dispatch(UINT16_C(${entry.bindingId}),arguments,UINT32_C(${argumentsList.length}),&output)!=DEHERM_DMSDK_NAMED_SCALAR_RANGE||g_calls[${entry.bindingId}]!=calls||output!=UINT64_C(0xfeed))return ${500 + entry.bindingId * 4 + position};}`;
        return parameter.lane === "usize" ? `#if UINTPTR_MAX < UINT64_MAX\n${check}\n#endif` : check;
      }),
    )
    .filter(Boolean)
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-named-scalar-bindings.mjs. Do not edit.
#include <defold_hermes/generated_dmsdk_named_scalar_runtime.h>
#ifndef DLIB_LOG_DOMAIN
#define DLIB_LOG_DOMAIN "defold_hermes"
#endif
${includes}
#include <cstring>
namespace {uint32_t g_calls[${entries.length}]{};uint32_t g_failures[${entries.length}]{};uint64_t pack_f32(float value){uint32_t bits=0;memcpy(&bits,&value,sizeof(bits));return bits;}uint64_t pack_f64(double value){uint64_t bits=0;memcpy(&bits,&value,sizeof(bits));return bits;}}
${entries.map(fakeDefinition).join("\n")}
extern "C" int deherm_dmsdk_named_scalar_exact_verify(void){
  if(deherm_dmsdk_named_scalar_count()!=UINT32_C(${entries.length}))return 1;
${descriptorChecks}
${checks}
${rejectionChecks}
  return 0;
}
`;
}

function requireUniqueIds(rows, label) {
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) throw new Error(`${label} contains an invalid declaration id`);
    if (ids.has(row.id)) throw new Error(`${label} contains duplicate declaration id: ${row.id}`);
    ids.add(row.id);
  }
}

function validateProvenance(ir, irContent, shapes) {
  if (ir.schemaVersion !== 1 || !Array.isArray(ir.declarations) || typeof ir.defoldRevision !== "string")
    throw new Error("Invalid dmSDK IR schema");
  if (shapes.schemaVersion !== 1 || !Array.isArray(shapes.rows) || typeof shapes.defoldRevision !== "string")
    throw new Error("Invalid dmSDK ABI-shape schema");
  if (ir.defoldRevision !== shapes.defoldRevision) throw new Error("dmSDK IR and ABI-shape Defold revisions differ");
  if (shapes.sourceHashes?.ir !== digest(irContent))
    throw new Error("dmSDK ABI-shape IR hash does not match the exact IR input");
  requireUniqueIds(ir.declarations, "dmSDK IR");
  requireUniqueIds(shapes.rows, "dmSDK ABI-shape report");
}

export async function build({
  irPath = defaultIrPath,
  shapesPath = defaultShapesPath,
  valuePlanPath = defaultValuePlanPath,
  symbolEvidencePath = defaultSymbolEvidencePath,
  policyPath = defaultPolicyPath,
} = {}) {
  const [irContent, shapesContent, valuePlanContent, symbolEvidenceContent, policyContent] = await Promise.all([
    readFile(resolve(repositoryRoot, irPath), "utf8"),
    readFile(resolve(repositoryRoot, shapesPath), "utf8"),
    readFile(resolve(repositoryRoot, valuePlanPath), "utf8"),
    readFile(resolve(repositoryRoot, symbolEvidencePath), "utf8"),
    readFile(resolve(repositoryRoot, policyPath), "utf8"),
  ]);
  const ir = JSON.parse(irContent);
  const shapes = JSON.parse(shapesContent);
  const valuePlan = JSON.parse(valuePlanContent);
  const symbolEvidence = JSON.parse(symbolEvidenceContent);
  const policy = JSON.parse(policyContent);
  const reportedSymbolEvidencePath = normalizedInputPath(symbolEvidencePath);
  validateProvenance(ir, irContent, shapes);
  if (
    symbolEvidence.schemaVersion !== 2 ||
    symbolEvidence.defoldRevision !== ir.defoldRevision ||
    !symbolEvidence.declarations ||
    typeof symbolEvidence.declarations !== "object"
  )
    throw new Error("Invalid or revision-mismatched dmSDK symbol evidence");
  if (policy.schemaVersion !== 3 || !policy.policyVersion || policy.family !== "named-scalar")
    throw new Error("Invalid named-scalar structural policy");
  const byId = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const aliases = buildTypeIndex(ir);
  const planById = indexDmSdkValuePlan(valuePlan, {
    revision: ir.defoldRevision,
    sourceHashes: {
      ir: digest(irContent),
      shapes: digest(shapesContent),
      namedScalar: digest(policyContent),
    },
  });
  const patterns = valuePlan.patternRegistry.filter(
    ({ id }) => id === "value.named-scalar-direct" || id === "universal.default",
  );
  const candidates = shapes.rows
    .map((shape) => {
      const declaration = byId.get(shape.id);
      const decision = planById.get(shape.id);
      return decision?.patternId === "value.named-scalar-direct"
        ? { shape, declaration, semantics: decision.semantics, decision }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.declaration.id.localeCompare(b.declaration.id));
  const evidenceCache = new Map();
  const entries = [];
  const blocked = [];
  for (const { shape, declaration, semantics, decision } of candidates) {
    const linkage = symbolEvidence.declarations[declaration.id];
    if (!linkage) throw new Error(`dmSDK symbol evidence is missing ${declaration.id}`);
    const result = await typeSpec(declaration.returns, shape.result.role, declaration, aliases, evidenceCache);
    const parameters = await Promise.all(
      declaration.parameters.map(async (parameter, index) => ({
        ...(await typeSpec(parameter.type, shape.parameters[index].role, declaration, aliases, evidenceCache)),
        name: parameter.name,
        source: parameter.type,
      })),
    );
    const symbolBlocker =
      linkage.linkage === "header-only" ||
      (linkage.linkage === "external" && linkage.availability === "all-targets-all-variants")
        ? null
        : `native-symbol-${linkage.linkage === "external" ? linkage.availability : linkage.linkage}`;
    const blockerReasons = orderedBlockingReasons({
      symbolBlocker,
      resultBlocker: result.blocked,
      parameterBlockers: parameters.map(({ blocked }) => blocked),
    });
    const blocker = blockerReasons[0];
    const header = await readFile(resolve(repositoryRoot, declaration.header), "utf8");
    const headerHash = digest(header);
    if (shapes.sourceHashes.headers?.[declaration.header] !== headerHash)
      throw new Error(`${declaration.id}: named-scalar header provenance drifted`);
    const common = {
      declarationId: declaration.id,
      symbol: declaration.name,
      nativeSignature: declaration.type,
      shape: shape.shape,
      include: includeFor(declaration.header),
      aliases: semantics.aliases,
      patternDecision: decision.patternId,
      headerEvidence: { path: declaration.header, ...declarationEvidence(header, declaration), sha256: headerHash },
      symbolEvidence: {
        path: reportedSymbolEvidencePath,
        sha256: digest(symbolEvidenceContent),
        linkage: linkage.linkage,
        availability: linkage.availability,
        linkedIn: linkage.linkedIn,
      },
    };
    if (blocker) {
      blocked.push({
        ...common,
        emitted: false,
        blocker,
        ...(blockerReasons.length > 1 ? { blockerReasons } : {}),
      });
      continue;
    }
    const bindingId = entries.length;
    const wrapper = wrapperName(declaration);
    const recipe = {
      bindingId,
      declarationId: declaration.id,
      symbol: declaration.name,
      wrapper,
      include: common.include,
      result,
      parameters,
    };
    entries.push({ ...common, ...recipe, exactVectorSha256: digest(canonicalJson(recipe)) });
  }
  const recipeFacts = createDmSdkNamedScalarRecipeFacts(entries);
  const rendered = renderDmSdkNamedScalarOutputs(recipeFacts);
  const artifacts = new Map([
    [outputPaths.header, rendered.header],
    [outputPaths.runtimeHeader, rendered.runtimeHeader],
    [outputPaths.runtime, rendered.runtime],
    [outputPaths.jsiHeader, rendered.jsiHeader],
    [outputPaths.jsi, rendered.jsi],
    [outputPaths.exact, renderExact(entries)],
    [outputPaths.typescript, rendered.typescript],
  ]);
  const declarations = [
    ...entries.map((entry) => ({
      id: entry.declarationId,
      symbol: entry.symbol,
      nativeSignature: entry.nativeSignature,
      shape: entry.shape,
      emitted: true,
      bindingId: entry.bindingId,
      wrapper: entry.wrapper,
      preferredLowering: false,
      aliases: entry.aliases,
      patternDecision: entry.patternDecision,
      recipe: {
        include: entry.include,
        result: entry.result,
        parameters: entry.parameters,
        exactVectorSha256: entry.exactVectorSha256,
      },
      headerEvidence: entry.headerEvidence,
      symbolEvidence: entry.symbolEvidence,
      stages: {
        generated: { status: "complete", evidence: outputPaths.runtime },
        compiled: { status: "covered-by-reproducible-test", evidence: "tests/dmsdk-named-scalar-bindings.test.mjs" },
        linked: { status: "covered-by-reproducible-test", evidence: reportedSymbolEvidencePath },
        conformant: { status: "covered-by-reproducible-test", evidence: outputPaths.exact },
        allocation: {
          status: "100000-warmed-dispatch-zero-cpp-allocations",
          evidence: "native/dmsdk_named_scalar_runtime_test.cpp",
        },
        typescriptCallable: { status: "not-applicable", evidence: outputPaths.typescript },
      },
    })),
    ...blocked.map((entry) => ({
      id: entry.declarationId,
      symbol: entry.symbol,
      nativeSignature: entry.nativeSignature,
      shape: entry.shape,
      emitted: false,
      blocker: entry.blocker,
      ...(entry.blockerReasons ? { blockerReasons: entry.blockerReasons } : {}),
      aliases: entry.aliases,
      patternDecision: entry.patternDecision,
      headerEvidence: entry.headerEvidence,
      symbolEvidence: entry.symbolEvidence,
    })),
  ];
  const report = {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    defoldRevision: ir.defoldRevision,
    sourceShapeCensus: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
    scope:
      "Every function whose result and parameters resolve through the revision IR to fixed-width scalar cells and which contains at least one named scalar alias. Admission also requires a symbol that the pinned Defold target archives expose across all build variants; absent or target-partial symbols fail closed.",
    patternRegistry: patterns.map(({ id, family, emitter, priority, cost, fallback, when }) => ({
      id,
      family,
      emitter,
      priority,
      cost,
      fallback,
      when,
    })),
    universalFallback: {
      preserved: true,
      catalog: "packages/bindings/generated/defold-dmsdk-universal-bindings.json",
      mutation: "none",
    },
    coverage: {
      reviewed: candidates.length,
      generated: entries.length,
      policyBlocked: blocked.length,
      signatureCompileCovered: entries.length,
      linked: entries.length,
      behaviorCovered: entries.length,
      exactCallCovered: entries.length,
      typescriptCallable: 0,
      warmedDispatchIterations: 100000,
      warmedDispatchObservedCppAllocations: 0,
    },
    sourceHashes: {
      ir: digest(irContent),
      shapes: digest(shapesContent),
      valuePlan: digest(valuePlanContent),
      symbolEvidence: digest(symbolEvidenceContent),
      policy: digest(policyContent),
    },
    artifactHashes: Object.fromEntries(
      [...artifacts].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, digest(content)]),
    ),
    artifacts: [...artifacts.keys()].sort(),
    declarations,
  };
  artifacts.set(
    `packages/bindings/generated/${DMSDK_NAMED_SCALAR_RECIPE_FACTS_NAME}`,
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  artifacts.set(outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts, report };
}

async function writeOrCheck(outRoot, relativePath, content, check) {
  const path = resolve(outRoot, relativePath);
  if (check) {
    if ((await readFile(path, "utf8")) !== content)
      throw new Error(`${relativePath} is stale; regenerate named-scalar bindings`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function run(argv = process.argv.slice(2)) {
  const { outRoot, check, irPath, shapesPath, valuePlanPath, symbolEvidencePath, policyPath } = parseArguments(argv);
  const { artifacts, report } = await build({
    irPath,
    shapesPath,
    valuePlanPath,
    symbolEvidencePath,
    policyPath,
  });
  for (const [path, content] of artifacts) await writeOrCheck(outRoot, path, content, check);
  process.stdout.write(
    `${check ? "Verified" : "Generated"} ${report.coverage.generated}/${report.coverage.reviewed} named-scalar bindings; ${report.coverage.policyBlocked} ABI-blocked.\n`,
  );
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
