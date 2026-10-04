import { decodePolicyObject, encodePolicyObject } from "./policy-object-recipe.mjs";

export const DMSDK_UNIVERSAL_RECIPE_FACTS_KIND = "deherm.policy.dmsdk-universal-recipe-facts";
export const DMSDK_UNIVERSAL_RECIPE_FACTS_NAME = "defold-dmsdk-universal-recipe-facts.json";
export const DMSDK_UNIVERSAL_RECIPE_FACTS_CAPABILITY = "policy.compiler-document.dmsdk-universal.v2";
export const DMSDK_UNIVERSAL_OUTPUT_NAME = "defold-dmsdk-universal-bindings.json";

function validateReport(report) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    !Array.isArray(report.recipes) ||
    !Array.isArray(report.artifacts) ||
    report.coverage?.recipes !== report.recipes.length ||
    !/^[0-9a-f]{64}$/u.test(report.sourceHashes?.catalog ?? "")
  ) {
    throw new Error("dmSDK universal recipe facts require the canonical universal report");
  }
  return report;
}

export function createDmSdkUniversalRecipeFacts(report) {
  return {
    schemaVersion: 1,
    kind: DMSDK_UNIVERSAL_RECIPE_FACTS_KIND,
    ...encodePolicyObject(validateReport(report)),
  };
}

export function emitDmSdkUniversalReport(facts) {
  if (facts?.schemaVersion !== 1 || facts?.kind !== DMSDK_UNIVERSAL_RECIPE_FACTS_KIND) {
    throw new Error("Unsupported dmSDK universal recipe facts");
  }
  return validateReport(decodePolicyObject(facts, "dmSDK universal recipe"));
}
