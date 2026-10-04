// Package-owned emitters for revision-output files whose implementation is
// stable compiler machinery. Revision policies carry only the semantic inputs
// named by a recipe; they do not carry copies of these source templates.

import {
  generateDmSdkUniversalBrowserLibrary,
  generateDmSdkUniversalHeader,
  generateDmSdkUniversalJsiHeader,
  generateDmSdkUniversalRuntimeSource,
} from "./dmsdk-universal-output-emitter.mjs";
import {
  DMSDK_BORROWED_HANDLE_REVISION_OUTPUT_PATHS,
  renderDmSdkBorrowedHandleOutputs,
} from "./dmsdk-borrowed-handle-output-emitter.mjs";
import { DMSDK_ARENA_CSTRING_OUTPUTS, renderDmSdkArenaCStringOutputs } from "./dmsdk-arena-cstring-output-emitter.mjs";
import { DMSDK_BOUNDED_OUTPUTS, renderDmSdkBoundedOutputs } from "./dmsdk-bounded-output-emitter.mjs";
import {
  DMSDK_CSTRING_VALUE_RECIPE_FACTS_NAME,
  renderDmSdkCStringValueOutputs,
} from "./dmsdk-cstring-value-output-emitter.mjs";
import { DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME, renderDmSdkEnumValueOutputs } from "./dmsdk-enum-value-output-emitter.mjs";
import {
  DMSDK_NAMED_SCALAR_RECIPE_FACTS_NAME,
  renderDmSdkNamedScalarOutputs,
} from "./dmsdk-named-scalar-output-emitter.mjs";
import { DMSDK_SCALAR_RECIPE_FACTS_NAME, renderDmSdkScalarOutputs } from "./dmsdk-scalar-output-emitter.mjs";
import {
  DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS,
  renderDmSdkScratchScalarOutOutputs,
} from "./dmsdk-scratch-scalar-out-output-emitter.mjs";
import { DMSDK_UNIVERSAL_RECIPE_FACTS_NAME } from "./dmsdk-universal-recipe-facts.mjs";
import { DMSDK_HASH_STATE_OUTPUTS, renderDmSdkHashStateOutputs } from "./dmsdk-hash-state-output-emitter.mjs";
import { renderDefoldValueLayoutHeader } from "./defold-value-layout-output-emitter.mjs";
import { generateScriptBindingDescriptors } from "./script-binding-descriptor-generator.mjs";
import { renderScriptHandleLoweringArtifacts } from "./script-handle-lowering-output-emitter.mjs";
import { renderScriptScalarArtifacts } from "./script-scalar-output-emitter.mjs";
import { renderUniversalValueArtifacts } from "./script-universal-value-output-emitter.mjs";
import {
  renderScriptValueBindingOutputs,
  SCRIPT_VALUE_BINDING_RECIPE_FACTS_NAME,
} from "./script-value-binding-output-emitter.mjs";
import {
  GENERATED_MODULE_FACTS,
  GENERATED_MODULE_RECIPE,
  renderGeneratedModuleOutputs,
} from "./generated-module-output-emitter.mjs";
import { renderScriptUrlNativeOutputs } from "./script-url-output-emitter.mjs";
import {
  renderStaticHermesVmathHeader,
  renderStaticHermesVmathSource,
  renderStaticHermesVmathTypescript,
} from "./static-hermes-vmath-output-emitter.mjs";
import {
  renderScriptCallbackLifecycleOutputs,
  SCRIPT_CALLBACK_LIFECYCLE_FACTS,
} from "./script-callback-lifecycle-output-emitter.mjs";
import {
  renderScriptDynamicValuesOutputs,
  SCRIPT_DYNAMIC_VALUES_FACTS,
} from "./script-dynamic-values-output-emitter.mjs";
import { renderScriptFixedTuplesOutputs, SCRIPT_FIXED_TUPLES_FACTS } from "./script-fixed-tuples-output-emitter.mjs";
import {
  renderScriptOverloadDispatchOutputs,
  SCRIPT_OVERLOAD_DISPATCH_FACTS,
} from "./script-overload-dispatch-output-emitter.mjs";
import { renderScriptTableRecordOutputs, SCRIPT_TABLE_RECORD_FACTS } from "./script-table-record-output-emitter.mjs";
import { renderScriptValueTailOutputs, SCRIPT_VALUE_TAIL_FACTS } from "./script-value-tail-output-emitter.mjs";
import { LUA_BRIDGE_FACTS, renderLuaBridgeOutputs } from "./lua-bridge-output-emitter.mjs";
import { renderScriptSpecialCallVerificationHeaderFromReport } from "./script-special-call-verification.mjs";
import { renderDmSdkUniversalJsiSource } from "./dmsdk-universal-jsi-source-emitter.mjs";
import { renderTypescript as renderStaticHermesTypedNativeBridge } from "./static-hermes-typed-native-bridge-output-emitter.mjs";

