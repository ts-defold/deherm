// Which Defold engine revision does THIS project build against?
//
// Nothing downstream of this module is version-neutral: the script API IR, the
// dmSDK IR, route availability profiles, hashes, signatures and the canonical
// lowering plan are all derived from one immutable engine SHA. Answering this
// question with the revision déherm happens to have been built against produces
// TypeScript that compiles and is wrong, which is the one failure mode a
// generator may never have. So this module answers with evidence or refuses.
//
// `game.project` does not select an engine SDK (see
// `.agents/docs/decisions/api-source-resolution.md`), so there is no single
// place to read. Instead every independent observation is collected, ranked by
// how directly it witnesses the engine the project actually uses, and any
// disagreement between two observations that both claim to be current is a
// blocker rather than a silent precedence win.

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { unzipSync } from "fflate";

import { parseGameProject } from "./project.mjs";

export const DEFOLD_REVISION_PATTERN = /^[0-9a-f]{40}$/;

// Ordered most to least authoritative. `authority` is not a synonym for rank:
// it says whether the observation witnesses the engine in use right now
// (`live`), a claim the project makes about itself (`declared`), or a record of
// something that already happened (`historical`). Two disagreeing `live` or
// `declared` observations are a contradiction; a `historical` one that
// disagrees is just out of date.
export const defoldRevisionSources = Object.freeze([
  Object.freeze({ id: "explicit-option", authority: "live", cost: "cheap", label: "--defold-sdk" }),
  Object.freeze({ id: "editor-hook", authority: "live", cost: "cheap", label: "DEHERM_DEFOLD_ENGINE_SHA1 (Defold editor hook)" }),
  Object.freeze({ id: "bob-version", authority: "live", cost: "expensive", label: "the configured Bob jar" }),
  Object.freeze({ id: "game-project", authority: "declared", cost: "cheap", label: "game.project [defold_hermes] defold_sdk" }),
  Object.freeze({ id: "dependency-url", authority: "declared", cost: "cheap", label: "a game.project dependency naming a Defold archive" }),
  Object.freeze({ id: "extender-build", authority: "historical", cost: "expensive", label: ".internal/cache/<platform>/build.zip build log" }),
  Object.freeze({ id: "deherm-lock", authority: "historical", cost: "cheap", label: "deherm.lock" })
]);

const sourceRank = new Map(defoldRevisionSources.map((source, index) => [source.id, index]));
const sourceById = new Map(defoldRevisionSources.map((source) => [source.id, source]));

export function normalizeDefoldRevision(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a 40-character Defold engine SHA`);
  const normalized = value.trim().toLowerCase();
  if (!DEFOLD_REVISION_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a 40-character Defold engine SHA, got ${JSON.stringify(value)}`);
  }
  return normalized;
}

function isRevision(value) {
  return typeof value === "string" && DEFOLD_REVISION_PATTERN.test(value);
}

async function exists(file, mode = constants.F_OK) {
  try {
    await access(file, mode);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

// `d.defold.com/archive/<sha>/...`, `github.com/defold/defold/archive/<sha>.zip`
// and Extender's `.../sdk/<sha>/defoldsdk` all embed the engine SHA as a whole
// path segment. Matching the segment rather than a bare 40-hex run keeps an
// unrelated content digest in a URL or a build log from being read as an engine
// revision.
const archiveRevision = /(?:^|[/=])(?:archive|sdk)\/([0-9a-f]{40})(?:[/.]|$)/i;

function dependencyRevisions(properties) {
  const project = properties.project ?? {};
  const urls = Object.entries(project)
    .filter(([key]) => key === "dependencies" || /^dependencies#\d+$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .flatMap(([, value]) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const found = [];
  for (const url of urls) {
    if (!/(?:^|\/\/|\.)defold\.com\//i.test(url) && !/github\.com\/defold\/defold\//i.test(url)) continue;
    const match = archiveRevision.exec(url);
    if (match) found.push({ url, revision: match[1].toLowerCase() });
  }
  return found;
}

async function bobCandidates(projectRoot, options) {
  const candidates = [];
  if (options.bob) candidates.push(path.resolve(options.bob));
  const fromEnvironment = options.env?.DEHERM_BOB;
  if (fromEnvironment) candidates.push(path.resolve(fromEnvironment));
  candidates.push(path.join(projectRoot, "bob.jar"));
  const toolchains = path.join(projectRoot, ".deherm", "cache", "toolchains");
  let entries = [];
  try {
    entries = (await readdir(toolchains, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    entries = [];
  }
  for (const entry of entries) candidates.push(path.join(toolchains, entry, "bob.jar"));
  const seen = new Set();
  const resolved = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await exists(candidate)) resolved.push(candidate);
  }
  return resolved;
}

function runCapture(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, message: error.message, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, message: `timed out after ${timeoutMs}ms`, stdout, stderr });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: error.message, stdout, stderr });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, message: code === 0 ? "" : `exited with code ${code}`, stdout, stderr });
    });
  });
}

