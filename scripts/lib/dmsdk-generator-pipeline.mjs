// Single ownership and execution-order registry for generated dmSDK runtime glue.
// The Clang-derived SDK IR is a pinned input to this focused lowering pipeline;
// its upstream import pipeline remains independently owned.

export const dmSdkGeneratorSources = Object.freeze([
  "scripts/classify-dmsdk-bindings.mjs",
  "scripts/generate-dmsdk-scalar-thunks.mjs",
  "scripts/generate-dmsdk-abi-shapes.mjs",
  "scripts/generate-dmsdk-named-scalar-bindings.mjs",
  "scripts/generate-dmsdk-enum-value-bindings.mjs",
  "scripts/generate-dmsdk-runtime.mjs",
  "scripts/lib/dmsdk-generator-pipeline.mjs"
]);

export const dmSdkPinnedInputs = Object.freeze([
  "upstream.lock",
  "bindings/generated/defold-sdk-ir.json",
  "bindings/overrides/dmsdk-enum-value-bindings.json",
  "bindings/overrides/dmsdk-named-scalar-policies.json"
]);

export const generatedDmSdkArtifacts = Object.freeze([
  "bindings/generated/defold-dmsdk-binding-patterns.json",
  "bindings/generated/defold-dmsdk-scalar-thunks.json",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_jsi.hpp",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_runtime.h",
  "defold/defold_hermes/lib/web/generated_dmsdk_scalar.js",
  "defold/defold_hermes/src/generated_dmsdk_scalar_endian.cpp",
  "defold/defold_hermes/src/generated_dmsdk_scalar_jsi.cpp",
  "defold/defold_hermes/src/generated_dmsdk_scalar_log.cpp",
  "defold/defold_hermes/src/generated_dmsdk_scalar_profile.cpp",
  "defold/defold_hermes/src/generated_dmsdk_scalar_runtime.cpp",
  "defold/defold_hermes/src/generated_dmsdk_scalar_time.cpp",
  "defold/defold_hermes/src/generated_dmsdk_scalar_trig.cpp",
  "defold/defold_hermes/src/generated_dmsdk_scalar_utf8.cpp",
  "packages/sdk/src/generated/dmsdk/scalar.ts",
  "bindings/generated/defold-dmsdk-abi-shapes.json",
  "bindings/generated/defold-dmsdk-enum-value-bindings.json",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value.h",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_jsi.hpp",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_runtime.h",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_buffer.cpp",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_graphics.cpp",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_jsi.cpp",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_log.cpp",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_runtime.cpp",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_sound.cpp",
  "packages/sdk/src/generated/dmsdk/enum-value.ts",
  "bindings/generated/defold-dmsdk-named-scalar-bindings.json",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar.h",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_jsi.hpp",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_runtime.h",
  "defold/defold_hermes/src/generated_dmsdk_named_scalar_jsi.cpp",
  "defold/defold_hermes/src/generated_dmsdk_named_scalar_runtime.cpp",
  "packages/sdk/src/generated/dmsdk/named-scalar.ts"
]);

// Ordering is part of the contract: later reports hash and consume earlier ones.
export const dmSdkGenerationSteps = Object.freeze([
  Object.freeze({ runtime: "node", script: "scripts/classify-dmsdk-bindings.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-dmsdk-scalar-thunks.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-dmsdk-abi-shapes.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-dmsdk-named-scalar-bindings.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-dmsdk-enum-value-bindings.mjs" })
]);
