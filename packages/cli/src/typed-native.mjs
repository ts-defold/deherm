// Which projection a typed-native unit belongs to, and how a build keeps one
// out of a projection that cannot execute it.
//
// A `shermes -emit-c` unit is a transport of the **`hermes` runtime**, not a
// platform-neutral optimisation: the canonical lowering plan gives
// `staticHermesCAbi` the runtime id `hermes`, and its emitted C calls
// `_sh_*` entry points that only `libhermes.a` defines. The `browser` runtime
// has no Hermes at all - `browserWasmHost` runs the browser's own JavaScript
// engine over Defold's Wasm memory - so a Static Hermes unit is not a slower
// or a bigger choice there, it is a meaningless one.
//
// Bob discovers extensions by walking the project for `ext.manifest`, and an
// `ext.manifest` has no way to say "not on this platform": Extender compiles
// every `src/` file of every extension it is given. So the gate cannot live in
// the extension. It lives here, at the two seams that decide what Bob sees:
//
//   * `typedNativeDisposition` answers, from pinned data alone, whether a
//     target's runtime can execute such a unit. The assembler refuses to
//     materialise one for a target that cannot.
//   * `reconcileTypedNativeUpload` makes the answer true of the project on
//     disk before Bob walks it, by maintaining one `.defignore` entry. Bob
//     filters extension discovery through `.defignore`
//     (`ProjectResourceWalker.walkResources` -> `getExtensionFolders`), so an
//     ignored unit is not uploaded, not compiled, and not linked. The files
//     stay where they are: a unit assembled by a previous native build is
//     expensive to reproduce and is still correct for its own target.
//
// The result is that a stale unit cannot poison a later web build, and a
// non-Hermes target gets a named refusal instead of an undefined `_sh_*`
// symbol at link time.

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  BOB_TOOLING_IGNORE_ENTRIES,
  reconcileBobProjectBoundary
} from "./bob-project-boundary.mjs";

export { BOB_TOOLING_IGNORE_ENTRIES };


/** The materialised extension's directory name, relative to a project root. */
export const TYPED_NATIVE_EXTENSION = "defold_hermes_typed_native";

/** The `.defignore` entry that hides it from Bob. Bob requires a leading `/`. */
export const TYPED_NATIVE_IGNORE_ENTRY = `/${TYPED_NATIVE_EXTENSION}`;

/** The runtime a typed-native unit is a transport of. */
export const TYPED_NATIVE_RUNTIME = "hermes";

export const TYPED_NATIVE_REFUSAL_CODE = "typed-native-requires-hermes-runtime";

/**
 * The runtime that executes game code on one Defold bundle target.
 *
 * Derived from two pinned files rather than a list maintained here: the bundle
 * target table generated from Extender's own `build_input.yml` supplies the
 * platform group, and the native-artifact manifest supplies the builder that
 * produces that target's script artifact. `browser-host` is the declared
 * builder of the web targets, whose "artifact" is an Emscripten JavaScript
 * library rather than a Hermes archive. The two must agree; a disagreement is
 * a data defect and fails closed.
 */
async function readProjectToolchain(projectRoot) {
  if (!projectRoot) {
    throw new Error("A generated Defold project or authenticated toolchain policy is required to classify a target");
  }
  const lock = JSON.parse(await readFile(path.join(path.resolve(projectRoot), "deherm.lock"), "utf8"));
  if (lock.toolchain?.targetMatrix?.targets && lock.toolchain?.targetMatrix?.platformPairs) return lock.toolchain;
  throw new Error("deherm.lock has no authenticated Defold target matrix; run 'deherm generate'");
}

