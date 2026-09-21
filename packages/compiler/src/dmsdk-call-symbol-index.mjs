import { createHash } from "node:crypto";

import { createTypeRenderer, dmSdkRuntimeOverloads } from "./sdk/dmsdk-sdk.mjs";
import { materializeDmSdkUsages } from "./dmsdk-universal-materializer.mjs";
import {
  materializationFromDmSdkConcreteCallPlan,
  resolveDmSdkConcreteCallPlan,
} from "./dmsdk-concrete-call-plan.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bareMaterialization(recipe, catalog) {
  if (recipe.preferredLowering?.state === "generated-adapter") {
    const concrete = materializationFromDmSdkConcreteCallPlan(resolveDmSdkConcreteCallPlan(recipe));
    if (concrete.state !== "specialization-required") return concrete;
    try {
      materializeDmSdkUsages([{
        declarationId: recipe.declarationId,
        acknowledgements: {
          generatedAdapterBypass: {
            reason: "provider-only adapter is not release-callable",
            evidence: "deterministic universal-fallback materialization",
          },
        },
      }], {
        catalog,
        catalogSha256: catalog.sourceHashes.catalog
      });
      return { state: "universal-ready", requirements: [] };
    } catch {
      return concrete;
    }
  }
  try {
    materializeDmSdkUsages([{ declarationId: recipe.declarationId }], {
      catalog,
      catalogSha256: catalog.sourceHashes.catalog
    });
    return { state: "universal-ready", requirements: [] };
  } catch (error) {
    return {
      state: "specialization-required",
      requirements: [...new Set(recipe.fallback?.requirements ?? [])].sort(compareCodeUnits),
      diagnostic: error instanceof Error ? error.message : String(error)
    };
  }
}

function validMaterialization(value) {
  if (!value || typeof value !== "object") return false;
  if (value.state === "universal-ready") {
    return Array.isArray(value.requirements) && value.requirements.length === 0 && value.diagnostic === undefined;
  }
  if (value.state === "generated-adapter") {
    return typeof value.family === "string" && value.family.length > 0 &&
      Array.isArray(value.requirements) && value.requirements.length === 0 &&
      value.route?.applicability === "callable" &&
      ["named-wrapper", "family-dispatch"].includes(value.route.kind) &&
      typeof value.route.symbol === "string" && value.route.symbol.length > 0 &&
      typeof value.route.header === "string" && value.route.header.length > 0 &&
      /^[0-9a-f]{64}$/.test(value.route.planSha256 ?? "");
  }
  return value.state === "specialization-required" &&
    Array.isArray(value.requirements) && typeof value.diagnostic === "string" && value.diagnostic.length > 0;
}

/** Validate the content-addressed checker join before consuming its identities. */
export function verifyDmSdkCallSymbolIndex(index, source = "dmSDK call symbol index") {
  if (!index || index.schemaVersion !== 1 || index.generator !== "@ts-defold/deherm dmsdk-call-symbol-index/v1") {
    throw new Error(`${source}: unsupported dmSDK call symbol index`);
  }
  const { indexSha256, ...body } = index;
  if (!/^[0-9a-f]{64}$/.test(indexSha256 ?? "") || sha256(canonicalJson(body)) !== indexSha256) {
    throw new Error(`${source}: indexSha256 does not authenticate the canonical index body`);
  }
  if (!index.markers || !index.declarations ||
      Object.keys(index.markers).length !== index.overloadCount ||
      Object.keys(index.declarations).length !== index.recipeCount) {
    throw new Error(`${source}: dmSDK call index counts do not match its tables`);
  }
  const seen = new Set();
  const states = { "universal-ready": 0, "generated-adapter": 0, "specialization-required": 0 };
  let ambiguous = 0;
  for (const [marker, overload] of Object.entries(index.markers)) {
    if (!marker.startsWith("__deherm_dmsdk_") || !Array.isArray(overload?.declarations) ||
        overload.declarations.length === 0 || overload.ambiguous !== (overload.declarations.length > 1)) {
      throw new Error(`${source}: invalid overload entry '${marker}'`);
    }
    if (overload.ambiguous) ambiguous += 1;
    for (const declaration of overload.declarations) {
      const exact = index.declarations[declaration?.declarationId];
      if (!exact || exact.numericId !== declaration.numericId || exact.marker !== marker ||
          exact.symbol !== overload.symbol || !validMaterialization(exact.materialization) ||
          canonicalJson(exact.materialization) !== canonicalJson(declaration.materialization) ||
          seen.has(declaration.declarationId)) {
        throw new Error(`${source}: invalid declaration reverse link for '${declaration?.declarationId ?? "<unknown>"}'`);
      }
      seen.add(declaration.declarationId);
      states[exact.materialization.state] += 1;
    }
  }
  if (seen.size !== index.recipeCount || ambiguous !== index.ambiguousOverloadCount ||
      states["universal-ready"] !== index.universalReadyCount ||
      states["generated-adapter"] !== index.generatedAdapterCount ||
      states["specialization-required"] !== index.specializationRequiredCount ||
      index.universalReadyCount + index.generatedAdapterCount + index.specializationRequiredCount !== index.recipeCount) {
    throw new Error(`${source}: dmSDK call index accounting is inconsistent`);
  }
  return index;
}

