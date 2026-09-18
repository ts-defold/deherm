import { stableBindingId } from "./binding-identity.mjs";

export const universalTargetSupport = Object.freeze({
  nativeDynamicHermes: "generated-recursive-jsi-lua-adapter-with-23-registry-eligible-callback-inputs-and-2-rooted-higher-order-lua-closure-results-native-harness-proven-packaged-engine-unverified",
  nativeStaticHermes: "generated-sound-typed-fixed-capacity-frame-marshal-runtime-proven-for-non-callback-non-handle-non-defold-value-shapes-packaged-engine-unverified",
  html5BrowserHost: "generated-direct-wasm-memory-provider-plus-23-registry-eligible-callback-trampolines-node-and-native-harness-proven-2-higher-order-lua-closures-blocked-packaged-browser-engine-unverified"
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateUniversalPolicy(policy) {
  assert(policy?.schemaVersion === 1, "unsupported universal-value policy schema");
  assert(Array.isArray(policy.selection?.loweringFamilies), "universal loweringFamilies must be an array");
  assert(Array.isArray(policy.selection?.excludedLoweringFamilies), "universal excludedLoweringFamilies must be an array");
  assert(Array.isArray(policy.selection?.excludedContexts), "universal excludedContexts must be an array");
  assert(Number.isInteger(policy.bounds?.maximumArguments) && policy.bounds.maximumArguments > 0 && policy.bounds.maximumArguments <= 255, "maximumArguments must be a positive u8");
  assert(Number.isInteger(policy.bounds?.maximumDepth) && policy.bounds.maximumDepth > 0, "maximumDepth must be positive");
  assert(Number.isInteger(policy.bounds?.maximumEntries) && policy.bounds.maximumEntries > 0, "maximumEntries must be positive");
  assert(Number.isInteger(policy.bounds?.maximumStringBytes) && policy.bounds.maximumStringBytes > 0, "maximumStringBytes must be positive");
}

// Routes are normalized projections of the source IR. This selector is the
// single mechanical definition of the universal fallback census; generators
// may enrich selected rows with target-specific shape metadata afterward.
export function selectUniversalRoutes(routes, policy) {
  validateUniversalPolicy(policy);
  const selectedFamilies = new Set(policy.selection.loweringFamilies);
  const excludedFamilies = new Set(policy.selection.excludedLoweringFamilies);
  const excludedContexts = new Set(policy.selection.excludedContexts);
  const selected = [];
  const excluded = [];
  for (const route of routes) {
    if (!selectedFamilies.has(route.loweringFamily)) continue;
    if (excludedFamilies.has(route.loweringFamily) || excludedContexts.has(route.contextToken)) {
      excluded.push({ id: route.id, loweringFamily: route.loweringFamily, context: route.contextToken });
      continue;
    }
    const variadic = route.variadic === true;
    const fixedParameters = route.parameters.filter(({ name }) => name !== "...");
    const minimumArgumentCount = fixedParameters.filter(({ optional }) => !optional).length;
    const maximumArgumentCount = variadic ? policy.bounds.maximumArguments : route.parameters.length;
    const returns = route.returns ?? [];
    let minimumResultCount = returns.length;
    while (minimumResultCount > 0 && returns[minimumResultCount - 1]?.value?.kind === "optional") {
      --minimumResultCount;
    }
    const maximumResultCount = returns.length;
    const stableId = route.stableId ?? stableBindingId(route.id);
    assert(maximumArgumentCount <= 255 && maximumResultCount <= 255, `${route.id}: universal-value arity exceeds u8`);
    selected.push({
      id: route.id,
      stableId,
      modulePath: route.modulePath,
      member: route.member,
      loweringFamily: route.loweringFamily,
      minimumArgumentCount,
      maximumArgumentCount,
      // Lua may omit only a trailing optional suffix. Keeping the range in the
      // generated operation descriptor lets the backend preserve actual Lua
      // arity without weakening routes whose result list is exact.
      minimumResultCount,
      maximumResultCount,
      resultCount: maximumResultCount,
      variadic,
      shapeKinds: [...(route.shapeKinds ?? [])].sort(compare),
      recursive: route.recursive ?? { token: "shape-metadata-unavailable" }
    });
  }
  selected.sort((left, right) => left.stableId - right.stableId || compare(left.id, right.id));
  excluded.sort((left, right) => compare(left.id, right.id));
  assert(new Set(selected.map(({ id }) => id)).size === selected.length, "universal-value identities are duplicated");
  assert(new Set(selected.map(({ stableId }) => stableId)).size === selected.length, "universal-value stable ID collision");
  assert(selected.length > 0, "universal-value selection is empty");
  return { selected, excluded };
}
