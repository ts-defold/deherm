import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  renderStaticHermesVmathHeader,
  renderStaticHermesVmathSource,
  renderStaticHermesVmathTypescript,
} from "../packages/compiler/src/static-hermes-vmath-output-emitter.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relativeOutputs = {
  report: "packages/bindings/generated/defold-static-hermes-vmath.json",
  facts: "packages/bindings/generated/defold-static-hermes-vmath-recipe-facts.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_static_hermes_vmath.h",
  source: "defold/defold_hermes/src/generated_static_hermes_vmath.cpp",
  typescript: "packages/static-hermes/src/generated/script-vmath.ts",
};

function parseArguments(argv) {
  const result = {
    check: false,
    descriptor: path.join(repositoryRoot, "packages/bindings/generated/defold-script-value-bindings.json"),
    config: path.join(repositoryRoot, "packages/bindings/overrides/static-hermes-vmath.json"),
    outputRoot: repositoryRoot,
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
      result[argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = path.resolve(value);
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
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

function hex32(value) {
  return value.toString(16).padStart(8, "0");
}

function assertDescriptor(descriptor, config) {
  assert.equal(config.schemaVersion, 1, "Unsupported Static Hermes vmath config schema");
  assert.equal(descriptor.schemaVersion, 1, "Unsupported value-binding descriptor schema");
  assert.equal(descriptor.bindingCount, descriptor.bindings.length, "Descriptor bindingCount drift");
  assert.equal(
    new Set(descriptor.bindings.map(({ id }) => id)).size,
    descriptor.bindings.length,
    "Descriptor contains duplicate binding IDs",
  );
}

function classify(descriptor, config) {
  const selected = [];
  const exclusions = [];
  const stableIds = new Set();
  const selector = config.selector;
  for (const binding of descriptor.bindings) {
    assert.ok(
      Number.isInteger(binding.stableId) && binding.stableId >= 0 && binding.stableId <= 0xffffffff,
      `${binding.id} has an invalid source-generated stable ID`,
    );
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
        resultCodec: binding.resultCodec,
      });
      continue;
    }
    assert.ok(
      selector.operationTemplates.includes(binding.operation?.template),
      `${binding.id} uses an unreviewed operation template`,
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
        wrapper: `vmath${pascalCase(member)}${suffix}`,
      };
    });
    assert.equal(
      new Set(shapes.map(({ cFunction }) => cFunction)).size,
      shapes.length,
      `${binding.id} generates duplicate C functions`,
    );
    selected.push({ ...binding, shapes });
  }
  return { selected, exclusions };
}

function validateCoverage(descriptor, selected, exclusions, config) {
  const coverage = {
    descriptorBindings: descriptor.bindings.length,
    scopedVmathBindings: descriptor.bindings.filter((binding) => binding.id.startsWith(config.selector.idPrefix))
      .length,
    includedBindings: selected.length,
    includedCallShapes: selected.reduce((count, binding) => count + binding.shapes.length, 0),
    structuredResultExclusions: exclusions.filter((entry) => entry.reason.includes("aggregate-return")).length,
    outOfScopeBindings: exclusions.filter((entry) => entry.reason === "out-of-scope-non-vmath").length,
  };
  assert.equal(selected.length + exclusions.length, descriptor.bindings.length, "Classification is not exhaustive");
  assert.equal(
    coverage.scopedVmathBindings,
    coverage.includedBindings + coverage.structuredResultExclusions,
    "Every scoped vmath binding must be emitted or structurally excluded",
  );
  assert.equal(
    coverage.outOfScopeBindings + coverage.scopedVmathBindings,
    coverage.descriptorBindings,
    "The vmath selector must partition the complete descriptor",
  );
  return coverage;
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

export async function run(argv = process.argv) {
  const options = parseArguments(argv);
  const [descriptorRaw, configRaw] = await Promise.all([
    readFile(options.descriptor, "utf8"),
    readFile(options.config, "utf8"),
  ]);
  const descriptor = JSON.parse(descriptorRaw);
  const config = JSON.parse(configRaw);
  assertDescriptor(descriptor, config);
  const { selected, exclusions } = classify(descriptor, config);
  const coverage = validateCoverage(descriptor, selected, exclusions, config);
  const factsObject = {
    schemaVersion: 1,
    bindings: selected.map(({ id, stableId, shapes }) => ({ id, stableId, shapes })),
  };
  const facts = `${JSON.stringify(factsObject, null, 2)}\n`;
  const header = renderStaticHermesVmathHeader(factsObject);
  const source = renderStaticHermesVmathSource(factsObject);
  const typescript = renderStaticHermesVmathTypescript(factsObject);
  const report = `${JSON.stringify(
    {
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
        context: "none",
      },
      failurePolicy:
        "The native scalar ABI returns quiet NaN for dispatch errors, including the engine-defined vmath.project zero-target error. Every generated sound-typed wrapper detects result !== result and throws a stable route/shape string. This also rejects any otherwise successful operation that produces NaN from infinities; the scalar ABI cannot distinguish those cases without a status aggregate or caller-owned output pointer.",
      allocationClaim:
        "The successful generated C ABI shim and wrapper path uses only scalar parameters, fixed stack arrays, and ScriptCallFrame dispatch; it performs no explicit heap allocation. The exceptional wrapper path is not included in the zero-allocation claim. Engine math implementations may change independently.",
      included: selected.map((binding) => ({
        id: binding.id,
        stableId: binding.stableId,
        stableIdHex: `0x${hex32(binding.stableId)}`,
        operationTemplate: binding.operation.template,
        resultCodec: binding.resultCodec,
        shapes: binding.shapes,
      })),
      exclusions,
      generatedSha256: {
        header: sha256(header),
        source: sha256(source),
        typescript: sha256(typescript),
      },
    },
    null,
    2,
  )}\n`;

  await Promise.all([
    writeOrCheck(path.join(options.outputRoot, relativeOutputs.report), report, options.check),
    writeOrCheck(path.join(options.outputRoot, relativeOutputs.facts), facts, options.check),
    writeOrCheck(path.join(options.outputRoot, relativeOutputs.header), header, options.check),
    writeOrCheck(path.join(options.outputRoot, relativeOutputs.source), source, options.check),
    writeOrCheck(path.join(options.outputRoot, relativeOutputs.typescript), typescript, options.check),
  ]);

  console.log(
    `Static Hermes vmath bridge: ${coverage.includedBindings} bindings / ${coverage.includedCallShapes} shapes generated; ${coverage.structuredResultExclusions} structured-result vmath routes excluded`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
