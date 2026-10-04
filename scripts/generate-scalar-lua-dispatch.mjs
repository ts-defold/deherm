import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { renderScriptScalarArtifacts } from "../packages/compiler/src/script-scalar-output-emitter.mjs";
import { hexBindingId as hex32, stableBindingId as fnv1a32 } from "./lib/binding-identity.mjs";
import { loadScriptSemanticOverrides } from "./lib/script-semantic-overrides.mjs";
import { expectReviewedCount } from "./lib/reviewed-revision.mjs";

const root = new URL("../", import.meta.url);
const patternsUrl = new URL("packages/bindings/generated/defold-script-binding-patterns.json", root);
const irUrl = new URL("packages/bindings/generated/defold-script-api-ir.json", root);
const registrationGateUrl = new URL("packages/bindings/generated/defold-lua-registration-gate.json", root);
const reportUrl = new URL("packages/bindings/generated/defold-script-scalar-dispatch.json", root);
const headerUrl = new URL("defold/defold_hermes/include/defold_hermes/generated_scalar_lua_ids.hpp", root);
const sourceUrl = new URL("defold/defold_hermes/src/generated_scalar_lua_descriptors.cpp", root);

function pascal(value) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

function typeRegistry(ir) {
  return new Map(ir.types.map((type) => [type.name, type]));
}

function splitUnion(rawType) {
  return String(rawType)
    .split("|")
    .map((part) => part.trim());
}

function resolveCodec(rawType, registry, seen = new Set()) {
  const parts = splitUnion(rawType);
  const nullable = parts.includes("nil");
  const concrete = parts.filter((part) => part !== "nil");
  if (concrete.length !== 1) throw new Error(`Scalar codec cannot lower ${rawType}`);
  const type = concrete[0];
  if (type === "boolean") return { codec: "Boolean", nullable };
  if (type === "integer") return { codec: "Integer", nullable };
  if (type === "number") return { codec: "Number", nullable };
  if (type === "string") return { codec: "String", nullable };
  const definition = registry.get(type);
  if (!definition) throw new Error(`Unknown scalar type ${type}`);
  if (definition.kind === "enum" || (definition.rawType ?? "").startsWith("defold_enum.")) {
    return { codec: "Integer", nullable };
  }
  if (definition.kind === "alias" && !seen.has(type)) {
    return resolveCodec(definition.rawType, registry, new Set([...seen, type]));
  }
  throw new Error(`Unsupported scalar type ${type}`);
}

function runtimeLookups(gate, defoldRevision) {
  if (gate.defoldRevision !== defoldRevision) {
    throw new Error("Lua registration gate revision is stale against the script IR");
  }
  const result = new Map();
  for (const finding of gate.findings ?? []) {
    if (finding.action !== "use-registered-name") continue;
    if (typeof finding.route !== "string" || typeof finding.callableAs !== "string") {
      throw new Error("Lua registration name correction must name both route and callableAs");
    }
    if (result.has(finding.route)) throw new Error(`Duplicate Lua registration name correction for ${finding.route}`);
    const segments = finding.callableAs.split(".");
    const member = segments.pop();
    if (!member || segments.length === 0) {
      throw new Error(`${finding.route}: registered-name correction is not a qualified Lua route`);
    }
    result.set(finding.route, { modulePath: segments.join("."), member });
  }
  return result;
}

