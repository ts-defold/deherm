#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const sourceUrl = new URL("packages/bindings/probes/defold-script-real-engine-probes.json", root);
const descriptorsUrl = new URL("packages/bindings/generated/defold-script-scalar-dispatch.json", root);
const irUrl = new URL("packages/bindings/generated/defold-script-api-ir.json", root);
const reportUrl = new URL("packages/bindings/generated/defold-script-real-engine-probes.json", root);
const typescriptUrl = new URL("examples/runtime-smoke/src/generated/script-real-engine-probes.ts", root);

function literal(value) {
  return JSON.stringify(value);
}

function valueMatchesCodec(value, codec) {
  if (codec === "Boolean") return typeof value === "boolean";
  if (codec === "String") return typeof value === "string";
  if (codec === "Number") return typeof value === "number" && Number.isFinite(value);
  if (codec === "Integer") return typeof value === "number" && Number.isSafeInteger(value);
  return false;
}

function validateExpectation(probe, binding) {
  const expectation = probe.expectation;
  if (!expectation || typeof expectation.kind !== "string") {
    throw new Error(`${probe.key}: expectation kind is required`);
  }
  const result = binding.result;
  if (expectation.kind === "undefined") {
    if (result.codec !== "None") throw new Error(`${probe.key}: undefined expectation requires a None result`);
    return;
  }
  if (result.codec === "None") throw new Error(`${probe.key}: None result requires an undefined expectation`);
  if (expectation.kind === "equal") {
    if (expectation.value === null) {
      if (!result.nullable) throw new Error(`${probe.key}: null expectation requires a nullable result`);
      return;
    }
    if (!valueMatchesCodec(expectation.value, result.codec)) {
      throw new Error(`${probe.key}: equal expectation does not match ${result.codec} result codec`);
    }
    return;
  }
  if (expectation.kind === "integer-range") {
    if (result.codec !== "Integer" && result.codec !== "Number") {
      throw new Error(`${probe.key}: integer-range requires a numeric result`);
    }
    if (!Number.isSafeInteger(expectation.minimum) || !Number.isSafeInteger(expectation.maximum) || expectation.minimum > expectation.maximum) {
      throw new Error(`${probe.key}: invalid integer range`);
    }
    return;
  }
  if (expectation.kind === "non-empty-string") {
    if (result.codec !== "String") throw new Error(`${probe.key}: non-empty-string requires a String result`);
    return;
  }
  if (expectation.kind === "string-suffix") {
    if (result.codec !== "String" || typeof expectation.suffix !== "string" || !expectation.suffix) {
      throw new Error(`${probe.key}: string-suffix requires a String result and non-empty suffix`);
    }
    return;
  }
  throw new Error(`${probe.key}: unsupported expectation ${expectation.kind}`);
}

function expectationExpression(probe, resultName) {
  const expectation = probe.expectation;
  if (expectation.kind === "equal") return `Object.is(${resultName}, ${literal(expectation.value)})`;
  if (expectation.kind === "undefined") return `${resultName} === undefined`;
  if (expectation.kind === "integer-range") {
    return `typeof ${resultName} === "number" && Number.isInteger(${resultName}) && ${resultName} >= ${expectation.minimum} && ${resultName} <= ${expectation.maximum}`;
  }
  if (expectation.kind === "non-empty-string") return `typeof ${resultName} === "string" && ${resultName}.length > 0`;
  if (expectation.kind === "string-suffix") return `typeof ${resultName} === "string" && ${resultName}.endsWith(${literal(expectation.suffix)})`;
  throw new Error(`${probe.key}: unsupported expectation ${expectation.kind}`);
}

function exactMarkerValue(expectation) {
  if (expectation.kind === "equal") return String(expectation.value);
  if (expectation.kind === "undefined") return "undefined";
  return undefined;
}

function portableIdentifier(value, index) {
  return `${value.replace(/[^A-Za-z0-9_$]/g, "_")}_${index}`;
}