async function resolveJava(options) {
  const candidates = [
    options.java,
    options.env?.DEHERM_JAVA,
    options.env?.JAVA_HOME ? path.join(options.env.JAVA_HOME, "bin", "java") : undefined
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate, constants.X_OK)) return candidate;
  return "java";
}

// Bob prints its own engine identity, so it is asked rather than inferred from
// where its jar happens to sit on disk.
async function observeBob(projectRoot, options, diagnostics) {
  const jars = await bobCandidates(projectRoot, options);
  if (!jars.length) return [];
  const java = await resolveJava(options);
  const observations = [];
  for (const jar of jars) {
    const result = await (options.runBobVersion ?? runCapture)(java, ["-jar", jar, "--version"], options.bobTimeoutMs ?? 30_000);
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const match = /sha1\s*[:=]?\s*([0-9a-f]{40})/i.exec(text);
    if (!match) {
      diagnostics.push({
        severity: "warning",
        source: "bob-version",
        message: `${path.basename(jar)} did not report an engine sha1${result.ok ? "" : ` (${result.message})`}; it was not used to resolve the Defold revision`
      });
      continue;
    }
    observations.push({
      source: "bob-version",
      authority: "live",
      revision: match[1].toLowerCase(),
      evidence: { jar, java }
    });
  }
  return observations;
}

// Extender records the absolute SDK path of every compile in the build log it
// returns, so a project that has built its native extensions once carries a
// first-hand record of the engine revision it was actually compiled against.
async function observeExtenderBuild(projectRoot, diagnostics) {
  const cacheRoot = path.join(projectRoot, ".internal", "cache");
  let platforms;
  try {
    platforms = (await readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const observations = [];
  for (const platform of platforms) {
    const archive = path.join(cacheRoot, platform, "build.zip");
    let information;
    try {
      information = await stat(archive);
    } catch {
      continue;
    }
    if (!information.isFile()) continue;
    let log;
    try {
      const entries = unzipSync(new Uint8Array(await readFile(archive)), {
        filter: (file) => file.name === "log.txt"
      });
      log = entries["log.txt"];
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        source: "extender-build",
        message: `.internal/cache/${platform}/build.zip could not be read for an engine revision: ${error.message}`
      });
      continue;
    }
    if (!log) continue;
    const text = new TextDecoder().decode(log);
    const revisions = new Set();
    for (const match of text.matchAll(/\/sdk\/([0-9a-f]{40})\/defoldsdk/gi)) revisions.add(match[1].toLowerCase());
    if (revisions.size > 1) {
      diagnostics.push({
        severity: "warning",
        source: "extender-build",
        message: `.internal/cache/${platform}/build.zip names more than one engine SDK (${[...revisions].sort().join(", ")}); it was not used to resolve the Defold revision`
      });
      continue;
    }
    for (const revision of revisions) {
      observations.push({
        source: "extender-build",
        authority: "historical",
        revision,
        evidence: {
          archive: `.internal/cache/${platform}/build.zip`,
          platform,
          size: information.size,
          modifiedMs: Math.trunc(information.mtimeMs)
        }
      });
    }
  }
  return observations;
}

// A lock is only evidence when it records how it decided. A lock written before
// this resolver existed carries whatever revision the package was built with,
// which is exactly the assumption this module exists to stop, so it is ignored.
function observeLock(lock) {
  const previous = lock?.defoldResolution;
  if (!previous || typeof previous !== "object") return [];
  if (!isRevision(previous.revision) || previous.revision !== lock.defoldRevision) return [];
  if (typeof previous.source !== "string" || previous.source === "deherm-lock") return [];
  if (!sourceById.has(previous.source)) return [];
  return [{
    source: "deherm-lock",
    authority: "historical",
    revision: previous.revision,
    evidence: { recordedSource: previous.source, recordedEvidence: previous.evidence ?? null }
  }];
}

