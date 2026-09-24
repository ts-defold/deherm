// The single ownership registry for the generated Defold script surface.
// Every generator wave must register its implementation, pinned inputs,
// generated artifacts, and execution order here before accounting may promote it.

export const scriptGeneratorSources = Object.freeze([
  "scripts/import-defold-script-api.py",
  "scripts/generate-script-sdk-semantics.mjs",
  "scripts/generate-script-sdk.mjs",
  "scripts/generate-component-proxy-contract.mjs",
  "scripts/lib/defold-constant-values.mjs",
  "packages/compiler/src/sdk/script-sdk.mjs",
  "scripts/classify-script-bindings.mjs",
  "scripts/generate-script-binding-descriptors.mjs",
  "scripts/generate-script-callback-lifecycle.mjs",
  "scripts/generate-scalar-lua-dispatch.mjs",
  "scripts/generate-script-value-bindings.mjs",
  "scripts/generate-script-fixed-tuples.mjs",
  "scripts/generate-script-dynamic-values.mjs",
  "scripts/generate-script-defold-value-tail.mjs",
  "scripts/generate-script-overload-dispatch.mjs",
  "scripts/generate-script-table-record-bindings.mjs",
  "scripts/generate-defold-value-layouts.mjs",
  "scripts/generate-script-universal-value-bindings.mjs",
  "scripts/generate-typed-native-bridge.mjs",
  "scripts/generate-script-copied-value-record-blockers.mjs",
  "scripts/generate-script-opaque-record-blockers.mjs",
  "scripts/generate-static-hermes-vmath.mjs",
  "scripts/generate-script-real-engine-probes.mjs",
  "scripts/generate-script-value-real-engine-probes.mjs",
  "scripts/generate-script-api-accounting.mjs",
  "scripts/generate-script-special-call-verification.mjs",
  "scripts/generate-borrowed-handle-classification.mjs",
  "scripts/generate-script-table-tuple-schemas.mjs",
  "scripts/generate-script-url-address-classification.mjs",
  "scripts/generate-script-real-engine-matrix.mjs",
  "scripts/generate-script-route-availability-profiles.mjs",
  "scripts/generate-script-projection-ir.mjs",
  "scripts/generate-script-handle-lowering.mjs",
  "scripts/generate-script-recording-engine.mjs",
  "scripts/generate-script-runtime.mjs",
  "scripts/lib/binding-identity.mjs",
  "packages/compiler/src/binding-identity.mjs",
  "packages/compiler/src/component-proxy-contract.mjs",
  "packages/compiler/src/defold-hash.mjs",
  "packages/compiler/src/script-special-call-verification.mjs",
  "packages/compiler/src/script-recording-engine.mjs",
  "scripts/lib/script-generator-pipeline.mjs",
  "packages/compiler/src/script-public-api-policy.mjs",
  "scripts/lib/script-universal-selection.mjs",
  "scripts/lib/semantic-handle-kinds.mjs",
  "scripts/lib/script-semantic-overrides.mjs",
  "scripts/lib/reviewed-revision.mjs",
  "scripts/lib/revision-audit.mjs",
  "scripts/lib/script-lifecycle-callbacks.mjs",
  "scripts/lib/documented-route-duplication.mjs",
  "packages/compiler/src/names.mjs"
]);

