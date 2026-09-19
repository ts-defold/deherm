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

import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { extensionPlatform, readDefoldBundleTargets, readNativeArtifactManifest } from "./toolchains.mjs";

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
export async function defoldTargetRuntime(defoldPlatform) {
  if (typeof defoldPlatform !== "string" || !defoldPlatform) {
    throw new TypeError("A Defold bundle platform is required");
  }
  const target = extensionPlatform(defoldPlatform);
  const bundleTargets = await readDefoldBundleTargets();
  const declared = bundleTargets.targets.find((entry) => entry.target === target);
  if (!declared) {
    throw new Error(
      `${defoldPlatform} is not a Defold bundle target in ${bundleTargets.source}; ` +
      "deherm cannot decide which runtime would execute its game code");
  }
  const artifact = (await readNativeArtifactManifest()).targets?.[target];
  if (!artifact) {
    throw new Error(`The installed déherm package does not declare a ${target} script artifact`);
  }
  const byGroup = declared.group === "web" ? "browser" : "hermes";
  const byBuilder = artifact.builder === "browser-host" ? "browser" : "hermes";
  if (byGroup !== byBuilder) {
    throw new Error(
      `Pinned data disagrees about the ${target} runtime: bundle group '${declared.group}' implies ` +
      `${byGroup} and artifact builder '${artifact.builder}' implies ${byBuilder}`);
  }
  return {
    platform: defoldPlatform,
    extenderTarget: target,
    group: declared.group,
    runtimeId: byGroup,
    builder: artifact.builder ?? null,
    source: bundleTargets.source
  };
}

/**
 * Whether a typed-native unit may be assembled for, and uploaded with, one
 * target. The refusal is data, not prose: a caller can act on `code` without
 * reading `reason`.
 */
export async function typedNativeDisposition(defoldPlatform) {
  const runtime = await defoldTargetRuntime(defoldPlatform);
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

function parseIgnoreFile(text) {
  return text.split(/\r?\n/);
}

/**
 * Make the project on disk match the target's disposition before Bob walks it.
 *
 * Idempotent in both directions, and it never deletes the materialised unit: a
 * web build hides it, and the next Hermes build reveals the same files again.
 * The exclusion is written only when there is something to exclude, and the
 * `.defignore` itself is removed when this entry was its only content, so a
 * project that never assembled a unit is left exactly as it was.
 */
export async function reconcileTypedNativeUpload(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const disposition = await typedNativeDisposition(options.platform);
  const materialised = await access(path.join(projectRoot, TYPED_NATIVE_EXTENSION))
    .then(() => true, () => false);
  const defignore = path.join(projectRoot, ".defignore");
  let existing;
  try {
    existing = await readFile(defignore, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const lines = existing === undefined ? [] : parseIgnoreFile(existing);
  const present = lines.some((line) => line.trim() === TYPED_NATIVE_IGNORE_ENTRY);
  const wanted = !disposition.eligible && materialised;
  const result = {
    ...disposition,
    defignore,
    materialised,
    ignored: wanted,
    changed: present !== wanted,
    message: ""
  };
  if (present === wanted) {
    result.message = wanted
      ? `${TYPED_NATIVE_EXTENSION} stays excluded from the ${disposition.platform} upload (${disposition.code})`
      : materialised
        ? `${TYPED_NATIVE_EXTENSION} is uploadable for ${disposition.platform} (runtime ${disposition.runtimeId})`
        : `no ${TYPED_NATIVE_EXTENSION} is materialised in this project`;
    return result;
  }
  if (wanted) {
    const next = [...lines.filter((line, index) => line.trim() !== "" || index !== lines.length - 1)];
    next.push(TYPED_NATIVE_IGNORE_ENTRY);
    await writeFile(defignore, `${next.join("\n")}\n`);
    result.message =
      `${TYPED_NATIVE_EXTENSION} excluded from the ${disposition.platform} upload through .defignore ` +
      `(${disposition.code})`;
    return result;
  }
  const next = lines.filter((line) => line.trim() !== TYPED_NATIVE_IGNORE_ENTRY);
  if (next.every((line) => line.trim() === "")) await rm(defignore, { force: true });
  else await writeFile(defignore, `${next.join("\n").replace(/\n+$/, "")}\n`);
  result.message =
    `${TYPED_NATIVE_EXTENSION} re-enabled for the ${disposition.platform} upload (runtime ${disposition.runtimeId})`;
  return result;
}