export const STABLE_OUTPUT_RECIPE = "output.stable-template.render.v1";
export const DMSDK_UNIVERSAL_JSI_HEADER_RECIPE = "output.dmsdk-universal-jsi-header.render.v1";
export const DMSDK_UNIVERSAL_JSI_SOURCE_RECIPE = "output.dmsdk-universal-jsi-source.render.v1";
export const DMSDK_UNIVERSAL_HEADER_RECIPE = "output.dmsdk-universal-header.render.v1";
export const DMSDK_UNIVERSAL_RUNTIME_RECIPE = "output.dmsdk-universal-runtime.render.v1";
export const DMSDK_UNIVERSAL_BROWSER_RECIPE = "output.dmsdk-universal-browser.render.v1";
export const SCRIPT_HANDLE_KINDS_RECIPE = "output.script-handle-kinds.render.v1";
export const SCRIPT_HANDLE_LOWERING_HEADER_RECIPE = "output.script-handle-lowering-header.render.v1";
export const SCRIPT_HANDLE_LOWERING_SOURCE_RECIPE = "output.script-handle-lowering-source.render.v1";
export const SCRIPT_BINDING_DESCRIPTOR_RECIPE = "output.script-binding-descriptor.render.v1";
export const SCRIPT_SCALAR_RECIPE = "output.script-scalar.render.v1";
export const SCRIPT_UNIVERSAL_VALUE_RECIPE = "output.script-universal-value.render.v1";
export const SCRIPT_VALUE_BINDING_RECIPE = "output.script-value-binding.render.v1";
export const DEFOLD_VALUE_LAYOUT_HEADER_RECIPE = "output.defold-value-layout-header.render.v1";
export const DMSDK_BORROWED_HANDLE_RECIPE = "output.dmsdk-borrowed-handle.render.v1";
export const DMSDK_ARENA_CSTRING_RECIPE = "output.dmsdk-arena-cstring.render.v1";
export const DMSDK_BOUNDED_RECIPE = "output.dmsdk-bounded.render.v1";
export const DMSDK_CSTRING_VALUE_RECIPE = "output.dmsdk-cstring-value.render.v1";
export const DMSDK_ENUM_VALUE_RECIPE = "output.dmsdk-enum-value.render.v1";
export const DMSDK_NAMED_SCALAR_RECIPE = "output.dmsdk-named-scalar.render.v1";
export const DMSDK_SCALAR_RECIPE = "output.dmsdk-scalar.render.v1";
export const DMSDK_SCRATCH_SCALAR_OUT_RECIPE = "output.dmsdk-scratch-scalar-out.render.v1";
export const DMSDK_HASH_STATE_RECIPE = "output.dmsdk-hash-state.render.v1";
export const SCRIPT_URL_RECIPE = "output.script-url.render.v1";
export const STATIC_HERMES_VMATH_RECIPE = "output.static-hermes-vmath.render.v1";
export const SCRIPT_CALLBACK_LIFECYCLE_RECIPE = "output.script-callback-lifecycle.render.v1";
export const SCRIPT_DYNAMIC_VALUES_RECIPE = "output.script-dynamic-values.render.v1";
export const SCRIPT_FIXED_TUPLES_RECIPE = "output.script-fixed-tuples.render.v1";
export const SCRIPT_OVERLOAD_DISPATCH_RECIPE = "output.script-overload-dispatch.render.v1";
export const SCRIPT_TABLE_RECORD_RECIPE = "output.script-table-record.render.v1";
export const SCRIPT_VALUE_TAIL_RECIPE = "output.script-value-tail.render.v1";
export const LUA_BRIDGE_RECIPE = "output.lua-bridge.render.v1";
export const SCRIPT_SPECIAL_CALL_VERIFICATION_RECIPE = "output.script-special-call-verification.render.v1";
export const STATIC_HERMES_TYPED_NATIVE_BRIDGE_RECIPE = "output.static-hermes-typed-native-bridge.render.v1";

const SCRIPT_HANDLE_LOWERING_DOCUMENT = "defold-script-handle-lowering.json";
const SCRIPT_IR_DOCUMENT = "defold-script-api-ir.json";
const SCRIPT_BINDING_PATTERNS_DOCUMENT = "defold-script-binding-patterns.json";
const SCRIPT_SCALAR_DOCUMENT = "defold-script-scalar-dispatch.json";
const SCRIPT_UNIVERSAL_VALUE_DOCUMENT = "defold-script-universal-value-bindings.json";
const DEFOLD_VALUE_LAYOUTS_DOCUMENT = "defold-value-layouts.json";
const DMSDK_BORROWED_HANDLE_RECIPE_FACTS_NAME = "defold-dmsdk-borrowed-handle-recipe-facts.json";
const DMSDK_ARENA_CSTRING_RECIPE_FACTS_NAME = "defold-dmsdk-arena-cstring-recipe-facts.json";
const DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_NAME = "defold-dmsdk-scratch-scalar-out-recipe-facts.json";
const DMSDK_HASH_STATE_RECIPE_FACTS_NAME = "defold-dmsdk-hash-state-recipe-facts.json";
const SCRIPT_URL_RECIPE_FACTS_NAME = "defold-script-url-binding-recipe-facts.json";
const STATIC_HERMES_VMATH_RECIPE_FACTS_NAME = "defold-static-hermes-vmath-recipe-facts.json";
const SCRIPT_SPECIAL_CALL_VERIFICATION_DOCUMENT = "defold-script-special-call-verification.json";
const STATIC_HERMES_TYPED_NATIVE_BRIDGE_FACTS = "defold-typed-native-bridge-recipe-facts.json";

const generatedModuleOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_modules.h",
  "defold/defold_hermes/include/defold_hermes/generated_jsi.hpp",
  "defold/defold_hermes/src/generated_jsi.cpp",
  "defold/defold_hermes/lib/web/generated_modules.js",
  "packages/abi/src/generated/layouts.ts",
  "packages/static-hermes/src/generated/ffi.js",
]);
const luaBridgeOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_lua_bridge.hpp",
  "defold/defold_hermes/src/generated_lua_bridge.cpp",
]);
const scriptSpecialCallVerificationOutput =
  "defold/defold_hermes/include/defold_hermes/generated_script_special_call_verification.h";
const staticHermesTypedNativeBridgeOutput = "packages/static-hermes/src/generated/script-typed-native-bridge.ts";
const scriptUrlOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_url_bindings.hpp",
  "defold/defold_hermes/src/generated_script_url_bindings.cpp",
]);
const staticHermesVmathOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_static_hermes_vmath.h",
  "defold/defold_hermes/src/generated_static_hermes_vmath.cpp",
  "packages/static-hermes/src/generated/script-vmath.ts",
]);
const scriptCallbackLifecycleOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_callback_lifecycle.hpp",
  "defold/defold_hermes/src/generated_script_callback_lifecycle.cpp",
]);
const scriptDynamicValuesOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_dynamic_values.hpp",
  "defold/defold_hermes/src/generated_script_dynamic_values.cpp",
]);
const scriptFixedTuplesOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_fixed_tuples.hpp",
  "defold/defold_hermes/src/generated_script_fixed_tuples.cpp",
]);
const scriptOverloadDispatchOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_overload_dispatch.hpp",
  "defold/defold_hermes/src/generated_script_overload_dispatch.cpp",
]);
const scriptTableRecordOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_table_record_bindings.hpp",
  "defold/defold_hermes/src/generated_script_table_record_bindings.cpp",
]);
const scriptValueTailOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_value_tail_bindings.hpp",
  "defold/defold_hermes/src/generated_script_value_tail_bindings.cpp",
]);

const dmsdkBoundedFactsByFamily = Object.freeze({
  "fixed-digest": "defold-dmsdk-fixed-digest-recipe-facts.json",
  "base64-span": "defold-dmsdk-base64-span-recipe-facts.json",
  "astc-probe": "defold-dmsdk-astc-probe-recipe-facts.json",
  "xtea-span": "defold-dmsdk-xtea-span-recipe-facts.json",
  "hash-span": "defold-dmsdk-hash-span-recipe-facts.json",
});
const dmsdkBoundedOutputFacts = Object.freeze(
  Object.fromEntries(
    Object.entries(DMSDK_BOUNDED_OUTPUTS).flatMap(([family, outputs]) =>
      outputs.map((relative) => [relative, dmsdkBoundedFactsByFamily[family]]),
    ),
  ),
);

const dmsdkScalarOutputs = Object.freeze({
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h": "header",
  "defold/defold_hermes/src/generated_dmsdk_scalar_bindings.cpp": "source",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_runtime.h": "runtimeHeader",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_jsi.hpp": "jsiHeader",
  "defold/defold_hermes/src/generated_dmsdk_scalar_runtime.cpp": "runtime",
  "defold/defold_hermes/src/generated_dmsdk_scalar_jsi.cpp": "jsi",
  "defold/defold_hermes/lib/web/generated_dmsdk_scalar.js": "browser",
});
const dmsdkNamedScalarOutputs = Object.freeze({
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar.h": "header",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_runtime.h": "runtimeHeader",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_jsi.hpp": "jsiHeader",
  "defold/defold_hermes/src/generated_dmsdk_named_scalar_jsi.cpp": "jsi",
  "defold/defold_hermes/src/generated_dmsdk_named_scalar_runtime.cpp": "runtime",
});
const dmsdkEnumValueOutputs = Object.freeze({
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value.h": "header",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_runtime.h": "runtimeHeader",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_runtime.cpp": "runtime",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_jsi.cpp": "jsi",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_jsi.hpp": "jsiHeader",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_buffer.cpp": "sources.buffer",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_graphics.cpp": "sources.graphics",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_log.cpp": "sources.log",
  "defold/defold_hermes/src/generated_dmsdk_enum_value_sound.cpp": "sources.sound",
});
const dmsdkCStringValueOutputs = Object.freeze({
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_cstring_value.h": "header",
  "defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp": "runtime",
  "defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp": "native",
  "defold/defold_hermes/src/generated_dmsdk_cstring_value_jsi.cpp": "jsi",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_cstring_value_jsi.hpp": "jsiHeader",
  "defold/defold_hermes/lib/web/generated_dmsdk_cstring_value.js": "browser",
  "packages/static-hermes/src/generated/dmsdk-cstring-value.ts": "staticHermes",
});
const dmsdkScratchScalarOutOutputs = Object.freeze([
  DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.header,
  DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.runtime,
  DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.jsiHeader,
  DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.jsi,
  DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.browser,
  DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.staticHermes,
]);
const dmsdkHashStateRevisionOutputs = Object.freeze([DMSDK_HASH_STATE_OUTPUTS.header, DMSDK_HASH_STATE_OUTPUTS.source]);
const dmsdkArenaCStringRevisionOutputs = Object.freeze([
  DMSDK_ARENA_CSTRING_OUTPUTS.header,
  DMSDK_ARENA_CSTRING_OUTPUTS.production,
]);

const scriptUniversalValueOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_bindings.hpp",
  "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp",
  "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_capi.h",
  "defold/defold_hermes/src/generated_script_universal_value_capi.cpp",
  "defold/defold_hermes/include/defold_hermes/generated_script_universal_static_frame.h",
  "defold/defold_hermes/src/generated_script_universal_static_frame.cpp",
  "packages/static-hermes/src/generated/script-universal-value.ts",
  "defold/defold_hermes/lib/web/generated_script_universal_value.js",
]);
const scriptValueBindingOutputs = Object.freeze([
  "defold/defold_hermes/include/defold_hermes/generated_script_value_bindings.hpp",
  "defold/defold_hermes/src/generated_script_value_bindings.cpp",
]);

export const LOCALLY_RENDERED_OUTPUT_RECIPES = Object.freeze({
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_jsi.hpp": DMSDK_UNIVERSAL_JSI_HEADER_RECIPE,
  "defold/defold_hermes/src/generated_dmsdk_universal_jsi.cpp": DMSDK_UNIVERSAL_JSI_SOURCE_RECIPE,
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal.h": DMSDK_UNIVERSAL_HEADER_RECIPE,
  "defold/defold_hermes/src/generated_dmsdk_universal.cpp": DMSDK_UNIVERSAL_RUNTIME_RECIPE,
  "defold/defold_hermes/lib/web/generated_dmsdk_universal.js": DMSDK_UNIVERSAL_BROWSER_RECIPE,
  "defold/defold_hermes/include/defold_hermes/generated_script_handle_kinds.hpp": SCRIPT_HANDLE_KINDS_RECIPE,
  "defold/defold_hermes/include/defold_hermes/generated_script_handle_lowering.hpp":
    SCRIPT_HANDLE_LOWERING_HEADER_RECIPE,
  "defold/defold_hermes/src/generated_script_handle_lowering.cpp": SCRIPT_HANDLE_LOWERING_SOURCE_RECIPE,
  "defold/defold_hermes/include/defold_hermes/generated_script_binding_descriptors.hpp":
    SCRIPT_BINDING_DESCRIPTOR_RECIPE,
  "defold/defold_hermes/include/defold_hermes/generated_scalar_lua_ids.hpp": SCRIPT_SCALAR_RECIPE,
  "defold/defold_hermes/src/generated_scalar_lua_descriptors.cpp": SCRIPT_SCALAR_RECIPE,
  ...Object.fromEntries(scriptUniversalValueOutputs.map((relative) => [relative, SCRIPT_UNIVERSAL_VALUE_RECIPE])),
  ...Object.fromEntries(scriptValueBindingOutputs.map((relative) => [relative, SCRIPT_VALUE_BINDING_RECIPE])),
  "defold/defold_hermes/include/defold_hermes/generated_defold_value_layout.h": DEFOLD_VALUE_LAYOUT_HEADER_RECIPE,
  ...Object.fromEntries(
    DMSDK_BORROWED_HANDLE_REVISION_OUTPUT_PATHS.map((relative) => [relative, DMSDK_BORROWED_HANDLE_RECIPE]),
  ),
  ...Object.fromEntries(dmsdkArenaCStringRevisionOutputs.map((relative) => [relative, DMSDK_ARENA_CSTRING_RECIPE])),
  ...Object.fromEntries(Object.keys(dmsdkBoundedOutputFacts).map((relative) => [relative, DMSDK_BOUNDED_RECIPE])),
  ...Object.fromEntries(
    Object.keys(dmsdkCStringValueOutputs).map((relative) => [relative, DMSDK_CSTRING_VALUE_RECIPE]),
  ),
  ...Object.fromEntries(Object.keys(dmsdkEnumValueOutputs).map((relative) => [relative, DMSDK_ENUM_VALUE_RECIPE])),
  ...Object.fromEntries(Object.keys(dmsdkNamedScalarOutputs).map((relative) => [relative, DMSDK_NAMED_SCALAR_RECIPE])),
  ...Object.fromEntries(Object.keys(dmsdkScalarOutputs).map((relative) => [relative, DMSDK_SCALAR_RECIPE])),
  ...Object.fromEntries(dmsdkScratchScalarOutOutputs.map((relative) => [relative, DMSDK_SCRATCH_SCALAR_OUT_RECIPE])),
  ...Object.fromEntries(dmsdkHashStateRevisionOutputs.map((relative) => [relative, DMSDK_HASH_STATE_RECIPE])),
  ...Object.fromEntries(generatedModuleOutputs.map((relative) => [relative, GENERATED_MODULE_RECIPE])),
  ...Object.fromEntries(scriptUrlOutputs.map((relative) => [relative, SCRIPT_URL_RECIPE])),
  ...Object.fromEntries(staticHermesVmathOutputs.map((relative) => [relative, STATIC_HERMES_VMATH_RECIPE])),
  ...Object.fromEntries(scriptCallbackLifecycleOutputs.map((relative) => [relative, SCRIPT_CALLBACK_LIFECYCLE_RECIPE])),
  ...Object.fromEntries(scriptDynamicValuesOutputs.map((relative) => [relative, SCRIPT_DYNAMIC_VALUES_RECIPE])),
  ...Object.fromEntries(scriptFixedTuplesOutputs.map((relative) => [relative, SCRIPT_FIXED_TUPLES_RECIPE])),
  ...Object.fromEntries(scriptOverloadDispatchOutputs.map((relative) => [relative, SCRIPT_OVERLOAD_DISPATCH_RECIPE])),
  ...Object.fromEntries(scriptTableRecordOutputs.map((relative) => [relative, SCRIPT_TABLE_RECORD_RECIPE])),
  ...Object.fromEntries(scriptValueTailOutputs.map((relative) => [relative, SCRIPT_VALUE_TAIL_RECIPE])),
  ...Object.fromEntries(luaBridgeOutputs.map((relative) => [relative, LUA_BRIDGE_RECIPE])),
  [scriptSpecialCallVerificationOutput]: SCRIPT_SPECIAL_CALL_VERIFICATION_RECIPE,
  [staticHermesTypedNativeBridgeOutput]: STATIC_HERMES_TYPED_NATIVE_BRIDGE_RECIPE,
});

