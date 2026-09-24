import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { semanticDeclarationId, semanticEntryMap } from "./lib/dmsdk-semantic-id.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  policy: "packages/bindings/overrides/dmsdk-hash-span-bindings.json",
};
const previouslyGeneratedAdapters = 43;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const snake = (value) => value
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

function selectCandidates(shapes, selector) {
  const symbolPattern = new RegExp(selector.symbolPattern);
  return shapes.rows
    .filter((row) => row.tranche === selector.tranche
      && row.header === selector.header
      && symbolPattern.test(row.symbol))
    .sort((left, right) => left.id.localeCompare(right.id));
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
  if (new Set(declarationIds).size !== declarationIds.length
      || new Set(shapeIds).size !== shapeIds.length) {
    throw new Error("IR or ABI-shape census contains duplicate declaration ids");
  }
}

async function validateEvidence(candidate, declaration, entry, sources) {
  if (entry.expectedShape !== candidate.shape) {
    throw new Error(`Hash-span ABI shape drifted for ${candidate.id}`);
  }
  const expectedReturn = `uint${entry.resultBits}_t`;
  if (declaration.name !== candidate.symbol
      || declaration.header !== candidate.header
      || declaration.returns !== expectedReturn
      || declaration.type !== `${expectedReturn} (const void *, uint32_t)`
      || declaration.parameters.length !== 2
      || declaration.parameters[0].type !== "const void *"
      || declaration.parameters[1].type !== "uint32_t"
      || !candidate.shape.startsWith(`scalar:u${entry.resultBits}(`)) {
    throw new Error(`Hash-span IR signature drifted for ${candidate.id}`);
  }
  const evidence = [...entry.evidence, ...entry.implementationEvidence];
  for (const item of evidence) {
    if (!Number.isInteger(item.line) || typeof item.path !== "string" || typeof item.text !== "string") {
      throw new Error(`Invalid hash-span evidence for ${candidate.id}`);
    }
    let source = sources.get(item.path);
    if (source === undefined) {
      source = await readFile(resolve(root, item.path), "utf8");
      sources.set(item.path, source);
    }
    const hint = item.path === declaration.header ? declaration.line : item.line;
    const matches = source.split("\n")
      .map((line, index) => line.trim() === item.text.trim() ? index + 1 : 0)
      .filter(Boolean)
      .sort((left, right) => Math.abs(left - hint) - Math.abs(right - hint));
    if (matches.length === 0) {
      throw new Error(`Hash-span evidence drifted for ${candidate.id}`);
    }
    item.line = matches[0];
  }
  if (!entry.evidence.some(({ text }) => text.includes("Length of buffer"))
      || !entry.evidence.some(({ text }) => text.includes(declaration.name))) {
    throw new Error(`Hash-span policy lacks length/signature evidence for ${candidate.id}`);
  }
  if (!entry.implementationEvidence.some(({ text }) => text.includes("malloc"))
      || !entry.implementationEvidence.some(({ text }) => text.includes("m_Enabled = false"))) {
    throw new Error(`Hash-span policy must preserve reverse-hash default/allocation evidence for ${candidate.id}`);
  }
}

async function createEntries(selected, declarations, policy, sources) {
  const policiesBySemanticId = semanticEntryMap(policy.entries, "hash-span policy");
  const entries = [];
  const blocked = [];
  for (const candidate of selected) {
    const declaration = declarations.get(candidate.id);
    if (!declaration) throw new Error(`Hash-span candidate is absent from dmSDK IR: ${candidate.id}`);
    const rule = policiesBySemanticId.get(semanticDeclarationId(candidate.id));
    if (!rule) {
      blocked.push({ ...candidate, emitted: false, blocker: "unreviewed-hash-span-optimization" });
      continue;
    }
    if (rule.status !== "emit" || ![32, 64].includes(rule.resultBits)
        || !Array.isArray(rule.evidence) || !Array.isArray(rule.implementationEvidence)) {
      throw new Error(`Invalid hash-span policy for ${candidate.id}`);
    }
    try {
      await validateEvidence(candidate, declaration, rule, sources);
    } catch (error) {
      blocked.push({ ...candidate, emitted: false, blocker: "hash-span-evidence-withdrawn", detail: error.message });
      continue;
    }
    entries.push({
      id: entries.length,
      candidate,
      declaration,
      resultBits: rule.resultBits,
      evidence: rule.evidence,
      implementationEvidence: rule.implementationEvidence,
      wrapper: `deherm_dmsdk_hash_span_${snake(declaration.name)}`,
    });
  }
  return { entries, blocked };
}

function renderHeader(entries) {
  const declarations = entries.map(({ wrapper, resultBits }) =>
    `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint${resultBits}_t* out_hash);`).join("\n");
  return `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_H\n#include <stdint.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderSource(entries) {
  const wrappers = entries.map(({ wrapper, resultBits, declaration }) =>
    `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint${resultBits}_t* out_hash)\n{\n  if (out_hash == 0 || (input_length != 0 && input == 0)) return UINT8_C(0);\n  *out_hash = ${declaration.name}(input, input_length);\n  return UINT8_C(1);\n}`).join("\n");
  return `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_hash_span.h>\n#include <dmsdk/dlib/hash.h>\nextern "C" {\n${wrappers}\n}\n`;
}

