import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const adapterHeaders = Object.freeze({
  astcProbe: "defold_hermes/generated_dmsdk_astc_probe.h",
  base64Span: "defold_hermes/generated_dmsdk_base64_span.h",
  cstringValue: "defold_hermes/generated_dmsdk_cstring_value.h",
  enumValue: "defold_hermes/generated_dmsdk_enum_value.h",
  fixedDigest: "defold_hermes/generated_dmsdk_fixed_digest.h",
  hashSpan: "defold_hermes/generated_dmsdk_hash_span.h",
  scalar: "defold_hermes/generated_dmsdk_scalar.h",
  xteaSpan: "defold_hermes/generated_dmsdk_xtea_span.h",
});

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value ?? "")) {
    throw new Error(`${label} is not a C identifier: ${value}`);
  }
  return value;
}

/**
 * Resolve the release route for a recipe that selected an already-generated
 * adapter family. This is deliberately separate from the universal fallback:
 * a generated provider boundary is not executable until its policy provider
 * exists, while a named wrapper or the cstring family dispatcher is a concrete
 * linkable call contract.
 */
export function resolveDmSdkConcreteCallPlan(recipe) {
  const lowering = recipe?.preferredLowering;
  if (lowering?.state !== "generated-adapter") return null;
  const adapter = lowering.adapter;
  const base = {
    schemaVersion: 1,
    declarationId: recipe.declarationId,
    numericId: recipe.numericId,
    recipeId: recipe.projectionId,
    family: lowering.family,
    wrapper: lowering.wrapper ?? null,
    adapterId: Number.isSafeInteger(adapter?.id) ? adapter.id : null,
  };
  if (adapter?.applicability === "callable" &&
      ["named-wrapper", "family-dispatch"].includes(adapter.kind)) {
    const symbol = identifier(
      adapter.kind === "named-wrapper" ? lowering.wrapper : adapter.dispatcher,
      `${recipe.declarationId} generated adapter symbol`,
    );
    const header = adapterHeaders[lowering.family];
    if (!header) throw new Error(`${recipe.declarationId} has no generated adapter header for ${lowering.family}`);
    if (adapter.kind === "family-dispatch" && !Number.isSafeInteger(adapter.id)) {
      throw new Error(`${recipe.declarationId} family dispatcher needs a stable adapter id`);
    }
    const plan = {
      ...base,
      state: "generated-adapter",
      applicability: "callable",
      adapterKind: adapter.kind,
      symbol,
      header,
      requirements: [],
    };
    plan.planSha256 = sha256(canonicalJson(plan));
    return Object.freeze(plan);
  }
  const requirements = [...new Set(adapter?.blockers ?? ["generated-adapter-provider"])]
    .sort(compareCodeUnits);
  const plan = {
    ...base,
    state: "specialization-required",
    applicability: adapter?.applicability ?? "provider-required",
    adapterKind: adapter?.kind ?? "provider-boundary",
    requirements,
    diagnostic: `generated ${lowering.family} adapter is not release-callable: ${requirements.join(", ")}`,
  };
  plan.planSha256 = sha256(canonicalJson(plan));
  return Object.freeze(plan);
}

export function materializationFromDmSdkConcreteCallPlan(plan) {
  if (!plan) return null;
  if (plan.state === "generated-adapter") {
    return {
      state: "generated-adapter",
      family: plan.family,
      ...(plan.wrapper ? { wrapper: plan.wrapper } : {}),
      route: {
        applicability: plan.applicability,
        kind: plan.adapterKind,
        id: plan.adapterId,
        symbol: plan.symbol,
        header: plan.header,
        planSha256: plan.planSha256,
      },
      requirements: [],
    };
  }
  return {
    state: "specialization-required",
    family: plan.family,
    ...(plan.wrapper ? { wrapper: plan.wrapper } : {}),
    route: {
      applicability: plan.applicability,
      kind: plan.adapterKind,
      id: plan.adapterId,
      planSha256: plan.planSha256,
    },
    requirements: [...plan.requirements],
    diagnostic: plan.diagnostic,
  };
}

