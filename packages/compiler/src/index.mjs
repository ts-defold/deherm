export * from "./binding-identity.mjs";
export * from "./defold-value-layout-output-emitter.mjs";
export * from "./generated-module-output-emitter.mjs";
export * from "./script-url-output-emitter.mjs";
export * from "./static-hermes-vmath-output-emitter.mjs";
export * from "./script-copied-value-record-blockers-output-emitter.mjs";
export * from "./script-opaque-record-blockers-output-emitter.mjs";
export * from "./script-callback-lifecycle-output-emitter.mjs";
export * from "./script-dynamic-values-output-emitter.mjs";
export * from "./script-fixed-tuples-output-emitter.mjs";
export * from "./script-overload-dispatch-output-emitter.mjs";
export * from "./script-table-record-output-emitter.mjs";
export * from "./script-value-tail-output-emitter.mjs";
export * from "./lua-bridge-output-emitter.mjs";
export * from "./dmsdk-universal-jsi-source-emitter.mjs";
export * from "./static-hermes-typed-native-bridge-output-emitter.mjs";
export { generateScriptBindingDescriptors } from "./script-binding-descriptor-generator.mjs";
export * from "./component-proxy-generator.mjs";
// The public compiler boundary is pure: callers supply policy/materialized
// inputs. Repository path loading and the CLI runner remain available only via
// the repository command shim.
export { generateBindingLoweringPlan } from "./generate-binding-lowering-plan.mjs";
export * from "./binding-lowering-plan-recipe.mjs";
export * from "./dmsdk-universal-materializer.mjs";
export * from "./dmsdk-universal-jsi-exact-runner.mjs";
export * from "./dmsdk-universal-static-frame.mjs";
export * from "./native-extension-generator.mjs";
export * from "./defold-hash.mjs";
export * from "./dmsdk-call-symbol-index.mjs";
export * from "./dmsdk-concrete-call-plan.mjs";
export * from "./dmsdk-pattern-selector.mjs";
export * from "./dmsdk-bounded-span-plan.mjs";
export * from "./dmsdk-bounded-output-emitter.mjs";
export * from "./dmsdk-arena-cstring-output-emitter.mjs";
export * from "./dmsdk-value-plan.mjs";
export * from "./dmsdk-hash-state-plan.mjs";
export * from "./dmsdk-hash-state-output-emitter.mjs";
export * from "./dmsdk-cstring-value-plan.mjs";
export * from "./dmsdk-cstring-value-output-emitter.mjs";
export * from "./dmsdk-enum-value-output-emitter.mjs";
export * from "./dmsdk-named-scalar-output-emitter.mjs";
export * from "./dmsdk-scalar-output-emitter.mjs";
export * from "./dmsdk-borrowed-handle-plan.mjs";
export * from "./dmsdk-borrowed-handle-output-emitter.mjs";
export * from "./dmsdk-scratch-scalar-out-plan.mjs";
export * from "./dmsdk-scratch-scalar-out-output-emitter.mjs";
export * from "./cpp-ownership-effect-facts.mjs";
export * from "./dmsdk-cpp-ownership-effect-frontend.mjs";
export * from "./defold-source-include-aliases.mjs";
export * from "./api-policy.mjs";
export * from "./policy-surface-materializer.mjs";
export * from "./names.mjs";
export {
  buildApiTrees,
  createTypeRenderer as createScriptTypeRenderer,
  generateIndex as generateScriptIndex,
  generateModules as generateScriptModules,
  generateRuntime as generateScriptRuntime,
  generateTypes as generateScriptTypes,
} from "./sdk/script-sdk.mjs";
export {
  createTypeRenderer as createDmSdkTypeRenderer,
  generateRuntime as generateDmSdkRuntime,
  generateTypes as generateDmSdkTypes,
} from "./sdk/dmsdk-sdk.mjs";
export {
  generateDmSdkBrowserArena,
  generateDmSdkScalar,
  generateDmSdkUniversal,
  generateScriptBrowserTargetSupport,
  generateScriptHandleLowering,
  generateScriptUniversalValue,
} from "./sdk/support-sdk.mjs";
