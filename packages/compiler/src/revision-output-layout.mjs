import path from "node:path";

// Repository-relative roots whose generated members can vary with the selected
// Defold revision. Policies name exact files below these roots; the package
// never treats a root itself as permission to ship arbitrary generated files.
export const REVISION_OUTPUT_ROOTS = Object.freeze([
  Object.freeze({ root: "packages/abi/src/generated", all: true }),
  Object.freeze({ root: "packages/static-hermes/src/generated", all: true }),
  Object.freeze({ root: "defold/defold_hermes/include/defold_hermes", prefix: "generated" }),
  Object.freeze({ root: "defold/defold_hermes/src", prefix: "generated" }),
  Object.freeze({ root: "defold/defold_hermes/lib/web", prefix: "generated" })
]);

// These generated-looking files are functions only of package-owned emitters
// and constants. They are deliberately not revision-policy facts.
export const STABLE_GENERATED_OUTPUTS = Object.freeze(new Set([
  "defold/defold_hermes/include/defold_hermes/generated_build_config.h",
  "defold/defold_hermes/include/defold_hermes/generated_component_proxy_capability.hpp",
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_static_frame.h",
  "defold/defold_hermes/src/generated_dmsdk_universal_static_frame.cpp",
  "packages/static-hermes/src/generated/dmsdk-universal.ts"
]));

// Target-native artifacts are never package or source-tree inputs to project
// generation. They are selected from the authenticated Defold target matrix,
// downloaded from the matching release, and installed through the user cache.
// Keep the browser host adapter: it is portable source, not a native artifact.
const TARGET_NATIVE_OUTPUT_PATTERN =
  /^defold\/defold_hermes\/lib\/(?!web(?:\/|$))[^/]+\/(?:[^/]+\.(?:a|lib|so|dylib|dll|pdb)|\.deherm-artifact\.json)$/u;

export function isTargetNativeOutput(relative) {
  const portable = String(relative).replaceAll(path.sep, "/");
  return portable === "defold/defold_hermes/include/libhermesvm-config.h" ||
    TARGET_NATIVE_OUTPUT_PATTERN.test(portable);
}

export function isRevisionOutput(relative) {
  const portable = String(relative).replaceAll(path.sep, "/");
  if (STABLE_GENERATED_OUTPUTS.has(portable)) return false;
  return REVISION_OUTPUT_ROOTS.some((rule) => {
    if (!portable.startsWith(`${rule.root}/`)) return false;
    return rule.all || path.posix.basename(portable).startsWith(rule.prefix);
  });
}