export const scriptPinnedInputs = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "upstream.lock",
  "upstream/ref-doc.zip",
  "upstream/defold/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/pipeline/ScriptBuilders.java",
  "packages/bindings/lua-compat.json",
  "packages/bindings/modules.json",
  "packages/bindings/overrides/script-api-semantic-overrides.json",
  "packages/bindings/overrides/script-borrowed-handle-classification.json",
  "packages/bindings/overrides/script-callback-lifecycle-policies.json",
  "packages/bindings/overrides/script-defold-handle-bindings.json",
  "packages/bindings/overrides/script-defold-value-bindings.json",
  "packages/bindings/overrides/script-defold-value-tail-bindings.json",
  "packages/bindings/overrides/script-dynamic-value-bindings.json",
  "packages/bindings/overrides/script-overload-dispatch.json",
  "packages/bindings/overrides/script-table-record-bindings.json",
  "packages/bindings/overrides/defold-value-layouts.json",
  "packages/bindings/overrides/script-universal-value-bindings.json",
  "packages/bindings/overrides/script-copied-value-record-blockers.json",
  "packages/bindings/overrides/script-opaque-record-blockers.json",
  "packages/bindings/overrides/script-fixed-tuple-registrations.json",
  "packages/bindings/overrides/script-factory-structured-bindings.json",
  "packages/bindings/overrides/script-go-current-instance-bindings.json",
  "packages/bindings/overrides/script-gui-structured-bindings.json",
  "packages/bindings/overrides/script-msg-structured-bindings.json",
  "packages/bindings/overrides/script-table-tuple-schema-overrides.json",
  "packages/bindings/overrides/script-url-address-classification.json",
  "packages/bindings/overrides/script-route-availability-profiles.json",
  "packages/bindings/overrides/script-handle-lowering-policy.json",
  "packages/bindings/overrides/static-hermes-vmath.json",
  "defold/defold_hermes/include/defold_hermes/script_bridge_capi.hpp",
  "packages/bindings/probes/defold-script-real-engine-matrix.json",
  "packages/bindings/probes/defold-script-real-engine-probes.json",
  "packages/bindings/probes/defold-script-value-real-engine-probes.json",
  // The canonical lowering plan is an immutable declared authority with its own
  // deep-check gate. The recording engine joins it by exact route identity and
  // records any byte-level drift against the plan's own declared input hashes.
  "packages/bindings/generated/defold-binding-lowering-plan.json",
  // The Lua registration gate is owned by `luaRegistrationSurfaceGenerator`,
  // whose inputs are a whole source tree and so cannot join this clean room. Its
  // output is one enumerable file, which the projection IR reads as a declared
  // authority the same way it reads the lowering plan: source-derived findings
  // about which documented routes are callable and which documented slots the C
  // body refuses to default.
  "packages/bindings/generated/defold-lua-registration-gate.json",
  "packages/bindings/generated/defold-lua-registration-surface.json"
]);