// A lock whose own recorded evidence is an unchanged file on disk can stand in
// for re-reading that file. This is what keeps `deherm generate` from
// decompressing a 20MB Extender build archive on every run while still noticing
// the moment the project rebuilds against a different engine.
async function lockEvidenceStillCurrent(projectRoot, lock) {
  const previous = lock?.defoldResolution;
  if (previous?.source !== "extender-build") return false;
  const evidence = previous.evidence;
  if (!evidence || typeof evidence.archive !== "string") return false;
  const normalized = evidence.archive.split("/").join(path.sep);
  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes("..")) return false;
  try {
    const information = await stat(path.join(projectRoot, normalized));
    return information.isFile() &&
      information.size === evidence.size &&
      Math.trunc(information.mtimeMs) === evidence.modifiedMs;
  } catch {
    return false;
  }
}

function selectObservation(observations) {
  return [...observations].sort((left, right) =>
    sourceRank.get(left.source) - sourceRank.get(right.source) ||
    left.revision.localeCompare(right.revision))[0] ?? null;
}

function describeObservation(observation) {
  const label = sourceById.get(observation.source)?.label ?? observation.source;
  const detail = observation.evidence?.jar ?? observation.evidence?.archive ?? observation.evidence?.url ??
    observation.evidence?.recordedSource;
  return `${observation.revision} from ${label}${detail ? ` (${detail})` : ""}`;
}

/**
 * Resolve the Defold engine revision a project targets.
 *
 * Returns a resolution rather than throwing so a caller can report every
 * observation it found. `blocker` is non-null exactly when `revision` is null.
 */
