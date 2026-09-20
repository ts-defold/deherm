import { materializeDmSdkUsages as materializeWithCatalog } from "./dmsdk-universal-materializer-core.mjs";
import { assertDmSdkUniversalStaticFrameCapacity } from "./dmsdk-universal-static-frame.mjs";

export function materializeDmSdkUsages(usages, options = {}) {
  const catalog = options.catalog;
  const recipes = options.recipes ?? catalog?.recipes;
  const catalogSha256 = catalog?.sourceHashes?.catalog;
  if (!Array.isArray(recipes) || recipes.length === 0 || !/^[a-f0-9]{64}$/.test(catalogSha256 ?? "")) {
    throw new Error("dmSDK materializer requires a resolved policy catalog with recipes and sourceHashes.catalog");
  }
  if (options.catalogSha256 !== catalogSha256) {
    throw new Error(`dmSDK catalog identity mismatch: expected ${catalogSha256}`);
  }
  const catalogMaximum = assertDmSdkUniversalStaticFrameCapacity(catalog);
  if (options.maxArguments !== undefined && options.maxArguments > catalogMaximum) {
    assertDmSdkUniversalStaticFrameCapacity({ abi: { maxArguments: options.maxArguments } });
  }
  return materializeWithCatalog(usages, {
    recipes,
    ...options,
    catalogSha256
  });
}