function renderRuntimeHeader() {
  return `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_RUNTIME_H\n#include <stdint.h>\ntypedef enum DehermDmSdkHashSpanStatus { DEHERM_DMSDK_HASH_SPAN_OK=0, DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID=1, DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE=2 } DehermDmSdkHashSpanStatus;\ntypedef struct DehermDmSdkHashSpanDescriptor { uint16_t id; uint8_t result_bits; const char* declaration_id; } DehermDmSdkHashSpanDescriptor;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_hash_span_count(void);\nconst DehermDmSdkHashSpanDescriptor* deherm_dmsdk_hash_span_descriptors(void);\nDehermDmSdkHashSpanStatus deherm_dmsdk_hash_span_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint64_t* out_hash);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderRuntime(entries) {
  const descriptors = entries.map(({ id, resultBits, declaration }) =>
    `  { UINT16_C(${id}), UINT8_C(${resultBits}), ${JSON.stringify(declaration.id)} }`).join(",\n");
  const cases = entries.map(({ id, resultBits, wrapper }) => {
    if (resultBits === 64) return `    case ${id}: return ${wrapper}(input, input_length, out_hash) ? DEHERM_DMSDK_HASH_SPAN_OK : DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE;`;
    return `    case ${id}: { uint32_t value=0; if (!${wrapper}(input, input_length, &value)) return DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE; *out_hash=value; return DEHERM_DMSDK_HASH_SPAN_OK; }`;
  }).join("\n");
  return `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_hash_span.h>\n#include <defold_hermes/generated_dmsdk_hash_span_runtime.h>\nnamespace {\nconst DehermDmSdkHashSpanDescriptor kDescriptors[] = {\n${descriptors}\n};\n}\nextern "C" {\nuint32_t deherm_dmsdk_hash_span_count(void) { return UINT32_C(${entries.length}); }\nconst DehermDmSdkHashSpanDescriptor* deherm_dmsdk_hash_span_descriptors(void) { return kDescriptors; }\nDehermDmSdkHashSpanStatus deherm_dmsdk_hash_span_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint64_t* out_hash)\n{\n  if (id >= deherm_dmsdk_hash_span_count()) return DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID;\n  if (out_hash == 0 || (input_length != 0 && input == 0)) return DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE;\n  switch (id) {\n${cases}\n    default: return DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID;\n  }\n}\n}\n`;
}

function createReport(contents, ir, shapes, policy, sources, entries, blocked, selected, artifacts) {
  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    defoldRevision: ir.defoldRevision,
    sources: { ir: defaults.ir, shapes: defaults.shapes, policy: defaults.policy },
    sourceHashes: {
      ...Object.fromEntries(Object.entries(contents).map(([key, value]) => [key, sha256(value)])),
      evidence: Object.fromEntries([...sources].sort(([left], [right]) => left.localeCompare(right))
        .map(([path, content]) => [path, sha256(content)])),
    },
    policy: {
      candidateSelector: policy.candidateSelector,
      cAbi: "borrowed const uint8_t* plus explicit uint32_t byte length; scalar result written to caller-owned uint64_t storage",
      ownership: "input and output are borrowed only for the synchronous call; no pointer escapes generated glue",
      allocation: "generated glue has no heap primitive; native dmHashBuffer may malloc only when Defold reverse hashing is globally enabled, as pinned implementation evidence records",
      jsi: "not-generated pending typed-array lifetime and installer policy",
      html5: "not-claimed pending target compile/link matrix",
    },
    coverage: {
      baselineRuntimePending: shapes.coverage.runtimePending,
      previouslyGeneratedAdapters,
      discovered: selected.length,
      emitted: entries.length,
      policyBlocked: blocked.length,
      hostBehaviorVerified: entries.length,
      remainingWithoutGeneratedAdapters: shapes.coverage.runtimePending - previouslyGeneratedAdapters - entries.length,
    },
    artifactHashes: Object.fromEntries([...artifacts].sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => [path, sha256(content)])),
    artifacts: [...artifacts.keys()].sort(),
    declarations: [...entries.map(({ id, candidate, resultBits, evidence, implementationEvidence, wrapper }) => ({
      ...candidate,
      bindingId: id,
      resultBits,
      evidence,
      implementationEvidence,
      wrapper,
      stages: {
        generated: "complete",
        compiled: "packaged-sdk-object-test",
        linked: "packaged-sdk-host-link-test",
        runtime: "packaged-sdk-host-behavior-test",
        allocation: "100000-warmed-dispatch-zero-cpp-operator-new-with-reverse-hashing-default-disabled",
      },
    })), ...blocked],
  };
}

async function build(options) {
  const contents = Object.fromEntries(await Promise.all(Object.keys(defaults).map(async (key) =>
    [key, await readFile(options[key], "utf8")]))) ;
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const policy = JSON.parse(contents.policy);
  validateProvenance(ir, shapes, contents);
  const selected = selectCandidates(shapes, policy.candidateSelector);
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const sources = new Map();
  const { entries, blocked } = await createEntries(selected, declarations, policy, sources);
  const artifacts = new Map([
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_hash_span.h", renderHeader(entries)],
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_hash_span_runtime.h", renderRuntimeHeader()],
    ["defold/defold_hermes/src/generated_dmsdk_hash_span.cpp", renderSource(entries)],
    ["defold/defold_hermes/src/generated_dmsdk_hash_span_runtime.cpp", renderRuntime(entries)],
  ]);
  const report = createReport(contents, ir, shapes, policy, sources, entries, blocked, selected, artifacts);
  artifacts.set("packages/bindings/generated/defold-dmsdk-hash-span-bindings.json", `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts, report };
}

async function writeOrCheck(outRoot, relative, content, check) {
  const path = resolve(outRoot, relative);
  if (check) {
    if (await readFile(path, "utf8") !== content) throw new Error(`${relative} is stale`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build(options);
  for (const [path, content] of artifacts) await writeOrCheck(options.outRoot, path, content, options.check);
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.coverage.emitted}/${report.coverage.discovered} hash-span dmSDK bindings.\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
