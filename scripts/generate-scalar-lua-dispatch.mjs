import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  hexBindingId as hex32,
  stableBindingId as fnv1a32
} from "./lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);
const patternsUrl = new URL("bindings/generated/defold-script-binding-patterns.json", root);
const irUrl = new URL("bindings/generated/defold-script-api-ir.json", root);
const reportUrl = new URL("bindings/generated/defold-script-scalar-dispatch.json", root);
const headerUrl = new URL("defold/defold_hermes/include/defold_hermes/generated_scalar_lua_ids.hpp", root);
const sourceUrl = new URL("defold/defold_hermes/src/generated_scalar_lua_descriptors.cpp", root);

// Source-validated exceptions to the imported reference metadata. Keep these
// narrow, evidenced, and visible in the generated report rather than silently
// teaching heuristics to guess intent from prose.
const semanticOverrides = new Map([
  ["script:bit.tohex", {
    parameterOptional: { n: true },
    evidence: {
      source: "engine/script/src/bitop/bitop.c",
      line: 128,
      claim: "The second argument is optional and defaults to 8.",
      observed: "lua_isnone(L, 2) ? 8 : (SBits)barg(L, 2)"
    }
  }]
]);

async function validateSemanticOverrides() {
  const validated = new Map();
  for (const [id, override] of semanticOverrides) {
    const sourceUrl = new URL(`upstream/defold/${override.evidence.source}`, root);
    const contents = await readFile(sourceUrl, "utf8");
    const line = contents.split(/\r?\n/)[override.evidence.line - 1] ?? "";
    if (!line.includes(override.evidence.observed)) {
      throw new Error(`Semantic override evidence is stale for ${id} at ${override.evidence.source}:${override.evidence.line}`);
    }
    validated.set(id, {
      ...override,
      evidence: {
        ...override.evidence,
        sourceSha256: createHash("sha256").update(contents).digest("hex")
      }
    });
  }
  return validated;
}

function pascal(value) {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
}

function typeRegistry(ir) {
  return new Map(ir.types.map((type) => [type.name, type]));
}

function splitUnion(rawType) {
  return String(rawType).split("|").map((part) => part.trim());
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
  if (definition.kind === "enum" || /^defold_enum\./.test(definition.rawType ?? "")) {
    return { codec: "Integer", nullable };
  }
  if (definition.kind === "alias" && !seen.has(type)) {
    return resolveCodec(definition.rawType, registry, new Set([...seen, type]));
  }
  throw new Error(`Unsupported scalar type ${type}`);
}

function cppString(value) {
  return JSON.stringify(value);
}

