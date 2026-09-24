import { createRequire } from "node:module";
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILD_ARTIFACT_SCHEMA,
  buildArtifactRecord,
  checkBuildArtifacts,
  digestSourceFiles,
  formatBuildArtifactReport,
  portableRelativePath,
  sha256,
  summarizeBuildArtifacts
} from "../../compiler/src/bundle-freshness.mjs";
import { parseGameProject } from "./project.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export { BUILD_ARTIFACT_SCHEMA, formatBuildArtifactReport, summarizeBuildArtifacts };

function lockFile(projectRoot) {
  return path.join(path.resolve(projectRoot), "deherm.lock");
}

export async function readProjectLock(projectRoot) {
  try {
    return JSON.parse(await readFile(lockFile(projectRoot), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeProjectLock(projectRoot, lock) {
  const file = lockFile(projectRoot);
  const temporary = `${file}.deherm-tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The toolchain identity a freshness record is compared against. Different
 * bundler bytes can produce a different fingerprint from identical TypeScript,
 * so drift is reported - but as a warning, because the program is the same and
 * the user has done nothing wrong.
 */
export async function installedToolchain() {
  const identity = {};
  try {
    identity.deherm = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;
  } catch {
    // A freshness check must work from an installed package layout that does
    // not ship the workspace manifest.
  }
  try {
    const require = createRequire(import.meta.url);
    identity.esbuild = JSON.parse(await readFile(require.resolve("esbuild/package.json"), "utf8")).version;
  } catch {
    // esbuild is only needed to *produce* a bundle; the cheap check must not
    // require it to be resolvable.
  }
  return identity;
}

/**
 * Bob archives the `/deherm` directory as a `custom_resources` entry and the
 * extension loads the resource named by `[defold_hermes] app`, so that setting -
 * not a convention in this code - decides which file must be fresh.
 */
export async function expectedBundleArtifact(projectRoot) {
  let properties;
  try {
    properties = parseGameProject(await readFile(path.join(path.resolve(projectRoot), "game.project"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const resource = properties.defold_hermes?.app;
  if (typeof resource !== "string" || !resource.startsWith("/")) return null;
  return { kind: "bundle", resource, path: resource.slice(1) };
}

/**
 * Bind a materialised artifact to the sources it was produced from and store
 * the relation in `deherm.lock`. Every producer - the development bundler
 * today, the `shermes -emit-c` assembler when it lands - records through here,
 * so there is one shape of evidence and one place that defines it.
 */
export async function recordBuildArtifact({ projectRoot, kind, resource, artifacts, sources, build, fingerprint }) {
  const root = path.resolve(projectRoot);
  // A bundler reports its inputs through whichever spelling of the project
  // directory it resolved, which on macOS is the /private form of a symlinked
  // temporary or home directory. Both spellings name the same project, so the
  // one that keeps a path inside the project is the one recorded.
  const realRoot = await realpath(root).catch(() => root);
  const relativeInProject = (file) => {
    for (const base of new Set([root, realRoot])) {
      const relative = portableRelativePath(base, file);
      if (relative && !relative.startsWith("../")) return relative;
    }
    return portableRelativePath(root, file);
  };
  const outputs = {};
  for (const file of artifacts) {
    const relative = relativeInProject(file);
    if (!relative || relative.startsWith("../")) {
      throw new Error(`Build artifact ${file} is not inside the Defold project ${root}`);
    }
    outputs[relative] = sha256(await readFile(file));
  }
  const sourcePaths = [];
  let unportable = 0;
  for (const file of sources) {
    const relative = relativeInProject(file);
    if (!relative) unportable += 1;
    else sourcePaths.push(relative);
  }
  // A bundler input that is not a file on disk - the synthesised entry module
  // that imports the component registry and the app entry - cannot be hashed
  // and cannot drift independently of the settings that generate it, which the
  // build configuration already covers.
  const { files, missing } = await digestSourceFiles(root, sourcePaths);
  const syntheticInputCount = missing.length;
  const record = buildArtifactRecord({
    kind,
    resource,
    fingerprint,
    artifacts: outputs,
    files,
    build: {
      ...build,
      ...(unportable ? { unportableInputCount: unportable } : {}),
      ...(syntheticInputCount ? { syntheticInputCount } : {})
    }
  });
  const lock = await readProjectLock(root);
  if (!lock) throw new Error(`No deherm.lock in ${root}; run 'deherm generate' before recording build artifacts`);
  const name = Object.keys(outputs)[0];
  const existing = lock.buildArtifacts?.artifacts ?? {};
  const merged = { ...existing, [name]: record };
  const next = {
    ...lock,
    buildArtifacts: {
      schema: BUILD_ARTIFACT_SCHEMA,
      artifacts: Object.fromEntries(Object.entries(merged).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    }
  };
  // A development rebuild that changed nothing must not churn the lock.
  if (JSON.stringify(lock.buildArtifacts) === JSON.stringify(next.buildArtifacts)) return { record, written: false };
  await writeProjectLock(root, next);
  return { record, written: true };
}

/**
 * Record the bundle a development or one-shot build just wrote into the
 * project tree. The artifact bound here is the copy Bob archives - the one at
 * the resource path from `game.project` - not the session's private scratch
 * output, because the copy on Bob's input path is the one that can go stale.
 */
export async function recordBundleBuild({ projectRoot, build, toolchain }) {
  const root = path.resolve(projectRoot);
  const configuration = build.configuration ?? {};
  const resource = configuration.resourcePath ?? null;
  const target = resource?.slice(1);
  const artifact = [build.outputFile, ...(build.mirrors ?? [])]
    .find((file) => target && portableRelativePath(root, file) === target);
  if (!artifact) return { record: null, written: false, reason: "no-project-artifact" };
  const relativeOrNull = (file) => (file ? portableRelativePath(root, file) : null);
  return await recordBuildArtifact({
    projectRoot: root,
    kind: "bundle",
    resource,
    fingerprint: build.fingerprint,
    artifacts: [artifact],
    sources: build.sources ?? [],
    build: {
      entryPoint: relativeOrNull(configuration.entryPoint),
      preludeEntries: (configuration.preludeEntries ?? []).map(relativeOrNull),
      tsconfig: relativeOrNull(configuration.tsconfig),
      target: configuration.target ?? null,
      format: configuration.format ?? null,
      platform: configuration.platform ?? null,
      sourcemap: configuration.sourcemap ?? null,
      ttsc: configuration.ttsc ?? null,
      define: configuration.define ?? null,
      toolchain: toolchain ?? await installedToolchain()
    }
  });
}

/**
 * The cheap gate: recompute every recorded binding from the working tree.
 *
 * This is a hash comparison over the files the artifact was built from, never a
 * compile, so it is safe to run before every Bob invocation and in a watch loop.
 */
export async function verifyProjectBuildArtifacts(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const lock = await readProjectLock(root);
  const expectedBundle = options.expected ?? await expectedBundleArtifact(root);
  const expected = expectedBundle ? [expectedBundle] : [];
  const result = await checkBuildArtifacts({
    projectRoot: root,
    lock: lock ?? {},
    expected,
    toolchain: await installedToolchain()
  });
  if (!lock) {
    result.entries.unshift({
      name: "deherm.lock",
      kind: "bundle",
      resource: null,
      status: "lock-missing",
      severity: "warn",
      fingerprint: null,
      sources: null,
      outputs: [],
      toolchainDrift: [],
      build: null
    });
  }
  // Before Bob, an artifact nobody can relate to a source tree is as
  // unacceptable as one that provably disagrees with it: in both cases the
  // packaged game may be running code nobody checked. Elsewhere the same state
  // is only worth reporting.
  if (options.requireBinding) {
    for (const entry of result.entries) {
      if (["unbound", "artifact-absent", "lock-missing"].includes(entry.status)) entry.severity = "error";
    }
  }
  if (options.requireTransforms) {
    for (const entry of result.entries) {
      if (entry.kind === "bundle" && entry.build?.ttsc === false) {
        entry.status = "transform-disabled";
        entry.severity = "error";
      }
    }
  }
  return summarizeBuildArtifacts(result);
}

/**
 * The exact answer, on demand. The cheap check can say that the sources moved;
 * only a bundle of the current sources can say which fingerprint they produce.
 * It writes to a scratch directory, never over the artifact Bob will archive,
 * so asking the question cannot change the answer.
 */
export async function recomputeBundleFingerprint(projectRoot, entry) {
  const root = path.resolve(projectRoot);
  const build = entry?.build;
  if (!build?.entryPoint) {
    throw new Error(`deherm.lock records no bundler entry point for ${entry?.name ?? "the bundle"}; rebuild it once to record one`);
  }
  const { createIncrementalCompiler } = await import("./dev/compiler.mjs");
  const scratch = await mkdtemp(path.join(tmpdir(), "deherm-fingerprint-"));
  try {
    const compiler = await createIncrementalCompiler({
      entryPoint: path.resolve(root, build.entryPoint),
      preludeEntries: (build.preludeEntries ?? []).map((file) => path.resolve(root, file)),
      tsconfig: build.tsconfig ? path.resolve(root, build.tsconfig) : undefined,
      outputFile: path.join(scratch, path.basename(entry.outputs[0].path)),
      resourcePath: entry.resource ?? undefined,
      target: build.target ?? undefined,
      useTtsc: build.ttsc !== false,
      // Every setting that moved a byte of the recorded bundle is replayed,
      // including the source map, whose linked comment is part of the hashed
      // program text.
      sourcemap: build.sourcemap ?? undefined,
      define: build.define ?? undefined,
      captureDiagnostics: false
    });
    try {
      const rebuilt = await compiler.rebuild([]);
      return { fingerprint: rebuilt.fingerprint, sources: rebuilt.sources };
    } finally {
      await compiler.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
