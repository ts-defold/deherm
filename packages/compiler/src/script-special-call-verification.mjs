import { createHash } from "node:crypto";

import { componentProxyConstants } from "./component-proxy-contract.mjs";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const scalarSamples = Object.freeze({
  bool: true,
  i32: -19088743,
  u32: 4045620583,
  f32: 13.25,
  f64: 0.125
});

const callbackSample = Object.freeze({
  runtime: 2166572391,
  slot: 2433814808,
  generation: 2701057225,
  type: 2968299642
});

function parameterShape(parameter, scenario) {
  if (parameter.type !== "callback") return Object.freeze({
    name: parameter.name,
    type: parameter.type,
    sample: parameter.name === "delay" && Number.isFinite(scenario?.delay)
      ? scenario.delay
      : scalarSamples[parameter.type],
    cAbi: Object.freeze([parameter.name])
  });
  return Object.freeze({
    name: parameter.name,
    type: parameter.type,
    sample: callbackSample,
    cAbi: Object.freeze([
      `${parameter.name}_runtime`,
      `${parameter.name}_slot`,
      `${parameter.name}_generation`,
      `${parameter.name}_type`
    ])
  });
}

function derivePropertyVectors(rows) {
  const reverseResourceKinds = new Map(Object.entries(componentProxyConstants.resourceKinds)
    .map(([authoringKind, luaKind]) => [luaKind, authoringKind]));
  const goRows = rows.filter(({ rawName }) => rawName === "go.property");
  assert(goRows.length === 1, `expected one go.property compiler row, found ${goRows.length}`);
  const resourceRows = rows.filter(({ modulePath }) => modulePath === "resource");
  const expectedResources = [...reverseResourceKinds.keys()].sort(compareCodeUnits);
  const actualResources = resourceRows.map(({ member }) => member).sort(compareCodeUnits);
  assert(canonicalJson(actualResources) === canonicalJson(expectedResources),
    `component resource compiler rows differ from the generic compiler capability: expected ${expectedResources.join(", ")}, got ${actualResources.join(", ")}`);

  return Object.freeze([
    Object.freeze({
      id: goRows[0].id,
      rawName: goRows[0].rawName,
      source: goRows[0].source,
      line: goRows[0].line,
      lane: "component-property-compiler",
      transport: "compile-time-typescript-to-lua",
      propertyName: "dehermNumber",
      authoringExpression: "property.number(17)",
      expectedLua: 'go.property("dehermNumber", 17)'
    }),
    ...resourceRows.sort((left, right) => compareCodeUnits(left.id, right.id)).map((row, index) => {
      const authoringKind = reverseResourceKinds.get(row.member);
      const propertyName = `dehermResource${index}`;
      const resourcePath = `/deherm/${row.member}.${row.member}`;
      return Object.freeze({
        id: row.id,
        rawName: row.rawName,
        source: row.source,
        line: row.line,
        lane: "component-property-compiler",
        transport: "compile-time-typescript-to-lua",
        propertyName,
        authoringExpression: `property.${authoringKind}(${JSON.stringify(resourcePath)})`,
        expectedLua: `go.property(${JSON.stringify(propertyName)}, resource.${row.member}(${JSON.stringify(resourcePath)}))`
      });
    })
  ]);
}

function deriveTimerVectors(rows, moduleSchema, luaSchema) {
  const routeRows = new Map(rows.map((row) => [row.rawName, row]));
  const luaModules = new Map(luaSchema.modules.map((module) => [module.name, module]));
  const moduleFunctions = moduleSchema.modules.flatMap((module) => {
    const luaModule = luaModules.get(module.name);
    if (!luaModule) return [];
    const luaFunctions = new Map(luaModule.functions.map((fn) => [fn.name, fn]));
    return module.functions.map((fn) => {
      const luaFunction = luaFunctions.get(fn.name);
      assert(luaFunction, `${module.name}.${fn.name}: no Lua compatibility thunk`);
      return {
        module,
        fn,
        luaModule,
        luaFunction,
        route: `${luaModule.luaModule}.${luaFunction.luaFunction}`
      };
    });
  });

  const actual = moduleFunctions.map(({ route }) => route).sort(compareCodeUnits);
  const expected = [...routeRows.keys()].sort(compareCodeUnits);
  assert(canonicalJson(actual) === canonicalJson(expected),
    `separate-module routes differ from modules.json: expected ${expected.join(", ")}, got ${actual.join(", ")}`);

  return Object.freeze(moduleFunctions
    .sort((left, right) => compareCodeUnits(left.route, right.route))
    .map(({ module, fn, luaModule, luaFunction, route }) => {
      const row = routeRows.get(route);
      assert(canonicalJson(fn.parameters.map(({ name, type }) => ({ name, type }))) ===
        canonicalJson(luaFunction.parameters.map(({ name, type }) => ({ name, type }))),
      `${route}: module and Lua parameter schemas differ`);
      assert(fn.returns === luaFunction.returns, `${route}: module and Lua return schemas differ`);
      const parameters = fn.parameters.map((parameter) => parameterShape(parameter, module.verification));
      const vector = {
        id: row.id,
        rawName: row.rawName,
        source: row.source,
        line: row.line,
        lane: "separate-module",
        module: module.name,
        function: fn.name,
        cSymbol: fn.symbol,
        luaModule: luaModule.luaModule,
        luaFunction: luaFunction.luaFunction,
        parameters,
        cAbiArguments: parameters.flatMap(({ cAbi }) => cAbi),
        staticCAbiSamples: parameters.flatMap(({ type, sample }) => type === "callback"
          ? [sample.runtime, sample.slot, sample.generation, sample.type]
          : [sample]),
        returns: fn.returns,
        staticResultSample: fn.returns === "bool" ? true : fn.returns === "u32" ? 3777183751 : null,
        callbackFailureValue: fn.callbackFailureValue ?? null,
        evidence: Object.freeze([
          Object.freeze({ lane: "lua-stack-compatibility", contract: "scenario-exact-call-and-lifecycle", samples: "timer-lifecycle-v1" }),
          Object.freeze({ lane: "dynamic-hermes-jsi", contract: "scenario-exact-call-and-lifecycle", samples: "timer-lifecycle-v1" }),
          Object.freeze({ lane: "browser-wasm-host", contract: "scenario-exact-call-and-lifecycle", samples: "timer-lifecycle-v1" }),
          Object.freeze({
            lane: "static-hermes-c-abi",
            contract: "exact-symbol-ordered-abi-result-and-callback-handle-field-transport",
            samples: "staticCAbiSamples",
            callbackOwnership: "not-exercised"
          })
        ])
      };
      return Object.freeze({ ...vector, vectorSha256: sha256(canonicalJson(vector)) });
    }));
}

