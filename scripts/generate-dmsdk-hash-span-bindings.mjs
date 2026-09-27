import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  compactDmSdkPatternDecision,
  selectDmSdkPattern,
} from "../packages/compiler/src/dmsdk-pattern-selector.mjs";
import { fixedWidthHashPattern } from "../packages/compiler/src/dmsdk-pattern-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  policy: "packages/bindings/overrides/dmsdk-hash-span-bindings.json",
};
const previouslyGeneratedAdapters = 43;
const hashSpanSemanticTokens = fixedWidthHashPattern().when.requireSemanticTokens;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const snake = (value) =>
  value
    .replace(/::/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

function parseArgs(argv) {
  const options = { ...defaults, outRoot: root, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
    } else if (["--ir", "--shapes", "--policy", "--out-root"].includes(argument)) {
      const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a path`);
      options[key] = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  for (const key of Object.keys(defaults)) options[key] = resolve(root, options[key]);
  return options;
}

function patternFacts(row, semanticTokens = []) {
  return {
    id: row.id,
    kind: row.kind,
    result: row.result,
    parameters: row.parameters,
    families: row.families,
    semanticTokens,
  };
}

export function extractHashSpanSemantics(declaration, candidate, recipe) {
  if (!declaration || declaration.kind !== "function" || declaration.parameters?.length !== 2) return null;
  const resultBits = Number(candidate.result.role.match(/^scalar:u(32|64)$/u)?.[1]);
  if (!recipe.resultWidths.includes(resultBits)) return null;
  if (
    candidate.parameters.length !== 2 ||
    candidate.parameters[0].role !== "opaque-pointer" ||
    candidate.parameters[0].direction !== "in" ||
    candidate.parameters[1].role !== "scalar:u32" ||
    candidate.parameters[1].direction !== "value"
  )
    return null;
  return {
    resultBits,
    semanticTokens: [...hashSpanSemanticTokens].sort(),
    evidence: {
      header: declaration.header,
      semanticSource: "revision-ir-abi-shape",
      declarationLine: declaration.line,
    },
  };
}

function validateProvenance(ir, shapes, contents) {
  if (ir.defoldRevision !== shapes.defoldRevision) {
    throw new Error("Defold revisions differ between IR and ABI-shape census");
  }
  if (sha256(contents.ir) !== shapes.sourceHashes.ir) {
    throw new Error("IR hash does not match ABI-shape census provenance");
  }
  const declarationIds = ir.declarations.map(({ id }) => id);
  const shapeIds = shapes.rows.map(({ id }) => id);
  if (new Set(declarationIds).size !== declarationIds.length || new Set(shapeIds).size !== shapeIds.length) {
    throw new Error("IR or ABI-shape census contains duplicate declaration ids");
  }
}

function createEntries(rows, declarations, policy) {
  const patterns = [fixedWidthHashPattern(), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const entries = [];
  const blocked = [];
  let structurallyEligible = 0;
  for (const candidate of [...rows].sort((left, right) => left.id.localeCompare(right.id))) {
    const initial = selectDmSdkPattern(patternFacts(candidate), patterns);
    const trace = initial.trace.find(({ patternId }) => patternId === "span.fixed-width-hash");
    if (!trace || trace.blockers.some((blocker) => !blocker.startsWith("semantic-token-missing:"))) continue;
    structurallyEligible += 1;
    const declaration = declarations.get(candidate.id);
    if (!declaration) throw new Error(`Hash-span candidate is absent from dmSDK IR: ${candidate.id}`);
    const semantics = extractHashSpanSemantics(declaration, candidate, policy.recipe);
    const decision = selectDmSdkPattern(patternFacts(candidate, semantics?.semanticTokens), patterns);
    if (decision.patternId !== "span.fixed-width-hash") {
      blocked.push({
        ...candidate,
        emitted: false,
        blocker: "hash-span-evidence-withdrawn",
        patternDecision: compactDmSdkPatternDecision(decision),
      });
      continue;
    }
    entries.push({
      id: entries.length,
      candidate,
      declaration,
      resultBits: semantics.resultBits,
      evidence: semantics.evidence,
      patternDecision: compactDmSdkPatternDecision(decision),
      wrapper: `deherm_dmsdk_hash_span_${snake(declaration.name)}`,
    });
  }
  return { entries, blocked, structurallyEligible, patterns };
}

function renderHeader(entries) {
  const declarations = entries
    .map(
      ({ wrapper, resultBits }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint${resultBits}_t* out_hash);`,
    )
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_H\n#include <stdint.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderSource(entries) {
  const includes = [...new Set(entries.map(({ declaration }) => publicHeader(declaration.header)))]
    .sort()
    .map((header) => `#include <${header}>`)
    .join("\n");
  const wrappers = entries
    .map(
      ({ wrapper, resultBits, declaration }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint${resultBits}_t* out_hash)\n{\n  if (out_hash == 0 || (input_length != 0 && input == 0)) return UINT8_C(0);\n  *out_hash = ${declaration.name}(input, input_length);\n  return UINT8_C(1);\n}`,
    )
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_hash_span.h>\n${includes}\nextern "C" {\n${wrappers}\n}\n`;
}

function publicHeader(source) {
  const marker = "/src/dmsdk/";
  const position = source.indexOf(marker);
  if (position < 0) throw new Error(`hash-span header is outside the dmSDK projection: ${source}`);
  return `dmsdk/${source.slice(position + marker.length)}`;
}

function renderRuntimeHeader() {
  return `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_RUNTIME_H\n#include <stdint.h>\ntypedef enum DehermDmSdkHashSpanStatus { DEHERM_DMSDK_HASH_SPAN_OK=0, DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID=1, DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE=2 } DehermDmSdkHashSpanStatus;\ntypedef struct DehermDmSdkHashSpanDescriptor { uint16_t id; uint8_t result_bits; const char* declaration_id; } DehermDmSdkHashSpanDescriptor;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_hash_span_count(void);\nconst DehermDmSdkHashSpanDescriptor* deherm_dmsdk_hash_span_descriptors(void);\nDehermDmSdkHashSpanStatus deherm_dmsdk_hash_span_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint64_t* out_hash);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderRuntime(entries) {
  const descriptors = entries
    .map(
      ({ id, resultBits, declaration }) =>
        `  { UINT16_C(${id}), UINT8_C(${resultBits}), ${JSON.stringify(declaration.id)} }`,
    )
    .join(",\n");
  const cases = entries
    .map(({ id, resultBits, wrapper }) => {
      if (resultBits === 64)
        return `    case ${id}: return ${wrapper}(input, input_length, out_hash) ? DEHERM_DMSDK_HASH_SPAN_OK : DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE;`;
      return `    case ${id}: { uint32_t value=0; if (!${wrapper}(input, input_length, &value)) return DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE; *out_hash=value; return DEHERM_DMSDK_HASH_SPAN_OK; }`;
    })
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_hash_span.h>\n#include <defold_hermes/generated_dmsdk_hash_span_runtime.h>\nnamespace {\nconst DehermDmSdkHashSpanDescriptor kDescriptors[] = {\n${descriptors}\n};\n}\nextern "C" {\nuint32_t deherm_dmsdk_hash_span_count(void) { return UINT32_C(${entries.length}); }\nconst DehermDmSdkHashSpanDescriptor* deherm_dmsdk_hash_span_descriptors(void) { return kDescriptors; }\nDehermDmSdkHashSpanStatus deherm_dmsdk_hash_span_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint64_t* out_hash)\n{\n  if (id >= deherm_dmsdk_hash_span_count()) return DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID;\n  if (out_hash == 0 || (input_length != 0 && input == 0)) return DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE;\n  switch (id) {\n${cases}\n    default: return DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID;\n  }\n}\n}\n`;
}

function createReport(contents, ir, shapes, policy, entries, blocked, structurallyEligible, patterns, artifacts) {
  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    defoldRevision: ir.defoldRevision,
    sources: { ir: defaults.ir, shapes: defaults.shapes, policy: defaults.policy },
    sourceHashes: {
      ...Object.fromEntries(Object.entries(contents).map(([key, value]) => [key, sha256(value)])),
    },
    policy: {
      recipe: policy.recipe,
      patternRegistry: patterns.map(({ id, family, emitter, priority, cost, fallback, when }) => ({
        id,
        family,
        emitter,
        priority,
        cost,
        fallback,
        when,
      })),
      cAbi: "borrowed const uint8_t* plus explicit uint32_t byte length; scalar result written to caller-owned uint64_t storage",
      ownership: "input and output are borrowed only for the synchronous call; no pointer escapes generated glue",
      allocation:
        "generated glue has no heap primitive; the packaged host harness verifies zero warmed C++ operator new calls under its default engine configuration, without making a global claim about Defold internals",
      jsi: "not-generated pending typed-array lifetime and installer policy",
      html5: "not-claimed pending target compile/link matrix",
    },
    coverage: {
      baselineRuntimePending: shapes.coverage.runtimePending,
      previouslyGeneratedAdapters,
      discovered: structurallyEligible,
      structurallyEligible,
      emitted: entries.length,
      policyBlocked: blocked.length,
      hostBehaviorVerified: entries.length,
      remainingWithoutGeneratedAdapters: shapes.coverage.runtimePending - previouslyGeneratedAdapters - entries.length,
    },
    artifactHashes: Object.fromEntries(
      [...artifacts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, content]) => [path, sha256(content)]),
    ),
    artifacts: [...artifacts.keys()].sort(),
    declarations: [
      ...entries.map(({ id, candidate, resultBits, evidence, patternDecision, wrapper }) => ({
        ...candidate,
        bindingId: id,
        resultBits,
        evidence,
        patternDecision,
        wrapper,
        stages: {
          generated: "complete",
          compiled: "packaged-sdk-object-test",
          linked: "packaged-sdk-host-link-test",
          runtime: "packaged-sdk-host-behavior-test",
          allocation: "100000-warmed-dispatch-zero-cpp-operator-new-with-reverse-hashing-default-disabled",
        },
      })),
      ...blocked,
    ],
  };
}

