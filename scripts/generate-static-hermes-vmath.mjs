import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relativeOutputs = {
  report: "packages/bindings/generated/defold-static-hermes-vmath.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_static_hermes_vmath.h",
  source: "defold/defold_hermes/src/generated_static_hermes_vmath.cpp",
  typescript: "packages/static-hermes/src/generated/script-vmath.ts"
};

function parseArguments(argv) {
  const result = {
    check: false,
    descriptor: path.join(repositoryRoot, "packages/bindings/generated/defold-script-value-bindings.json"),
    config: path.join(repositoryRoot, "packages/bindings/overrides/static-hermes-vmath.json"),
    outputRoot: repositoryRoot
  };
  for (let index = 2; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === "--check") {
      result.check = true;
      continue;
    }
    if (argument === "--descriptor" || argument === "--config" || argument === "--output-root") {
      const value = argv[++index];
      assert.ok(value, `${argument} requires a value`);
      result[argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] =
        path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pascalCase(value) {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
}

function hex32(value) {
  return value.toString(16).padStart(8, "0");
}

const lanesByCodec = Object.freeze({
  Vector3: ["x", "y", "z"],
  Vector4: ["x", "y", "z", "w"],
  Quaternion: ["x", "y", "z", "w"]
});

function flattenedParameters(shape) {
  return shape.flatMap((codec, argumentIndex) =>
    lanesByCodec[codec].map((lane) => ({
      cName: `arg${argumentIndex}_${lane}`,
      tsName: `arg${argumentIndex}${lane.toUpperCase()}`
    })));
}

function assertDescriptor(descriptor, config, descriptorRaw) {
  assert.equal(config.schemaVersion, 1, "Unsupported Static Hermes vmath config schema");
  assert.equal(descriptor.schemaVersion, 1, "Unsupported value-binding descriptor schema");
  assert.equal(
    sha256(descriptorRaw),
    config.descriptorSha256,
    "Static Hermes vmath descriptor-sha256-drift: review the changed value-binding descriptor and update the pinned override"
  );
  assert.equal(descriptor.bindingCount, descriptor.bindings.length, "Descriptor bindingCount drift");
  assert.equal(descriptor.bindings.length, config.expectedCoverage.descriptorBindings, "Descriptor coverage drift");
}

function classify(descriptor, config) {
  const selected = [];
  const exclusions = [];
  const stableIds = new Set();
  const selector = config.selector;
  for (const binding of descriptor.bindings) {
    assert.ok(Number.isInteger(binding.stableId) && binding.stableId >= 0 && binding.stableId <= 0xffffffff,
      `${binding.id} has an invalid source-generated stable ID`);
    assert.ok(!stableIds.has(binding.stableId), `${binding.id} has a duplicate source-generated stable ID`);
    stableIds.add(binding.stableId);
    if (!binding.id.startsWith(selector.idPrefix)) {
      exclusions.push({ id: binding.id, stableId: binding.stableId, reason: "out-of-scope-non-vmath" });
      continue;
    }
    if (binding.resultCodec !== selector.resultCodec) {
      exclusions.push({
        id: binding.id,
        stableId: binding.stableId,
        reason: "static-hermes-ffi-has-no-allocation-free-aggregate-return",
        resultCodec: binding.resultCodec
      });
      continue;
    }
    assert.ok(
      selector.operationTemplates.includes(binding.operation?.template),
      `${binding.id} uses an unreviewed operation template`
    );
    assert.equal(binding.operation.parameters.context, undefined, `${binding.id} unexpectedly requires context`);
    assert.equal(binding.operation.parameters.backend, undefined, `${binding.id} unexpectedly requires a backend`);
    assert.ok(binding.implementedCallShapes.length > 0, `${binding.id} has no implemented call shapes`);
    const member = binding.id.slice(selector.idPrefix.length);
    assert.match(member, /^[a-z][a-z0-9_]*$/, `${binding.id} cannot form a stable C symbol`);
    const shapes = binding.implementedCallShapes.map((shape) => {
      assert.ok(shape.length > 0, `${binding.id} unexpectedly has an empty scalar-result shape`);
      for (const codec of shape) {
        assert.ok(selector.argumentCodecs.includes(codec), `${binding.id} uses unsupported ${codec}`);
      }
      const suffix = shape.map(pascalCase).join("");
      return {
        codecs: shape,
        cFunction: `deherm_static_vmath_${hex32(binding.stableId)}_${member}_${shape.map((codec) => codec.toLowerCase()).join("_")}`,
        wrapper: `vmath${pascalCase(member)}${suffix}`
      };
    });
    assert.equal(new Set(shapes.map(({ cFunction }) => cFunction)).size, shapes.length,
      `${binding.id} generates duplicate C functions`);
    selected.push({ ...binding, shapes });
  }
  return { selected, exclusions };
}

function validateCoverage(descriptor, selected, exclusions, config) {
  const coverage = {
    descriptorBindings: descriptor.bindings.length,
    scopedVmathBindings: descriptor.bindings.filter((binding) => binding.id.startsWith(config.selector.idPrefix)).length,
    includedBindings: selected.length,
    includedCallShapes: selected.reduce((count, binding) => count + binding.shapes.length, 0),
    structuredResultExclusions: exclusions.filter((entry) => entry.reason.includes("aggregate-return")).length,
    outOfScopeBindings: exclusions.filter((entry) => entry.reason === "out-of-scope-non-vmath").length
  };
  assert.deepEqual(coverage, config.expectedCoverage, "Static Hermes vmath coverage drift");
  assert.equal(selected.length + exclusions.length, descriptor.bindings.length, "Classification is not exhaustive");
  return coverage;
}

function renderHeader(selected) {
  const declarations = selected.flatMap((binding) => binding.shapes.map((shape) => {
    const parameters = flattenedParameters(shape.codecs)
      .map(({ cName }) => `float ${cName}`).join(", ");
    return `double ${shape.cFunction}(${parameters});`;
  })).join("\n");
  return `// Generated by scripts/generate-static-hermes-vmath.mjs. Do not edit.\n#pragma once\n\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n\n// A quiet NaN reports a generated-shape or engine dispatch error.\n// Sound-typed wrappers convert this sentinel to a deterministic exception.\n${declarations}\n\n#ifdef __cplusplus\n}\n#endif\n`;
}

function renderSource(selected) {
  const functions = selected.flatMap((binding) => binding.shapes.map((shape) => {
    const parameters = flattenedParameters(shape.codecs);
    const signature = parameters.map(({ cName }) => `float ${cName}`).join(", ");
    const argumentsSetup = shape.codecs.map((codec, argumentIndex) => {
      const laneValues = lanesByCodec[codec]
        .map((lane) => `arg${argumentIndex}_${lane}`).concat(Array(4 - lanesByCodec[codec].length).fill("0.0f"));
      return `  arguments[${argumentIndex}] = makeDefoldValue(ScriptDefoldValueKind::k${codec}, ${laneValues.join(", ")});`;
    }).join("\n");
    return `extern \"C\" double ${shape.cFunction}(${signature}) {\n  ScriptValue arguments[${shape.codecs.length}]{};\n${argumentsSetup}\n  return dispatchScalar(0x${hex32(binding.stableId)}u, arguments, ${shape.codecs.length});\n}`;
  })).join("\n\n");

  return `// Generated by scripts/generate-static-hermes-vmath.mjs. Do not edit.\n#include <defold_hermes/generated_static_hermes_vmath.h>\n\n#include <defold_hermes/generated_script_value_bindings.hpp>\n\n#include <limits>\n\nnamespace {\nusing defold_hermes::ScriptCallFrame;\nusing defold_hermes::ScriptDefoldValueKind;\nusing defold_hermes::ScriptValue;\nusing defold_hermes::ScriptValueTag;\n\nScriptValue makeDefoldValue(\n    ScriptDefoldValueKind kind,\n    float x,\n    float y,\n    float z,\n    float w) noexcept {\n  ScriptValue value{};\n  value.tag = ScriptValueTag::kDefoldValue;\n  value.defoldKind = kind;\n  value.defoldValue[0] = x;\n  value.defoldValue[1] = y;\n  value.defoldValue[2] = z;\n  value.defoldValue[3] = w;\n  return value;\n}\n\ndouble dispatchScalar(\n    uint32_t stableId,\n    const ScriptValue* arguments,\n    uint32_t argumentCount) noexcept {\n  ScriptValue result{};\n  ScriptCallFrame frame{};\n  frame.stableId = stableId;\n  frame.arguments = arguments;\n  frame.argumentCount = argumentCount;\n  frame.results = &result;\n  frame.resultCapacity = 1;\n  const auto status = defold_hermes::value_binding::dispatch(&frame, nullptr, 0);\n  if (status != defold_hermes::value_binding::DispatchStatus::kSuccess ||\n      frame.resultCount != 1 || result.tag != ScriptValueTag::kNumber) {\n    return std::numeric_limits<double>::quiet_NaN();\n  }\n  return result.number;\n}\n}  // namespace\n\n${functions}\n`;
}

function renderTypescript(selected) {
  const blocks = selected.flatMap((binding) => binding.shapes.map((shape) => {
    const parameters = flattenedParameters(shape.codecs);
    const typed = parameters.map(({ tsName }) => `${tsName}: c_f32`).join(", ");
    const names = parameters.map(({ tsName }) => tsName).join(", ");
    const signature = `${binding.id}(${shape.codecs.join(",")})`;
    return `const __ffi_${shape.wrapper} = $SHBuiltin.extern_c(\n  {include: \"defold_hermes/generated_static_hermes_vmath.h\"},\n  function ${shape.cFunction}(${typed}): c_f64 { throw 0; }\n);\n\nfunction ${shape.wrapper}(${typed}): number {\n  const result: number = __ffi_${shape.wrapper}(${names});\n  if (result !== result) {\n    throw ${JSON.stringify(`deherm Static Hermes dispatch failed: ${signature}`)};\n  }\n  return result;\n}`;
  })).join("\n\n");
  return `// Generated by scripts/generate-static-hermes-vmath.mjs. Do not edit.\n// Exact float32 lanes cross the C ABI; wrappers return the scalar Lua number.\n\"use strict\";\n\n${blocks}\n`;
}

async function writeOrCheck(target, content, check) {
  if (check) {
    const current = await readFile(target, "utf8");
    assert.equal(current, content, `${path.relative(repositoryRoot, target)} is stale`);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

const options = parseArguments(process.argv);
const [descriptorRaw, configRaw] = await Promise.all([
  readFile(options.descriptor, "utf8"),
  readFile(options.config, "utf8")
]);
const descriptor = JSON.parse(descriptorRaw);
const config = JSON.parse(configRaw);
assertDescriptor(descriptor, config, descriptorRaw);
const { selected, exclusions } = classify(descriptor, config);
const coverage = validateCoverage(descriptor, selected, exclusions, config);
const header = renderHeader(selected);
const source = renderSource(selected);
const typescript = renderTypescript(selected);
const report = `${JSON.stringify({
  schemaVersion: 1,
  descriptorSha256: sha256(descriptorRaw),
  overrideSha256: sha256(configRaw),
  descriptorInputSha256: descriptor.inputSha256,
  coverage,
  abi: {
    argumentLayout: "flattened-c-f32-lanes",
    resultLayout: "c-f64-scalar",
    errorSentinel: "quiet-nan-converted-to-deterministic-wrapper-exception",
    reentrant: true,
    context: "none"
  },
  failurePolicy: "The native scalar ABI returns quiet NaN for dispatch errors, including the engine-defined vmath.project zero-target error. Every generated sound-typed wrapper detects result !== result and throws a stable route/shape string. This also rejects any otherwise successful operation that produces NaN from infinities; the scalar ABI cannot distinguish those cases without a status aggregate or caller-owned output pointer.",
  allocationClaim: "The successful generated C ABI shim and wrapper path uses only scalar parameters, fixed stack arrays, and ScriptCallFrame dispatch; it performs no explicit heap allocation. The exceptional wrapper path is not included in the zero-allocation claim. Engine math implementations may change independently.",
  included: selected.map((binding) => ({
    id: binding.id,
    stableId: binding.stableId,
    stableIdHex: `0x${hex32(binding.stableId)}`,
    operationTemplate: binding.operation.template,
    resultCodec: binding.resultCodec,
    shapes: binding.shapes
  })),
  exclusions,
  generatedSha256: {
    header: sha256(header),
    source: sha256(source),
    typescript: sha256(typescript)
  }
}, null, 2)}\n`;

await Promise.all([
  writeOrCheck(path.join(options.outputRoot, relativeOutputs.report), report, options.check),
  writeOrCheck(path.join(options.outputRoot, relativeOutputs.header), header, options.check),
  writeOrCheck(path.join(options.outputRoot, relativeOutputs.source), source, options.check),
  writeOrCheck(path.join(options.outputRoot, relativeOutputs.typescript), typescript, options.check)
]);

console.log(`Static Hermes vmath bridge: ${coverage.includedBindings} bindings / ${coverage.includedCallShapes} shapes generated; ${coverage.structuredResultExclusions} structured-result vmath routes excluded`);
