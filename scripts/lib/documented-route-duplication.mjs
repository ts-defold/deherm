// Why one Lua name can be documented twice, and what each reason means.
//
// Defold's reference archive is a set of per-source stub files, so the same Lua
// name legitimately appears in more than one of them. Taking every declaration
// as a distinct route therefore produces duplicate route ids - which is what
// stopped every derivation of Defold 1.13.1, reported (misleadingly) as a hash
// collision. 1.14.0 happens not to duplicate because Defold consolidated its
// stubs into per-module files like `doc/b2d.lua`; that is a property of one
// revision's documentation layout, not a rule we can rely on.
//
// There are exactly four reasons, they mean different things, and a fifth would
// be a genuine ambiguity we must not guess at:
//
//   editor-surface   One declaration is the EDITOR's scripting API. The editor
//                    is a separate Lua runtime with its own host; `json.decode`,
//                    `zlib.inflate`, `http.request` and `pprint` exist in both
//                    and are not the same function. We bind the game runtime, so
//                    the editor declaration is dropped.
//
//   build-variant    The declarations come from sources belonging to different
//                    BUILD FEATURES - at 1.13.1, `b2d.body.*` is documented by
//                    both the box2d v2 and v3 backends, of which a build
//                    compiles one. This is one Lua name with per-profile
//                    availability, which this repository already models: see
//                    `packages/bindings/overrides/script-route-availability-profiles.json`
//                    and its six runtime profiles. One route; the variants that
//                    documented it are recorded.
//
//   overload         The declarations come from the SAME source file, which is
//                    how Defold documents alternative signatures - `vmath.vector3()`,
//                    `vmath.vector3(x, y, z)` and `vmath.vector3(v)` are three
//                    stubs for one function. One route carrying the additional
//                    signatures; `generate-script-overload-dispatch.mjs` owns
//                    what happens to them downstream.
//
//   lifecycle        Handled before this module sees it, in
//                    `scripts/lib/script-lifecycle-callbacks.mjs`: namespace-less
//                    callbacks documented once per script type are not routes.
//
// Anything else is refused by name. A duplicate we cannot attribute is a real
// question about the engine, and answering it by picking one is exactly the
// guess this repository exists not to make.

/**
 * Build features a documented source belongs to, keyed by what its path says.
 *
 * These names are the ones `generate-script-route-availability-profiles.mjs`
 * already uses (`featureBits`), so a variant discovered here lines up with the
 * profile machinery instead of inventing a parallel vocabulary. A path that
 * matches none of them has no variant, which is the common case.
 */
const VARIANT_PATTERNS = Object.freeze([
  Object.freeze({ feature: "box2d-v2", pattern: /box2d[-_]v2|_v2\.cpp/ }),
  Object.freeze({ feature: "box2d-v3", pattern: /box2d[-_]v3|_v3\.cpp/ }),
  Object.freeze({ feature: "bullet3d", pattern: /bullet3d/ })
]);

/** The editor's own scripting API, which is not the game runtime. */
export function isEditorSurface(source) {
  return /(^|\/)editor\.apidoc/.test(source);
}

/** Which build feature a documented source belongs to, or null. */
export function variantFeature(source) {
  return VARIANT_PATTERNS.find(({ pattern }) => pattern.test(source))?.feature ?? null;
}

/**
 * Resolve every declaration of one documented Lua name into a single route.
 *
 * @param {string} name          the fully-qualified Lua name
 * @param {object[]} declarations  every parsed declaration of it, in archive order
 * @returns {{route: object|null, reason: string, variants: string[], overloads: object[]}}
 *          `route` is null only when every declaration was dropped.
 */
export function resolveDocumentedDuplication(name, declarations) {
  if (declarations.length === 1) {
    return { route: declarations[0], reason: "single", variants: [], overloads: [] };
  }

  // The editor surface is removed first, because a name shared between the
  // editor and the runtime is not a duplicate of anything once it is gone.
  const runtime = declarations.filter((row) => !isEditorSurface(row.source));
  if (runtime.length !== declarations.length) {
    if (runtime.length === 0) return { route: null, reason: "editor-surface", variants: [], overloads: [] };
    const resolved = resolveDocumentedDuplication(name, runtime);
    return { ...resolved, reason: resolved.reason === "single" ? "editor-surface" : resolved.reason };
  }

  const features = [...new Set(runtime.map((row) => variantFeature(row.source)))];
  if (features.length > 1 && !features.includes(null)) {
    // One Lua name, one route, per-profile availability decided downstream.
    // The first declaration wins as the emitted signature because the variants
    // document the same call; a disagreement between them is a route-level
    // question the availability policy answers, not a parse-level one.
    return {
      route: runtime[0],
      reason: "build-variant",
      variants: features.sort(),
      overloads: runtime.slice(1)
    };
  }

  const sources = new Set(runtime.map((row) => row.source));
  if (sources.size === 1) {
    return { route: runtime[0], reason: "overload", variants: [], overloads: runtime.slice(1) };
  }

  throw new Error(
    `${name} is documented ${runtime.length} times and the duplication cannot be attributed:\n  ` +
    runtime.map((row) => `${row.source}:${row.line}`).join("\n  ") + "\n" +
    "It is not the editor surface, not a build variant this repository models, and not " +
    "alternative signatures in one file. Classify it in " +
    "scripts/lib/documented-route-duplication.mjs rather than letting one declaration win."
  );
}
