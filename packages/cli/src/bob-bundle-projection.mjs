// Project the authored/development bundle into the one representation Bob is
// allowed to archive for a selected build. Release-native Hermes consumes HBC
// bytes, the browser consumes JavaScript, and a Static Hermes application is
// already linked into the executable. Source maps are never runtime resources.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { reconcileBobProjectBoundary } from "./bob-project-boundary.mjs";
import { expectedBundleArtifact } from "./build-artifacts.mjs";
import { TYPED_NATIVE_IGNORE_ENTRY, TYPED_NATIVE_RUNTIME, defoldTargetRuntime } from "./typed-native.mjs";

export const RELEASE_BUNDLE_RESOURCE = "/deherm/app.release.dehermc";
export const RELEASE_SETTINGS = ".deherm/bob-release.settings";

function releaseResource(resource) {
  if (!resource.endsWith(".dehermc")) {
    throw new Error(`The configured Defold Hermes application must end in .dehermc: ${resource}`);
  }
  return `${resource.slice(0, -".dehermc".length)}.release.dehermc`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeAtomically(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.deherm-tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function bobBundleProjection({ resource, runtimeId, variant, applicationMode = "dynamic" }) {
  if (!resource?.startsWith("/")) throw new Error("A configured absolute Defold bundle resource is required");
  if (!["debug", "release"].includes(variant)) throw new Error(`Unknown Bob variant: ${variant}`);
  if (!["dynamic", "static"].includes(applicationMode)) throw new Error(`Unknown application mode: ${applicationMode}`);
  const source = resource;
  const bytecode = `${resource}.hbc`;
  const sourceMap = `${resource}.map`;
  const release = releaseResource(resource);

  if (applicationMode === "static") {
    if (runtimeId !== "hermes") throw new Error("Static Hermes application mode requires the Hermes runtime");
    return {
      representation: "static-application",
      resource: null,
      include: [],
      ignore: [source, bytecode, sourceMap, release],
    };
  }
  if (variant !== "release") {
    return {
      representation: "javascript",
      resource: source,
      include: [source],
      ignore: [bytecode, sourceMap, release],
    };
  }
  if (runtimeId === "browser") {
    return {
      representation: "javascript",
      resource: source,
      include: [source],
      ignore: [bytecode, sourceMap, release],
    };
  }
  if (runtimeId === "hermes") {
    return {
      representation: "hermes-bytecode",
      resource: release,
      include: [release],
      ignore: [source, bytecode, sourceMap],
    };
  }
  throw new Error(`Unknown runtime for Bob bundle projection: ${runtimeId}`);
}

async function compileOptimizedBytecode(source, output, options = {}) {
  const sourceBytes = await readFile(source);
  const compiler = options.compiler ?? (await import("./host-compilers.mjs")).requireHostTool;
  const tool = await compiler("hermesc");
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.deherm-tmp-${process.pid}`;
  try {
    const result = spawnSync(tool.path, ["-O", "-emit-binary", `-out=${temporary}`, source], { encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(`hermesc failed for ${source}: ${result.stderr || result.stdout || "no output"}`);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  const outputBytes = await readFile(output);
  return {
    compiler: tool.path,
    sourceBytes: sourceBytes.length,
    sourceSha256: digest(sourceBytes),
    outputBytes: outputBytes.length,
    outputSha256: digest(outputBytes),
  };
}

export async function prepareBobBundleProjection(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const expected = await expectedBundleArtifact(projectRoot);
  if (!expected) throw new Error("game.project has no [defold_hermes] app resource");
  const runtime = await defoldTargetRuntime(options.platform, { projectRoot });
  const projection = bobBundleProjection({
    resource: expected.resource,
    runtimeId: runtime.runtimeId,
    variant: options.variant,
    applicationMode: options.applicationMode,
  });
  const releaseOutput = projection.resource
    ? path.join(projectRoot, projection.resource.slice(1))
    : path.join(projectRoot, releaseResource(expected.resource).slice(1));
  let compilation = null;
  if (projection.representation === "hermes-bytecode") {
    compilation = await compileOptimizedBytecode(path.join(projectRoot, expected.path), releaseOutput, options);
  }
  const settings = path.join(projectRoot, RELEASE_SETTINGS);
  if (projection.resource && projection.resource !== expected.resource) {
    await writeAtomically(settings, `[defold_hermes]\napp = ${projection.resource}\n`);
  } else {
    await rm(settings, { force: true });
  }
  // The managed block is replaceable by design, so every target-specific
  // decision must be present in this final pre-Bob write. Otherwise bundle
  // projection would accidentally reveal a Static Hermes unit that the target
  // selector had just hidden from a browser build.
  const typedNativeMaterialized = await access(path.join(projectRoot, TYPED_NATIVE_IGNORE_ENTRY.slice(1))).then(
    () => true,
    () => false,
  );
  const typedNativeIgnored = runtime.runtimeId !== TYPED_NATIVE_RUNTIME && typedNativeMaterialized;
  const boundary = await reconcileBobProjectBoundary({
    projectRoot,
    includeEntries: [...projection.ignore, ...(typedNativeIgnored ? [TYPED_NATIVE_IGNORE_ENTRY] : [])],
    excludeEntries: [...projection.include, ...(typedNativeIgnored ? [] : [TYPED_NATIVE_IGNORE_ENTRY])],
  });
  return {
    projectRoot,
    platform: runtime.platform,
    runtimeId: runtime.runtimeId,
    variant: options.variant,
    applicationMode: options.applicationMode ?? "dynamic",
    ...projection,
    settings: projection.resource && projection.resource !== expected.resource ? settings : null,
    compilation,
    typedNativeIgnored,
    boundaryChanged: boundary.changed,
  };
}