export async function resolveDefoldRevision(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const diagnostics = [];
  const observations = [];
  const checked = [];

  if (options.explicit !== undefined && options.explicit !== null) {
    observations.push({
      source: "explicit-option",
      authority: "live",
      revision: normalizeDefoldRevision(options.explicit, "--defold-sdk"),
      evidence: { option: "--defold-sdk" }
    });
  }
  checked.push("--defold-sdk");

  const hook = env.DEHERM_DEFOLD_ENGINE_SHA1;
  if (hook) {
    observations.push({
      source: "editor-hook",
      authority: "live",
      revision: normalizeDefoldRevision(hook, "DEHERM_DEFOLD_ENGINE_SHA1"),
      evidence: { variable: "DEHERM_DEFOLD_ENGINE_SHA1" }
    });
  }
  checked.push("DEHERM_DEFOLD_ENGINE_SHA1 (Defold editor hook)");

  let properties = options.properties;
  if (!properties) {
    try {
      properties = parseGameProject(await readFile(path.join(projectRoot, "game.project"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      properties = {};
    }
  }
  const declared = properties.defold_hermes?.defold_sdk;
  if (declared) {
    observations.push({
      source: "game-project",
      authority: "declared",
      revision: normalizeDefoldRevision(declared, "game.project [defold_hermes] defold_sdk"),
      evidence: { key: "[defold_hermes] defold_sdk" }
    });
  }
  checked.push("game.project [defold_hermes] defold_sdk");

  for (const { url, revision } of dependencyRevisions(properties)) {
    observations.push({ source: "dependency-url", authority: "declared", revision, evidence: { url } });
  }
  checked.push("game.project dependency URLs naming a Defold engine archive");

  const lock = await readJson(path.join(projectRoot, "deherm.lock"));
  observations.push(...observeLock(lock));
  checked.push("deherm.lock");

  // Expensive observations are skipped only when something that witnesses the
  // engine right now, or that the project asserts about itself, already
  // answered. A lock alone never suppresses them, or an engine upgrade would be
  // invisible forever - unless the lock's own evidence file is provably
  // unchanged, in which case re-reading it cannot say anything new.
  //
  // An explicitly configured Bob is the exception: naming one is a request to
  // ask it, and it is the only thing that can catch a `game.project`
  // declaration that has drifted from the engine the project really builds
  // with. Without `--bob`/`DEHERM_BOB` a declaration is taken at its word
  // rather than paying a JVM start on every generation.
  const cheapAuthority = observations.some(({ authority }) => authority === "live" || authority === "declared");
  const lockCovers = await lockEvidenceStillCurrent(projectRoot, lock);
  const bobRequested = Boolean(options.bob || env.DEHERM_BOB);
  if (bobRequested || (!cheapAuthority && !lockCovers)) {
    observations.push(...await observeBob(projectRoot, options, diagnostics));
    checked.push("the configured Bob jar (--bob, DEHERM_BOB, <project>/bob.jar, .deherm/cache/toolchains/*/bob.jar)");
  }
  if (!cheapAuthority && !lockCovers && !observations.some(({ authority }) => authority === "live")) {
    observations.push(...await observeExtenderBuild(projectRoot, diagnostics));
    checked.push(".internal/cache/<platform>/build.zip Extender build log");
  }

  const selected = selectObservation(observations);
  if (!selected) {
    return {
      schemaVersion: 1,
      revision: null,
      source: null,
      selected: null,
      observations,
      diagnostics,
      blocker: {
        code: "defold-revision-unresolved",
        message: [
          "Cannot determine which Defold engine revision this project builds against.",
          "déherm generates a version-specific API surface, so it will not guess one.",
          "Checked, in order:",
          ...checked.map((entry) => `  - ${entry}`),
          "Resolve it by passing --defold-sdk <sha>, by declaring [defold_hermes] defold_sdk in game.project,",
          "or by building the project's native extensions once so Extender's build log records the SDK."
        ].join("\n")
      }
    };
  }

  const contradicting = observations.filter((observation) =>
    observation.revision !== selected.revision &&
    (observation.authority === "live" || observation.authority === "declared"));
  // `--defold-sdk` is a first-class input, not a tie-breaker: a user building
  // in CI against several Defold versions, or targeting a revision their
  // working tree does not name, has stated the answer. It always wins, and what
  // it overrode is reported rather than hidden. Every other disagreement
  // between two current claims is a contradiction déherm will not resolve.
  if (contradicting.length && selected.source !== "explicit-option") {
    return {
      schemaVersion: 1,
      revision: null,
      source: null,
      selected: null,
      observations,
      diagnostics,
      blocker: {
        code: "defold-revision-conflict",
        message: [
          "This project names more than one Defold engine revision, and déherm will not pick between them:",
          ...[selected, ...contradicting].map((observation) => `  - ${describeObservation(observation)}`),
          "Make them agree, or pass --defold-sdk <sha> to state the revision explicitly."
        ].join("\n")
      }
    };
  }

  for (const observation of observations) {
    if (observation.revision === selected.revision || observation === selected) continue;
    diagnostics.push({
      severity: "warning",
      source: observation.source,
      message: `${describeObservation(observation)} ${observation.authority === "historical" ? "is out of date" : "was overridden"}; generating for ${selected.revision} from ${sourceById.get(selected.source)?.label ?? selected.source}`
    });
  }

  return {
    schemaVersion: 1,
    revision: selected.revision,
    source: selected.source,
    selected,
    observations,
    diagnostics,
    blocker: null
  };
}

/**
 * The record written into `deherm.lock` and the generated manifest.
 *
 * A resolution that came from the lock records the witness the lock itself
 * named, not the lock. Recording "deherm-lock" would make the next run reject
 * its own record - the rule above ignores a lock that cannot say how it
 * decided - and the project would re-derive from the expensive evidence on
 * every generation. `via` keeps the hop visible without losing the origin.
 */
export function defoldResolutionRecord(resolution) {
  if (!resolution?.revision) throw new Error("Cannot record an unresolved Defold revision");
  const carried = resolution.source === "deherm-lock" ? resolution.selected?.evidence : null;
  const source = carried?.recordedSource ?? resolution.source;
  return {
    schemaVersion: 1,
    revision: resolution.revision,
    source,
    authority: sourceById.get(source)?.authority ?? "unknown",
    evidence: carried ? carried.recordedEvidence ?? null : resolution.selected?.evidence ?? null,
    ...(carried ? { via: "deherm-lock" } : {})
  };
}

export class DefoldRevisionError extends Error {
  constructor(blocker) {
    super(blocker.message);
    this.name = "DefoldRevisionError";
    this.code = blocker.code;
    this.blocker = blocker;
  }
}

export function assertResolvedDefoldRevision(resolution) {
  if (resolution.blocker) throw new DefoldRevisionError(resolution.blocker);
  return resolution.revision;
}
