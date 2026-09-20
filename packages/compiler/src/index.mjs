export * from "./binding-identity.mjs";
export * from "./component-proxy-generator.mjs";
export * from "./generate-binding-lowering-plan.mjs";
export * from "./dmsdk-universal-materializer.mjs";
export * from "./native-extension-generator.mjs";
export * from "./defold-hash.mjs";
export * from "./api-policy.mjs";
export * from "./policy-surface-materializer.mjs";
export * from "./names.mjs";
export {
  buildApiTrees,
  createTypeRenderer as createScriptTypeRenderer,
  generateIndex as generateScriptIndex,
  generateModules as generateScriptModules,
  generateRuntime as generateScriptRuntime,
  generateTypes as generateScriptTypes
} from "./sdk/script-sdk.mjs";
export {
  createTypeRenderer as createDmSdkTypeRenderer,
  generateRuntime as generateDmSdkRuntime,
  generateTypes as generateDmSdkTypes
} from "./sdk/dmsdk-sdk.mjs";
export {
  generateDmSdkBrowserArena,
  generateDmSdkScalar,
  generateDmSdkUniversal,
  generateScriptBrowserTargetSupport,
  generateScriptHandleLowering,
  generateScriptUniversalValue
} from "./sdk/support-sdk.mjs";