export const LOCALLY_RENDERED_OUTPUT_INPUTS = Object.freeze({
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_jsi.hpp": Object.freeze([
    DMSDK_UNIVERSAL_RECIPE_FACTS_NAME,
  ]),
  "defold/defold_hermes/src/generated_dmsdk_universal_jsi.cpp": Object.freeze([DMSDK_UNIVERSAL_RECIPE_FACTS_NAME]),
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal.h": Object.freeze([
    DMSDK_UNIVERSAL_RECIPE_FACTS_NAME,
  ]),
  "defold/defold_hermes/src/generated_dmsdk_universal.cpp": Object.freeze([DMSDK_UNIVERSAL_RECIPE_FACTS_NAME]),
  "defold/defold_hermes/lib/web/generated_dmsdk_universal.js": Object.freeze([DMSDK_UNIVERSAL_RECIPE_FACTS_NAME]),
  "defold/defold_hermes/include/defold_hermes/generated_script_handle_kinds.hpp": Object.freeze([
    SCRIPT_HANDLE_LOWERING_DOCUMENT,
  ]),
  "defold/defold_hermes/include/defold_hermes/generated_script_handle_lowering.hpp": Object.freeze([
    SCRIPT_HANDLE_LOWERING_DOCUMENT,
  ]),
  "defold/defold_hermes/src/generated_script_handle_lowering.cpp": Object.freeze([SCRIPT_HANDLE_LOWERING_DOCUMENT]),
  "defold/defold_hermes/include/defold_hermes/generated_script_binding_descriptors.hpp": Object.freeze([
    SCRIPT_IR_DOCUMENT,
    SCRIPT_BINDING_PATTERNS_DOCUMENT,
  ]),
  "defold/defold_hermes/include/defold_hermes/generated_scalar_lua_ids.hpp": Object.freeze([SCRIPT_SCALAR_DOCUMENT]),
  "defold/defold_hermes/src/generated_scalar_lua_descriptors.cpp": Object.freeze([SCRIPT_SCALAR_DOCUMENT]),
  ...Object.fromEntries(
    scriptUniversalValueOutputs.map((relative) => [
      relative,
      Object.freeze([SCRIPT_UNIVERSAL_VALUE_DOCUMENT, DEFOLD_VALUE_LAYOUTS_DOCUMENT]),
    ]),
  ),
  ...Object.fromEntries(
    scriptValueBindingOutputs.map((relative) => [relative, Object.freeze([SCRIPT_VALUE_BINDING_RECIPE_FACTS_NAME])]),
  ),
  "defold/defold_hermes/include/defold_hermes/generated_defold_value_layout.h": Object.freeze([
    DEFOLD_VALUE_LAYOUTS_DOCUMENT,
  ]),
  ...Object.fromEntries(
    DMSDK_BORROWED_HANDLE_REVISION_OUTPUT_PATHS.map((relative) => [
      relative,
      Object.freeze([DMSDK_BORROWED_HANDLE_RECIPE_FACTS_NAME]),
    ]),
  ),
  ...Object.fromEntries(
    dmsdkArenaCStringRevisionOutputs.map((relative) => [
      relative,
      Object.freeze([DMSDK_ARENA_CSTRING_RECIPE_FACTS_NAME]),
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(dmsdkBoundedOutputFacts).map(([relative, facts]) => [relative, Object.freeze([facts])]),
  ),
  ...Object.fromEntries(
    Object.keys(dmsdkCStringValueOutputs).map((relative) => [
      relative,
      Object.freeze([DMSDK_CSTRING_VALUE_RECIPE_FACTS_NAME]),
    ]),
  ),
  ...Object.fromEntries(
    Object.keys(dmsdkEnumValueOutputs).map((relative) => [
      relative,
      Object.freeze([DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME]),
    ]),
  ),
  ...Object.fromEntries(
    Object.keys(dmsdkNamedScalarOutputs).map((relative) => [
      relative,
      Object.freeze([DMSDK_NAMED_SCALAR_RECIPE_FACTS_NAME]),
    ]),
  ),
  ...Object.fromEntries(
    Object.keys(dmsdkScalarOutputs).map((relative) => [relative, Object.freeze([DMSDK_SCALAR_RECIPE_FACTS_NAME])]),
  ),
  ...Object.fromEntries(
    dmsdkScratchScalarOutOutputs.map((relative) => [
      relative,
      Object.freeze([DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_NAME]),
    ]),
  ),
  ...Object.fromEntries(
    dmsdkHashStateRevisionOutputs.map((relative) => [relative, Object.freeze([DMSDK_HASH_STATE_RECIPE_FACTS_NAME])]),
  ),
  ...Object.fromEntries(generatedModuleOutputs.map((relative) => [relative, Object.freeze([GENERATED_MODULE_FACTS])])),
  ...Object.fromEntries(scriptUrlOutputs.map((relative) => [relative, Object.freeze([SCRIPT_URL_RECIPE_FACTS_NAME])])),
  ...Object.fromEntries(
    staticHermesVmathOutputs.map((relative) => [relative, Object.freeze([STATIC_HERMES_VMATH_RECIPE_FACTS_NAME])]),
  ),
  ...Object.fromEntries(
    scriptCallbackLifecycleOutputs.map((relative) => [relative, Object.freeze([SCRIPT_CALLBACK_LIFECYCLE_FACTS])]),
  ),
  ...Object.fromEntries(
    scriptDynamicValuesOutputs.map((relative) => [relative, Object.freeze([SCRIPT_DYNAMIC_VALUES_FACTS])]),
  ),
  ...Object.fromEntries(
    scriptFixedTuplesOutputs.map((relative) => [relative, Object.freeze([SCRIPT_FIXED_TUPLES_FACTS])]),
  ),
  ...Object.fromEntries(
    scriptOverloadDispatchOutputs.map((relative) => [relative, Object.freeze([SCRIPT_OVERLOAD_DISPATCH_FACTS])]),
  ),
  ...Object.fromEntries(
    scriptTableRecordOutputs.map((relative) => [relative, Object.freeze([SCRIPT_TABLE_RECORD_FACTS])]),
  ),
  ...Object.fromEntries(scriptValueTailOutputs.map((relative) => [relative, Object.freeze([SCRIPT_VALUE_TAIL_FACTS])])),
  ...Object.fromEntries(luaBridgeOutputs.map((relative) => [relative, Object.freeze([LUA_BRIDGE_FACTS])])),
  [scriptSpecialCallVerificationOutput]: Object.freeze([SCRIPT_SPECIAL_CALL_VERIFICATION_DOCUMENT]),
  [staticHermesTypedNativeBridgeOutput]: Object.freeze([STATIC_HERMES_TYPED_NATIVE_BRIDGE_FACTS]),
});