function makeOutputs(patternsText, irText, registrationGateText, validatedOverrides) {
  const patterns = JSON.parse(patternsText);
  const ir = JSON.parse(irText);
  const registrationGate = JSON.parse(registrationGateText);
  const correctedLookups = runtimeLookups(registrationGate, ir.defoldRevision);
  const functions = new Map(ir.functions.map((entry) => [entry.id, entry]));
  const registry = typeRegistry(ir);
  const ids = new Map();
  const usedOverrides = new Set();
  const bindings = patterns.bindings
    .filter((entry) => entry.loweringFamily === "scalar")
    .map((pattern) => {
      const fn = functions.get(pattern.id);
      if (!fn) throw new Error(`Missing script IR function ${pattern.id}`);
      const stableId = fnv1a32(pattern.id);
      const collision = ids.get(stableId);
      if (collision) throw new Error(`FNV-1a collision ${hex32(stableId)}: ${collision} and ${pattern.id}`);
      ids.set(stableId, pattern.id);
      const override = validatedOverrides.get(pattern.id);
      if (override) usedOverrides.add(pattern.id);
      const lookup = correctedLookups.get(fn.rawName) ?? {
        modulePath: fn.modulePath.join("."),
        member: fn.member,
      };
      const parameters = fn.parameters.map((parameter) => {
        const lowered = resolveCodec(parameter.rawType, registry);
        if (lowered.nullable) throw new Error(`Nullable scalar input needs an explicit policy: ${pattern.id}`);
        return {
          name: parameter.rawName,
          rawType: parameter.rawType,
          codec: lowered.codec,
          optional: override?.parameterOptional?.[parameter.rawName] ?? parameter.optional,
        };
      });
      const firstOptional = parameters.findIndex((parameter) => parameter.optional);
      if (firstOptional >= 0 && parameters.slice(firstOptional).some((parameter) => !parameter.optional)) {
        throw new Error(`Non-suffix optional parameters need an explicit call-shape policy: ${pattern.id}`);
      }
      if (fn.returns.length > 1) throw new Error(`Scalar binding has multiple results: ${pattern.id}`);
      const result =
        fn.returns.length === 0
          ? { codec: "None", nullable: false, rawType: null }
          : { ...resolveCodec(fn.returns[0], registry), rawType: fn.returns[0] };
      return {
        id: pattern.id,
        stableId,
        enumName: pascal(fn.rawName),
        rawName: fn.rawName,
        modulePath: lookup.modulePath,
        member: lookup.member,
        source: fn.source,
        line: fn.line,
        parameters,
        requiredArgumentCount: firstOptional < 0 ? parameters.length : firstOptional,
        maximumArgumentCount: parameters.length,
        result,
        semanticOverride: override?.evidence ?? null,
        executableStatus: "stable-ID runtime dispatch enabled; per-function engine-context conformance not claimed",
      };
    })
    .sort((left, right) => left.stableId - right.stableId);

  // 90 is the count at the revision this generator was written against. In an
  // ordinary generation a different number is a regression; in a declared
  // derivation it is what that revision has - 1.13.1 has 117 - and is reported.
  expectReviewedCount({
    input: "scripts/generate-scalar-lua-dispatch.mjs",
    label: "scalar bindings",
    expected: 90,
    observed: bindings.length,
  });
  for (const id of validatedOverrides.keys()) {
    if (!usedOverrides.has(id)) throw new Error(`Semantic override does not match an emitted scalar binding: ${id}`);
  }
  const duplicateNames = new Set();
  for (const binding of bindings) {
    if (duplicateNames.has(binding.enumName)) throw new Error(`Duplicate generated enum name ${binding.enumName}`);
    duplicateNames.add(binding.enumName);
  }
  const argumentsFlat = bindings.flatMap((binding) => binding.parameters);
  const maxArguments = Math.max(...bindings.map((binding) => binding.maximumArgumentCount));
  const overrideEvidence = [...validatedOverrides.entries()];
  const inputHash = createHash("sha256")
    .update(patternsText)
    .update("\0")
    .update(irText)
    .update("\0")
    .update(registrationGateText)
    .update("\0")
    .update(JSON.stringify(overrideEvidence))
    .digest("hex");
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    inputSha256: inputHash,
    stableIdAlgorithm: "FNV-1a 32-bit over canonical script:<module>.<member> id; collisions fail generation",
    coverageClaim:
      "Stable-ID runtime dispatch is installed for all 90 scalar-classified functions; representative mock execution is proven, but per-function real-engine conformance is not claimed.",
    allocationClaim:
      "Generated tables and native dispatch use fixed storage. Lua may allocate while interning new strings, formatting errors, or inside called engine functions.",
    bindingCount: bindings.length,
    argumentCodecCount: argumentsFlat.length,
    maxArgumentCount: maxArguments,
    semanticOverrideCount: bindings.filter((binding) => binding.semanticOverride).length,
    bindings,
  };

  return { report: `${JSON.stringify(report, null, 2)}\n`, ...renderScriptScalarArtifacts(report) };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const [patternsText, irText, registrationGateText] = await Promise.all([
    readFile(patternsUrl, "utf8"),
    readFile(irUrl, "utf8"),
    readFile(registrationGateUrl, "utf8"),
  ]);
  const validatedOverrides = await loadScriptSemanticOverrides(root);
  const outputs = makeOutputs(patternsText, irText, registrationGateText, validatedOverrides);
  const targets = [
    [reportUrl, outputs.report],
    [headerUrl, outputs.header],
    [sourceUrl, outputs.source],
  ];
  if (check) {
    for (const [url, expected] of targets) {
      const actual = await readFile(url, "utf8");
      if (actual !== expected) throw new Error(`${url.pathname} is stale`);
    }
  } else {
    await Promise.all(targets.map(([url, contents]) => writeFile(url, contents)));
  }
  console.log(`${check ? "Verified" : "Generated"} 90 stable scalar Lua descriptors.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
