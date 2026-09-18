import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableBindingId } from "../../compiler/src/binding-identity.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRequire = createRequire(import.meta.url);
const callableKinds = new Set(["function", "method", "constructor", "destructor", "function-template"]);
const typeKinds = new Set(["record", "enum", "type-alias"]);
const executionPolicies = new Set(["safe", "destructive", "interactive", "context-blocked", "not-applicable"]);
const stageDispositions = new Set(["compile-only", "linked", "executable", "skipped-with-reason"]);
const semanticStates = new Set(["unverified", "host-conformant", "target-conformant", "blocked", "not-applicable"]);
const observedStatuses = new Set(["passed", "failed", "skipped"]);

export const conformanceJsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ts-defold.github.io/deherm/schemas/conformance-v1.json",
  title: "Deherm API conformance artifacts",
  oneOf: [
    { $ref: "#/$defs/plan" },
    { $ref: "#/$defs/observation" },
    { $ref: "#/$defs/report" }
  ],
  $defs: {
    stageDisposition: { enum: ["compile-only", "linked", "executable", "skipped-with-reason"] },
    executionPolicy: { enum: ["safe", "destructive", "interactive", "context-blocked", "not-applicable"] },
    semanticState: { enum: ["unverified", "host-conformant", "target-conformant", "blocked", "not-applicable"] },
    observedStatus: { enum: ["passed", "failed", "skipped"] },
    plan: {
      type: "object",
      required: ["schemaVersion", "planId", "defoldRevision", "target", "shard", "cases"],
      properties: {
        schemaVersion: { const: 1 },
        planId: { type: "string", pattern: "^[a-f0-9]{64}$" },
        defoldRevision: { type: "string", pattern: "^[a-f0-9]{40}$" },
        target: { type: "string", minLength: 1 },
        shard: { type: "object", required: ["index", "count"] },
        cases: { type: "array", items: { $ref: "#/$defs/case" } }
      }
    },
    case: {
      type: "object",
      required: ["id", "stableId", "surface", "execution", "stages"],
      properties: {
        id: { type: "string", minLength: 1 },
        stableId: { type: "integer", minimum: 0, maximum: 4294967295 },
        surface: { enum: ["script", "dmsdk"] },
        execution: {
          type: "object",
          required: ["policy"],
          properties: { policy: { $ref: "#/$defs/executionPolicy" } }
        },
        stages: {
          type: "object",
          required: ["compile", "link", "runtime", "semantic"],
          properties: {
            compile: { $ref: "#/$defs/plannedStage" },
            link: { $ref: "#/$defs/plannedStage" },
            runtime: { $ref: "#/$defs/plannedStage" },
            semantic: { type: "object", required: ["state"], properties: { state: { $ref: "#/$defs/semanticState" } } }
          }
        }
      }
    },
    plannedStage: {
      type: "object",
      required: ["disposition"],
      properties: { disposition: { $ref: "#/$defs/stageDisposition" }, reason: { type: "string" } }
    },
    observation: {
      type: "object",
      required: ["schemaVersion", "planId", "target", "results"],
      properties: {
        schemaVersion: { const: 1 },
        planId: { type: "string", pattern: "^[a-f0-9]{64}$" },
        target: { type: "string", minLength: 1 },
        results: { type: "array", items: { $ref: "#/$defs/observedCase" } }
      }
    },
    observedCase: {
      type: "object",
      required: ["id", "stages"],
      properties: {
        id: { type: "string", minLength: 1 },
        stages: { type: "object", additionalProperties: { $ref: "#/$defs/observedStage" } }
      }
    },
    observedStage: {
      type: "object",
      required: ["status"],
      properties: { status: { $ref: "#/$defs/observedStatus" }, evidence: {}, reason: { type: "string" } }
    },
    report: {
      type: "object",
      required: ["schemaVersion", "planId", "target", "caseCount", "strictPass", "cases"],
      properties: {
        schemaVersion: { const: 1 },
        planId: { type: "string", pattern: "^[a-f0-9]{64}$" },
        target: { type: "string", minLength: 1 },
        caseCount: { type: "integer", minimum: 0 },
        strictPass: { type: "boolean" },
        cases: { type: "array" }
      }
    }
  }
});