/**
 * Join checker-visible overload markers to canonical dmSDK recipe identities.
 * The catalog remains authoritative for numeric IDs and materialization.
 */
export function buildDmSdkCallSymbolIndex(ir, catalog) {
  if (ir?.schemaVersion !== 1 || !Array.isArray(ir.declarations)) {
    throw new Error("dmSDK call symbol index requires generated dmSDK IR schema v1");
  }
  if (!Array.isArray(catalog?.recipes) || !/^[0-9a-f]{64}$/.test(catalog?.sourceHashes?.catalog ?? "")) {
    throw new Error("dmSDK call symbol index requires the resolved universal recipe catalog");
  }
  const recipeByDeclaration = new Map(catalog.recipes.map((recipe) => [recipe.declarationId, recipe]));
  if (recipeByDeclaration.size !== catalog.recipes.length) {
    throw new Error("dmSDK universal recipe catalog contains duplicate declaration IDs");
  }
  const renderer = createTypeRenderer(ir);
  const overloads = dmSdkRuntimeOverloads(ir, renderer);
  const markers = {};
  const declarations = {};
  const materializationByDeclaration = new Map(catalog.recipes.map((recipe) => [
    recipe.declarationId,
    bareMaterialization(recipe, catalog)
  ]));
  for (const overload of overloads) {
    const entries = overload.declarationIds.map((declarationId) => {
      const recipe = recipeByDeclaration.get(declarationId);
      if (!recipe) throw new Error(`dmSDK overload ${declarationId} has no universal recipe`);
      declarations[declarationId] = {
        numericId: recipe.numericId,
        marker: overload.marker,
        symbol: overload.name,
        materialization: materializationByDeclaration.get(declarationId)
      };
      return {
        declarationId,
        numericId: recipe.numericId,
        materialization: materializationByDeclaration.get(declarationId)
      };
    });
    if (markers[overload.marker]) throw new Error(`dmSDK overload marker collision: ${overload.marker}`);
    markers[overload.marker] = {
      symbol: overload.name,
      ambiguous: entries.length > 1,
      declarations: entries
    };
  }
  if (Object.keys(declarations).length !== catalog.recipes.length) {
    throw new Error(
      `dmSDK call symbol index covers ${Object.keys(declarations).length}/${catalog.recipes.length} universal recipes`,
    );
  }
  const body = {
    schemaVersion: 1,
    generator: "@ts-defold/deherm dmsdk-call-symbol-index/v1",
    defoldRevision: ir.defoldRevision,
    catalogSha256: catalog.sourceHashes.catalog,
    declarationSuffix: "/generated/dmsdk/runtime.ts",
    recipeCount: catalog.recipes.length,
    overloadCount: overloads.length,
    ambiguousOverloadCount: Object.values(markers).filter(({ ambiguous }) => ambiguous).length,
    universalReadyCount: [...materializationByDeclaration.values()].filter(({ state }) => state === "universal-ready").length,
    generatedAdapterCount: [...materializationByDeclaration.values()].filter(({ state }) => state === "generated-adapter").length,
    specializationRequiredCount: [...materializationByDeclaration.values()].filter(({ state }) => state === "specialization-required").length,
    markers: Object.fromEntries(Object.entries(markers).sort(([left], [right]) => compareCodeUnits(left, right))),
    declarations: Object.fromEntries(Object.entries(declarations).sort(([left], [right]) => compareCodeUnits(left, right)))
  };
  return verifyDmSdkCallSymbolIndex(
    { ...body, indexSha256: sha256(canonicalJson(body)) },
    "generated dmSDK call symbol index",
  );
}
