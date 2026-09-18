import { materializeDmSdkUsages as materializeWithCatalog } from "./dmsdk-universal-materializer-core.mjs";
import { dmSdkUniversalCatalogSha256, dmSdkUniversalRecipes } from "./generated/dmsdk-universal-recipes.mjs";

export { dmSdkUniversalCatalogSha256, dmSdkUniversalRecipes };

export function materializeDmSdkUsages(usages, options = {}) {
  if (options.catalogSha256 !== dmSdkUniversalCatalogSha256) {
    throw new Error(`dmSDK catalog identity mismatch: expected ${dmSdkUniversalCatalogSha256}`);
  }
  return materializeWithCatalog(usages, {
    recipes: options.recipes ?? dmSdkUniversalRecipes,
    ...options,
    catalogSha256: dmSdkUniversalCatalogSha256
  });
}
