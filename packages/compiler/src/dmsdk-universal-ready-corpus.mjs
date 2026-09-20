import { createHash } from "node:crypto";

import { verifyDmSdkCallSymbolIndex } from "./dmsdk-call-symbol-index.mjs";
import { materializeDmSdkUsages } from "./dmsdk-universal-materializer.mjs";

export const dmSdkUniversalReadyCorpusArtifacts = Object.freeze({
  plan: "packages/bindings/generated/defold-dmsdk-universal-ready-exact-plan.json",
  productionSource: "tests/fixtures/generated_dmsdk_universal_ready_provider.cpp",
  verificationSource: "tests/fixtures/generated_dmsdk_universal_ready_verification.cpp",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
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

function authenticatedCatalog(catalog, index) {
  if (!catalog || !Array.isArray(catalog.recipes) ||
      !/^[0-9a-f]{64}$/.test(catalog.sourceHashes?.catalog ?? "")) {
    throw new Error("dmSDK universal-ready corpus requires the authenticated recipe catalog");
  }
  const catalogSha256 = sha256(JSON.stringify(catalog.recipes));
  if (catalogSha256 !== catalog.sourceHashes.catalog || catalogSha256 !== index.catalogSha256) {
    throw new Error("dmSDK universal-ready corpus catalog identity does not match its recipes and symbol index");
  }
  if (catalog.recipes.length !== index.recipeCount) {
    throw new Error("dmSDK universal-ready corpus catalog and symbol index counts differ");
  }
  return catalogSha256;
}

/**
 * Resolve the canonical ready corpus from the authenticated release-call index.
 * Numeric recipe order is the transport-independent vector order.
 */
export function dmSdkUniversalReadyUsages(index, catalog) {
  const verified = verifyDmSdkCallSymbolIndex(index, "dmSDK universal-ready corpus symbol index");
  authenticatedCatalog(catalog, verified);
  const recipes = new Map(catalog.recipes.map((recipe) => [recipe.declarationId, recipe]));
  if (recipes.size !== catalog.recipes.length) {
    throw new Error("dmSDK universal-ready corpus catalog contains duplicate declaration IDs");
  }
  const ready = Object.entries(verified.declarations)
    .filter(([, declaration]) => declaration.materialization.state === "universal-ready")
    .map(([declarationId, declaration]) => {
      const recipe = recipes.get(declarationId);
      if (!recipe || recipe.numericId !== declaration.numericId || recipe.symbol !== declaration.symbol) {
        throw new Error(`dmSDK universal-ready corpus index disagrees with catalog for ${declarationId}`);
      }
      return Object.freeze({ declarationId, numericId: declaration.numericId });
    })
    .sort((left, right) => left.numericId - right.numericId || compareCodeUnits(left.declarationId, right.declarationId));
  if (ready.length !== verified.universalReadyCount) {
    throw new Error("dmSDK universal-ready corpus count disagrees with its authenticated symbol index");
  }
  return Object.freeze(ready.map(({ declarationId }) => Object.freeze({ declarationId })));
}

export function materializeDmSdkUniversalReadyCorpus(index, catalog) {
  const verified = verifyDmSdkCallSymbolIndex(index, "dmSDK universal-ready corpus symbol index");
  const catalogSha256 = authenticatedCatalog(catalog, verified);
  const usages = dmSdkUniversalReadyUsages(verified, catalog);
  const generated = materializeDmSdkUsages(usages, {
    catalog,
    catalogSha256,
    providerName: "deherm_dmsdk_universal_ready_provider",
    installName: "deherm_dmsdk_universal_ready_provider_install",
  });
  const productionSourceSha256 = sha256(generated.source);
  const verificationSourceSha256 = sha256(generated.verificationSource);
  const body = {
    schemaVersion: 1,
    source: "deherm-dmsdk-universal-ready-exact-corpus",
    ordering: "numeric-id-ascending",
    defoldRevision: verified.defoldRevision,
    catalogSha256,
    symbolIndexSha256: verified.indexSha256,
    universalReadyCount: verified.universalReadyCount,
    artifacts: {
      productionSource: {
        path: dmSdkUniversalReadyCorpusArtifacts.productionSource,
        sha256: productionSourceSha256,
      },
      verificationSource: {
        path: dmSdkUniversalReadyCorpusArtifacts.verificationSource,
        sha256: verificationSourceSha256,
      },
    },
    production: {
      provider: generated.provider,
      sourceSha256: productionSourceSha256,
      manifest: jsonValue(generated.manifest),
    },
    verification: jsonValue({
      ...generated.verification,
      sourceSha256: verificationSourceSha256,
    }),
  };
  const report = Object.freeze({ ...body, corpusSha256: sha256(canonicalJson(body)) });
  return Object.freeze({ usages, generated, report });
}