const inputPaths = {
  scriptIr: "bindings/generated/defold-script-api-ir.json",
  dmsdkIr: "bindings/generated/defold-sdk-ir.json",
  scriptPatterns: "bindings/generated/defold-script-binding-patterns.json",
  dmsdkPatterns: "bindings/generated/defold-dmsdk-binding-patterns.json",
  scriptDispatch: "bindings/generated/defold-script-scalar-dispatch.json",
  scriptProbes: "bindings/generated/defold-script-real-engine-probes.json",
  dmsdkThunks: "bindings/generated/defold-dmsdk-scalar-thunks.json"
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function portable(value) {
  return value.split(path.sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pascal(value) {
  const words = String(value).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("") || "Anonymous";
  return /^[A-Za-z_$]/.test(joined) ? joined : `_${joined}`;
}

function camel(value) {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
  return String(value).replace(/_([a-zA-Z0-9])/g, (_, character) => character.toUpperCase());
}

function readJson(relative, root = packageRoot) {
  return readFile(path.join(root, relative), "utf8").then(JSON.parse);
}

export async function loadConformanceInputs(root = packageRoot) {
  const entries = await Promise.all(Object.entries(inputPaths).map(async ([key, relative]) => [key, await readJson(relative, root)]));
  return Object.fromEntries(entries);
}

export function parseShard(value = "0/1") {
  const match = /^(\d+)\/(\d+)$/.exec(String(value));
  if (!match) throw new Error("--shard must use zero-based INDEX/COUNT syntax, for example 0/8");
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new Error(`Invalid shard ${value}: require 0 <= INDEX < COUNT`);
  }
  return { index, count };
}

function scriptContexts(item) {
  const root = item.modulePath[0] ?? "builtins";
  if (root === "gui") return ["gui-scene"];
  if (["render", "graphics", "material", "font", "compute"].includes(root)) return ["render-script"];
  if (["go", "sprite", "tilemap", "label", "model", "particlefx", "factory", "collectionfactory", "collectionproxy", "camera", "physics", "b2d", "bullet3d"].includes(root)) return ["game-object"];
  if (root === "html5") return ["browser"];
  if (root === "window") return ["window"];
  if (["http", "socket"].includes(root)) return ["network"];
  return ["engine"];
}

function dmsdkContexts(item) {
  const name = item.name;
  if (/dmHID/.test(name)) return ["input-system"];
  if (/dmGui|dmGameObject|dmScript|dmMessage|dmResource/.test(name)) return ["engine-instance"];
  if (/dmGraphics|dmRender|dmModel|dmRig|dmParticle/.test(name)) return ["render-thread"];
  if (/dmExtension/.test(name)) return ["extension-lifecycle"];
  if (/dmHttp|dmSocket|dmConnectionPool/.test(name)) return ["network"];
  return ["native-host"];
}

function behavioralPolicy(name) {
  const full = String(name).toLowerCase();
  const leaf = full.split(/[.:]/).at(-1);
  if (/^(destroy|delete|remove|clear|reset|reboot|exit|quit|terminate|unregister|free|close|release)$/.test(leaf) || /^(destroy|delete|remove|clear|reset|terminate|unregister|free|close|release)_/.test(leaf)) {
    return { policy: "destructive", reason: `operation name '${leaf}' requires an isolated disposable fixture` };
  }
  if (full.startsWith("dmsdk:dmhid::") || /^dmhid::/.test(full) || ["show_keyboard", "hide_keyboard", "open_url", "get_mouse_lock", "set_mouse_lock"].includes(leaf)) {
    return { policy: "interactive", reason: `operation name '${leaf}' requires interactive input or an OS surface` };
  }
  return { policy: "safe" };
}

function targetBlock(surface, item, families, target) {
  if (surface === "script" && item.modulePath[0] === "html5" && target !== "js-web") {
    return `html5 script API requires target js-web, selected ${target}`;
  }
  if (!families.includes("platform-gated")) return undefined;
  const lower = item.name.toLowerCase();
  if (lower.includes("ios") && !target.includes("ios")) return `iOS-only API does not match target ${target}`;
  if (lower.includes("android") && !target.includes("android")) return `Android-only API does not match target ${target}`;
  if ((lower.includes("html5") || lower.includes("web")) && target !== "js-web") return `web-only API does not match target ${target}`;
  return `platform-gated API requires target-specific availability evidence for ${target}`;
}

function applySelectionPolicy(basePolicy, requiredContexts, selectedContexts, targetReason) {
  if (targetReason) return { policy: "context-blocked", reason: targetReason };
  if (!selectedContexts.includes("*") && !requiredContexts.some((context) => selectedContexts.includes(context))) {
    return {
      policy: "context-blocked",
      reason: `requires one of [${requiredContexts.join(", ")}], selected [${selectedContexts.join(", ")}]`
    };
  }
  return basePolicy;
}

function scriptTypeAccess(item) {
  const [root, ...nested] = item.modulePath;
  return {
    moduleType: `${pascal(root ?? "builtins")}Api`,
    path: [...nested.map(camel), item.jsName]
  };
}

function commonCase({ item, surface, shard, contexts, target, families, requiredContexts, policy }) {
  const stableId = stableBindingId(item.id);
  const source = surface === "script"
    ? { path: item.source, line: item.line }
    : { path: item.header, line: item.line };
  return {
    id: item.id,
    stableId,
    stableIdHex: `0x${stableId.toString(16).padStart(8, "0")}`,
    shard: stableId % shard.count,
    surface,
    kind: item.kind ?? "function",
    name: item.rawName ?? item.name,
    source,
    target,
    requiredContexts,
    selectedContexts: contexts,
    execution: policy,
    families
  };
}

function skipped(reason, evidence) {
  const result = { disposition: "skipped-with-reason", reason };
  if (evidence) result.evidence = evidence;
  return result;
}

function scriptCase(item, pattern, dispatch, probes, selection) {
  const families = pattern ? [pattern.loweringFamily, ...(pattern.traits ?? [])] : [];
  const requiredContexts = scriptContexts(item);
  const basePolicy = behavioralPolicy(item.rawName);
  const policy = applySelectionPolicy(basePolicy, requiredContexts, selection.contexts, targetBlock("script", item, families, selection.target));
  const specialized = item.runtimeStatus === "implemented-generated-lua-bridge";
  const scalarDispatch = Boolean(dispatch);
  const implemented = specialized || scalarDispatch;
  const runtimeEligible = implemented && policy.policy === "safe";
  const linkEvidence = scalarDispatch
    ? "generated_scalar_lua_descriptors.cpp + script_scalar_lua_adapter.cpp"
    : "generated_lua_bridge.cpp + native/lua_hermes_e2e.cpp";
  return {
    ...commonCase({ item, surface: "script", ...selection, families, requiredContexts, policy }),
    typeAccess: scriptTypeAccess(item),
    invocation: { kind: "script", modulePath: item.modulePath.join("."), member: item.member },
    stages: {
      compile: { disposition: "compile-only", expected: "must-pass" },
      link: implemented
        ? { disposition: "linked", evidenceScope: scalarDispatch ? "host-source" : "host-e2e", evidence: linkEvidence }
        : skipped("generated TypeScript surface exists but the Lua/native adapter is not implemented"),
      runtime: runtimeEligible
        ? { disposition: "executable", evidenceScope: "host-e2e", fixture: "generated-runtime-driver" }
        : skipped(implemented ? policy.reason : "runtime adapter is not implemented"),
      semantic: specialized
        ? { state: "host-conformant", evidence: "native/lua_hermes_e2e.cpp", targetConformant: false }
        : scalarDispatch
          ? { state: "unverified", reason: "generated scalar dispatch is executable, but per-function behavioral conformance is not claimed", targetConformant: false }
          : { state: "blocked", reason: "runtime adapter is not implemented" }
    },
    generatedDispatch: dispatch ? {
      stableId: dispatch.stableId,
      executableStatus: dispatch.executableStatus
    } : undefined,
    targetProbeSelection: probes?.length ? {
      target: selection.target,
      probeKeys: probes.map(({ key }) => key),
      claim: "Selected by the generated target harness; only a fresh runtime observation proves execution."
    } : undefined
  };
}

function dmsdkCase(item, pattern, thunk, selection) {
  const families = pattern?.families ?? item.abiStrategies ?? [];
  const requiredContexts = dmsdkContexts(item);
  const basePolicy = callableKinds.has(item.kind) ? behavioralPolicy(item.name) : { policy: "not-applicable", reason: "type metadata is not executable" };
  const policy = applySelectionPolicy(basePolicy, requiredContexts, selection.contexts, targetBlock("dmsdk", item, families, selection.target));
  const emitted = thunk?.emitted === true;
  const hostLinked = emitted && thunk.stages?.linked?.status?.includes("covered");
  const hostConformant = emitted && thunk.stages?.conformant?.status?.includes("covered");
  const runtimeEligible = hostLinked && policy.policy === "safe";
  const accessKind = callableKinds.has(item.kind) && item.disposition === "generated-raw-call"
    ? "call"
    : typeKinds.has(item.kind)
      ? "type"
      : item.kind === "variable" ? "variable" : "metadata";
  return {
    ...commonCase({ item, surface: "dmsdk", ...selection, families, requiredContexts, policy }),
    typeAccess: { kind: accessKind, key: accessKind === "metadata" ? item.id : item.name, declarationId: item.id },
    invocation: callableKinds.has(item.kind) ? { kind: "dmsdk", symbol: item.name } : undefined,
    stages: {
      compile: { disposition: "compile-only", expected: "must-pass" },
      link: hostLinked
        ? { disposition: "linked", evidenceScope: "host-source", evidence: thunk.stages.linked.evidence, targetConformant: false }
        : skipped(callableKinds.has(item.kind) ? "native adapter is not linked" : "type metadata has no link stage"),
      runtime: runtimeEligible
        ? { disposition: "executable", evidenceScope: "host-source", fixture: "generated-runtime-driver", targetConformant: false }
        : skipped(!callableKinds.has(item.kind) ? "type metadata is not executable" : hostLinked ? policy.reason : "native adapter is not linked"),
      semantic: !callableKinds.has(item.kind)
        ? { state: "not-applicable" }
        : hostConformant
          ? { state: "host-conformant", evidence: thunk.stages.conformant.evidence, targetConformant: false }
          : { state: "blocked", reason: emitted ? "behavioral conformance evidence is missing" : "native adapter is not generated" }
    },
    blockers: pattern?.blockers ?? []
  };
}

function validateCase(item) {
  invariant(executionPolicies.has(item.execution.policy), `${item.id}: invalid execution policy ${item.execution.policy}`);
  for (const stage of ["compile", "link", "runtime"]) {
    invariant(stageDispositions.has(item.stages[stage].disposition), `${item.id}: invalid ${stage} disposition`);
    if (item.stages[stage].disposition === "skipped-with-reason") invariant(item.stages[stage].reason, `${item.id}: skipped ${stage} needs a reason`);
  }
  invariant(semanticStates.has(item.stages.semantic.state), `${item.id}: invalid semantic state`);
}

function countBy(items, select) {
  const result = {};
  for (const item of items) {
    const key = select(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

export function buildConformancePlan(inputs, options = {}) {
  const target = options.target ?? inputs.dmsdkIr.platform ?? "arm64-macos";
  const contexts = options.contexts?.length ? [...new Set(options.contexts)].sort() : ["*"];
  const shard = typeof options.shard === "string" ? parseShard(options.shard) : options.shard ?? { index: 0, count: 1 };
  const surfaces = options.surface && options.surface !== "all" ? [options.surface] : ["script", "dmsdk"];
  invariant(surfaces.every((value) => value === "script" || value === "dmsdk"), "--surface must be script, dmsdk, or all");
  const revisions = new Set([inputs.scriptIr.defoldRevision, inputs.dmsdkIr.defoldRevision].filter(Boolean));
  invariant(revisions.size === 1, "script and dmSDK IR must have the same Defold revision");

  const scriptPatterns = new Map(inputs.scriptPatterns.bindings.map((item) => [item.id, item]));
  const dmsdkPatterns = new Map(inputs.dmsdkPatterns.bindings.map((item) => [item.id, item]));
  const scriptDispatch = new Map(inputs.scriptDispatch.bindings.map((item) => [item.id, item]));
  const scriptProbes = new Map();
  if (inputs.scriptProbes.target === target) {
    for (const probe of inputs.scriptProbes.probes) {
      const selected = scriptProbes.get(probe.id) ?? [];
      selected.push(probe);
      scriptProbes.set(probe.id, selected);
    }
  }
  const dmsdkThunks = new Map(inputs.dmsdkThunks.declarations.map((item) => [item.id, item]));
  const selection = { shard, contexts, target };
  const allCases = [];
  if (surfaces.includes("script")) {
    allCases.push(...inputs.scriptIr.functions.map((item) => scriptCase(
      item,
      scriptPatterns.get(item.id),
      scriptDispatch.get(item.id),
      scriptProbes.get(item.id),
      selection)));
  }
  if (surfaces.includes("dmsdk")) {
    allCases.push(...inputs.dmsdkIr.declarations.map((item) => dmsdkCase(item, dmsdkPatterns.get(item.id), dmsdkThunks.get(item.id), selection)));
  }
  const ids = new Set();
  const stableIds = new Map();
  for (const item of allCases) {
    invariant(!ids.has(item.id), `duplicate conformance case id ${item.id}`);
    ids.add(item.id);
    const collision = stableIds.get(item.stableId);
    invariant(!collision, `stable conformance ID collision: ${collision} and ${item.id}`);
    stableIds.set(item.stableId, item.id);
    validateCase(item);
  }
  const cases = allCases.filter((item) => item.shard === shard.index).sort((left, right) => left.id.localeCompare(right.id));
  const inputHashes = Object.fromEntries(Object.keys(inputPaths).map((key) => [key, sha256(stableJson(inputs[key]))]));
  const identity = {
    schemaVersion: 1,
    defoldRevision: [...revisions][0],
    target,
    contexts,
    surfaces,
    shard,
    sourceCounts: {
      script: surfaces.includes("script") ? inputs.scriptIr.functions.length : 0,
      dmsdk: surfaces.includes("dmsdk") ? inputs.dmsdkIr.declarations.length : 0
    },
    inputHashes,
    caseIds: cases.map((item) => item.id)
  };
  const planId = sha256(stableJson(identity));
  return {
    schemaVersion: 1,
    planId,
    defoldRevision: identity.defoldRevision,
    target,
    contexts,
    surfaces,
    shard,
    sourceCounts: identity.sourceCounts,
    selectedCaseCount: cases.length,
    coverageClaim: "Generated dispositions are a test plan. Only attached observations or explicitly scoped baseline evidence prove a stage.",
    summary: {
      surface: countBy(cases, (item) => item.surface),
      executionPolicy: countBy(cases, (item) => item.execution.policy),
      compile: countBy(cases, (item) => item.stages.compile.disposition),
      link: countBy(cases, (item) => item.stages.link.disposition),
      runtime: countBy(cases, (item) => item.stages.runtime.disposition),
      semantic: countBy(cases, (item) => item.stages.semantic.state)
    },
    inputs: Object.fromEntries(Object.entries(inputPaths).map(([key, value]) => [key, value])),
    inputHashes,
    cases
  };
}

function typePath(base, parts) {
  return parts.reduce((value, part) => `${value}[${JSON.stringify(part)}]`, base);
}

export function renderCompileFixture(plan, outputDirectory, root = packageRoot) {
  const scriptTypes = portable(path.relative(outputDirectory, path.join(root, "packages/sdk/src/generated/script/types.js")));
  const dmsdkTypes = portable(path.relative(outputDirectory, path.join(root, "packages/sdk/src/generated/dmsdk/types.js")));
  const relative = (value) => value.startsWith(".") ? value : `./${value}`;
  const lines = [
    "// Generated by @ts-defold/deherm conformance. Do not edit.",
    `// plan ${plan.planId}; target ${plan.target}; shard ${plan.shard.index}/${plan.shard.count}`,
    `import type * as Script from ${JSON.stringify(relative(scriptTypes))};`,
    `import type * as Dm from ${JSON.stringify(relative(dmsdkTypes))};`,
    ""
  ];
  for (const item of plan.cases) {
    const suffix = item.stableIdHex.slice(2);
    lines.push(`// ${item.id}`);
    if (item.surface === "script") {
      const callable = typePath(`Script.${item.typeAccess.moduleType}`, item.typeAccess.path);
      lines.push(`type Case_${suffix} = ${callable};`);
      lines.push(`type Args_${suffix} = Parameters<Case_${suffix}>;`);
      lines.push(`type Result_${suffix} = ReturnType<Case_${suffix}>;`);
    } else {
      lines.push(`type Meta_${suffix} = Dm.DmSdkDeclarationMap[${JSON.stringify(item.id)}];`);
      if (item.typeAccess.kind === "call") {
        lines.push(`type Case_${suffix} = Dm.DmSdkCalls[${JSON.stringify(item.typeAccess.key)}];`);
        lines.push(`type Args_${suffix} = Parameters<Case_${suffix}>;`);
        lines.push(`type Result_${suffix} = ReturnType<Case_${suffix}>;`);
      } else if (item.typeAccess.kind === "type") {
        lines.push(`type Shape_${suffix} = Dm.DmSdkTypes[${JSON.stringify(item.typeAccess.key)}];`);
      } else if (item.typeAccess.kind === "variable") {
        lines.push(`type Value_${suffix} = Dm.DmSdkVariables[${JSON.stringify(item.typeAccess.key)}];`);
      }
    }
    lines.push("");
  }
  lines.push("export {};", "");
  return lines.join("\n");
}

export function renderRuntimeFixture(plan) {
  const cases = plan.cases.map((item) => ({
    id: item.id,
    stableId: item.stableId,
    surface: item.surface,
    name: item.name,
    invocation: item.invocation,
    execution: item.execution,
    runtime: item.stages.runtime,
    semantic: item.stages.semantic
  }));
  return `// Generated by @ts-defold/deherm conformance. Do not edit.
export const planId = ${JSON.stringify(plan.planId)};
export const target = ${JSON.stringify(plan.target)};
export const cases = Object.freeze(${JSON.stringify(cases, null, 2)});

/**
 * Execute every safe, runnable case through one target adapter. The adapter
 * supplies context-owned arguments and semantic oracles; no API call is
 * handwritten into this driver.
 */
export async function runGeneratedConformance(adapter) {
  const results = [];
  for (const testCase of cases) {
    if (testCase.runtime.disposition !== "executable" || testCase.execution.policy !== "safe") {
      results.push({ id: testCase.id, stages: { runtime: { status: "skipped", reason: testCase.runtime.reason ?? testCase.execution.reason ?? "not executable" } } });
      continue;
    }
    const fixture = await adapter.fixtureFor(testCase);
    if (!fixture) {
      results.push({ id: testCase.id, stages: { runtime: { status: "skipped", reason: "context adapter supplied no fixture" } } });
      continue;
    }
    try {
      const actual = await adapter.invoke(testCase.invocation, fixture.args ?? []);
      const semantic = fixture.assert ? await fixture.assert(actual, testCase) : undefined;
      results.push({
        id: testCase.id,
        stages: {
          runtime: { status: "passed", evidence: fixture.evidence },
          semantic: semantic === true
            ? { status: "passed", evidence: fixture.evidence }
            : semantic === undefined
              ? { status: "skipped", reason: "no semantic oracle supplied" }
              : { status: "failed", reason: "semantic oracle did not return true" }
        }
      });
    } catch (error) {
      results.push({ id: testCase.id, stages: { runtime: { status: "failed", reason: error instanceof Error ? error.message : String(error) } } });
    }
  }
  return { schemaVersion: 1, planId, target, results };
}
`;
}

export async function writeConformanceHarness(plan, output) {
  const outputDirectory = path.resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  const files = {
    plan: path.join(outputDirectory, "plan.json"),
    schema: path.join(outputDirectory, "conformance.schema.json"),
    compile: path.join(outputDirectory, "compile.ts"),
    runtime: path.join(outputDirectory, "runtime.mjs"),
    observations: path.join(outputDirectory, "observations.example.json"),
    tsconfig: path.join(outputDirectory, "tsconfig.json")
  };
  await Promise.all([
    writeFile(files.plan, `${JSON.stringify(plan, null, 2)}\n`),
    writeFile(files.schema, `${JSON.stringify(conformanceJsonSchema, null, 2)}\n`),
    writeFile(files.compile, renderCompileFixture(plan, outputDirectory)),
    writeFile(files.runtime, renderRuntimeFixture(plan)),
    writeFile(files.observations, `${JSON.stringify({ schemaVersion: 1, planId: plan.planId, target: plan.target, results: [] }, null, 2)}\n`),
    writeFile(files.tsconfig, `${JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: false
      },
      files: ["compile.ts"]
    }, null, 2)}\n`)
  ]);
  return { root: outputDirectory, files, plan };
}

export async function generateConformanceHarness(options = {}) {
  const inputs = options.inputs ?? await loadConformanceInputs(options.root);
  const plan = buildConformancePlan(inputs, options);
  return writeConformanceHarness(
    plan,
    options.output ?? path.resolve(process.cwd(), ".deherm", "conformance", `${plan.shard.index}-of-${plan.shard.count}`)
  );
}

export async function compileConformanceHarness(planPath, output) {
  const absolutePlan = path.resolve(planPath);
  const directory = path.dirname(absolutePlan);
  const plan = JSON.parse(await readFile(absolutePlan, "utf8"));
  const config = path.join(directory, "tsconfig.json");
  const typescriptPackage = packageRequire.resolve("typescript/package.json");
  const compiler = path.join(path.dirname(typescriptPackage), "bin", "tsc");
  const command = [compiler, "--project", config, "--pretty", "false"];
  const result = spawnSync(process.execPath, command, { cwd: packageRoot, encoding: "utf8" });
  const passed = result.status === 0;
  const diagnostic = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const evidence = `TypeScript exit ${result.status ?? "unknown"}: node ${portable(path.relative(packageRoot, compiler))} --project ${portable(path.relative(packageRoot, config))}`;
  const observation = {
    schemaVersion: 1,
    planId: plan.planId,
    target: plan.target,
    results: plan.cases.map((item) => ({
      id: item.id,
      stages: {
        compile: passed
          ? { status: "passed", evidence }
          : { status: "failed", reason: diagnostic || evidence }
      }
    }))
  };
  const destination = path.resolve(output ?? path.join(directory, "compile-observation.json"));
  await writeFile(destination, `${JSON.stringify(observation, null, 2)}\n`);
  return { passed, status: result.status, stdout: result.stdout, stderr: result.stderr, output: destination, observation };
}

function emptyObserved() {
  return {
    compile: { status: "not-run" },
    link: { status: "not-run" },
    runtime: { status: "not-run" },
    semantic: { status: "not-run" }
  };
}

export function buildConformanceReport(plan, observations = []) {
  const cases = new Map(plan.cases.map((item) => [item.id, { ...item, observed: emptyObserved() }]));
  const seen = new Set();
  for (const observation of observations) {
    invariant(observation.schemaVersion === 1, "observation schemaVersion must be 1");
    invariant(observation.planId === plan.planId, `observation plan ${observation.planId} does not match ${plan.planId}`);
    invariant(observation.target === plan.target, `observation target ${observation.target} does not match ${plan.target}`);
    invariant(Array.isArray(observation.results), "observation results must be an array");
    for (const result of observation.results) {
      invariant(cases.has(result.id), `observation contains unknown case ${result.id}`);
      for (const [stage, value] of Object.entries(result.stages ?? {})) {
        invariant(["compile", "link", "runtime", "semantic"].includes(stage), `${result.id}: unknown observed stage ${stage}`);
        invariant(observedStatuses.has(value.status), `${result.id}: invalid observed ${stage} status ${value.status}`);
        const key = `${result.id}:${stage}`;
        invariant(!seen.has(key), `duplicate observation for ${key}`);
        seen.add(key);
        cases.get(result.id).observed[stage] = value;
      }
    }
  }
  const values = [...cases.values()];
  const strictFailures = [];
  for (const item of values) {
    if (item.observed.compile.status !== "passed") strictFailures.push(`${item.id}: compile ${item.observed.compile.status}`);
    if (item.stages.link.disposition === "linked" && item.observed.link.status !== "passed") strictFailures.push(`${item.id}: link ${item.observed.link.status}`);
    if (item.stages.runtime.disposition === "executable" && item.execution.policy === "safe" && item.observed.runtime.status !== "passed") {
      strictFailures.push(`${item.id}: runtime ${item.observed.runtime.status}`);
    }
    if (item.stages.runtime.disposition === "executable" && item.execution.policy === "safe" && item.stages.semantic.state !== "not-applicable" && item.observed.semantic.status !== "passed") {
      strictFailures.push(`${item.id}: semantic ${item.observed.semantic.status}`);
    }
  }
  return {
    schemaVersion: 1,
    planId: plan.planId,
    target: plan.target,
    shard: plan.shard,
    caseCount: values.length,
    observationCount: seen.size,
    summary: {
      compile: countBy(values, (item) => item.observed.compile.status),
      link: countBy(values, (item) => item.observed.link.status),
      runtime: countBy(values, (item) => item.observed.runtime.status),
      semantic: countBy(values, (item) => item.observed.semantic.status),
      plannedSemantic: countBy(values, (item) => item.stages.semantic.state)
    },
    strictPass: strictFailures.length === 0,
    strictFailures,
    cases: values
  };
}

export async function readConformanceReport(planPath, observationPaths = []) {
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8"));
  const observations = await Promise.all(observationPaths.map((value) => readFile(path.resolve(value), "utf8").then(JSON.parse)));
  return buildConformanceReport(plan, observations);
}

export const conformanceSchema = Object.freeze({
  stageDispositions: [...stageDispositions],
  executionPolicies: [...executionPolicies],
  semanticStates: [...semanticStates],
  observedStatuses: [...observedStatuses]
});