function buildOutputs(sourceText, descriptorsText, irText) {
  const source = JSON.parse(sourceText);
  const descriptors = JSON.parse(descriptorsText);
  const ir = JSON.parse(irText);
  if (source.schemaVersion !== 1) throw new Error(`Unsupported probe schema ${source.schemaVersion}`);
  if (!Array.isArray(source.probes) || source.probes.length === 0) throw new Error("At least one real-engine probe is required");
  const descriptorById = new Map(descriptors.bindings.map((binding) => [binding.id, binding]));
  const functionById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const keys = new Set();
  const inputSha256 = createHash("sha256")
    .update(sourceText).update("\0").update(descriptorsText).update("\0").update(irText)
    .digest("hex");
  const probes = source.probes.map((probe, index) => {
    if (typeof probe.key !== "string" || !probe.key || keys.has(probe.key)) throw new Error(`Probe key must be unique: ${probe.key}`);
    keys.add(probe.key);
    const binding = descriptorById.get(probe.id);
    const fn = functionById.get(probe.id);
    if (!binding || !fn) throw new Error(`${probe.key}: ${probe.id} is not a generated scalar binding`);
    if (!Array.isArray(probe.arguments)) throw new Error(`${probe.key}: arguments must be an array`);
    if (probe.arguments.length < binding.requiredArgumentCount || probe.arguments.length > binding.maximumArgumentCount) {
      throw new Error(`${probe.key}: ${probe.arguments.length} arguments violate generated range ${binding.requiredArgumentCount}..${binding.maximumArgumentCount}`);
    }
    for (let argumentIndex = 0; argumentIndex < probe.arguments.length; ++argumentIndex) {
      const codec = binding.parameters[argumentIndex].codec;
      if (!valueMatchesCodec(probe.arguments[argumentIndex], codec)) {
        throw new Error(`${probe.key}: argument ${argumentIndex} does not match generated ${codec} codec`);
      }
    }
    validateExpectation(probe, binding);
    const markerPrefix = `INFO:DEFOLD_HERMES: script-api:${probe.key}:`;
    const exactValue = exactMarkerValue(probe.expectation);
    return {
      index,
      key: probe.key,
      id: probe.id,
      stableId: binding.stableId,
      rawName: binding.rawName,
      modulePath: fn.modulePath,
      jsName: fn.jsName,
      arguments: probe.arguments,
      argumentCodecs: binding.parameters.slice(0, probe.arguments.length).map(({ codec }) => codec),
      requiredArgumentCount: binding.requiredArgumentCount,
      maximumArgumentCount: binding.maximumArgumentCount,
      result: binding.result,
      expectation: probe.expectation,
      expectedMarkerPrefix: markerPrefix,
      ...(exactValue === undefined ? {} : { expectedMarker: `${markerPrefix}${exactValue}` })
    };
  });

  const roots = [...new Set(probes.map((probe) => probe.modulePath[0]))].sort();
  const lines = [
    "// Generated by scripts/generate-script-real-engine-probes.mjs. Do not edit.",
    `import { ${roots.join(", ")} } from "@ts-defold/deherm";`,
    "",
    "export type ScriptRealEngineProbeLog = (message: string) => void;",
    "",
    "export function runScriptRealEngineProbes(log: ScriptRealEngineProbeLog): void {",
    `  log(${literal(`script-api-probes:${inputSha256}`)});`
  ];
  for (const probe of probes) {
    const resultName = portableIdentifier(probe.key, probe.index);
    const callable = [...probe.modulePath, probe.jsName].join(".");
    lines.push(`  const ${resultName} = ${callable}(${probe.arguments.map(literal).join(", ")});`);
    lines.push(`  if (!(${expectationExpression(probe, resultName)})) {`);
    lines.push(`    throw new Error(${literal(`${probe.id} probe ${probe.key} failed; received `)} + String(${resultName}));`);
    lines.push("  }");
    lines.push(`  log(${literal(`script-api:${probe.key}:`)} + String(${resultName}));`);
  }
  lines.push("}");

  const report = {
    schemaVersion: 1,
    defoldRevision: descriptors.defoldRevision,
    target: source.target,
    inputSha256,
    expectedInputMarker: `INFO:DEFOLD_HERMES: script-api-probes:${inputSha256}`,
    coverageClaim: `${probes.length} descriptor-validated scalar calls are selected for the arm64 Defold runtime harness; no claim is made for unselected bindings or other targets.`,
    probeCount: probes.length,
    uniqueBindingCount: new Set(probes.map(({ id }) => id)).size,
    argumentCodecs: [...new Set(probes.flatMap(({ argumentCodecs }) => argumentCodecs))].sort(),
    resultCodecs: [...new Set(probes.map(({ result }) => result.codec))].sort(),
    nullableResultProbeCount: probes.filter(({ expectation }) => expectation.kind === "equal" && expectation.value === null).length,
    optionalOmissionProbeCount: probes.filter((probe) => probe.arguments.length < probe.maximumArgumentCount).length,
    probes: probes.map(({ index: _index, ...probe }) => probe)
  };
  return {
    report: `${JSON.stringify(report, null, 2)}\n`,
    typescript: `${lines.join("\n")}\n`
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const [sourceText, descriptorsText, irText] = await Promise.all([
    readFile(sourceUrl, "utf8"),
    readFile(descriptorsUrl, "utf8"),
    readFile(irUrl, "utf8")
  ]);
  const outputs = buildOutputs(sourceText, descriptorsText, irText);
  const targets = [[reportUrl, outputs.report], [typescriptUrl, outputs.typescript]];
  if (check) {
    for (const [url, expected] of targets) {
      const actual = await readFile(url, "utf8");
      if (actual !== expected) throw new Error(`${url.pathname} is stale`);
    }
  } else {
    await mkdir(new URL("./", typescriptUrl), { recursive: true });
    await Promise.all(targets.map(([url, contents]) => writeFile(url, contents)));
  }
  console.log(`${check ? "Verified" : "Generated"} ${JSON.parse(outputs.report).probeCount} descriptor-driven real-engine probes.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