export const generatedScriptArtifacts = Object.freeze([
  "packages/bindings/generated/defold-script-api-inventory.json",
  ".agents/docs/research/script-api-coverage.md",
  "packages/bindings/generated/defold-script-api-ir.json",
  "packages/bindings/generated/defold-script-constant-lowering.json",
  "packages/bindings/generated/defold-script-sdk-documentation.json",
  "packages/bindings/generated/defold-component-proxy-contract.json",
  "packages/sdk/src/generated/script/types.ts",
  "packages/sdk/src/generated/script/modules.ts",
  "packages/sdk/src/generated/script/runtime.ts",
  "packages/sdk/src/generated/script/index.ts",
  "packages/bindings/generated/defold-script-binding-patterns.json",
  "packages/bindings/generated/defold-script-binding-descriptors.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_binding_descriptors.hpp",
  "packages/bindings/generated/defold-script-callback-lifecycle.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_callback_lifecycle.hpp",
  "defold/defold_hermes/src/generated_script_callback_lifecycle.cpp",
  "packages/sdk/src/generated/script/callback-lifecycle.ts",
  "packages/bindings/generated/defold-script-scalar-dispatch.json",
  "defold/defold_hermes/include/defold_hermes/generated_scalar_lua_ids.hpp",
  "defold/defold_hermes/src/generated_scalar_lua_descriptors.cpp",
  "packages/bindings/generated/defold-script-value-bindings.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_value_bindings.hpp",
  "defold/defold_hermes/src/generated_script_value_bindings.cpp",
  "packages/sdk/src/generated/script/value-target-support.ts",
  "packages/bindings/generated/defold-static-hermes-vmath.json",
  "defold/defold_hermes/include/defold_hermes/generated_static_hermes_vmath.h",
  "defold/defold_hermes/src/generated_static_hermes_vmath.cpp",
  "packages/static-hermes/src/generated/script-vmath.ts",
  "packages/bindings/generated/defold-script-fixed-tuples.json",
  "packages/bindings/generated/defold-script-fixed-tuple-probes.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_fixed_tuples.hpp",
  "defold/defold_hermes/src/generated_script_fixed_tuples.cpp",
  "packages/sdk/src/generated/script/fixed-tuple-target-support.ts",
  "packages/bindings/generated/defold-script-dynamic-value-bindings.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_dynamic_values.hpp",
  "defold/defold_hermes/src/generated_script_dynamic_values.cpp",
  "packages/sdk/src/generated/script/dynamic-values.ts",
  "packages/bindings/generated/defold-script-value-tail-bindings.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_value_tail_bindings.hpp",
  "defold/defold_hermes/src/generated_script_value_tail_bindings.cpp",
  "packages/sdk/src/generated/script/value-tail-target-support.ts",
  "packages/bindings/generated/defold-script-overload-dispatch.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_overload_dispatch.hpp",
  "defold/defold_hermes/src/generated_script_overload_dispatch.cpp",
  "packages/sdk/src/generated/script/overload-dispatch-target-support.ts",
  "packages/bindings/generated/defold-script-table-record-bindings.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_table_record_bindings.hpp",
  "defold/defold_hermes/src/generated_script_table_record_bindings.cpp",
  "packages/sdk/src/generated/script/table-record-bindings.ts",
  "packages/bindings/generated/defold-value-layouts.json",
  "defold/defold_hermes/include/defold_hermes/generated_defold_value_layout.h",
  "packages/bindings/generated/defold-script-universal-value-bindings.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_bindings.hpp",
  "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp",
  "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_capi.h",
  "defold/defold_hermes/src/generated_script_universal_value_capi.cpp",
  "defold/defold_hermes/include/defold_hermes/generated_script_universal_static_frame.h",
  "defold/defold_hermes/src/generated_script_universal_static_frame.cpp",
  "packages/sdk/src/generated/script/universal-value-bindings.ts",
  "packages/sdk/src/generated/script/browser-target-support.ts",
  "packages/static-hermes/src/generated/script-universal-value.ts",
  "packages/bindings/generated/defold-typed-native-bridge.json",
  "packages/static-hermes/src/generated/script-typed-native-bridge.ts",
  "defold/defold_hermes/lib/web/generated_script_universal_value.js",
  "packages/bindings/generated/defold-script-copied-value-record-blockers.json",
  "packages/sdk/src/generated/script/copied-value-record-blockers.ts",
  "packages/bindings/generated/defold-script-opaque-record-blockers.json",
  "packages/sdk/src/generated/script/opaque-record-blockers.ts",
  "packages/bindings/generated/defold-script-real-engine-probes.json",
  "examples/runtime-smoke/src/generated/script-real-engine-probes.ts",
  "packages/bindings/generated/defold-script-value-real-engine-probes.json",
  "examples/runtime-smoke/src/generated/script-value-real-engine-probes.ts",
  "packages/bindings/generated/defold-script-api-accounting.json",
  "packages/bindings/generated/defold-script-special-call-verification.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_special_call_verification.h",
  "packages/bindings/generated/defold-script-borrowed-handle-classification.json",
  "packages/bindings/generated/defold-script-table-tuple-schemas.json",
  ".agents/docs/research/script-table-tuple-schema-classification.md",
  "packages/bindings/generated/defold-script-url-address-classification.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_url_bindings.hpp",
  "defold/defold_hermes/src/generated_script_url_bindings.cpp",
  "packages/sdk/src/generated/script/url-target-support.ts",
  "packages/bindings/generated/defold-script-real-engine-matrix.json",
  "packages/bindings/generated/defold-script-route-availability-profiles.json",
  "packages/bindings/generated/defold-script-projection-ir.json",
  "packages/bindings/generated/defold-script-handle-lowering.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_handle_kinds.hpp",
  "defold/defold_hermes/include/defold_hermes/generated_script_handle_lowering.hpp",
  "defold/defold_hermes/src/generated_script_handle_lowering.cpp",
  "packages/sdk/src/generated/script/handle-lowering.ts",
  "packages/bindings/generated/defold-script-recording-engine.json",
  "tests/fixtures/generated_script_recording_engine.h",
  "tests/fixtures/generated_script_recording_tables.cpp",
  "tests/fixtures/generated_script_recording_provider.cpp",
  "tests/fixtures/generated_script_recording_lua_adapter.cpp",
  "tests/fixtures/generated_script_recording_native_pod_driver.cpp",
  "tests/fixtures/generated_script_recording_native_pod_driver.js",
  "tests/fixtures/generated_script_recording_browser_callback_driver.cpp",
  "tests/fixtures/generated_script_recording_browser_callback_driver.js",
  "tests/fixtures/generated_script_recording_driver.cpp",
  "tests/fixtures/generated_script_recording_driver.js",
  "tests/fixtures/generated_script_recording_expected_trace.txt"
]);

