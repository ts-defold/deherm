#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const sourceUrl = new URL("bindings/probes/defold-script-value-real-engine-probes.json", root);
const bindingsUrl = new URL("bindings/generated/defold-script-value-bindings.json", root);
const reportUrl = new URL("bindings/generated/defold-script-value-real-engine-probes.json", root);
const typescriptUrl = new URL("sample/src/generated/script-value-real-engine-probes.ts", root);

const componentNames = ["x", "y", "z", "w"];

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function argumentCodec(argument, label) {
  if (typeof argument === "string") return "String";
  if (typeof argument === "number") {
    finite(argument, label);
    return "Number";
  }
  if (argument?.codec === "Hash" && typeof argument.factoryCreate === "string") return "Hash";
  if (argument?.codec === "Node" && typeof argument.guiGetNode === "string") return "Node";
  if (!argument || typeof argument !== "object" || !["Vector3", "Vector4", "Quaternion", "Matrix4"].includes(argument.codec)) {
    throw new Error(`${label} must be a number or supported generated Defold value`);
  }
  const count = argument.codec === "Vector3" ? 3 : argument.codec === "Matrix4" ? 16 : 4;
  if (!Array.isArray(argument.components) || argument.components.length !== count) {
    throw new Error(`${label} ${argument.codec} requires ${count} components`);
  }
  argument.components.forEach((value, index) => finite(value, `${label}.components[${index}]`));
  return argument.codec;
}

function argumentExpression(argument) {
  if (typeof argument === "string") return JSON.stringify(argument);
  if (typeof argument === "number") return JSON.stringify(argument);
  if (argument.codec === "Hash") return `factory.create(${JSON.stringify(argument.factoryCreate)})`;
  if (argument.codec === "Node") return `gui.getNode(${JSON.stringify(argument.guiGetNode)})`;
  if (argument.codec === "Matrix4") return `[${argument.components.map(JSON.stringify).join(", ")}] as const`;
  const call = argument.codec === "Vector3" ? "vmath.vector3" : argument.codec === "Vector4" ? "vmath.vector4" : "vmath.quat";
  return `${call}(${argument.components.map(JSON.stringify).join(", ")})`;
}

function expectationExpression(expectation, resultName, resultCodec, key) {
  if (expectation.kind === "deferredLua") {
    if (typeof expectation.marker !== "string" || !expectation.marker.startsWith("DEBUG:SCRIPT: ")) {
      throw new Error(`${key}: deferredLua expectation requires a DEBUG:SCRIPT marker`);
    }
    if (resultCodec === "None") return `${resultName} === undefined`;
    if (resultCodec === "Hash") return `typeof ${resultName} === "bigint"`;
    if (resultCodec === "Node") return `typeof ${resultName} === "object" && ${resultName} !== null`;
    throw new Error(`${key}: deferredLua has no generated predicate for ${resultCodec}`);
  }
  if (expectation.kind === "hashHex") {
    if (resultCodec !== "Hash" || typeof expectation.value !== "string" || !/^[0-9a-f]{16}$/i.test(expectation.value)) {
      throw new Error(`${key}: hashHex expectation requires a 16-digit hex value and Hash result`);
    }
    return `typeof ${resultName} === "bigint" && ${resultName} === BigInt(${JSON.stringify(`0x${expectation.value}`)})`;
  }
  const tolerance = finite(expectation.tolerance, `${key}.expectation.tolerance`);
  if (tolerance < 0) throw new Error(`${key}: expectation tolerance must not be negative`);
  if (expectation.kind === "number") {
    if (resultCodec !== "Number") throw new Error(`${key}: numeric expectation requires Number result`);
    const value = finite(expectation.value, `${key}.expectation.value`);
    return `typeof ${resultName} === "number" && Math.abs(${resultName} - ${JSON.stringify(value)}) <= ${JSON.stringify(tolerance)}`;
  }
  if (expectation.kind === "components") {
    const count = resultCodec === "Vector3" ? 3 :
      ["Vector4", "Quaternion"].includes(resultCodec) ? 4 : resultCodec === "Matrix4" ? 16 : 0;
    if (!count || !Array.isArray(expectation.values) || expectation.values.length !== count) {
      throw new Error(`${key}: component expectation does not match ${resultCodec}`);
    }
    return expectation.values.map((value, index) => {
      finite(value, `${key}.expectation.values[${index}]`);
      const access = resultCodec === "Matrix4" ? `[${index}]` : `.${componentNames[index]}`;
      return `Math.abs(${resultName}${access} - ${JSON.stringify(value)}) <= ${JSON.stringify(tolerance)}`;
    }).join(" && ");
  }
  throw new Error(`${key}: unsupported expectation kind ${expectation.kind}`);
}

