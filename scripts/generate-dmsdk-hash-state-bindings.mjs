#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  compactDmSdkPatternDecision,
  defineDmSdkPattern,
  selectDmSdkPattern,
} from "../packages/compiler/src/dmsdk-pattern-selector.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  symbols: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json",
  policy: "packages/bindings/overrides/dmsdk-hash-state-bindings.json",
});
const artifactPaths = Object.freeze({
  report: "packages/bindings/generated/defold-dmsdk-hash-state-bindings.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_hash_state.h",
  source: "defold/defold_hermes/src/generated_dmsdk_hash_state.cpp",
  exact: "tests/fixtures/generated_dmsdk_hash_state_exact.cpp",
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function parseArgs(argv) {
  const options = { ...defaults, outRoot: root, check: false };
  for (let i = 0; i < argv.length; ++i) {
    if (argv[i] === "--check") options.check = true;
    else if (argv[i] === "--out-root") options.outRoot = path.resolve(argv[++i]);
    else if (["--ir", "--shapes", "--symbols", "--policy"].includes(argv[i]))
      options[argv[i].slice(2)] = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  for (const key of Object.keys(defaults)) options[key] = path.resolve(root, options[key]);
  return options;
}

function hashStatePattern(policy) {
  return defineDmSdkPattern({
    schemaVersion: 1,
    id: "state.incremental-hash-lifecycle",
    family: "hash-state",
    emitter: "scripts/generate-dmsdk-hash-state-bindings.mjs",
    priority: 850,
    cost: 12,
    fallback: false,
    when: {
      declarationKinds: ["function"],
      result: { rolePrefixes: ["scalar:"] },
      parameters: { some: [{ rolePrefixes: ["pointer:record:"], directions: ["in", "inout"] }] },
      requireSemanticTokens: policy.documentationContract.semantics,
    },
  });
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

function stateType(parameter) {
  const match = parameter?.role?.match(/^pointer:record:(.+)$/u);
  return match ? match[1] : null;
}

function widthFromState(type, supportedWidths) {
  const match = type?.match(/(32|64)$/u);
  const width = match ? Number(match[1]) : null;
  return supportedWidths.includes(width) ? width : null;
}

export function inferHashStateSemantics(declaration, row, policy) {
  if (!declaration || row.parameters.length === 0) return null;
  const contract = policy.documentationContract;
  const state = stateType(row.parameters[0]);
  const width = widthFromState(state, policy.recipe.widths);
  if (!state || !width || declaration.parameters[0]?.description !== contract.stateDescription) return null;
  let operation = null;
  if (
    row.result.role === "scalar:void" &&
    row.parameters.length === 2 &&
    row.parameters[1].role === "scalar:bool" &&
    row.parameters[1].direction === "value"
  ) {
    const match = (declaration.description ?? "").match(new RegExp(contract.initPattern, "u"));
    if (match && Number(match[1]) === width) operation = "Init";
  } else if (
    row.result.role === "scalar:void" &&
    row.parameters.length === 3 &&
    stateType(row.parameters[1]) === state &&
    row.parameters[1].direction === "in" &&
    row.parameters[2].role === "scalar:bool" &&
    declaration.parameters[1]?.description === contract.sourceStateDescription
  ) {
    const match = (declaration.description ?? "").match(new RegExp(contract.clonePattern, "u"));
    if (match && Number(match[1]) === width) operation = "Clone";
  } else if (
    row.result.role === "scalar:void" &&
    row.parameters.length === 3 &&
    row.parameters[1].role === "opaque-pointer" &&
    row.parameters[1].direction === "in" &&
    row.parameters[2].role === "scalar:u32" &&
    declaration.description === contract.updateSummary &&
    declaration.parameters[1]?.description === contract.bufferDescription &&
    declaration.parameters[2]?.description === contract.bufferLengthDescription
  ) {
    operation = "UpdateBuffer";
  } else if (
    row.result.role === `scalar:u${width}` &&
    row.parameters.length === 1 &&
    declaration.description === contract.finalSummary &&
    new RegExp(contract.finalResultPattern, "u").test(declaration.returnDescription ?? "")
  ) {
    operation = "Final";
  } else if (
    row.result.role === "scalar:void" &&
    row.parameters.length === 1 &&
    (declaration.description ?? "").startsWith(contract.releaseSummaryPrefix)
  ) {
    operation = "Release";
  }
  if (!operation || !policy.recipe.operations.includes(operation)) return null;
  return {
    operation,
    width,
    stateType: state,
    semanticTokens: [...contract.semantics].sort(compareCodeUnits),
    evidence: {
      header: declaration.header,
      summary: declaration.description,
      parameters: declaration.parameters.map(({ description }) => description),
      result: declaration.returnDescription,
      stateType: state,
      documentationSource: "clang-comment-ast+abi-record-role",
      declarationLine: declaration.line,
    },
  };
}

function validate(inputs, parsed) {
  const { ir, shapes, symbols, policy } = parsed;
  if (ir.defoldRevision !== shapes.defoldRevision || ir.defoldRevision !== symbols.defoldRevision)
    throw new Error("hash-state input revisions differ");
  if (sha256(inputs.ir) !== shapes.sourceHashes.ir) throw new Error("hash-state ABI-shape provenance drifted");
  if (
    policy.schemaVersion !== 2 ||
    !policy.documentationContract ||
    !Array.isArray(policy.documentationContract.semantics) ||
    !Array.isArray(policy.recipe?.operations) ||
    !Array.isArray(policy.recipe?.widths)
  )
    throw new Error("hash-state semantic policy is unsupported");
  if (policy.symbolEvidence.path !== defaults.symbols) throw new Error("hash-state symbol-evidence path drifted");
  const patterns = [hashStatePattern(policy), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const declarations = new Map(ir.declarations.map((entry) => [entry.id, entry]));
  const seen = new Set();
  const entries = [];
  const blocked = [];
  let discovered = 0;
  for (const row of [...shapes.rows].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const declaration = declarations.get(row.id);
    const semantics = inferHashStateSemantics(declaration, row, policy);
    if (!semantics) continue;
    discovered += 1;
    const decision = selectDmSdkPattern(patternFacts(row, semantics.semanticTokens), patterns);
    const evidence = symbols.declarations[row.id];
    const cell = `${semantics.operation}:${semantics.width}`;
    const signatureHolds = decision.patternId === "state.incremental-hash-lifecycle";
    const linkageHolds =
      evidence?.name === row.symbol &&
      evidence.kind === "function" &&
      evidence.header === row.header &&
      evidence.linkage === policy.symbolEvidence.requiredLinkage &&
      evidence.availability === policy.symbolEvidence.requiredAvailability &&
      symbols.variants.every((variant) => (evidence.linkedIn?.[variant] ?? []).length === symbols.targets.length);
    if (!signatureHolds || !linkageHolds || seen.has(cell)) {
      blocked.push({
        ...row,
        disposition: "blocked",
        blocker: !signatureHolds
          ? "hash-state-signature-unverified"
          : !linkageHolds
            ? "hash-state-linkage-unverified"
            : "duplicate-hash-state-operation",
        universalFallback: "retained",
        stages: {
          generated: "universal-fallback-only",
          compiled: "not-claimed",
          linked: "not-claimed",
          runtime: "not-claimed",
          allocation: "not-claimed",
        },
      });
      continue;
    }
    seen.add(cell);
    entries.push({
      ...row,
      denseId: entries.length,
      operation: semantics.operation,
      width: semantics.width,
      stateType: semantics.stateType,
      evidence: semantics.evidence,
      patternDecision: compactDmSdkPatternDecision(decision),
      disposition: "generated",
      wrapper: row.symbol,
    });
  }
  return { entries, blocked, discovered, patterns };
}

function renderHeader(entries, policy) {
  const rows = entries
    .map(
      (entry) =>
        `  DEHERM_DMSDK_HASH_STATE_${entry.operation.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_${entry.width} = ${entry.denseId},`,
    )
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-hash-state-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_HASH_STATE_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_HASH_STATE_H\n#include <stdint.h>\n#define DEHERM_DMSDK_HASH_STATE_CAPACITY_PER_WIDTH UINT32_C(${policy.registry.capacityPerWidth})\ntypedef enum DehermDmSdkHashStateStatus { DEHERM_DMSDK_HASH_STATE_OK=0, DEHERM_DMSDK_HASH_STATE_UNKNOWN_ID=1, DEHERM_DMSDK_HASH_STATE_NULL_STORAGE=2, DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE=3, DEHERM_DMSDK_HASH_STATE_CAPACITY_EXHAUSTED=4, DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT=5, DEHERM_DMSDK_HASH_STATE_REENTRANT=6 } DehermDmSdkHashStateStatus;\ntypedef enum DehermDmSdkHashStateId {\n${rows}\n} DehermDmSdkHashStateId;\ntypedef struct DehermDmSdkHashStateDescriptor { uint16_t id; uint8_t width; uint8_t consumes; const char* operation; const char* declaration_id; } DehermDmSdkHashStateDescriptor;\n#ifdef __cplusplus\nextern \"C\" {\n#endif\nuint32_t deherm_dmsdk_hash_state_count(void);\nconst DehermDmSdkHashStateDescriptor* deherm_dmsdk_hash_state_descriptors(void);\nDehermDmSdkHashStateStatus deherm_dmsdk_hash_state_dispatch(uint16_t id, uint64_t handle, const uint8_t* input, uint32_t input_length, uint8_t reverse_hash, uint64_t* out_value);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderSource(entries, policy) {
  const descriptors = entries
    .map(
      (e) =>
        `  {UINT16_C(${e.denseId}),UINT8_C(${e.width}),UINT8_C(${["Final", "Release"].includes(e.operation) ? 1 : 0}),${JSON.stringify(e.operation)},${JSON.stringify(e.id)}}`,
    )
    .join(",\n");
  const cases = entries
    .map((e) => {
      const p = e.width === 32 ? "g32" : "g64";
      const type = e.stateType;
      if (e.operation === "Init")
        return `case ${e.denseId}:{if(handle||input||input_length||reverse_hash>UINT8_C(1))return DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT;Slot<${type}>* slot=allocate(${p},${e.width});if(!slot)return DEHERM_DMSDK_HASH_STATE_CAPACITY_EXHAUSTED;${e.symbol}(&slot->state,reverse_hash!=0);*out_value=token(*slot,${e.width});return DEHERM_DMSDK_HASH_STATE_OK;}`;
      if (e.operation === "Clone")
        return `case ${e.denseId}:{if(input||input_length||reverse_hash>UINT8_C(1))return DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT;Slot<${type}>* source=find(${p},handle,${e.width});if(!source)return DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE;Slot<${type}>* destination=allocate(${p},${e.width});if(!destination)return DEHERM_DMSDK_HASH_STATE_CAPACITY_EXHAUSTED;${e.symbol}(&destination->state,&source->state,reverse_hash!=0);*out_value=token(*destination,${e.width});return DEHERM_DMSDK_HASH_STATE_OK;}`;
      if (e.operation === "UpdateBuffer")
        return `case ${e.denseId}:{if(reverse_hash)return DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT;Slot<${type}>* slot=find(${p},handle,${e.width});if(!slot)return DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE;if(input_length>UINT32_C(0x7fffffff)||(input_length&&input==nullptr))return DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT;${e.symbol}(&slot->state,input,input_length);return DEHERM_DMSDK_HASH_STATE_OK;}`;
      if (e.operation === "Final")
        return `case ${e.denseId}:{if(input||input_length||reverse_hash)return DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT;Slot<${type}>* slot=find(${p},handle,${e.width});if(!slot)return DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE;*out_value=${e.symbol}(&slot->state);consume(*slot);return DEHERM_DMSDK_HASH_STATE_OK;}`;
      return `case ${e.denseId}:{if(input||input_length||reverse_hash)return DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT;Slot<${type}>* slot=find(${p},handle,${e.width});if(!slot)return DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE;${e.symbol}(&slot->state);consume(*slot);return DEHERM_DMSDK_HASH_STATE_OK;}`;
    })
    .join("\n");
  return `// Generated by scripts/generate-dmsdk-hash-state-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_hash_state.h>\n#include <dmsdk/dlib/hash.h>\n#include <atomic>\n#include <stddef.h>\nnamespace {\nconstexpr uint64_t kMagic=UINT64_C(0xd348);constexpr uint32_t kCapacity=${policy.registry.capacityPerWidth};constexpr uint32_t kMaxGeneration=UINT32_C(0x7fffffff);\ntemplate<class T> struct Slot{T state;uint32_t generation=1;uint16_t index=0;bool live=false;bool retired=false;};\nSlot<HashState32> g32[kCapacity];Slot<HashState64> g64[kCapacity];std::atomic_flag g_lock=ATOMIC_FLAG_INIT;thread_local bool g_active=false;\nstruct Guard{bool locked=false;Guard(){if(g_active)return;g_active=true;while(g_lock.test_and_set(std::memory_order_acquire)){}locked=true;}~Guard(){if(locked){g_lock.clear(std::memory_order_release);g_active=false;}}};\ntemplate<class T> Slot<T>* allocate(Slot<T>(&slots)[kCapacity],uint32_t){for(uint16_t i=0;i<kCapacity;++i){auto& s=slots[i];s.index=i;if(!s.live&&!s.retired){s.live=true;return &s;}}return nullptr;}\ntemplate<class T> uint64_t token(const Slot<T>& slot,uint32_t width){return (kMagic<<48)|(uint64_t(width==64)<<47)|(uint64_t(slot.generation)<<16)|slot.index;}\ntemplate<class T> Slot<T>* find(Slot<T>(&slots)[kCapacity],uint64_t value,uint32_t width){if((value>>48)!=kMagic||((value>>47)&1)!=(width==64))return nullptr;const uint16_t index=uint16_t(value);const uint32_t generation=uint32_t((value>>16)&kMaxGeneration);if(index>=kCapacity)return nullptr;auto& slot=slots[index];return slot.live&&!slot.retired&&slot.generation==generation?&slot:nullptr;}\ntemplate<class T> void consume(Slot<T>& slot){slot.live=false;if(slot.generation==kMaxGeneration)slot.retired=true;else ++slot.generation;}\nconst DehermDmSdkHashStateDescriptor kDescriptors[]={\n${descriptors}\n};}\nextern \"C\" {\nuint32_t deherm_dmsdk_hash_state_count(void){return UINT32_C(${entries.length});}\nconst DehermDmSdkHashStateDescriptor* deherm_dmsdk_hash_state_descriptors(void){return kDescriptors;}\nDehermDmSdkHashStateStatus deherm_dmsdk_hash_state_dispatch(uint16_t id,uint64_t handle,const uint8_t* input,uint32_t input_length,uint8_t reverse_hash,uint64_t* out_value){if(out_value==nullptr)return DEHERM_DMSDK_HASH_STATE_NULL_STORAGE;*out_value=0;if(id>=deherm_dmsdk_hash_state_count())return DEHERM_DMSDK_HASH_STATE_UNKNOWN_ID;Guard guard;if(!guard.locked)return DEHERM_DMSDK_HASH_STATE_REENTRANT;switch(id){${cases}default:return DEHERM_DMSDK_HASH_STATE_UNKNOWN_ID;}}}\n`;
}

function renderExactForEntries(entries) {
  const bodies = entries
    .map((entry) => {
      const { denseId: id, operation: op, width } = entry;
      const state = entry.stateType;
      if (op === "Init")
        return `void ${entry.symbol}(${state}* s,bool r){++calls[${id}];s->m_Hash=r?${width}:${width === 32 ? 3 : 6};s->m_Tail=0;s->m_Count=0;s->m_Size=0;s->m_ReverseHashEntryIndex=0;}`;
      if (op === "Clone")
        return `void ${entry.symbol}(${state}* d,const ${state}* s,bool r){++calls[${id}];d->m_Hash=s->m_Hash+(r?${width === 32 ? 7 : 9}:1);d->m_Tail=s->m_Tail;d->m_Count=s->m_Count;d->m_Size=s->m_Size;d->m_ReverseHashEntryIndex=0;}`;
      if (op === "UpdateBuffer")
        return `void ${entry.symbol}(${state}* s,const void* p,uint32_t n){++calls[${id}];const auto* b=(const uint8_t*)p;for(uint32_t i=0;i<n;++i)s->m_Hash+=b[i];}`;
      if (op === "Final") return `uint${width}_t ${entry.symbol}(${state}* s){++calls[${id}];return s->m_Hash;}`;
      return `void ${entry.symbol}(${state}*){++calls[${id}];}`;
    })
    .join("\n");
  return `// Generated exact ABI twin for the dmHash state family. Do not edit.\n#include <dmsdk/dlib/hash.h>\n#include <stdint.h>\nnamespace {uint32_t calls[${Math.max(1, entries.length)}]{};}\n${bodies}\nextern "C" uint32_t deherm_dmsdk_hash_state_exact_calls(uint16_t id){return id<${entries.length}?calls[id]:0;}\n`;
}

async function build(options = {}) {
  const inputs = Object.fromEntries(
    await Promise.all(
      Object.keys(defaults).map(async (key) => {
        const value = options[key] ?? path.resolve(root, defaults[key]);
        return [
          key,
          typeof value === "string" && value.trimStart().startsWith("{") ? value : await readFile(value, "utf8"),
        ];
      }),
    ),
  );
  const parsed = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, JSON.parse(value)]));
  const { entries, blocked, discovered, patterns } = validate(inputs, parsed);
  const artifacts = new Map([
    [artifactPaths.header, renderHeader(entries, parsed.policy)],
    [artifactPaths.source, renderSource(entries, parsed.policy)],
    [artifactPaths.exact, renderExactForEntries(entries)],
  ]);
  const report = {
    schemaVersion: 1,
    policyVersion: parsed.policy.policyVersion,
    defoldRevision: parsed.ir.defoldRevision,
    sources: defaults,
    sourceHashes: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, sha256(value)])),
    policy: {
      ...parsed.policy,
      patternRegistry: patterns.map(({ id, family, emitter, priority, cost, fallback, when }) => ({
        id,
        family,
        emitter,
        priority,
        cost,
        fallback,
        when,
      })),
    },
    coverage: {
      discovered,
      generated: entries.length,
      blocked: blocked.length,
      registryCapacityPerWidth: parsed.policy.registry.capacityPerWidth,
      exactFixtureCount: entries.length,
    },
    artifacts: [...artifacts.keys()].sort(),
    artifactHashes: Object.fromEntries([...artifacts].sort().map(([name, value]) => [name, sha256(value)])),
    declarations: entries,
    blockedDeclarations: blocked,
  };
  artifacts.set(artifactPaths.report, `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts, report };
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build(options);
  for (const [relative, content] of artifacts) {
    const output = path.resolve(options.outRoot, relative);
    if (options.check) {
      if ((await readFile(output, "utf8")) !== content) throw new Error(`${relative} is stale`);
    } else {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, content);
    }
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.generated}/${report.coverage.discovered} dmHash state bindings.\n`,
  );
  return report;
}
export { build, run };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