export const scriptGenerationSteps = Object.freeze([
  Object.freeze({ runtime: "python3", script: "scripts/import-defold-script-api.py" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-sdk-semantics.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-component-proxy-contract.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/classify-script-bindings.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-binding-descriptors.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-callback-lifecycle.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-scalar-lua-dispatch.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-value-bindings.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-overload-dispatch.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-static-hermes-vmath.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-fixed-tuples.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-dynamic-values.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-url-address-classification.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-defold-value-tail.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-real-engine-probes.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-value-real-engine-probes.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-api-accounting.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-special-call-verification.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-borrowed-handle-classification.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-table-tuple-schemas.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-table-record-bindings.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-copied-value-record-blockers.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-opaque-record-blockers.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-real-engine-matrix.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-route-availability-profiles.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-sdk.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-projection-ir.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-defold-value-layouts.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-universal-value-bindings.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-typed-native-bridge.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-handle-lowering.mjs" }),
  Object.freeze({ runtime: "node", script: "scripts/generate-script-recording-engine.mjs" })
]);

// Build-directory exact verification is executable evidence, not a committed
// clean-room artifact. Keep its ownership explicit without pretending the
// script clean-room copies and executes this CMake/shermes lane.
export const staticScriptExactVerificationGenerator = Object.freeze({
  sources: Object.freeze([
    "scripts/build-static-script-exact-verification.mjs",
    "scripts/generate-script-universal-value-bindings.mjs",
    "packages/compiler/src/script-static-exact-verification.mjs",
    "packages/compiler/src/script-recording-engine.mjs",
    "native/static_script_exact_test.cpp"
  ]),
  pinnedInputs: Object.freeze([
    "packages/bindings/generated/defold-script-recording-engine.json",
    "packages/bindings/generated/defold-value-layouts.json"
  ]),
  buildOutputs: Object.freeze([
    "static-script-exact.c",
    "static_script_exact_fixture.cpp",
    "static_script_exact_fixture.h",
    "static-script-exact-evidence.json"
  ]),
  execution: Object.freeze({
    cmakeTarget: "defold-hermes-static-script-exact-test",
    packageScript: "test:static-script-exact",
    sanitizerPackageScript: "test:static-script-exact-sanitize"
  })
});

// The Lua-registration ground-truth lane. It derives a target's REGISTERED Lua
// surface from that target's whole C/C++ source tree and diffs it against the
// DECLARED surface, so `.script_api` and reference documentation are treated as
// claims to be checked rather than as inputs to trust.
//
// It follows the ownership conventions above - implementation, pinned inputs,
// generated artifacts, execution order - but owns its own registry rather than
// joining the script graph, because its inputs cannot be enumerated ahead of the
// parse: which files register which Lua names is exactly what it decides. The
// clean-room check copies an enumerated evidence subset into a temporary root,
// which this lane cannot express, so it is verified by `--check` and by
// `tests/lua-registration-surface.test.mjs` instead.
export const luaRegistrationSurfaceGenerator = Object.freeze({
  sources: Object.freeze([
    "scripts/generate-lua-registration-surface.mjs",
    "scripts/lib/lua-c-registration.mjs",
    "scripts/lib/reviewed-revision.mjs",
    "scripts/lib/revision-audit.mjs"
  ]),
  pinnedInputs: Object.freeze([
    "upstream.lock",
    "packages/bindings/overrides/lua-registration-surface-targets.json",
    "packages/bindings/generated/defold-script-api-ir.json"
  ]),
  artifacts: Object.freeze([
    "packages/bindings/generated/defold-lua-registration-surface.json",
    // The gate: the subset of the report backed by positive evidence in C
    // source and agreed by every mutually exclusive engine build variant. It is
    // small and stable on purpose, because the script graph consumes it.
    "packages/bindings/generated/defold-lua-registration-gate.json"
  ]),
  steps: Object.freeze([
    Object.freeze({ runtime: "node", script: "scripts/generate-lua-registration-surface.mjs" })
  ]),
  // Every target's sources are discovered from its declared root or archive
  // rather than listed, so the source tree itself is the pinned evidence.
  sourceTreeEvidence: Object.freeze(["upstream/defold/engine"])
});

// The resource-declaration schema is derived from Bob's own builder annotations
// and the pinned `.proto` files they name, so like the registration surface its
// inputs are a source tree rather than an enumerable file list. It therefore
// owns its artifacts here instead of joining `scriptGenerationSteps`, whose
// clean room copies an enumerated evidence subset.
export const resourceNamespaceGenerator = Object.freeze({
  sources: Object.freeze([
    "scripts/generate-defold-resource-schema.mjs",
    "scripts/generate-script-resource-namespace-classification.mjs"
  ]),
  pinnedInputs: Object.freeze([
    "upstream.lock",
    "packages/bindings/generated/defold-script-api-ir.json"
  ]),
  artifacts: Object.freeze([
    "packages/bindings/generated/defold-resource-declaration-schema.json",
    "packages/bindings/generated/defold-script-resource-namespaces.json"
  ]),
  steps: Object.freeze([
    Object.freeze({ runtime: "node", script: "scripts/generate-defold-resource-schema.mjs" }),
    Object.freeze({ runtime: "node", script: "scripts/generate-script-resource-namespace-classification.mjs" })
  ]),
  sourceTreeEvidence: Object.freeze([
    "upstream/defold/engine",
    "upstream/defold/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/pipeline"
  ])
});

// The layered API policy lane. It assembles one Defold revision's derived
// surface - the script API IR, the dmSDK IR, the route availability profiles,
// the source-derived Lua registration surface and the resource declaration
// schema - into content-addressed per-namespace subtrees, and carries that
// revision's toolchain pins alongside them.
//
// Like `luaRegistrationSurfaceGenerator` and `resourceNamespaceGenerator` it
// owns its artifacts here rather than joining `scriptGenerationSteps`, and for
// the same two reasons in combination:
//
//   * its evidence is a source tree - Defold's `build_tools/sdk.py` and
//     `share/extender/build_input.yml` declare the toolchain pins, and the
//     clean room copies an enumerated evidence subset it cannot express; and
//   * its outputs are CONTENT-ADDRESSED, so their filenames are hashes that are
//     not knowable before the derivation runs. `storeRoot` names the directory
//     they live under; `artifacts` lists only the two files whose paths are
//     fixed. `--check` verifies the store as a closure instead: every object an
//     index entry reaches must exist and hash to its own path, and nothing
//     unreferenced may sit in the store.
export const apiPolicyGenerator = Object.freeze({
  sources: Object.freeze([
    "scripts/generate-api-policy.mjs",
    "packages/generator/src/policy/generate-api-policy.mjs",
    "packages/compiler/src/sdk/script-sdk.mjs",
    "packages/compiler/src/sdk/dmsdk-sdk.mjs",
    "packages/compiler/src/sdk/support-sdk.mjs",
    "packages/compiler/src/api-policy.mjs",
    "packages/compiler/src/policy-surface-materializer.mjs",
    "packages/compiler/src/binding-lowering-plan-recipe.mjs",
    "packages/compiler/src/revision-output-emitter.mjs",
    "packages/compiler/src/dmsdk-universal-static-frame.mjs",
    "packages/compiler/src/defold-toolchain-pins.mjs"
  ]),
  pinnedInputs: Object.freeze([
    "upstream.lock",
    "packages/bindings/policy-site.json",
    "packages/bindings/generated/defold-script-api-ir.json",
    "packages/bindings/generated/defold-script-sdk-documentation.json",
    "packages/bindings/generated/defold-value-layouts.json",
    "packages/bindings/generated/defold-sdk-ir.json",
    "packages/bindings/generated/defold-dmsdk-sdk-documentation.json",
    "packages/bindings/generated/defold-lua-registration-surface.json",
    "packages/bindings/generated/defold-script-route-availability-profiles.json",
    "packages/bindings/generated/defold-resource-declaration-schema.json",
    "packages/bindings/generated/defold-script-scalar-dispatch.json",
    "packages/bindings/generated/defold-script-api-accounting.json",
    "packages/bindings/generated/defold-script-universal-value-bindings.json",
    "packages/bindings/generated/defold-script-handle-lowering.json",
    "packages/bindings/generated/defold-binding-lowering-plan.json",
    "packages/bindings/generated/defold-binding-lowering-plan.sentinel.json",
    "packages/bindings/generated/defold-dmsdk-scalar-thunks.json",
    "packages/bindings/generated/defold-dmsdk-universal-bindings.json",
    "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json",
    "packages/bindings/generated/defold-script-value-bindings.json",
    "packages/bindings/generated/defold-script-url-address-classification.json",
    "packages/sdk/src/generated/script/browser-target-support.ts",
    "packages/sdk/src/generated/script/callback-lifecycle.ts",
    "packages/sdk/src/generated/script/copied-value-record-blockers.ts",
    "packages/sdk/src/generated/script/dynamic-values.ts",
    "packages/sdk/src/generated/script/fixed-tuple-target-support.ts",
    "packages/sdk/src/generated/script/handle-lowering.ts",
    "packages/sdk/src/generated/script/index.ts",
    "packages/sdk/src/generated/script/modules.ts",
    "packages/sdk/src/generated/script/opaque-record-blockers.ts",
    "packages/sdk/src/generated/script/overload-dispatch-target-support.ts",
    "packages/sdk/src/generated/script/runtime.ts",
    "packages/sdk/src/generated/script/table-record-bindings.ts",
    "packages/sdk/src/generated/script/types.ts",
    "packages/sdk/src/generated/script/universal-value-bindings.ts",
    "packages/sdk/src/generated/script/url-target-support.ts",
    "packages/sdk/src/generated/script/value-tail-target-support.ts",
    "packages/sdk/src/generated/script/value-target-support.ts",
    "packages/sdk/src/generated/dmsdk/borrowed-handle.ts",
    "packages/sdk/src/generated/dmsdk/browser-arena.ts",
    "packages/sdk/src/generated/dmsdk/cstring-value.ts",
    "packages/sdk/src/generated/dmsdk/enum-value.ts",
    "packages/sdk/src/generated/dmsdk/index.ts",
    "packages/sdk/src/generated/dmsdk/named-scalar.ts",
    "packages/sdk/src/generated/dmsdk/runtime.ts",
    "packages/sdk/src/generated/dmsdk/scalar.ts",
    "packages/sdk/src/generated/dmsdk/scratch-scalar-out.ts",
    "packages/sdk/src/generated/dmsdk/types.ts",
    "packages/sdk/src/generated/dmsdk/universal.ts"
  ]),
  artifacts: Object.freeze([
    "packages/bindings/generated/defold-api-policy.json",
    "packages/bindings/generated/defold-policy-index.json"
  ]),
  storeRoot: "packages/bindings/generated/policy",
  steps: Object.freeze([
    Object.freeze({ runtime: "node", script: "scripts/generate-api-policy.mjs" })
  ]),
  sourceTreeEvidence: Object.freeze([
    "upstream/defold/build_tools/sdk.py",
    "upstream/defold/share/extender/build_input.yml"
  ])
});
