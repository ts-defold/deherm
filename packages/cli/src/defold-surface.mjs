// Layer-0 of the layered API policy cache: the generated Defold engine surface
// for one immutable engine revision.
//
// See `.agents/docs/decisions/layered-api-policy-cache.md`. Layer 0 is keyed by
// the Defold revision alone and is produced once per revision, never per
// `deherm generate`. The déherm package ships no layer-0 surface. A selected
// revision is resolved from a descriptor-backed user/project cache populated
// from its authenticated policy. A repository checkout may expose its generated
// tree only as a final contributor fallback; an npm package carries neither the
// checkout marker nor that generated tree.
//
// Two things are deliberately kept apart here and were conflated before:
//
//   * the Defold revision, which decides the engine surface, and
//   * the native input set, which decides the project's extension surface.
//
// They move independently: a user upgrades Defold without touching extensions,
// or vendors an extension without touching Defold. The generation cache key is
// therefore a Merkle root over two sibling nodes rather than one digest over
// everything, so changing one leaves the other's subtree valid and a root
// mismatch resolves down to the leaf that actually moved.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { DEFOLD_REVISION_PATTERN } from "./defold-revision.mjs";

// Every file a surface layer must provide, by the key the generator uses for it.
// `ir` files are the version-specific binding IR; `sdk` is the generated
// TypeScript surface derived from them. A layer that is missing any of these is
// incomplete and is not used.
export const surfaceIrFiles = Object.freeze({
  valueLayoutsPath: "defold-value-layouts.json",
  scriptIrPath: "defold-script-api-ir.json",
  scriptConstantLoweringPath: "defold-script-constant-lowering.json",
  dmsdkIrPath: "defold-sdk-ir.json",
  scriptDispatchPath: "defold-script-scalar-dispatch.json",
  scriptPatternsPath: "defold-script-binding-patterns.json",
  dmsdkPatternsPath: "defold-dmsdk-binding-patterns.json",
  scriptProbesPath: "defold-script-real-engine-probes.json",
  scriptAccountingPath: "defold-script-api-accounting.json",
  scriptUniversalPath: "defold-script-universal-value-bindings.json",
  scriptProfilesPath: "defold-script-route-availability-profiles.json",
  loweringPlanPath: "defold-binding-lowering-plan.json",
  loweringPlanSentinelPath: "defold-binding-lowering-plan.sentinel.json",
  dmsdkThunksPath: "defold-dmsdk-scalar-thunks.json",
  dmsdkUniversalPath: "defold-dmsdk-universal-bindings.json",
  resourceSchemaPath: "defold-resource-declaration-schema.json",
  resourceNamespacesPath: "defold-script-resource-namespaces.json",
  toolchainPath: "defold-toolchain.json"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digestOf(value) {
  return sha256(JSON.stringify(canonical(value)));
}

export function defoldSurfaceCacheHome(env = process.env, platform = process.platform, userHome = homedir()) {
  if (env.DEHERM_CACHE_HOME) return path.resolve(env.DEHERM_CACHE_HOME);
  if (env.XDG_CACHE_HOME) return path.join(path.resolve(env.XDG_CACHE_HOME), "deherm");
  if (platform === "darwin") return path.join(userHome, "Library", "Caches", "deherm");
  if (platform === "win32") {
    const windowsCache = env.LOCALAPPDATA
      ? path.resolve(env.LOCALAPPDATA)
      : path.join(userHome, "AppData", "Local");
    return path.join(windowsCache, "deherm", "cache");
  }
  return path.join(userHome, ".cache", "deherm");
}

/**
 * The pre-native-default cache location, read-only and lower priority.
 *
 * Existing macOS and Windows caches are not moved or rewritten implicitly.
 * A successful read keeps an older installation usable while every new write
 * goes to the native cache root. Explicit DEHERM/XDG roots are authoritative
 * and never acquire an implicit fallback.
 */
export function defoldSurfaceLegacyCacheHome(
  env = process.env,
  platform = process.platform,
  userHome = homedir()
) {
  if (env.DEHERM_CACHE_HOME || env.XDG_CACHE_HOME) return null;
  if (platform !== "darwin" && platform !== "win32") return null;
  return path.join(userHome, ".cache", "deherm");
}

function cacheSurfaceLayer(layer, cacheHome, revision) {
  const root = path.join(cacheHome, "surfaces", revision);
  return {
    layer,
    root,
    irRoot: path.join(root, "ir"),
    sdkRoot: path.join(root, "sdk"),
    repositoryRoot: path.join(root, "repository"),
    descriptor: path.join(root, "surface.json")
  };
}

/**
 * Where a layer-0 surface for `revision` may live, most preferred first.
 *
 * The user cache is shared across that user's projects; the project cache makes
 * a checkout self-contained for CI. A source checkout is considered last for
 * repository dogfooding, never as an installed-package contract.
 */
export function defoldSurfaceSearchPath(revision, options = {}) {
  const packageRoot = options.packageRoot;
  const projectRoot = options.projectRoot;
  const layers = [];
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();
  const cacheHome = defoldSurfaceCacheHome(env, platform, userHome);
  layers.push(cacheSurfaceLayer("user-cache", cacheHome, revision));
  const legacyCacheHome = defoldSurfaceLegacyCacheHome(env, platform, userHome);
  if (legacyCacheHome && path.resolve(legacyCacheHome) !== path.resolve(cacheHome)) {
    layers.push(cacheSurfaceLayer("legacy-user-cache", legacyCacheHome, revision));
  }
  if (projectRoot) {
    const root = path.join(projectRoot, ".deherm", "cache", "surfaces", revision);
    layers.push({
      layer: "project-cache",
      root,
      irRoot: path.join(root, "ir"),
      sdkRoot: path.join(root, "sdk"),
      repositoryRoot: path.join(root, "repository"),
      descriptor: path.join(root, "surface.json")
    });
  }
  if (packageRoot) {
    layers.push({
      layer: "repository-checkout",
      root: packageRoot,
      irRoot: path.join(packageRoot, "packages", "bindings", "generated"),
      sdkRoot: path.join(packageRoot, "packages", "sdk", "src"),
      repositoryRoot: packageRoot,
      descriptor: null,
      repositoryMarker: path.join(packageRoot, "pnpm-workspace.yaml"),
      policyManifest: path.join(packageRoot, "packages", "bindings", "generated", "defold-api-policy.json")
    });
  }
  return layers;
}

async function layerProvides(candidate, revision) {
  const missing = [];
  let descriptor = null;
  let toolchain = null;
  let artifacts = null;
  if (candidate.repositoryMarker) {
    try {
      const information = await stat(candidate.repositoryMarker);
      if (!information.isFile()) return { ok: false, missing: ["repository checkout marker"] };
    } catch {
      return { ok: false, missing: ["repository checkout marker"] };
    }
  }
  for (const [key, relative] of Object.entries(surfaceIrFiles)) {
    if (key === "toolchainPath" && candidate.policyManifest) continue;
    const file = path.join(candidate.irRoot, relative);
    try {
      const information = await stat(file);
      if (!information.isFile()) missing.push(relative);
    } catch {
      missing.push(relative);
    }
  }
  if (missing.length) return { ok: false, missing };
  if (candidate.descriptor) {
    try {
      descriptor = JSON.parse(await readFile(candidate.descriptor, "utf8"));
    } catch (error) {
      return { ok: false, missing: ["surface.json"], error: error?.code === "ENOENT" ? undefined : error.message };
    }
    if (descriptor.kind !== "deherm.materialized-defold-surface" || descriptor.defoldRevision !== revision) {
      return { ok: false, missing: [], revision: descriptor.defoldRevision, error: "invalid surface descriptor" };
    }
    for (const relative of Object.keys(descriptor.sdk ?? {})) {
      try {
        const information = await stat(path.join(candidate.sdkRoot, "generated", relative));
        if (!information.isFile()) missing.push(`sdk/generated/${relative}`);
      } catch {
        missing.push(`sdk/generated/${relative}`);
      }
    }
    for (const relative of Object.keys(descriptor.outputs ?? {})) {
      try {
        const information = await stat(path.join(candidate.repositoryRoot, relative));
        if (!information.isFile()) missing.push(`repository/${relative}`);
      } catch {
        missing.push(`repository/${relative}`);
      }
    }
    if (missing.length) return { ok: false, missing };
    if (!/^[0-9a-f]{64}$/u.test(descriptor.sdkTreeSha256 ?? "") ||
        !/^[0-9a-f]{64}$/u.test(descriptor.outputTreeSha256 ?? "")) {
      return { ok: false, missing: [], error: "surface descriptor has no authenticated tree digests" };
    }
    if (!/^[0-9a-f]{64}$/u.test(descriptor.toolchainSha256 ?? "")) {
      return { ok: false, missing: [], error: "surface descriptor has no authenticated toolchain digest" };
    }
    try {
      const bytes = await readFile(path.join(candidate.irRoot, surfaceIrFiles.toolchainPath));
      if (sha256(bytes) !== descriptor.toolchainSha256) {
        return { ok: false, missing: [], error: "surface toolchain digest mismatch" };
      }
      toolchain = JSON.parse(bytes);
      if (toolchain.kind !== "deherm.policy.toolchain") {
        return { ok: false, missing: [], error: "surface toolchain object has invalid kind" };
      }
    } catch (error) {
      return { ok: false, missing: [surfaceIrFiles.toolchainPath], error: error.message };
    }
    if (descriptor.artifactsSha256) {
      try {
        const bytes = await readFile(path.join(candidate.irRoot, "defold-artifacts.json"));
        if (sha256(bytes) !== descriptor.artifactsSha256) {
          return { ok: false, missing: [], error: "surface artifact mapping digest mismatch" };
        }
        artifacts = JSON.parse(bytes);
      } catch (error) {
        return { ok: false, missing: ["defold-artifacts.json"], error: error.message };
      }
    }
  }
  let declared;
  try {
    declared = JSON.parse(await readFile(path.join(candidate.irRoot, surfaceIrFiles.scriptIrPath), "utf8")).defoldRevision;
  } catch (error) {
    return { ok: false, missing: [], error: error.message };
  }
  if (declared !== revision) return { ok: false, missing: [], revision: declared };
  if (candidate.policyManifest) {
    try {
      const manifest = JSON.parse(await readFile(candidate.policyManifest, "utf8"));
      const digest = manifest.subtrees?.["@toolchain"]?.hash;
      if (manifest.defoldRevision !== revision || !/^[0-9a-f]{64}$/u.test(digest ?? "")) {
        return { ok: false, missing: [], error: "invalid repository policy toolchain reference" };
      }
      const objectFile = path.join(candidate.irRoot, "policy", manifest.layoutVersion, "object", `${digest}.json`);
      const bytes = await readFile(objectFile);
      if (sha256(bytes) !== digest) return { ok: false, missing: [], error: "repository toolchain object digest mismatch" };
      toolchain = JSON.parse(bytes);
      if (toolchain.kind !== "deherm.policy.toolchain") {
        return { ok: false, missing: [], error: "repository toolchain object has invalid kind" };
      }
    } catch (error) {
      return { ok: false, missing: [], error: `unreadable repository toolchain: ${error.message}` };
    }
  }
  return { ok: true, missing: [], descriptor, toolchain, artifacts };
}

export class DefoldSurfaceError extends Error {
  constructor(blocker) {
    super(blocker.message);
    this.name = "DefoldSurfaceError";
    this.code = blocker.code;
    this.blocker = blocker;
  }
}

/**
 * Resolve the layer-0 surface for one Defold revision, or explain precisely why
 * there is none. Never falls back to a different revision's surface.
 */
export async function resolveDefoldSurface(revision, options = {}) {
  if (!DEFOLD_REVISION_PATTERN.test(String(revision))) {
    throw new Error(`A Defold surface is keyed by a 40-character engine SHA, got ${JSON.stringify(revision)}`);
  }
  const searched = [];
  for (const candidate of defoldSurfaceSearchPath(revision, options)) {
    const result = await layerProvides(candidate, revision);
    if (result.ok) {
      return {
        schemaVersion: 1,
        revision,
        layer: candidate.layer,
        irRoot: candidate.irRoot,
        sdkRoot: candidate.sdkRoot,
        repositoryRoot: candidate.repositoryRoot,
        descriptor: result.descriptor,
        toolchain: result.toolchain,
        artifacts: result.artifacts,
        paths: Object.fromEntries(Object.entries(surfaceIrFiles)
          .map(([key, relative]) => [key, path.join(candidate.irRoot, relative)])),
        searched,
        blocker: null
      };
    }
    searched.push({
      layer: candidate.layer,
      root: candidate.root ?? candidate.irRoot,
      reason: result.revision ? `holds Defold ${result.revision}` :
        result.error ? `unreadable: ${result.error}` :
        result.missing.length === Object.keys(surfaceIrFiles).length ? "absent" :
        `incomplete, missing ${result.missing.join(", ")}`
    });
  }
  return {
    schemaVersion: 1,
    revision,
    layer: null,
    irRoot: null,
    sdkRoot: null,
    paths: null,
    searched,
    blocker: {
      code: "defold-surface-not-cached",
      message: [
        `No generated Defold API surface is available for engine revision ${revision}.`,
        "Searched:",
        ...searched.map((entry) => `  - ${entry.layer}: ${entry.root} (${entry.reason})`),
        "Run `deherm policy --defold-sdk <revision-or-SDK>` to fetch the authenticated published policy",
        "and materialize its revision-keyed surface using the compiler shipped in this package.",
        "No Defold source checkout or reference archive is required for a published revision.",
        "Until that surface exists, generating for this revision would mean emitting another revision's",
        "signatures, which is refused."
      ].join("\n")
    }
  };
}

export function assertResolvedDefoldSurface(surface) {
  if (surface.blocker) throw new DefoldSurfaceError(surface.blocker);
  return surface;
}

// --- Generation cache key -------------------------------------------------
//
// A Merkle root over two independent subtrees. `engine` covers everything the
// Defold revision decides; `native` covers everything the project's own native
// input set decides. Leaf and node ordering is path-sorted so the root is a
// function of content and structure only.

function extensionLeaves(extension) {
  const leaves = [];
  for (const api of extension.scriptApis ?? []) {
    leaves.push({ path: api.path, kind: "script-api", digest: digestOf(api.declarations ?? []) });
  }
  for (const header of extension.publicHeaders ?? []) {
    leaves.push({ path: header, kind: "public-header", digest: null });
  }
  for (const source of extension.sourceFiles ?? []) {
    leaves.push({ path: source, kind: "native-source", digest: null });
  }
  return leaves.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function buildGenerationMerkle({ defoldRevision, surface, extensions = [], engineProfiles = null, generator = null }) {
  const engineNode = {
    kind: "engine",
    defoldRevision,
    surfaceLayer: surface?.layer ?? null,
    surfaceInputs: surface?.inputs ?? null,
    engineProfiles
  };
  const nativeChildren = [...extensions]
    .map((extension) => {
      const leaves = extensionLeaves(extension);
      return {
        kind: "extension",
        name: extension.name,
        // The archive or tree the extension came from, which is what a layer-1
        // or layer-2 policy would be keyed by.
        origin: extension.archive ?? extension.root ?? extension.manifestPath,
        manifestPath: extension.manifestPath,
        leaves,
        digest: digestOf(leaves)
      };
    })
    .sort((left, right) => left.manifestPath < right.manifestPath ? -1 : left.manifestPath > right.manifestPath ? 1 : 0);
  const nativeNode = { kind: "native-inputs", children: nativeChildren };
  const engineRoot = digestOf(engineNode);
  const nativeRoot = digestOf(nativeNode);
  return {
    schemaVersion: 1,
    // The two keys are named separately on purpose: a caller can ask "did the
    // engine move" and "did the native inputs move" without rehashing, and a
    // root mismatch is attributable before anything is regenerated.
    engineRoot,
    nativeRoot,
    root: digestOf({ generator, engineRoot, nativeRoot }),
    nodes: { engine: engineNode, native: nativeNode }
  };
}