export async function defoldTargetRuntime(defoldPlatform, options = {}) {
  if (typeof defoldPlatform !== "string" || !defoldPlatform) {
    throw new TypeError("A Defold bundle platform is required");
  }
  const toolchain = options.toolchain ?? await readProjectToolchain(options.projectRoot);
  const targetMatrix = toolchain.targetMatrix;
  const pair = targetMatrix.platformPairs.find(
    (entry) => entry.bobPlatform === defoldPlatform || entry.extenderTarget === defoldPlatform
  );
  const target = pair?.extenderTarget ?? defoldPlatform;
  const declared = targetMatrix.targets.find((entry) => entry.target === target);
  if (!declared) {
    throw new Error(
      `${defoldPlatform} is not a Defold bundle target in ${targetMatrix.authority.targets}; ` +
      "deherm cannot decide which runtime would execute its game code");
  }
  const byGroup = declared.group === "web" ? "browser" : "hermes";
  return {
    platform: defoldPlatform,
    extenderTarget: target,
    group: declared.group,
    runtimeId: byGroup,
    artifact: null,
    source: targetMatrix.authority.targets
  };
}

/**
 * Whether a typed-native unit may be assembled for, and uploaded with, one
 * target. The refusal is data, not prose: a caller can act on `code` without
 * reading `reason`.
 */
export async function typedNativeDisposition(defoldPlatform, options = {}) {
  const runtime = await defoldTargetRuntime(defoldPlatform, options);
  if (runtime.runtimeId === TYPED_NATIVE_RUNTIME) {
    return { ...runtime, eligible: true, code: null, reason: null };
  }
  return {
    ...runtime,
    eligible: false,
    code: TYPED_NATIVE_REFUSAL_CODE,
    reason:
      `A Static Hermes unit is a transport of the 'hermes' runtime, and ${runtime.platform} runs game code ` +
      `on the '${runtime.runtimeId}' runtime, which embeds no Hermes. Its emitted C calls _sh_* entry points ` +
      "that only libhermes.a defines, so uploading one would fail the link rather than change a transport."
  };
}

/**
 * Make the project on disk match the target's disposition before Bob walks it.
 *
 * Idempotent in both directions, and it never deletes the materialised unit: a
 * web build hides it, and the next Hermes build reveals the same files again.
 * npm dependencies remain hidden on every target. The installed package
 * contains the revision-neutral extension seed; generation materialises the
 * selected revision into `/defold_hermes`, and Bob must never rediscover the
 * incomplete seed below `/node_modules` as a second native extension.
 */
export async function reconcileTypedNativeUpload(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const disposition = await typedNativeDisposition(options.platform, { projectRoot });
  const materialised = await access(path.join(projectRoot, TYPED_NATIVE_EXTENSION))
    .then(() => true, () => false);
  const defignore = path.join(projectRoot, ".defignore");
  const wanted = !disposition.eligible && materialised;
  const boundary = await reconcileBobProjectBoundary({
    projectRoot,
    includeEntries: wanted ? [TYPED_NATIVE_IGNORE_ENTRY] : [],
    excludeEntries: wanted ? [] : [TYPED_NATIVE_IGNORE_ENTRY]
  });
  const result = {
    ...disposition,
    defignore,
    materialised,
    ignored: wanted,
    changed: boundary.changed,
    message: ""
  };
  if (!boundary.changed) {
    result.message = wanted
      ? `${TYPED_NATIVE_EXTENSION} stays excluded from the ${disposition.platform} upload (${disposition.code})`
      : materialised
        ? `${TYPED_NATIVE_EXTENSION} is uploadable for ${disposition.platform} (runtime ${disposition.runtimeId})`
        : `no ${TYPED_NATIVE_EXTENSION} is materialised in this project`;
    return result;
  }
  if (wanted) {
    result.message =
      `${TYPED_NATIVE_EXTENSION} excluded from the ${disposition.platform} upload and npm tooling hidden through .defignore ` +
      `(${disposition.code})`;
    return result;
  }
  result.message =
    `${TYPED_NATIVE_EXTENSION} uploadable for ${disposition.platform}; npm tooling hidden through .defignore ` +
    `(runtime ${disposition.runtimeId})`;
  return result;
}
