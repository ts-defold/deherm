import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { context } from "esbuild";

import {
  BUNDLE_FINGERPRINT_GLOBAL as fingerprintGlobal,
  applyBundleFingerprint,
  bundleFingerprintBanner,
  createBundleFingerprintPlaceholder
} from "../../../compiler/src/bundle-fingerprint.mjs";
import {
  loadDehermPluginConfig,
  transformProject
} from "../transform-compiler.mjs";

let temporarySequence = 0;

async function writeAtomically(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.deherm-tmp-${process.pid}-${temporarySequence += 1}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function normalizeResourcePath(value) {
  const resource = value.replaceAll("\\", "/");
  return resource.startsWith("/") ? resource : `/${resource}`;
}

// Compile the bundle to Hermes bytecode with the SHIPPED hermesc.
//
// Hermes parses JavaScript at load time unless it is handed bytecode, so a
// bundle shipped as source pays that parse on every start. hermesc is one of
// the tools deherm publishes per host precisely so this step never requires a
// native toolchain on the user's machine - and nothing called it, so every
// build shipped source and the published compiler was never the one that ran.
//
// Resolved through the host-compiler manifest rather than a build directory, so
// the repository exercises the same binary a user downloads. Failing closed is
// deliberate: a bundle that silently stays source is exactly the "someone
// forgot to run deherm" failure this seam exists to prevent.
//
// -O for release. Dev keeps -Og -g2 so a stack trace still names a line.
async function emitBytecode(outputFile, { optimize, sourceMapFile }) {
  const { requireHostTool } = await import("../host-compilers.mjs");
  const tool = await requireHostTool("hermesc");
  const bytecodeFile = `${outputFile}.hbc`;
  // `-source-map` feeds the INPUT bundle's map into hermesc, so the debug info
  // baked into the bytecode resolves through the bundle and back to the
  // TypeScript the author wrote. Without it a stack trace or a breakpoint lands
  // in generated bundle text, which is the same as having no source map at all.
  // `-g2` keeps location info for every instruction; `-Og` keeps the
  // optimisations that do not destroy that mapping.
  const result = spawnSync(tool.path, [
    ...(optimize ? ["-O"] : ["-Og", "-g2"]),
    ...(sourceMapFile ? [`-source-map=${sourceMapFile}`] : []),
    "-emit-binary",
    `-out=${bytecodeFile}`,
    outputFile
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`hermesc failed for ${outputFile}: ${result.stderr || result.stdout || "no output"}`);
  }
  return {
    file: bytecodeFile,
    bytes: (await stat(bytecodeFile)).size,
    optimized: Boolean(optimize),
    sourceMapped: Boolean(sourceMapFile)
  };
}

export async function createIncrementalCompiler(options) {
  const entryPoint = path.resolve(options.entryPoint);
  const preludeEntries = [...new Set((options.preludeEntries ?? []).map((file) => path.resolve(file)))];
  const outputFile = path.resolve(options.outputFile);
  const mirrors = [...new Set((options.mirrors ?? []).map((file) => path.resolve(file)))];
  const resourcePath = normalizeResourcePath(options.resourcePath ?? path.basename(outputFile));
  const tsconfig = options.tsconfig ? path.resolve(options.tsconfig) : undefined;
  const target = options.target ?? "es2020";
  const sourcemap = options.sourcemap ?? true;
  const useTtsc = options.useTtsc !== false;
  if (useTtsc && !tsconfig) {
    throw new Error("The déherm transform compiler requires a generated tsconfig");
  }
  let transformedSources = new Map();
  let transformInputFiles = [];
  const transformedSourcePlugin = {
    name: "deherm-precompiled-transform",
    setup(build) {
      build.onLoad({ filter: /\.[cm]?tsx?$/ }, (args) => {
        const source = transformedSources.get(path.resolve(args.path));
        if (source === undefined) return null;
        return {
          contents: source,
          loader: args.path.endsWith("x") ? "tsx" : "ts",
          watchFiles: transformInputFiles
        };
      });
    }
  };
  const refreshTransforms = async () => {
    if (!useTtsc) return;
    const projectRoot = path.dirname(tsconfig);
    const envelope = await transformProject({
      tsconfig,
      cwd: projectRoot,
      config: await loadDehermPluginConfig(tsconfig)
    });
    transformedSources = new Map(Object.entries(envelope.typescript ?? {}).map(([file, source]) => [
      path.resolve(projectRoot, file),
      source
    ]));
    const observedHostInputs = Object.entries(envelope.hostInputHashes ?? {})
      .filter(([, digest]) => typeof digest === "string")
      .map(([file]) => path.resolve(projectRoot, file));
    const configInputs = (envelope.graph?.configs ?? []).map((file) => path.resolve(projectRoot, file));
    transformInputFiles = [...new Set([
      ...transformedSources.keys(),
      ...observedHostInputs,
      ...configInputs
    ])].sort();
  };
  // Identical TypeScript compiled through a different entry point, tsconfig, or
  // output setting is a different program with a different fingerprint, so the
  // freshness binding covers these settings alongside the source contents.
  const configuration = {
    entryPoint,
    preludeEntries,
    tsconfig,
    resourcePath,
    target,
    sourcemap,
    format: "iife",
    platform: "neutral",
    ttsc: useTtsc,
    transformCompiler: useTtsc ? "dehermc" : null,
    define: options.define ?? null
  };
  const fingerprintPlaceholder = createBundleFingerprintPlaceholder();
  if (Object.hasOwn(options.define ?? {}, fingerprintGlobal)) {
    throw new Error(`${fingerprintGlobal} is reserved by the deherm compiler`);
  }
  const input = preludeEntries.length
    ? {
        stdin: {
          contents: [...preludeEntries, entryPoint]
            .map((file) => `import ${JSON.stringify(file)};`)
            .join("\n"),
          resolveDir: path.dirname(entryPoint),
          sourcefile: ".deherm-composed-entry.ts",
          loader: "ts"
        }
      }
    : { entryPoints: [entryPoint] };
  const buildContext = await context({
    ...input,
    outfile: outputFile,
    bundle: true,
    format: "iife",
    platform: "neutral",
    target,
    plugins: useTtsc ? [transformedSourcePlugin] : [],
    ...(tsconfig ? { tsconfig } : {}),
    define: options.define,
    banner: { js: bundleFingerprintBanner(fingerprintPlaceholder) },
    sourcemap,
    sourcesContent: true,
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    write: false
  });

  let previousBytes = 0;
  return {
    async rebuild(changedSources = []) {
      await options.beforeRebuild?.(changedSources);
      await refreshTransforms();
      await mkdir(path.dirname(outputFile), { recursive: true });
      const startedAt = performance.now();
      const diagnosticChunks = [];
      const originalStderrWrite = process.stderr.write;
      if (options.captureDiagnostics !== false) {
        process.stderr.write = function capturedDiagnostic(chunk, encoding, callback) {
          diagnosticChunks.push(Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk));
          if (typeof encoding === "function") queueMicrotask(encoding);
          else if (typeof callback === "function") queueMicrotask(callback);
          return true;
        };
      }
      let result;
      try {
        result = await buildContext.rebuild();
      } catch (error) {
        const diagnostics = diagnosticChunks.join("").trim();
        if (diagnostics) {
          const message = `${error instanceof Error ? error.message : String(error)}\n${diagnostics}`;
          throw new Error(message, { cause: error });
        }
        throw error;
      } finally {
        process.stderr.write = originalStderrWrite;
      }
      const bundledOutput = result.outputFiles.find(({ path: file }) => path.resolve(file) === outputFile);
      if (!bundledOutput) throw new Error(`esbuild did not produce expected output: ${outputFile}`);
      const { fingerprint, source: finalSource } =
          applyBundleFingerprint(bundledOutput.text, fingerprintPlaceholder);
      for (const artifact of result.outputFiles.filter(({ path: file }) => path.resolve(file) !== outputFile)) {
        await writeAtomically(artifact.path, artifact.contents);
      }
      await writeAtomically(outputFile, finalSource);
      // Bytecode is produced from the written bundle, after the fingerprint is
      // stamped, so the .hbc corresponds to the exact bytes on disk.
      const bytecode = options.bytecode
        ? await emitBytecode(outputFile, {
            optimize: options.bytecodeOptimize !== false,
            // The bundle's own map is written above, before this runs.
            sourceMapFile: sourcemap ? `${outputFile}.map` : null
          })
        : null;
      const sourceMap = result.outputFiles.find(({ path: file }) => path.resolve(file) === `${outputFile}.map`);
      for (const mirror of mirrors) {
        if (sourcemap && sourceMap) {
          await writeAtomically(`${mirror}.map`, sourceMap.contents);
        }
        await writeAtomically(mirror, finalSource);
        // The bytecode travels with the bundle it was compiled from. Bob
        // archives the mirror, so a .hbc left only beside outputFile would
        // never reach the engine.
        if (bytecode) {
          await writeAtomically(`${mirror}.hbc`, await readFile(bytecode.file));
        }
      }
      // Every file the bundler read is a build input, whether or not it
      // contributed bytes: a type-only module can still change the emitted
      // program through a ttsc transform. The freshness binding in deherm.lock
      // is only as honest as this list, so it is the bundler's whole input
      // closure and not the retained-module census below.
      const sources = [...new Set([
        ...Object.keys(result.metafile.inputs).map((file) => path.resolve(file)),
        ...transformInputFiles
      ])].sort();
      const output = Object.entries(result.metafile.outputs).find(([file]) => path.resolve(file) === outputFile)?.[1];
      const bytes = Buffer.byteLength(finalSource);
      const modules = Object.entries(output?.inputs ?? {})
        .map(([file, contribution]) => ({ file, bytes: contribution.bytesInOutput }))
        .filter(({ bytes: retained }) => retained > 0)
        .sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file));
      const metrics = {
        durationMs: performance.now() - startedAt,
        bytes,
        byteDelta: bytes - previousBytes,
        moduleCount: modules.length,
        modules
      };
      previousBytes = bytes;
      const build = { fingerprint, outputFile, bytecode, mirrors, resourcePaths: [resourcePath], sources, configuration, metrics };
      await options.afterRebuild?.(build);
      return build;
    },
    dispose: () => buildContext.dispose()
  };
}
