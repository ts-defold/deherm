import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includes(text) {
  return [...String(text).matchAll(/^\s*#\s*include\s*[<"]([^">]+)[">]/gmu)].map((match) => match[1]);
}

async function existingFile(file) {
  try {
    await access(file);
    return file;
  } catch (error) {
    if (error.code === "ENOENT") return null;
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

/**
 * Reconstruct Defold's build-time module include aliases from its source tree.
 * The mapping is revision-parametric: no module or header name lives in the
 * package. Only the stable `engine/<module>/src[/dmsdk]` layout recipe does.
 */
export async function deriveDefoldSourceIncludeAliases({ repositoryRoot, engineRoot, sources }) {
  assert(path.isAbsolute(repositoryRoot), "source include alias repository root must be absolute");
  assert(path.isAbsolute(engineRoot), "source include alias engine root must be absolute");
  assert(Array.isArray(sources), "source include alias inputs must be an array");
  const queue = sources.flatMap(({ text }) => includes(text));
  const visited = new Set();
  const aliases = [];
  while (queue.length > 0) {
    const includeName = queue.shift();
    if (visited.has(includeName)) continue;
    visited.add(includeName);
    const source = await sourceAlias(engineRoot, includeName);
    if (!source) continue;
    const contents = await readFile(source);
    aliases.push({
      include: includeName,
      source: path.relative(repositoryRoot, source).replaceAll(path.sep, "/"),
      sourceSha256: sha256(contents),
    });
    queue.push(...includes(contents.toString("utf8")));
  }
  return aliases.sort((left, right) => compareCodeUnits(left.include, right.include));
}

export async function materializeDefoldSourceIncludeAliases({ repositoryRoot, aliases }) {
  assert(path.isAbsolute(repositoryRoot), "source include alias repository root must be absolute");
  const digest = sha256(JSON.stringify(aliases));
  const directory = path.join(repositoryRoot, ".deherm", "cache", "dmsdk-semantic-includes", digest);
  for (const alias of aliases) {
    const destination = path.join(directory, alias.include);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await access(destination);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await copyFile(path.join(repositoryRoot, alias.source), destination);
    }
  }
  return { directory, digest };
}
