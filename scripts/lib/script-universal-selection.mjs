import { stableBindingId } from "./binding-identity.mjs";

export const universalTargetSupport = Object.freeze({
  nativeDynamicHermes: "generated-recursive-jsi-lua-adapter-with-23-registry-eligible-callback-inputs-and-2-rooted-higher-order-lua-closure-results-native-harness-proven-packaged-engine-unverified",
  nativeStaticHermes: "generated-sound-typed-fixed-capacity-frame-marshal-runtime-proven-for-optional-input-callbacks-that-decline-to-jsi-non-handle-non-defold-value-shapes-packaged-engine-unverified",
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
/**
 * Split one `fun(...)` overload token into its fixed parameter list. Pinned IR
 * carries a route's alternative signatures as tokens beside its primary
 * parameter list, so a route whose primary list is empty can still accept
 * arguments. Returning `null` marks an unparsable token, which the caller
 * refuses rather than silently under-counting.
 */
function overloadArity(token) {
  if (typeof token !== "string") return null;
  const open = token.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let index = open; index < token.length; ++index) {
    const char = token[index];
    if (char === "(") ++depth;
    else if (char === ")" && --depth === 0) { close = index; break; }
  }
  if (close < 0) return null;
  const body = token.slice(open + 1, close).trim();
  if (body === "") return { total: 0, required: 0 };
  const parts = [];
  let nesting = 0;
  let start = 0;
  for (let index = 0; index < body.length; ++index) {
    const char = body[index];
    if (char === "<" || char === "(" || char === "[") ++nesting;
    else if (char === ">" || char === ")" || char === "]") --nesting;
    else if (char === "," && nesting === 0) { parts.push(body.slice(start, index)); start = index + 1; }
  }
  parts.push(body.slice(start));
  const parameters = parts.map((part) => part.trim()).filter((part) => part.length !== 0);
  if (parameters.some((parameter) => parameter.startsWith("..."))) return null;
  const name = (parameter) => {
    const colon = parameter.indexOf(":");
    return (colon < 0 ? parameter : parameter.slice(0, colon)).trim();
  };
  return {
    total: parameters.length,
    required: parameters.filter((parameter) => !name(parameter).endsWith("?")).length
  };
}

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
    // A route's accepted arity is the union of its primary parameter list and
    // every alternative signature the pinned IR declares for it. Deriving it
    // from the primary list alone leaves overload-only arities — `msg.url(s)`
    // among them — declared as zero-argument and refused by their own
    // descriptor before they reach a backend.
    const overloads = (route.overloadTokens ?? []).map((token) => {
      const arity = overloadArity(token);
      assert(arity !== null, `${route.id}: unparsable overload signature ${token}`);
      return arity;
    });
    const minimumArgumentCount = Math.min(
      fixedParameters.filter(({ optional }) => !optional).length,
      ...overloads.map(({ required }) => required));
    const maximumArgumentCount = variadic
      ? policy.bounds.maximumArguments
      : Math.max(route.parameters.length, ...overloads.map(({ total }) => total));
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
      // Public TypeScript identity remains derived from the documented route;
      // Lua lookup follows the registered C-source spelling when they differ.
      modulePath: route.runtimeModulePath ?? route.modulePath,
      member: route.runtimeMember ?? route.member,
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
      // Exact Defold value constructor names, including names reachable only
      // inside union variants. Transports that copy fixed-layout records need
      // the type identity, not just the `defold-value` shape kind.
      defoldValueTypes: [...(route.defoldValueTypes ?? [])].sort(compare),
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