function makeOutputs(patternsText, irText, validatedOverrides) {
  const patterns = JSON.parse(patternsText);
  const ir = JSON.parse(irText);
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
      const parameters = fn.parameters.map((parameter) => {
        const lowered = resolveCodec(parameter.rawType, registry);
        if (lowered.nullable) throw new Error(`Nullable scalar input needs an explicit policy: ${pattern.id}`);
        return {
          name: parameter.rawName,
          rawType: parameter.rawType,
          codec: lowered.codec,
          optional: override?.parameterOptional?.[parameter.rawName] ?? parameter.optional
        };
      });
      const firstOptional = parameters.findIndex((parameter) => parameter.optional);
      if (firstOptional >= 0 && parameters.slice(firstOptional).some((parameter) => !parameter.optional)) {
        throw new Error(`Non-suffix optional parameters need an explicit call-shape policy: ${pattern.id}`);
      }
      if (fn.returns.length > 1) throw new Error(`Scalar binding has multiple results: ${pattern.id}`);
      const result = fn.returns.length === 0
        ? { codec: "None", nullable: false, rawType: null }
        : { ...resolveCodec(fn.returns[0], registry), rawType: fn.returns[0] };
      return {
        id: pattern.id,
        stableId,
        enumName: pascal(fn.rawName),
        rawName: fn.rawName,
        modulePath: fn.modulePath.join("."),
        member: fn.member,
        source: fn.source,
        line: fn.line,
        parameters,
        requiredArgumentCount: firstOptional < 0 ? parameters.length : firstOptional,
        maximumArgumentCount: parameters.length,
        result,
        semanticOverride: override?.evidence ?? null,
        executableStatus: "descriptor-generated; engine-context execution not claimed"
      };
    })
    .sort((left, right) => left.stableId - right.stableId);

  if (bindings.length !== 90) throw new Error(`Expected 90 scalar bindings, got ${bindings.length}`);
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
    .update(patternsText).update("\0").update(irText).update("\0")
    .update(JSON.stringify(overrideEvidence)).digest("hex");
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    inputSha256: inputHash,
    stableIdAlgorithm: "FNV-1a 32-bit over canonical script:<module>.<member> id; collisions fail generation",
    coverageClaim: "Descriptors for all 90 scalar-classified functions; only the generic codec and mock representatives are executable in this slice.",
    allocationClaim: "Generated tables and native dispatch use fixed storage. Lua may allocate while interning new strings, formatting errors, or inside called engine functions.",
    bindingCount: bindings.length,
    argumentCodecCount: argumentsFlat.length,
    maxArgumentCount: maxArguments,
    semanticOverrideCount: bindings.filter((binding) => binding.semanticOverride).length,
    bindings
  };

  const header = `// Generated by scripts/generate-scalar-lua-dispatch.mjs. Do not edit.\n#pragma once\n\n#include <cstddef>\n#include <cstdint>\n\nnamespace defold_hermes::lua_bridge::scalar::generated {\n\ninline constexpr size_t kBindingCount = ${bindings.length};\ninline constexpr size_t kArgumentCodecCount = ${argumentsFlat.length};\ninline constexpr size_t kMaxArgumentCount = ${maxArguments};\n\nenum class BindingId : uint32_t {\n${bindings.map((binding) => `  ${binding.enumName} = ${hex32(binding.stableId)},`).join("\n")}\n};\n\n}  // namespace defold_hermes::lua_bridge::scalar::generated\n`;

  let argumentOffset = 0;
  const offsets = [0];
  for (const binding of bindings) {
    argumentOffset += binding.parameters.length;
    offsets.push(argumentOffset);
  }
  const source = `// Generated by scripts/generate-scalar-lua-dispatch.mjs. Do not edit.\n#include <defold_hermes/scalar_lua_dispatch.hpp>\n\nnamespace defold_hermes::lua_bridge::scalar::generated {\nnamespace {\nconstexpr uint32_t kStableIds[] = {\n${bindings.map((binding) => `  ${hex32(binding.stableId)},  // ${binding.id}`).join("\n")}\n};\nconstexpr const char* kCanonicalIds[] = {\n${bindings.map((binding) => `  ${cppString(binding.id)},`).join("\n")}\n};\nconstexpr const char* kModulePaths[] = {\n${bindings.map((binding) => `  ${cppString(binding.modulePath)},`).join("\n")}\n};\nconstexpr const char* kMembers[] = {\n${bindings.map((binding) => `  ${cppString(binding.member)},`).join("\n")}\n};\nconstexpr uint16_t kArgumentOffsets[] = {\n  ${offsets.join(", ")}\n};\nconstexpr ScalarCodec kArgumentCodecs[] = {\n${argumentsFlat.map((argument) => `  ScalarCodec::k${argument.codec},`).join("\n")}\n};\nconstexpr uint8_t kArgumentOptional[] = {\n  ${argumentsFlat.map((argument) => argument.optional ? 1 : 0).join(", ")}\n};\nconstexpr uint8_t kRequiredArgumentCounts[] = {\n  ${bindings.map((binding) => binding.requiredArgumentCount).join(", ")}\n};\nconstexpr uint8_t kMaximumArgumentCounts[] = {\n  ${bindings.map((binding) => binding.maximumArgumentCount).join(", ")}\n};\nconstexpr ScalarCodec kResultCodecs[] = {\n${bindings.map((binding) => `  ScalarCodec::k${binding.result.codec},`).join("\n")}\n};\nconstexpr uint8_t kResultNullable[] = {\n  ${bindings.map((binding) => binding.result.nullable ? 1 : 0).join(", ")}\n};\nconstexpr ScalarBindingTables kTables{\n  kBindingCount, kArgumentCodecCount, kStableIds, kCanonicalIds, kModulePaths, kMembers,\n  kArgumentOffsets, kArgumentCodecs, kArgumentOptional, kRequiredArgumentCounts,\n  kMaximumArgumentCounts, kResultCodecs, kResultNullable\n};\n}  // namespace\n\nconst ScalarBindingTables& tables() noexcept { return kTables; }\n\n}  // namespace defold_hermes::lua_bridge::scalar::generated\n`;
  return { report: `${JSON.stringify(report, null, 2)}\n`, header, source };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const [patternsText, irText] = await Promise.all([
    readFile(patternsUrl, "utf8"),
    readFile(irUrl, "utf8")
  ]);
  const validatedOverrides = await validateSemanticOverrides();
  const outputs = makeOutputs(patternsText, irText, validatedOverrides);
  const targets = [
    [reportUrl, outputs.report],
    [headerUrl, outputs.header],
    [sourceUrl, outputs.source]
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
