import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { context } from "esbuild";
import ttsc from "@ttsc/unplugin/esbuild";

import {
  BUNDLE_FINGERPRINT_GLOBAL as fingerprintGlobal,
  applyBundleFingerprint,
  bundleFingerprintBanner,
  createBundleFingerprintPlaceholder
} from "../../../compiler/src/bundle-fingerprint.mjs";

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

export async function createIncrementalCompiler(options) {
  const entryPoint = path.resolve(options.entryPoint);
  const preludeEntries = [...new Set((options.preludeEntries ?? []).map((file) => path.resolve(file)))];
  const outputFile = path.resolve(options.outputFile);
  const mirrors = [...new Set((options.mirrors ?? []).map((file) => path.resolve(file)))];
  const resourcePath = normalizeResourcePath(options.resourcePath ?? path.basename(outputFile));
  const tsconfig = options.tsconfig ? path.resolve(options.tsconfig) : undefined;
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
    target: options.target ?? "es2020",
    plugins: options.useTtsc === false ? [] : [ttsc(tsconfig ? { project: tsconfig } : {})],
    ...(tsconfig ? { tsconfig } : {}),
    define: options.define,
    banner: { js: bundleFingerprintBanner(fingerprintPlaceholder) },
    sourcemap: options.sourcemap ?? true,
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
      const sourceMap = result.outputFiles.find(({ path: file }) => path.resolve(file) === `${outputFile}.map`);
      for (const mirror of mirrors) {
        if ((options.sourcemap ?? true) && sourceMap) {
          await writeAtomically(`${mirror}.map`, sourceMap.contents);
        }
        await writeAtomically(mirror, finalSource);
      }
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
      return { fingerprint, outputFile, resourcePaths: [resourcePath], metrics };
    },
    dispose: () => buildContext.dispose()
  };
}