export function generateRevisionOutput(relative, recipe, documents) {
  if (recipe === STABLE_OUTPUT_RECIPE) {
    const owningRecipe = LOCALLY_RENDERED_OUTPUT_RECIPES[relative];
    if (typeof owningRecipe !== "string" || owningRecipe === STABLE_OUTPUT_RECIPE) {
      throw new Error(`${relative}: no family emitter owns the legacy stable-template output`);
    }
    return generateRevisionOutput(relative, owningRecipe, documents);
  }
  if (recipe === DMSDK_UNIVERSAL_JSI_HEADER_RECIPE) {
    return generateDmSdkUniversalJsiHeader(documents["defold-dmsdk-universal-bindings.json"]);
  }
  if (recipe === DMSDK_UNIVERSAL_JSI_SOURCE_RECIPE) {
    return renderDmSdkUniversalJsiSource({
      catalogSha256: documents["defold-dmsdk-universal-bindings.json"]?.sourceHashes?.catalog,
    });
  }
  if (recipe === DMSDK_UNIVERSAL_HEADER_RECIPE) {
    return generateDmSdkUniversalHeader(documents["defold-dmsdk-universal-bindings.json"]);
  }
  if (recipe === DMSDK_UNIVERSAL_RUNTIME_RECIPE) {
    return generateDmSdkUniversalRuntimeSource(documents["defold-dmsdk-universal-bindings.json"]);
  }
  if (recipe === DMSDK_UNIVERSAL_BROWSER_RECIPE) {
    return generateDmSdkUniversalBrowserLibrary(documents["defold-dmsdk-universal-bindings.json"]);
  }
  if (
    recipe === SCRIPT_HANDLE_KINDS_RECIPE ||
    recipe === SCRIPT_HANDLE_LOWERING_HEADER_RECIPE ||
    recipe === SCRIPT_HANDLE_LOWERING_SOURCE_RECIPE
  ) {
    const artifacts = renderScriptHandleLoweringArtifacts(documents[SCRIPT_HANDLE_LOWERING_DOCUMENT]);
    if (recipe === SCRIPT_HANDLE_KINDS_RECIPE) return artifacts.kindHeader;
    if (recipe === SCRIPT_HANDLE_LOWERING_HEADER_RECIPE) return artifacts.header;
    return artifacts.source;
  }
  if (recipe === SCRIPT_BINDING_DESCRIPTOR_RECIPE) {
    return generateScriptBindingDescriptors(documents[SCRIPT_IR_DOCUMENT], documents[SCRIPT_BINDING_PATTERNS_DOCUMENT])
      .header;
  }
  if (recipe === SCRIPT_SCALAR_RECIPE) {
    const artifacts = renderScriptScalarArtifacts(documents[SCRIPT_SCALAR_DOCUMENT]);
    if (relative.endsWith("generated_scalar_lua_ids.hpp")) return artifacts.header;
    if (relative.endsWith("generated_scalar_lua_descriptors.cpp")) return artifacts.source;
    throw new Error(`${relative}: no scalar output renderer`);
  }
  if (recipe === SCRIPT_UNIVERSAL_VALUE_RECIPE) {
    const artifacts = renderUniversalValueArtifacts(
      documents[SCRIPT_UNIVERSAL_VALUE_DOCUMENT],
      documents[DEFOLD_VALUE_LAYOUTS_DOCUMENT],
    );
    const key = {
      "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_bindings.hpp": "header",
      "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp": "source",
      "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_capi.h": "cHeader",
      "defold/defold_hermes/src/generated_script_universal_value_capi.cpp": "cSource",
      "defold/defold_hermes/include/defold_hermes/generated_script_universal_static_frame.h": "staticFrameHeader",
      "defold/defold_hermes/src/generated_script_universal_static_frame.cpp": "staticFrameSource",
      "packages/static-hermes/src/generated/script-universal-value.ts": "staticHermes",
      "defold/defold_hermes/lib/web/generated_script_universal_value.js": "browser",
    }[relative];
    if (!key) throw new Error(`${relative}: no universal-value output renderer`);
    return artifacts[key];
  }
  if (recipe === SCRIPT_VALUE_BINDING_RECIPE) {
    const artifacts = renderScriptValueBindingOutputs(documents[SCRIPT_VALUE_BINDING_RECIPE_FACTS_NAME]);
    if (relative.endsWith("generated_script_value_bindings.hpp")) return artifacts.header;
    if (relative.endsWith("generated_script_value_bindings.cpp")) return artifacts.source;
    throw new Error(`${relative}: no script value-binding output renderer`);
  }
  if (recipe === DEFOLD_VALUE_LAYOUT_HEADER_RECIPE) {
    return renderDefoldValueLayoutHeader(documents[DEFOLD_VALUE_LAYOUTS_DOCUMENT]);
  }
  if (recipe === DMSDK_BORROWED_HANDLE_RECIPE) {
    const output = renderDmSdkBorrowedHandleOutputs(documents[DMSDK_BORROWED_HANDLE_RECIPE_FACTS_NAME]).get(relative);
    if (typeof output !== "string") throw new Error(`${relative}: no borrowed-handle output renderer`);
    return output;
  }
  if (recipe === DMSDK_ARENA_CSTRING_RECIPE) {
    const output = renderDmSdkArenaCStringOutputs(documents[DMSDK_ARENA_CSTRING_RECIPE_FACTS_NAME]).get(relative);
    if (typeof output !== "string") throw new Error(`${relative}: no arena C-string output renderer`);
    return output;
  }
  if (recipe === DMSDK_BOUNDED_RECIPE) {
    const factsName = dmsdkBoundedOutputFacts[relative];
    const output = factsName ? renderDmSdkBoundedOutputs(documents[factsName]).get(relative) : undefined;
    if (typeof output !== "string") throw new Error(`${relative}: no bounded-family output renderer`);
    return output;
  }
  if (recipe === DMSDK_CSTRING_VALUE_RECIPE) {
    const key = dmsdkCStringValueOutputs[relative];
    const output = key
      ? renderDmSdkCStringValueOutputs(documents[DMSDK_CSTRING_VALUE_RECIPE_FACTS_NAME])[key]
      : undefined;
    if (typeof output !== "string") throw new Error(`${relative}: no C-string/value output renderer`);
    return output;
  }
  if (recipe === DMSDK_ENUM_VALUE_RECIPE) {
    const key = dmsdkEnumValueOutputs[relative];
    const rendered = renderDmSdkEnumValueOutputs(documents[DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME]);
    const output = key?.startsWith("sources.") ? rendered.sources[key.slice("sources.".length)] : rendered[key];
    if (typeof output !== "string") throw new Error(`${relative}: no enum-value output renderer`);
    return output;
  }
  if (recipe === DMSDK_NAMED_SCALAR_RECIPE) {
    const key = dmsdkNamedScalarOutputs[relative];
    const output = key
      ? renderDmSdkNamedScalarOutputs(documents[DMSDK_NAMED_SCALAR_RECIPE_FACTS_NAME])[key]
      : undefined;
    if (typeof output !== "string") throw new Error(`${relative}: no named-scalar output renderer`);
    return output;
  }
  if (recipe === DMSDK_SCALAR_RECIPE) {
    const key = dmsdkScalarOutputs[relative];
    const output = key ? renderDmSdkScalarOutputs(documents[DMSDK_SCALAR_RECIPE_FACTS_NAME])[key] : undefined;
    if (typeof output !== "string") throw new Error(`${relative}: no scalar output renderer`);
    return output;
  }
  if (recipe === DMSDK_SCRATCH_SCALAR_OUT_RECIPE) {
    const output = renderDmSdkScratchScalarOutOutputs(documents[DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_NAME]).get(
      relative,
    );
    if (typeof output !== "string") throw new Error(`${relative}: no scratch-scalar-out output renderer`);
    return output;
  }
  if (recipe === DMSDK_HASH_STATE_RECIPE) {
    const output = renderDmSdkHashStateOutputs(documents[DMSDK_HASH_STATE_RECIPE_FACTS_NAME]).get(relative);
    if (typeof output !== "string") throw new Error(`${relative}: no hash-state output renderer`);
    return output;
  }
  if (recipe === GENERATED_MODULE_RECIPE) {
    const output = renderGeneratedModuleOutputs(documents[GENERATED_MODULE_FACTS]).get(relative);
    if (typeof output !== "string") throw new Error(`${relative}: no generated-module output renderer`);
    return output;
  }
  if (recipe === SCRIPT_URL_RECIPE) {
    const rendered = renderScriptUrlNativeOutputs(documents[SCRIPT_URL_RECIPE_FACTS_NAME]);
    if (relative.endsWith("generated_script_url_bindings.hpp")) return rendered.header;
    if (relative.endsWith("generated_script_url_bindings.cpp")) return rendered.source;
    throw new Error(`${relative}: no script URL output renderer`);
  }
  if (recipe === STATIC_HERMES_VMATH_RECIPE) {
    const facts = documents[STATIC_HERMES_VMATH_RECIPE_FACTS_NAME];
    if (relative.endsWith("generated_static_hermes_vmath.h")) return renderStaticHermesVmathHeader(facts);
    if (relative.endsWith("generated_static_hermes_vmath.cpp")) return renderStaticHermesVmathSource(facts);
    if (relative.endsWith("script-vmath.ts")) return renderStaticHermesVmathTypescript(facts);
    throw new Error(`${relative}: no Static Hermes vmath output renderer`);
  }
  const scriptFamily = {
    [SCRIPT_CALLBACK_LIFECYCLE_RECIPE]: [SCRIPT_CALLBACK_LIFECYCLE_FACTS, renderScriptCallbackLifecycleOutputs],
    [SCRIPT_DYNAMIC_VALUES_RECIPE]: [SCRIPT_DYNAMIC_VALUES_FACTS, renderScriptDynamicValuesOutputs],
    [SCRIPT_FIXED_TUPLES_RECIPE]: [SCRIPT_FIXED_TUPLES_FACTS, renderScriptFixedTuplesOutputs],
    [SCRIPT_OVERLOAD_DISPATCH_RECIPE]: [SCRIPT_OVERLOAD_DISPATCH_FACTS, renderScriptOverloadDispatchOutputs],
    [SCRIPT_TABLE_RECORD_RECIPE]: [SCRIPT_TABLE_RECORD_FACTS, renderScriptTableRecordOutputs],
    [SCRIPT_VALUE_TAIL_RECIPE]: [SCRIPT_VALUE_TAIL_FACTS, renderScriptValueTailOutputs],
  }[recipe];
  if (scriptFamily) {
    const [factsName, render] = scriptFamily;
    const rendered = render(documents[factsName]);
    if (relative.endsWith(".hpp")) return rendered.header;
    if (relative.endsWith(".cpp")) return rendered.source;
    throw new Error(`${relative}: no script-family output renderer`);
  }
  if (recipe === LUA_BRIDGE_RECIPE) {
    const output = renderLuaBridgeOutputs(documents[LUA_BRIDGE_FACTS]).get(relative);
    if (typeof output !== "string") throw new Error(`${relative}: no Lua bridge output renderer`);
    return output;
  }
  if (recipe === SCRIPT_SPECIAL_CALL_VERIFICATION_RECIPE) {
    if (relative !== scriptSpecialCallVerificationOutput) {
      throw new Error(`${relative}: no script special-call verification renderer`);
    }
    return renderScriptSpecialCallVerificationHeaderFromReport(documents[SCRIPT_SPECIAL_CALL_VERIFICATION_DOCUMENT]);
  }
  if (recipe === STATIC_HERMES_TYPED_NATIVE_BRIDGE_RECIPE) {
    if (relative !== staticHermesTypedNativeBridgeOutput) {
      throw new Error(`${relative}: no Static Hermes typed-native bridge renderer`);
    }
    return renderStaticHermesTypedNativeBridge(documents[STATIC_HERMES_TYPED_NATIVE_BRIDGE_FACTS]);
  }
  throw new Error(`${relative}: unsupported package-owned revision-output recipe ${JSON.stringify(recipe)}`);
}