function verifyUsageRoute(usage, plan) {
  const expected = materializationFromDmSdkConcreteCallPlan(plan);
  if (usage.materialization && !isDeepStrictEqual(usage.materialization, expected)) {
    throw new Error(`${usage.declarationId} generated adapter usage disagrees with its concrete call plan`);
  }
}

/**
 * Emit the release-retention side of concrete generated-adapter calls. The
 * family adapter remains the production transport; this source binds each
 * checker-selected recipe identity to its exact wrapper/dispatcher symbol and
 * forces a linker relocation for that selected symbol only.
 */
export function materializeDmSdkGeneratedAdapterUsages(usages, options = {}) {
  const recipes = options.recipes;
  if (!Array.isArray(recipes) || !recipes.length) {
    throw new Error("dmSDK generated-adapter materializer requires a non-empty recipes catalog");
  }
  if (!/^[0-9a-f]{64}$/.test(options.catalogSha256 ?? "")) {
    throw new Error("dmSDK generated-adapter materializer requires the exact catalogSha256");
  }
  const byId = new Map(recipes.map((recipe) => [recipe.declarationId, recipe]));
  const installName = identifier(
    options.installName ?? "deherm_dmsdk_generated_provider_install",
    "installName",
  );
  const seen = new Set();
  const plans = usages.map((usage) => {
    if (seen.has(usage.declarationId)) throw new Error(`duplicate dmSDK generated adapter usage: ${usage.declarationId}`);
    seen.add(usage.declarationId);
    const recipe = byId.get(usage.declarationId);
    if (!recipe) throw new Error(`Unknown dmSDK declaration: ${usage.declarationId}`);
    const plan = resolveDmSdkConcreteCallPlan(recipe);
    if (!plan || plan.state !== "generated-adapter") {
      throw new Error(`${usage.declarationId} has no callable generated adapter route`);
    }
    verifyUsageRoute(usage, plan);
    return plan;
  }).sort((left, right) => left.numericId - right.numericId);
  const headers = [...new Set(plans.map(({ header }) => header))].sort(compareCodeUnits);
  const retainName = identifier(`${installName}_retain_generated_adapters`, "generated adapter retain function");
  const references = plans.map((plan, index) =>
    `static auto (* volatile deherm_dmsdk_adapter_${index}) = &${plan.symbol};`).join("\n");
  const touches = plans.map((_, index) => `(void)deherm_dmsdk_adapter_${index};`).join("");
  const source = plans.length
    ? "// Generated by @deherm/compiler dmSDK concrete call planner. Do not edit.\n" +
      `${headers.map((header) => `#include <${header}>`).join("\n")}\n` +
      `${references}\nextern \"C\" void ${retainName}(void){${touches}}\n`
    : "";
  const manifest = plans.map((plan) => ({
    declarationId: plan.declarationId,
    numericId: plan.numericId,
    recipeId: plan.recipeId,
    family: plan.family,
    adapterKind: plan.adapterKind,
    adapterId: plan.adapterId,
    symbol: plan.symbol,
    planSha256: plan.planSha256,
    catalogSha256: options.catalogSha256,
  }));
  const verification = {
    schemaVersion: 1,
    source: "deherm-dmsdk-generated-adapter-call-plan",
    evidenceBoundary: "The concrete plan authenticates the checker-selected recipe-to-family wrapper or dispatcher join and the emitted linker relocation. Family-owned exact-call tests remain authoritative for the adapter implementation; provider-boundary families are excluded until their policy providers exist.",
    catalogSha256: options.catalogSha256,
    retain: retainName,
    callCount: manifest.length,
    calls: manifest,
  };
  verification.manifestSha256 = sha256(canonicalJson(verification));
  return Object.freeze({ source, retain: retainName, manifest: Object.freeze(manifest), verification: Object.freeze(verification) });
}
