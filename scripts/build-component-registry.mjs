import { createHash } from "node:crypto";
import { build } from "esbuild";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateComponentProxies } from "./lib/component-proxy-generator.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function regularFile(file) {
  try {
    const stat = await lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${sha256(file).slice(0, 8)}`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseArguments(argv) {
  const options = { projectRoot: null, outputRoot: null, check: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") options.projectRoot = path.resolve(argv[++index]);
    else if (argument === "--output-root") options.outputRoot = path.resolve(argv[++index]);
    else if (argument === "--check") options.check = true;
    else if (argument === "--force") options.force = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.projectRoot) throw new Error("build-component-registry requires --project <Defold project>");
  if (options.check && options.force) throw new Error("--check and --force are mutually exclusive");
  options.outputRoot ??= path.join(options.projectRoot, ".deherm", "build", "components");
  return options;
}

async function verifySentinel(sentinelPath, outputRoot, key, deep) {
  let sentinel;
  try {
    sentinel = JSON.parse(await readFile(sentinelPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  if (sentinel.schemaVersion !== 1 || sentinel.cacheKey !== key) return null;
  const names = Object.keys(sentinel.outputs ?? {}).sort(compareCodeUnits);
  if (!names.length) return null;
  for (const name of names) {
    const absolute = path.resolve(outputRoot, name);
    const relative = path.relative(outputRoot, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Component bundle sentinel contains unsafe output ${JSON.stringify(name)}`);
    }
    const stat = await regularFile(absolute);
    if (!stat || stat.size !== sentinel.outputs[name].size) return null;
    if (deep && sha256(await readFile(absolute)) !== sentinel.outputs[name].sha256) {
      throw new Error(`Component bundle output is stale: ${absolute}`);
    }
  }
  return sentinel;
}

export async function buildComponentRegistry(argv = []) {
  const options = Array.isArray(argv) ? parseArguments(argv) : argv;
  options.projectRoot = path.resolve(options.projectRoot);
  options.outputRoot = path.resolve(options.outputRoot ?? path.join(options.projectRoot, ".deherm", "build", "components"));
  const generated = await generateComponentProxies({
    projectRoot: options.projectRoot,
    outputRoot: options.projectRoot,
    check: options.check === true
  });
  const registryPath = path.join(options.projectRoot, ".deherm", "generated", "components", "registry.ts");
  const manifestPath = path.join(options.projectRoot, ".deherm", "generated", "components", "manifest.json");
  const [registrySource, manifestSource, generatorSource, buildSource] = await Promise.all([
    readFile(registryPath),
    readFile(manifestPath),
    readFile(path.join(repositoryRoot, "packages/compiler/src/component-proxy-generator.mjs")),
    readFile(fileURLToPath(import.meta.url))
  ]);
  const manifest = JSON.parse(manifestSource);
  const key = sha256(JSON.stringify({
    schemaVersion: 1,
    generator: sha256(generatorSource),
    builder: sha256(buildSource),
    registry: sha256(registrySource),
    manifest: sha256(manifestSource),
    target: "es2020",
    format: "iife",
    platform: "neutral"
  }));
  const sentinelPath = path.join(options.outputRoot, "component-bundle.sentinel.json");
  const current = !options.force && await verifySentinel(sentinelPath, options.outputRoot, key, options.check === true);
  if (current) return { cacheHit: true, key, manifest, sentinel: current, generated };
  if (options.check) throw new Error("Component registry bundle is missing or stale; run without --check to regenerate it");

  const buildResult = await build({
    absWorkingDir: options.projectRoot,
    entryPoints: [registryPath],
    outdir: options.outputRoot,
    entryNames: "components",
    bundle: true,
    write: false,
    format: "iife",
    platform: "neutral",
    target: "es2020",
    legalComments: "none",
    sourcemap: "external",
    metafile: true,
    alias: {
      "@ts-defold/deherm/component": path.join(repositoryRoot, "packages/sdk/src/component.ts")
    }
  });
  const js = buildResult.outputFiles.find(({ path: file }) => file.endsWith(".js"));
  const map = buildResult.outputFiles.find(({ path: file }) => file.endsWith(".js.map"));
  if (!js || !map) throw new Error("Component registry bundler did not emit JavaScript and source map outputs");
  const usage = `${JSON.stringify({
    schemaVersion: 1,
    generator: "scripts/build-component-registry.mjs",
    cacheKey: key,
    registry: "__defoldComponentsV1",
    componentOnlyBootstrap: true,
    components: manifest.components.map(({ componentId, source, contextKind, schemaFingerprint }) => ({
      componentId, source, contextKind, schemaFingerprint
    }))
  }, null, 2)}\n`;
  const contents = new Map([
    ["components.js", js.contents],
    ["components.js.map", map.contents],
    ["components.usage.json", Buffer.from(usage)]
  ]);
  const outputs = Object.fromEntries([...contents].map(([name, content]) => [name, {
    size: content.byteLength,
    sha256: sha256(content)
  }]));
  const sentinel = {
    schemaVersion: 1,
    generator: "scripts/build-component-registry.mjs",
    cacheKey: key,
    inputs: {
      componentManifestSha256: sha256(manifestSource),
      registrySha256: sha256(registrySource)
    },
    outputs
  };
  for (const [name, content] of contents) await atomicWrite(path.join(options.outputRoot, name), content);
  await atomicWrite(sentinelPath, `${JSON.stringify(sentinel, null, 2)}\n`);
  return { cacheHit: false, key, manifest, sentinel, generated };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildComponentRegistry(process.argv.slice(2));
  console.log(`Component registry bundle: ${result.cacheHit ? "current" : "generated"} (${result.manifest.components.length} components)`);
}
