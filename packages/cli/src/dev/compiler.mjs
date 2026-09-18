import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { context } from "esbuild";
import ttsc from "@ttsc/unplugin/esbuild";

const fingerprintGlobal = "__DEFOLD_HERMES_BUILD_FINGERPRINT__";
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
  const outputFile = path.resolve(options.outputFile);
  const mirrors = [...new Set((options.mirrors ?? []).map((file) => path.resolve(file)))];
  const resourcePath = normalizeResourcePath(options.resourcePath ?? path.basename(outputFile));
  const fingerprintPlaceholder = randomBytes(32).toString("hex");
  if (Object.hasOwn(options.define ?? {}, fingerprintGlobal)) {
    throw new Error(`${fingerprintGlobal} is reserved by the deherm compiler`);
  }
  const buildContext = await context({
    entryPoints: [entryPoint],
    outfile: outputFile,
    bundle: true,
    format: "iife",
    platform: "neutral",
    target: options.target ?? "es2020",
    plugins: options.useTtsc === false ? [] : [ttsc()],
    define: options.define,
    banner: { js: `var ${fingerprintGlobal} = "${fingerprintPlaceholder}";` },
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
      const result = await buildContext.rebuild();
      const bundledOutput = result.outputFiles.find(({ path: file }) => path.resolve(file) === outputFile);
      if (!bundledOutput) throw new Error(`esbuild did not produce expected output: ${outputFile}`);
      const source = bundledOutput.text;
      const occurrences = source.split(fingerprintPlaceholder).length - 1;
      if (occurrences !== 1) {
        throw new Error(`expected one build fingerprint placeholder, found ${occurrences}`);
      }
      const placeholderIndex = source.indexOf(fingerprintPlaceholder);
      const canonicalSource = `${source.slice(0, placeholderIndex)}${"0".repeat(64)}${source.slice(placeholderIndex + 64)}`;
      const fingerprint = createHash("sha256").update(canonicalSource).digest("hex");
      const finalSource = `${source.slice(0, placeholderIndex)}${fingerprint}${source.slice(placeholderIndex + 64)}`;
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
