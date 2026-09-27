import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includes(text) {
  return [...String(text).matchAll(/^\s*#\s*include\s*([<"])([^">]+)[">]/gmu)].map((match) => ({
    local: match[1] === '"',
    name: match[2],
  }));
}

async function existingFile(file) {
  try {
    await access(file);
    return file;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function safeIncludeName(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return normalized.length > 0 && !path.posix.isAbsolute(normalized) && !normalized.split("/").includes("..")
    ? normalized
    : null;
}

async function sourceAlias(engineRoot, includeName) {
  const safe = safeIncludeName(includeName);
  if (!safe) return null;
  const [module, ...restParts] = safe.split("/");
  if (restParts.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(module)) return null;
  const rest = restParts.join("/");
  const candidates = [
    path.join(engineRoot, module, "src", safe),
    path.join(engineRoot, module, "src", rest),
    path.join(engineRoot, module, "src", "dmsdk", safe),
  ];
  for (const candidate of candidates) {
    const file = await existingFile(candidate);
    if (file) return file;
  }
  return null;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function defoldSourceQuoteRoots(file, engineRoot) {
  const relative = path.relative(engineRoot, file);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
  const [module, sourceDirectory, ...sourceSegments] = relative.split(path.sep);
  if (!module || sourceDirectory !== "src") return [];
  const moduleSource = path.join(engineRoot, module, "src");
  return [moduleSource, sourceSegments.length > 1 ? path.join(moduleSource, sourceSegments[0]) : null]
    .filter(Boolean)
    .sort(compareCodeUnits);
}

async function generatedAlias(engineRoot, sdkIncludeRoots, includingFile, includeName) {
  const target = path.resolve(path.dirname(includingFile), includeName);
  if (!inside(engineRoot, target)) return null;
  const targetParts = path.relative(engineRoot, target).split(path.sep);
  const generatedIndex = targetParts.lastIndexOf("proto");
  if (generatedIndex < 0 || generatedIndex === targetParts.length - 1) return null;
  const exported = targetParts.slice(generatedIndex + 1);
  for (const sdkRoot of sdkIncludeRoots) {
    const source = await existingFile(path.join(sdkRoot, ...exported));
    if (source) return { source, target };
  }
  return null;
}

/**
 * Reconstruct Defold's build-time module include aliases from its source tree.
 * The mapping is revision-parametric: no module or header name lives in the
 * package. Only the stable `engine/<module>/src[/dmsdk]` layout recipe does.
 */
export async function deriveDefoldSourceIncludeAliases({ repositoryRoot, engineRoot, sdkIncludeRoots = [], sources }) {
  assert(path.isAbsolute(repositoryRoot), "source include alias repository root must be absolute");
  assert(path.isAbsolute(engineRoot), "source include alias engine root must be absolute");
  assert(
    Array.isArray(sdkIncludeRoots) && sdkIncludeRoots.every((entry) => path.isAbsolute(entry)),
    "source include alias SDK roots must be absolute",
  );
  assert(Array.isArray(sources), "source include alias inputs must be an array");
  const queue = sources.flatMap(({ path: sourcePath, text }) =>
    includes(text).map((include) => ({
      ...include,
      includingFile: path.resolve(repositoryRoot, sourcePath),
      projection: null,
    })),
  );
  const visited = new Set();
  const aliases = new Map();
  while (queue.length > 0) {
    const { includingFile, local, name: includeName, projection } = queue.shift();
    const visitKey = `${includingFile}\0${projection ?? "source"}\0${local ? "local" : "search"}\0${includeName}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (local) {
      let source = null;
      for (const directory of [path.dirname(includingFile), ...defoldSourceQuoteRoots(includingFile, engineRoot)]) {
        source = await existingFile(path.resolve(directory, includeName));
        if (source) break;
      }
      if (source) {
        const contents = await readFile(source);
        const sourceRelative = path.relative(repositoryRoot, source).replaceAll(path.sep, "/");
        aliases.set(`source-local\0${sourceRelative}`, {
          kind: "source-local",
          include: sourceRelative,
          source: sourceRelative,
          sourceSha256: sha256(contents),
        });
        const projected = projection
          ? path.posix.normalize(path.posix.join(path.posix.dirname(projection), includeName.replaceAll("\\", "/")))
          : null;
        if (projected && safeIncludeName(projected)) {
          aliases.set(`include-search\0${projected}`, {
            kind: "include-search",
            include: projected,
            source: sourceRelative,
            sourceSha256: sha256(contents),
          });
        }
        queue.push(
          ...includes(contents.toString("utf8")).map((include) => ({
            ...include,
            includingFile: source,
            projection: projected,
          })),
        );
        continue;
      }
      const generated = await generatedAlias(engineRoot, sdkIncludeRoots, includingFile, includeName);
      if (generated) {
        const contents = await readFile(generated.source);
        const include = path.relative(repositoryRoot, generated.target).replaceAll(path.sep, "/");
        aliases.set(`virtual-file\0${include}`, {
          kind: "virtual-file",
          include,
          source: path.relative(repositoryRoot, generated.source).replaceAll(path.sep, "/"),
          sourceSha256: sha256(contents),
        });
        queue.push(
          ...includes(contents.toString("utf8")).map((nested) => ({
            ...nested,
            includingFile: generated.source,
            projection: null,
          })),
        );
        continue;
      }
    }
    const source = await sourceAlias(engineRoot, includeName);
    if (!source) continue;
    const contents = await readFile(source);
    aliases.set(`include-search\0${includeName}`, {
      kind: "include-search",
      include: includeName,
      source: path.relative(repositoryRoot, source).replaceAll(path.sep, "/"),
      sourceSha256: sha256(contents),
    });
    queue.push(
      ...includes(contents.toString("utf8")).map((include) => ({
        ...include,
        includingFile: source,
        projection: includeName,
      })),
    );
  }
  return [...aliases.values()].sort(
    (left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.include, right.include),
  );
}

export async function materializeDefoldSourceIncludeAliases({ repositoryRoot, aliases }) {
  assert(path.isAbsolute(repositoryRoot), "source include alias repository root must be absolute");
  const digest = sha256(JSON.stringify(aliases));
  const directory = path.join(repositoryRoot, ".deherm", "cache", "dmsdk-semantic-includes", digest);
  for (const alias of aliases.filter(({ kind }) => kind === "include-search")) {
    const destination = path.join(directory, alias.include);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await access(destination);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await copyFile(path.join(repositoryRoot, alias.source), destination);
    }
  }
  const virtualAliases = aliases.filter(({ kind }) => kind === "virtual-file");
  const vfsOverlay = virtualAliases.length > 0 ? path.join(directory, "virtual-files.json") : null;
  if (vfsOverlay) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      vfsOverlay,
      `${JSON.stringify(
        {
          version: 0,
          "case-sensitive": "true",
          roots: virtualAliases.map((alias) => ({
            type: "file",
            name: path.join(repositoryRoot, alias.include),
            "external-contents": path.join(repositoryRoot, alias.source),
          })),
        },
        null,
        2,
      )}\n`,
    );
  }
  return { directory, digest, vfsOverlay };
}
