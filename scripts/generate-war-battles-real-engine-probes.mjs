#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const urls = {
  manifest: new URL("bindings/probes/war-battles-script-real-engine-probes.json", root),
  ir: new URL("bindings/generated/defold-script-api-ir.json", root),
  scalar: new URL("bindings/generated/defold-script-scalar-dispatch.json", root),
  value: new URL("bindings/generated/defold-script-value-bindings.json", root)
};
const reportUrl = new URL("bindings/generated/war-battles-script-real-engine-probes.json", root);
const typescriptUrl = new URL("sample/src/generated/war-battles-script-real-engine-probes.ts", root);
const requiredIds = ["script:msg.post", "script:factory.create", "script:go.delete", "script:gui.get_node", "script:gui.set_text"];
const requiredAssertions = new Map([
  ["script:msg.post", ["receiver-observes-full-sender-url", "serialized-payload-at-or-below-2048-bytes-is-delivered", "serialized-payload-above-2048-bytes-is-rejected"]],
  ["script:factory.create", ["factory-child-init-runs-with-child-context", "parent-game-object-context-restored-after-child-init"]],
  ["script:go.delete", ["created-object-remains-live-until-end-of-frame", "created-object-is-deleted-after-end-of-frame"]],
  ["script:gui.get_node", ["active-gui-scene-token-required", "wrong-scene-token-rejected", "deleted-node-token-rejected", "finalized-scene-token-rejected"]],
  ["script:gui.set_text", ["active-gui-scene-token-required", "wrong-scene-token-rejected", "deleted-node-token-rejected", "finalized-scene-token-rejected", "numeric-text-uses-defold-number-formatting"]]
]);

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
}

function argumentExpression(argument, captures, label) {
  if (!argument || typeof argument !== "object") throw new Error(`${label} must be an argument object`);
  if (argument.kind === "literal") {
    if (!["string", "number", "boolean"].includes(typeof argument.value) && argument.value !== null) {
      throw new Error(`${label}: unsupported literal`);
    }
    return JSON.stringify(argument.value);
  }
  if (argument.kind === "capture") {
    nonEmpty(argument.name, `${label}.name`);
    if (!captures.has(argument.name)) throw new Error(`${label}: capture is used before declaration: ${argument.name}`);
    return argument.name;
  }
  throw new Error(`${label}: unsupported argument kind ${argument.kind}`);
}

function argumentCodec(argument, captures) {
  if (argument.kind === "literal") {
    if (typeof argument.value === "string") return "String";
    if (typeof argument.value === "number") return "Number";
    if (typeof argument.value === "boolean") return "Boolean";
    return "Null";
  }
  return captures.get(argument.name);
}

function resultCodec(fn) {
  if (fn.returns.length === 0) return "None";
  if (fn.returns.length !== 1) return "Multiple";
  return new Map([["hash", "Hash"], ["node", "Node"]]).get(fn.returns[0]) ?? fn.returns[0];
}

function validateSignature(scenario, fn) {
  const expected = scenario.expectedSignature;
  if (!expected || !Array.isArray(expected.parameters) || !Array.isArray(expected.returns)) throw new Error(`${scenario.key}: expectedSignature is required`);
  const actualParameters = fn.parameters.map(({ rawType }) => rawType);
  if (JSON.stringify(expected.parameters) !== JSON.stringify(actualParameters)) {
    throw new Error(`${scenario.key}: Defold parameter signature changed: ${JSON.stringify(actualParameters)}`);
  }
  if (JSON.stringify(expected.returns) !== JSON.stringify(fn.returns)) {
    throw new Error(`${scenario.key}: Defold return signature changed: ${JSON.stringify(fn.returns)}`);
  }
  const argumentCount = scenario.invocation.arguments.length;
  const minimum = fn.parameters.filter(({ optional }) => !optional).length;
  if (argumentCount < minimum || argumentCount > fn.parameters.length) throw new Error(`${scenario.key}: invocation arity ${argumentCount} is outside ${minimum}..${fn.parameters.length}`);
}

function executableRoutes(scalar, value) {
  const routes = new Map();
  for (const binding of scalar.bindings) routes.set(binding.id, {
    kind: "scalar",
    stableId: binding.stableId,
    operation: binding.operation,
    implementedCallShapes: Array.from(
      { length: binding.maximumArgumentCount - binding.requiredArgumentCount + 1 },
      (_, offset) => binding.parameters.slice(0, binding.requiredArgumentCount + offset).map(({ codec }) => codec)
    )
  });
  for (const binding of value.bindings) {
    if (routes.has(binding.id)) throw new Error(`${binding.id}: executable route is duplicated`);
    routes.set(binding.id, {
      kind: binding.id === "script:hash" ? "handle" : "value",
      stableId: binding.stableId,
      operation: binding.operation,
      implementedCallShapes: binding.implementedCallShapes ?? []
    });
  }
  return routes;
}