export function generateScriptValueRealEngineProbes(sourceText, bindingsText) {
  const source = JSON.parse(sourceText);
  const generated = JSON.parse(bindingsText);
  if (source.schemaVersion !== 1 || !Array.isArray(source.probes) || !Array.isArray(source.plannedFamilyRecipes)) {
    throw new Error("Unsupported value probe schema");
  }
  if (!source.instrumentedProbeSet ||
      typeof source.instrumentedProbeSet.marker !== "string" ||
      !/^INFO:DEFOLD_HERMES: script-value-probes:[0-9a-f]{64}$/.test(source.instrumentedProbeSet.marker) ||
      !/^[0-9a-f]{64}$/.test(source.instrumentedProbeSet.semanticSha256 ?? "")) {
    throw new Error("Value probes require a pinned instrumentedProbeSet marker and semantic SHA-256");
  }
  const inputSha256 = createHash("sha256").update(sourceText).update("\0").update(bindingsText).digest("hex");
  const byId = new Map(generated.bindings.map((binding) => [binding.id, binding]));
  const seenKeys = new Set();
  const seenBindings = new Set();
  const lines = [
    "// Generated by scripts/generate-script-value-real-engine-probes.mjs. Do not edit.",
    'import { builtins, factory, go, gui, msg, vmath } from "@defold-hermes/sdk";',
    "",
    "export type ScriptValueRealEngineProbeLog = (message: string) => void;",
    "",
    "export function runScriptValueRealEngineProbes(log: ScriptValueRealEngineProbeLog): void {",
    `  log(${JSON.stringify(source.instrumentedProbeSet.marker.replace("INFO:DEFOLD_HERMES: ", ""))});`
  ];
  const generatedProbeInputs = generated.bindings
    .filter(({ generatedProbe }) => generatedProbe != null)
    .map((binding) => {
      if (!binding.generatedFamily || !binding.generatedProbe ||
          typeof binding.generatedProbe !== "object" || Array.isArray(binding.generatedProbe) ||
          "id" in binding.generatedProbe ||
          (binding.generatedProbe.state != null && binding.generatedProbe.state !== "planned") ||
          (binding.generatedProbe.state === "planned" &&
            (typeof binding.generatedProbe.reason !== "string" || !binding.generatedProbe.reason))) {
        throw new Error(`${binding.id}: generated family probe metadata is invalid`);
      }
      return { ...binding.generatedProbe, id: binding.id, generatedFamily: binding.generatedFamily };
    });
  const probeInputs = [...source.probes, ...generatedProbeInputs];
  const probes = probeInputs.map((probe, index) => {
    if (typeof probe.key !== "string" || !probe.key || seenKeys.has(probe.key)) throw new Error(`Probe key must be unique: ${probe.key}`);
    seenKeys.add(probe.key);
    const binding = byId.get(probe.id);
    if (!binding) throw new Error(`${probe.key}: ${probe.id} is not a generated value binding`);
    if (!Array.isArray(probe.arguments)) throw new Error(`${probe.key}: arguments must be an array`);
    const codecs = probe.arguments.map((argument, argumentIndex) => argumentCodec(argument, `${probe.key}.arguments[${argumentIndex}]`));
    if (!Array.isArray(binding.implementedCallShapes)) {
      throw new Error(`${probe.key}: generated binding has no implementedCallShapes`);
    }
    if (!binding.implementedCallShapes.some((shape) => JSON.stringify(shape) === JSON.stringify(codecs))) {
      throw new Error(`${probe.key}: argument codecs ${JSON.stringify(codecs)} do not match an implemented call shape`);
    }
    if (probe.expectation?.kind === "deferredLua" &&
        probe.expectation.marker !== `DEBUG:SCRIPT: script-value:${probe.key}:ok`) {
      throw new Error(`${probe.key}: deferredLua marker must be derived from the probe key`);
    }
    const state = probe.state ?? "instrumented";
    if (!["instrumented", "planned"].includes(state)) throw new Error(`${probe.key}: invalid probe state ${state}`);
    if (state === "planned" && (typeof probe.reason !== "string" || !probe.reason)) {
      throw new Error(`${probe.key}: planned probe requires a reason`);
    }
    const resultCodec = binding.resultCodec === "SameDefoldValue" ? codecs[0] : binding.resultCodec;
    const resultName = `result_${index}`;
    const callable = binding.id === "script:hash"
      ? `builtins.${binding.jsName}`
      : `${binding.rawName.split(".")[0]}.${binding.jsName}`;
    const predicate = expectationExpression(probe.expectation, resultName, resultCodec, probe.key);
    if (state === "instrumented") {
      lines.push(`  const ${resultName} = ${callable}(${probe.arguments.map(argumentExpression).join(", ")});`);
      lines.push(`  if (!(${predicate})) throw new Error(${JSON.stringify(`${probe.id} probe ${probe.key} failed`)});`);
      if (probe.expectation.kind !== "deferredLua") {
        lines.push(`  log(${JSON.stringify(`script-value:${probe.key}:ok`)});`);
      }
    }
    seenBindings.add(probe.id);
    return {
      key: probe.key,
      id: probe.id,
      stableId: binding.stableId,
      state,
      ...(state === "planned" ? { reason: probe.reason } : {}),
      callShape: codecs,
      resultCodec,
      expectation: probe.expectation,
      ...(probe.generatedFamily ? { generatedFamily: probe.generatedFamily } : {}),
      expectedMarker: probe.expectation.kind === "deferredLua"
        ? probe.expectation.marker
        : `INFO:DEFOLD_HERMES: script-value:${probe.key}:ok`
    };
  });
  const plannedFamilyRecipes = new Map();
  for (const recipe of source.plannedFamilyRecipes) {
    if (!recipe || typeof recipe !== "object" ||
        typeof recipe.generatedFamily !== "string" || !recipe.generatedFamily ||
        typeof recipe.context !== "string" || !recipe.context ||
        typeof recipe.scenarioKeyPrefix !== "string" || !recipe.scenarioKeyPrefix ||
        typeof recipe.reason !== "string" || !recipe.reason) {
      throw new Error("Planned family recipe requires generatedFamily, context, scenarioKeyPrefix, and reason");
    }
    if (plannedFamilyRecipes.has(recipe.generatedFamily)) {
      throw new Error(`Duplicate planned family recipe: ${recipe.generatedFamily}`);
    }
    if (!recipe.scenarioKeyPrefix.startsWith("planned:") || !recipe.scenarioKeyPrefix.endsWith(":")) {
      throw new Error(`${recipe.generatedFamily}: planned scenarioKeyPrefix must be a planned: namespace ending in ':'`);
    }
    plannedFamilyRecipes.set(recipe.generatedFamily, recipe);
  }

  const plannedProbes = [];
  for (const binding of generated.bindings) {
    if (seenBindings.has(binding.id)) continue;
    const recipe = plannedFamilyRecipes.get(binding.generatedFamily);
    if (!recipe) continue;
    const key = `${recipe.scenarioKeyPrefix}${binding.id}`;
    if (seenKeys.has(key)) throw new Error(`Probe key must be unique: ${key}`);
    if (!Array.isArray(binding.implementedCallShapes) || binding.implementedCallShapes.length === 0) {
      throw new Error(`${key}: generated binding has no implementedCallShapes`);
    }
    const bindingContext = binding.operation?.parameters?.context ?? "none";
    if (bindingContext !== recipe.context) {
      throw new Error(`${key}: planned family context ${recipe.context} does not match generated route context`);
    }
    seenKeys.add(key);
    seenBindings.add(binding.id);
    plannedProbes.push({
      key,
      id: binding.id,
      stableId: binding.stableId,
      state: "planned-only",
      reason: recipe.reason,
      context: recipe.context,
      target: source.target,
      implementedCallShapes: binding.implementedCallShapes,
      resultCodec: binding.resultCodec
    });
  }
  for (const family of plannedFamilyRecipes.keys()) {
    if (!generated.bindings.some((binding) => binding.generatedFamily === family)) {
      throw new Error(`Planned family recipe does not match a generated binding family: ${family}`);
    }
  }
  lines.push("}");
  if (seenBindings.size !== generated.bindings.length) {
    const missing = generated.bindings.filter(({ id }) => !seenBindings.has(id)).map(({ id }) => id);
    throw new Error(`Every generated value binding requires a real-engine probe; missing: ${missing.join(", ")}`);
  }
  const instrumentedSemanticRows = probes.filter(({ state }) => state === "instrumented").map((probe) => ({
    key: probe.key,
    id: probe.id,
    stableId: probe.stableId,
    callShape: probe.callShape,
    resultCodec: probe.resultCodec,
    expectation: probe.expectation,
    expectedMarker: probe.expectedMarker
  }));
  const instrumentedSemanticSha256 = createHash("sha256")
    .update(JSON.stringify(instrumentedSemanticRows)).digest("hex");
  if (instrumentedSemanticSha256 !== source.instrumentedProbeSet.semanticSha256) {
    throw new Error(`Instrumented value probe semantics changed: ${instrumentedSemanticSha256}`);
  }
  const report = {
    schemaVersion: 1,
    defoldRevision: generated.defoldRevision,
    target: source.target,
    inputSha256,
    expectedInputMarker: source.instrumentedProbeSet.marker,
    instrumentedSemanticSha256,
    coverageClaim: `All ${generated.bindings.length} generated native value bindings have a deterministic packaged-engine probe disposition for dynamic Hermes on arm64 macOS; ${plannedProbes.length} family routes are planned-only and are neither emitted nor claimed as observed.`,
    probeCount: probes.length,
    generatedProbeCount: generatedProbeInputs.length,
    instrumentedProbeCount: probes.filter(({ state }) => state === "instrumented").length,
    explicitPlannedProbeCount: probes.filter(({ state }) => state === "planned").length,
    plannedProbeCount: probes.filter(({ state }) => state === "planned").length + plannedProbes.length,
    plannedFamilyProbeCount: plannedProbes.length,
    routeDispositionCount: probes.length + plannedProbes.length,
    uniqueBindingCount: seenBindings.size,
    probes,
    plannedProbes
  };
  return { report: `${JSON.stringify(report, null, 2)}\n`, typescript: `${lines.join("\n")}\n` };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const [sourceText, bindingsText] = await Promise.all([readFile(sourceUrl, "utf8"), readFile(bindingsUrl, "utf8")]);
  const outputs = generateScriptValueRealEngineProbes(sourceText, bindingsText);
  const targets = [[reportUrl, outputs.report], [typescriptUrl, outputs.typescript]];
  if (check) {
    for (const [url, expected] of targets) if (await readFile(url, "utf8") !== expected) throw new Error(`${url.pathname} is stale`);
  } else {
    await mkdir(new URL("./", typescriptUrl), { recursive: true });
    await Promise.all(targets.map(([url, contents]) => writeFile(url, contents)));
  }
  console.log(`${check ? "Verified" : "Generated"} ${JSON.parse(outputs.report).probeCount} value real-engine probes.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