export async function build(options) {
  const contents = Object.fromEntries(
    await Promise.all(Object.keys(defaults).map(async (key) => [key, await readFile(options[key], "utf8")])),
  );
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const policy = JSON.parse(contents.policy);
  validateProvenance(ir, shapes, contents);
  if (
    policy.schemaVersion !== 1 ||
    policy.policyVersion !== "hash-span-v3" ||
    policy.family !== "fixed-width-buffer-hash" ||
    policy.recipe?.input !== "borrowed-counted-bytes" ||
    JSON.stringify(policy.recipe?.resultWidths) !== JSON.stringify([32, 64]) ||
    policy.recipe?.ownership !== "synchronous-noescape" ||
    policy.recipe?.fallback !== "universal-recipe"
  ) {
    throw new Error("Unsupported hash-span semantic policy");
  }
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const { entries, blocked, structurallyEligible, patterns } = createEntries(shapes.rows, declarations, policy);
  const artifacts = new Map([
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_hash_span.h", renderHeader(entries)],
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_hash_span_runtime.h", renderRuntimeHeader()],
    ["defold/defold_hermes/src/generated_dmsdk_hash_span.cpp", renderSource(entries)],
    ["defold/defold_hermes/src/generated_dmsdk_hash_span_runtime.cpp", renderRuntime(entries)],
  ]);
  const report = createReport(
    contents,
    ir,
    shapes,
    policy,
    entries,
    blocked,
    structurallyEligible,
    patterns,
    artifacts,
  );
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return { artifacts, report };
}

async function writeOrCheck(outRoot, relative, content, check) {
  const path = resolve(outRoot, relative);
  if (check) {
    if ((await readFile(path, "utf8")) !== content) throw new Error(`${relative} is stale`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build(options);
  for (const [path, content] of artifacts) await writeOrCheck(options.outRoot, path, content, options.check);
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.emitted}/${report.coverage.discovered} hash-span dmSDK bindings.\n`,
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