export function generateWarBattlesRealEngineProbes(texts) {
  const manifest = JSON.parse(texts.manifest);
  const ir = JSON.parse(texts.ir);
  const scalar = JSON.parse(texts.scalar);
  const value = JSON.parse(texts.value);
  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported War Battles probe schema ${manifest.schemaVersion}`);
  if (manifest.target !== "arm64-macos-dynamic-hermes") throw new Error("War Battles probe target must remain explicit");
  if (!Array.isArray(manifest.setups) || !Array.isArray(manifest.scenarios) || !Array.isArray(manifest.observations)) throw new Error("War Battles probe arrays are required");
  if (manifest.observations.length !== 0) throw new Error("This generator never promotes observations; verified observations belong in the SHA-bound real-engine matrix");
  const setupById = new Map();
  for (const setup of manifest.setups) {
    nonEmpty(setup.id, "setup.id");
    if (setupById.has(setup.id)) throw new Error(`Duplicate setup ${setup.id}`);
    if (!new Set(["game-object", "gui-scene"]).has(setup.context)) throw new Error(`${setup.id}: unsupported context`);
    if (!setup.fixture || typeof setup.fixture !== "object") throw new Error(`${setup.id}: fixture is required`);
    if (setup.context === "gui-scene" && (setup.fixture.contextSource !== "generated .gui_script Lua proxy with captured Lua/HScene identity" || setup.fixture.publicDmSdkAvailable !== false)) {
      throw new Error(`${setup.id}: GUI proof requires a generated .gui_script Lua proxy and cannot claim a public dmSDK HScene path`);
    }
    if (setup.context === "game-object" && setup.fixture.requiredContextBehavior !== "Factory child init executes with the child active, then the parent game-object context is restored before factory.create returns.") {
      throw new Error(`${setup.id}: factory context restoration requirement is missing`);
    }
    setupById.set(setup.id, setup);
  }
  const fnById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const routes = executableRoutes(scalar, value);
  const ids = new Set();
  const keys = new Set();
  const capturesByEntrypoint = new Map();
  const linesByEntrypoint = new Map([["gameObject", []], ["gui", []]]);
  const scenarioReports = [];
  for (const scenario of manifest.scenarios) {
    nonEmpty(scenario.key, "scenario.key");
    nonEmpty(scenario.routeId, `${scenario.key}.routeId`);
    if (keys.has(scenario.key)) throw new Error(`Duplicate scenario key ${scenario.key}`);
    if (ids.has(scenario.routeId)) throw new Error(`Every target route must have exactly one primary scenario: ${scenario.routeId}`);
    keys.add(scenario.key);
    ids.add(scenario.routeId);
    if (!requiredIds.includes(scenario.routeId)) throw new Error(`${scenario.key}: route is outside the five-API War Battles wave`);
    const fn = fnById.get(scenario.routeId);
    if (!fn) throw new Error(`${scenario.key}: route is absent from the canonical Defold IR`);
    if (!setupById.has(scenario.setupId)) throw new Error(`${scenario.key}: unknown setup ${scenario.setupId}`);
    if (!linesByEntrypoint.has(scenario.entrypoint)) throw new Error(`${scenario.key}: unsupported entrypoint ${scenario.entrypoint}`);
    if (!scenario.invocation || !Array.isArray(scenario.invocation.arguments)) throw new Error(`${scenario.key}: invocation arguments are required`);
    if (JSON.stringify(scenario.assertions) !== JSON.stringify(requiredAssertions.get(scenario.routeId))) {
      throw new Error(`${scenario.key}: required engine assertions are incomplete or reordered`);
    }
    if (!new Set(["planned", "implemented-not-run"]).has(scenario.assertionHarnessState)) {
      throw new Error(`${scenario.key}: assertionHarnessState must be planned or implemented-not-run`);
    }
    validateSignature(scenario, fn);
    const captures = capturesByEntrypoint.get(scenario.entrypoint) ?? new Map();
    capturesByEntrypoint.set(scenario.entrypoint, captures);
    const args = scenario.invocation.arguments.map((argument, index) => argumentExpression(argument, captures, `${scenario.key}.arguments[${index}]`));
    const callShape = scenario.invocation.arguments.map((argument) => argumentCodec(argument, captures));
    if (JSON.stringify(callShape) !== JSON.stringify(scenario.expectedCallShape)) {
      throw new Error(`${scenario.key}: invocation call shape ${JSON.stringify(callShape)} does not match expectedCallShape`);
    }
    const callable = `${fn.modulePath.join(".")}.${fn.jsName}`;
    let statement = `${callable}(${args.join(", ")});`;
    if (scenario.invocation.capture) {
      nonEmpty(scenario.invocation.capture, `${scenario.key}.capture`);
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(scenario.invocation.capture)) throw new Error(`${scenario.key}: capture is not a safe TypeScript identifier`);
      if (captures.has(scenario.invocation.capture)) throw new Error(`${scenario.key}: duplicate capture ${scenario.invocation.capture}`);
      const codec = resultCodec(fn);
      if (codec === "None" || codec === "Multiple") throw new Error(`${scenario.key}: capture requires exactly one result`);
      captures.set(scenario.invocation.capture, codec);
      statement = `const ${scenario.invocation.capture} = ${statement}`;
    }
    linesByEntrypoint.get(scenario.entrypoint).push(`  ${statement}`);
    const route = routes.get(scenario.routeId);
    const callShapeImplemented = route?.implementedCallShapes.some((shape) => JSON.stringify(shape) === JSON.stringify(callShape)) ?? false;
    if (!scenario.expectedOperationParameters || typeof scenario.expectedOperationParameters !== "object" || Array.isArray(scenario.expectedOperationParameters)) {
      throw new Error(`${scenario.key}: expectedOperationParameters are required`);
    }
    if (route) {
      const actualParameters = route.operation?.parameters;
      for (const [name, expected] of Object.entries(scenario.expectedOperationParameters)) {
        if (JSON.stringify(actualParameters?.[name]) !== JSON.stringify(expected)) {
          throw new Error(`${scenario.key}: generated operation parameter ${name} changed`);
        }
      }
    }
    const markerPrefix = scenario.routeId.replace(/^script:/, "").replaceAll(".", ":");
    const expectedMarkers = scenario.assertions.map((assertion) => `DEBUG:SCRIPT: war-battles-api:${markerPrefix}:${assertion}:ok`);
    scenarioReports.push({
      key: scenario.key,
      routeId: scenario.routeId,
      setupId: scenario.setupId,
      entrypoint: scenario.entrypoint,
      expectedMarkers,
      expectedCallShape: scenario.expectedCallShape,
      expectedOperationParameters: scenario.expectedOperationParameters,
      assertions: scenario.assertions,
      assertionHarnessState: scenario.assertionHarnessState,
      harnessState: "generated-not-run",
      routeStatus: route && callShapeImplemented ? "generated-executable-route" : route ? "awaiting-generated-call-shape" : "awaiting-generated-route",
      ...(route ? { routeKind: route.kind, stableId: route.stableId, implementedCallShapes: route.implementedCallShapes } : {}),
      evidence: {
        compile: { status: "unverified", observationIds: [] },
        link: { status: "unverified", observationIds: [] },
        runtime: { status: "unverified", observationIds: [] }
      }
    });
  }
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...requiredIds].sort())) throw new Error("All five War Battles routes require exactly one scenario");
  const roots = [...new Set(manifest.scenarios.map(({ routeId }) => fnById.get(routeId).modulePath[0]))].sort();
  const typescript = [
    "// Generated by scripts/generate-war-battles-real-engine-probes.mjs. Do not edit.",
    `import { ${roots.join(", ")} } from "@defold-hermes/sdk";`,
    "",
    "// Invoke only from a generated .script.ts proxy with an active game-object context.",
    "export function runWarBattlesGameObjectProbes(): void {",
    ...linesByEntrypoint.get("gameObject"),
    "}",
    "",
    "// Invoke only from a generated .gui_script.ts proxy with an active GUI-scene context.",
    "export function runWarBattlesGuiProbes(): void {",
    ...linesByEntrypoint.get("gui"),
    "}"
  ].join("\n");
  const inputSha256 = createHash("sha256").update(texts.manifest).update("\0").update(texts.ir).update("\0").update(texts.scalar).update("\0").update(texts.value).digest("hex");
  const executableScenarioCount = scenarioReports.filter(({ routeStatus }) => routeStatus === "generated-executable-route").length;
  return {
    report: {
      schemaVersion: 1,
      defoldRevision: ir.defoldRevision,
      target: manifest.target,
      inputSha256,
      coverageClaim: "Five context-specific War Battles harness calls are generated and signature-checked. Compile, link, and runtime behavior remain unverified until the SHA-bound evidence matrix observes them in a packaged engine.",
      scenarioCount: scenarioReports.length,
      executableScenarioCount,
      awaitingRouteCount: scenarioReports.length - executableScenarioCount,
      verifiedCompileCount: 0,
      verifiedLinkCount: 0,
      verifiedRuntimeCount: 0,
      setups: manifest.setups,
      probes: scenarioReports
    },
    typescript: `${typescript}\n`
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const entries = await Promise.all(Object.entries(urls).map(async ([key, url]) => [key, await readFile(url, "utf8")]));
  const outputs = generateWarBattlesRealEngineProbes(Object.fromEntries(entries));
  const targets = [[reportUrl, `${JSON.stringify(outputs.report, null, 2)}\n`], [typescriptUrl, outputs.typescript]];
  if (check) {
    for (const [url, expected] of targets) if (await readFile(url, "utf8") !== expected) throw new Error(`${url.pathname} is stale`);
  } else {
    await Promise.all(targets.map(([url, contents]) => writeFile(url, contents)));
  }
  console.log(`${check ? "Verified" : "Generated"} ${outputs.report.scenarioCount} War Battles scenarios; ${outputs.report.executableScenarioCount} executable, ${outputs.report.awaitingRouteCount} awaiting routes, 0 runtime-verified.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