export function generateScriptSpecialCallVerification({ accounting, moduleSchema, luaSchema }) {
  assert(accounting?.schemaVersion === 1, "script accounting schemaVersion must be 1");
  const compilerRows = accounting.rows.filter(({ category }) => category === "component-property-compiler");
  const separateRows = accounting.rows.filter(({ category }) => category === "separate-module");
  const compilerIntrinsics = derivePropertyVectors(compilerRows);
  const separateModules = deriveTimerVectors(separateRows, moduleSchema, luaSchema);
  assert(compilerIntrinsics.length === compilerRows.length, "compiler verification vector count drifted");
  assert(separateModules.length === separateRows.length, "separate-module verification vector count drifted");

  const report = {
    schemaVersion: 1,
    source: "deherm-script-special-call-verification",
    defoldRevision: accounting.defoldRevision,
    evidenceBoundary: "Compiler intrinsics are verified by exact generated Lua declarations. Lua, Dynamic Hermes/JSI, and browser/Wasm execute the generated timer lifecycle scenario with exact call and ownership assertions. Static Hermes separately verifies sound-typed symbol selection, ordered ABI values/results, and callback-handle field transport; it does not claim callback ownership. Defold remains the semantic authority behind the bridge.",
    inputs: {
      accountingSha256: sha256(canonicalJson(accounting)),
      moduleSchemaSha256: sha256(canonicalJson(moduleSchema)),
      luaSchemaSha256: sha256(canonicalJson(luaSchema))
    },
    counts: {
      componentPropertyCompiler: compilerIntrinsics.length,
      separateModule: separateModules.length,
      total: compilerIntrinsics.length + separateModules.length
    },
    compilerIntrinsics,
    separateModules,
    scenarios: moduleSchema.modules
      .filter(({ verification }) => verification)
      .map(({ name, verification }) => ({ module: name, ...verification }))
  };
  return Object.freeze({ ...report, reportSha256: sha256(canonicalJson(report)) });
}

export function renderScriptSpecialCallVerification(inputs) {
  return `${JSON.stringify(generateScriptSpecialCallVerification(inputs), null, 2)}\n`;
}

function macroName(value) {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function cLiteral(type, value) {
  if (type === "f64") return `${Number(value).toPrecision(17)}`;
  if (type === "f32") return `${Number(value).toPrecision(9)}f`;
  if (type === "i32") return `INT32_C(${value})`;
  if (type === "bool") return value ? "UINT8_C(1)" : "UINT8_C(0)";
  return `UINT32_C(${value})`;
}

export function renderScriptSpecialCallVerificationHeader(inputs) {
  const report = generateScriptSpecialCallVerification(inputs);
  const lines = [
    "// Generated by @deherm/compiler script-special-call-verification. Do not edit.",
    "#pragma once",
    "",
    "#include <stdint.h>",
    "",
    `#define DEHERM_SCRIPT_SPECIAL_CALL_VECTOR_COUNT UINT32_C(${report.counts.total})`
  ];
  for (const vector of report.separateModules) {
    const prefix = `DEHERM_VERIFY_${macroName(vector.module)}_${macroName(vector.function)}`;
    let flatIndex = 0;
    for (const parameter of vector.parameters) {
      if (parameter.type === "callback") {
        for (const field of ["runtime", "slot", "generation", "type"]) {
          lines.push(`#define ${prefix}_${macroName(parameter.name)}_${macroName(field)} UINT32_C(${parameter.sample[field]})`);
          flatIndex += 1;
        }
      } else {
        lines.push(`#define ${prefix}_${macroName(parameter.name)} ${cLiteral(parameter.type, parameter.sample)}`);
        flatIndex += 1;
      }
    }
    lines.push(`#define ${prefix}_C_ABI_ARITY UINT32_C(${flatIndex})`);
    if (vector.returns !== "void") {
      lines.push(`#define ${prefix}_RESULT ${cLiteral(vector.returns, vector.staticResultSample)}`);
    }
  }
  for (const scenario of report.scenarios) {
    const prefix = `DEHERM_VERIFY_${macroName(scenario.module)}_SCENARIO`;
    for (const [name, value] of Object.entries(scenario)) {
      if (name === "module" || name === "kind") continue;
      const type = typeof value === "boolean" ? "bool" : Number.isInteger(value) ? "u32" : "f64";
      lines.push(`#define ${prefix}_${macroName(name)} ${cLiteral(type, value)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
