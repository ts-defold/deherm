#!/usr/bin/env node

// The host half of the toolchain, kept deliberately separate from
// manage-native-artifacts.mjs because the two matrices are sized independently:
// `libhermes.a` is indexed by the Defold BUNDLE TARGET Bob uploads to Extender,
// while hermesc, shermes and dehermc are indexed by the USER'S HOST. A user
// on macOS bundling for Android needs the macOS host tools and the Android
// archive, and neither matrix implies the other.
//
// Status is recorded per tool rather than per host. dehermc cross-compiles to
// all five hosts from one job; hermesc and shermes must each be built on a
// runner of their own architecture. A host-wide status would either hide a
// published tool behind an unpublished one or claim a host is ready when only
// part of it is.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { downloadReleaseAssets, extractReleaseArchive } from "../packages/cli/src/release-assets.mjs";
import { fileURLToPath } from "node:url";

// What determines the bytes of a host tool is declared in one place for all
// three artifact families - see ./lib/artifact-releases.mjs. The two host
// families are kept apart there because they share no input at all: hermesc and
// shermes come from the pinned Hermes tree, dehermc from its own Go sources and
// the pinned ttsc version. One fingerprint over both meant a Go transform edit
// republished ten unchanged LLVM compilers and a Hermes repin republished five
// unchanged Go binaries.
import {
  artifactFamilies,
  expectedAssetNames,
  familyForHostTool,
  familyRelease,
  fingerprintFamily,
  hostArtifactFamilyNames,
  publishedAssets
} from "./lib/artifact-releases.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages", "toolchains", "host-compilers.json");

function requireHostFamily(name) {
  if (!name) {
    throw new Error(`Name the artifact family: one of ${hostArtifactFamilyNames.join(", ")}`);
  }
  if (!hostArtifactFamilyNames.includes(name)) {
    throw new Error(`${name} is not a host artifact family; declared families are ${hostArtifactFamilyNames.join(", ")}`);
  }
  return name;
}

const missingStatuses = new Set(["required-missing", "blocked"]);
const knownStatuses = new Set(["vendored", "required-missing", "blocked"]);

// A host tool small enough to be a wrapper script or a Git LFS pointer is not
// the artifact, and pinning its digest would make the lie permanent. hermesc and
// shermes are multi-megabyte LLVM binaries; dehermc links the whole
// typescript-go compiler and lands around 20 MB.
const MINIMUM_PLAUSIBLE_BYTES = 1_000_000;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function writeManifest(manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function filesBelow(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(directory);
  return files;
}

function hostRecord(manifest, key) {
  const record = manifest.hosts?.[key];
  if (!record) throw new Error(`Unknown host compiler key ${key}`);
  return record;
}

// Record one tool that is already sitting in the in-tree staging directory.
async function recordTool(manifest, key, tool) {
  const record = hostRecord(manifest, key);
  const toolRecord = record.tools?.[tool];
  if (!toolRecord) throw new Error(`${key} declares no ${tool}; declared tools are ${Object.keys(record.tools ?? {}).join(", ")}`);
  const file = path.join(root, record.directory, toolRecord.file);
  const bytes = await readFile(file);
  if (bytes.byteLength < MINIMUM_PLAUSIBLE_BYTES) {
    throw new Error(`${key} ${tool} is implausibly small (${bytes.byteLength} bytes)`);
  }
  toolRecord.status = "vendored";
  toolRecord.sha256 = digest(bytes);
  toolRecord.bytes = bytes.byteLength;
  return toolRecord;
}

// Record every tool present for a host, leaving the ones that are not. One
// runner failing never unpins another tool's digest.
async function recordHost(manifest, key) {
  const record = hostRecord(manifest, key);
  const recorded = {};
  for (const tool of Object.keys(record.tools ?? {})) {
    try {
      await stat(path.join(root, record.directory, record.tools[tool].file));
    } catch {
      continue;
    }
    recorded[tool] = await recordTool(manifest, key, tool);
  }
  if (!Object.keys(recorded).length) {
    throw new Error(`No host tool is staged under ${record.directory} for ${key}`);
  }
  return recorded;
}

async function install(downloadRoot) {
  const manifest = await readManifest();
  const available = await filesBelow(path.resolve(downloadRoot));
  const installed = [];
  for (const [key, record] of Object.entries(manifest.hosts)) {
    for (const [tool, toolRecord] of Object.entries(record.tools ?? {})) {
      if (toolRecord.status === "blocked") continue;
      const name = path.basename(toolRecord.file);
      const candidates = available.filter((file) =>
        path.basename(file) === name && file.split(path.sep).includes(`host-compilers-${key}`));
      if (candidates.length > 1) throw new Error(`Expected one ${name} in host-compilers-${key}, found ${candidates.length}`);
      // A download that carries nothing for a tool leaves that tool alone, so
      // one runner failing never silently unpins another tool's digest.
      if (candidates.length === 0) continue;
      const destination = path.join(root, record.directory, toolRecord.file);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(candidates[0], destination);
      // Artifact download loses the executable bit; a compiler that cannot be
      // executed is not installed, it is merely present.
      if (!toolRecord.file.endsWith(".exe")) await chmod(destination, 0o755);
      await recordTool(manifest, key, tool);
      installed.push(`${key}/${tool}`);
    }
  }
  await writeManifest(manifest);
  return installed;
}

async function report() {
  const manifest = await readManifest();
  const rows = [];
  for (const [key, record] of Object.entries(manifest.hosts)) {
    const tools = [];
    for (const [tool, toolRecord] of Object.entries(record.tools ?? {})) {
      const entry = {
        host: key,
        tool,
        // Which release holds this tool. The two host families are published
        // under separate tags, so a user told a tool is missing needs to know
        // which release to look in.
        family: familyForHostTool(tool),
        status: toolRecord.status,
        builder: toolRecord.builder ?? null,
        file: toolRecord.file,
        blocker: toolRecord.blocker ?? null,
        detail: ""
      };
      if (!knownStatuses.has(toolRecord.status)) {
        entry.detail = `unknown status ${toolRecord.status}`;
        entry.invalid = true;
      } else if (toolRecord.status === "vendored") {
        if (!/^[a-f0-9]{64}$/.test(toolRecord.sha256 ?? "")) {
          entry.detail = "carries no pinned digest";
          entry.invalid = true;
        } else {
          try {
            const bytes = await readFile(path.join(root, record.directory, toolRecord.file));
            if (digest(bytes) !== toolRecord.sha256) {
              entry.detail = "checksum mismatch";
              entry.invalid = true;
            } else {
              entry.sha256 = toolRecord.sha256;
              entry.bytes = bytes.byteLength;
              entry.detail = `${toolRecord.sha256.slice(0, 12)} (${bytes.byteLength} bytes)`;
            }
          } catch {
            entry.detail = `missing at ${record.directory}/${toolRecord.file}`;
            entry.invalid = true;
          }
        }
      } else if (toolRecord.status === "required-missing") {
        if (!toolRecord.builder) {
          entry.detail = "required-missing without a builder";
          entry.invalid = true;
        } else entry.detail = `build with ${toolRecord.builder}`;
      } else if (!toolRecord.blocker?.code || !toolRecord.blocker?.reason) {
        entry.detail = "blocked without a machine-readable blocker";
        entry.invalid = true;
      } else entry.detail = toolRecord.blocker.code;
      tools.push(entry);
    }
    tools.sort((left, right) => left.tool.localeCompare(right.tool));
    const missing = tools.filter((entry) => entry.status !== "vendored" || entry.invalid);
    rows.push({
      host: key,
      platform: record.host.platform,
      architecture: record.host.architecture,
      package: record.package,
      status: missing.length === 0 ? "vendored" : tools.every((entry) => entry.status === "blocked") ? "blocked" : "required-missing",
      invalid: tools.some((entry) => entry.invalid),
      tools,
      detail: missing.length === 0
        ? tools.map((entry) => `${entry.tool} ${entry.sha256.slice(0, 12)}`).join(", ")
        : missing.map((entry) => `${entry.tool}: ${entry.detail}`).join("; ")
    });
  }
  rows.sort((left, right) => left.host.localeCompare(right.host));
  return {
    schemaVersion: 3,
    hermesRevision: manifest.hermesRevision,
    ttscVersion: manifest.ttscVersion ?? null,
    packageVersion: manifest.packageVersion,
    tools: Object.keys(manifest.tools ?? {}),
    families: Object.fromEntries(hostArtifactFamilyNames.map((name) => [name, artifactFamilies[name].tools])),
    hosts: rows
  };
}

async function verify(complete, json) {
  const result = await report();
  if (json) console.log(JSON.stringify(result, null, 2));
  const problems = [];
  for (const row of result.hosts) {
    for (const entry of row.tools) {
      if (entry.invalid) problems.push(`${row.host} ${entry.tool}: ${entry.detail}`);
      else if (complete && missingStatuses.has(entry.status)) {
        problems.push(`${row.host} ${entry.tool}: ${entry.status}${entry.blocker ? ` (${entry.blocker.code}: ${entry.blocker.reason})` : ` (${entry.detail})`}`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`Host tool matrix (${complete ? "complete" : "declared"}) failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  if (!json) {
    for (const row of result.hosts) {
      for (const entry of row.tools) {
        console.log(`${entry.status === "vendored" ? "ok" : "--"} ${row.host} ${entry.tool}: ${entry.status} ${entry.detail}`);
      }
    }
    const count = result.hosts.reduce((total, row) => total + row.tools.length, 0);
    console.log(`ok host tool matrix (${complete ? "complete" : "declared"}): ${result.hosts.length} host(s), ${count} tool(s)`);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

const [command, ...args] = process.argv.slice(2);
// The asset names a complete release of ONE host family carries.
//
// A release EXISTING is not evidence that it is complete. The first run of the
// native-artifacts workflow created this release and then most lanes failed,
// leaving two assets of fifteen behind a tag the next run treated as done. The
// skip has to be keyed on the assets themselves - and now per family, because
// the ten Hermes compilers and the five dehermc binaries are published under
// separate tags and neither's completeness says anything about the other's.
//
// Blocked tools are excluded, matching `report`, so a tool that is deliberately
// not published does not hold the release open forever.
async function expectedAssets(family) {
  return expectedAssetNames(requireHostFamily(family), { root });
}

if (command === "fingerprint") console.log(await fingerprintFamily(requireHostFamily(args[0]), { root }));
// The TAG, derived beside the expected-asset listing rather than assembled from
// a prefix in YAML and a digest from here. See ./lib/artifact-releases.mjs.
else if (command === "tag") console.log((await familyRelease(requireHostFamily(args[0]), { root })).tag);
else if (command === "release-metadata") {
  console.log(JSON.stringify(await familyRelease(requireHostFamily(args[0]), { root }), null, 2));
}
else if (command === "install") {
  if (!args[0]) throw new Error("install requires a downloaded artifact directory");
  const installed = await install(args[0]);
  console.log(`installed ${installed.length} host tool(s): ${installed.join(", ") || "none"}`);
} else if (command === "record") {
  if (!args[0]) throw new Error("record requires a host key, for example darwin-arm64");
  const manifest = await readManifest();
  const recorded = args[1]
    ? { [args[1]]: await recordTool(manifest, args[0], args[1]) }
    : await recordHost(manifest, args[0]);
  await writeManifest(manifest);
  console.log(`recorded ${args[0]} ${Object.entries(recorded).map(([tool, value]) => `${tool}=${value.sha256}`).join(" ")}`);
} else if (command === "report") console.log(JSON.stringify(await report(), null, 2));
else if (command === "expected-assets") console.log((await expectedAssets(args[0])).join("\n"));
else if (command === "verify") await verify(args.includes("--complete"), args.includes("--json"));
else if (command === "pull") {
  // Release assets, not workflow artifacts: a workflow artifact expires, is
  // run-scoped and needs auth, and none of that survives to a user six months
  // later. The tag is the family's input fingerprint, so many déherm versions
  // share one artifact release.
  //
  // Both host families are pulled by default, because a user wants a working
  // host and does not care that the Hermes compilers and dehermc are built by
  // different jobs on different schedules. `--tag` addresses one release, so it
  // has to say which family that release holds.
  const tagIndex = args.indexOf("--tag");
  const familyIndex = args.indexOf("--family");
  if (tagIndex >= 0 && familyIndex < 0) {
    throw new Error(`--tag names a single release, so it requires --family <${hostArtifactFamilyNames.join("|")}>`);
  }
  const families = familyIndex >= 0 ? [requireHostFamily(args[familyIndex + 1])] : hostArtifactFamilyNames;
  const installed = [];
  for (const family of families) {
    const tag = tagIndex >= 0 ? args[tagIndex + 1] : (await familyRelease(family, { root })).tag;
    const destination = path.join(root, "build", "host-compiler-downloads", tag);
    await mkdir(destination, { recursive: true });
    // By URL, not through `gh` - see packages/cli/src/release-assets.mjs. The
    // asset names are the same listing CI checks the release against, so nothing
    // is fetched to discover what to fetch.
    const rows = await publishedAssets(family, { root });
    const { missing } = await downloadReleaseAssets({
      tag,
      assets: rows.map((row) => row.asset),
      destination,
      optional: args.includes("--partial"),
      onProgress: ({ asset, status }) => console.log(`${status === "missing" ? "absent" : "fetched"} ${asset}`)
    });
    if (missing.length) console.log(`${missing.length} ${family} asset(s) not published for these inputs`);
    // Each asset is one reproducible .tar.gz holding that host's tools for this
    // family - hermesc and shermes together, or dehermc alone. Unpack each into
    // the directory `install` matches on, which is the row it was requested
    // for; the flat names the download side used to parse are gone, and with
    // them the second, differently-spelled parser they needed.
    //
    // The archive also carries the executable bit, which a bare release asset
    // does not - `install` still chmods, because a tarball produced by some
    // future path might not.
    const absent = new Set(missing);
    for (const row of rows) {
      if (absent.has(row.asset)) continue;
      await extractReleaseArchive({
        archive: path.join(destination, row.asset),
        destination: path.join(destination, `host-compilers-${row.host}`, "bin")
      });
    }
    installed.push(...await install(destination));
  }
  console.log(`installed ${installed.length} host tool(s): ${installed.join(", ") || "none"}`);
  // A partial pull of one family still leaves the other's tools missing, so the
  // complete check only makes sense when every family was asked for.
  await verify(!args.includes("--partial") && familyIndex < 0, false);
} else if (command === "stage") {
  // Copy this host's freshly built tools out of a local build, so the same
  // record/verify path works without a CI round trip.
  const [key, buildDir, only] = args;
  if (!key || !buildDir) throw new Error("stage requires <host key> <build directory> [tool]");
  const manifest = await readManifest();
  const record = hostRecord(manifest, key);
  const staged = [];
  for (const [tool, toolRecord] of Object.entries(record.tools ?? {})) {
    if (only && tool !== only) continue;
    const name = path.basename(toolRecord.file);
    // hermesc and shermes land in a CMake build's bin/; dehermc lands
    // wherever build-dehermc.sh was pointed. Accept either shape.
    const candidates = [path.resolve(buildDir, "bin", name), path.resolve(buildDir, name)];
    let source = null;
    for (const candidate of candidates) {
      if (await stat(candidate).then(() => true, () => false)) {
        source = candidate;
        break;
      }
    }
    if (!source) {
      if (only) throw new Error(`${tool} was not built at ${candidates.join(" or ")}`);
      continue;
    }
    const destination = path.join(root, record.directory, toolRecord.file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
    if (!toolRecord.file.endsWith(".exe")) await chmod(destination, 0o755);
    await recordTool(manifest, key, tool);
    staged.push(tool);
  }
  if (!staged.length) throw new Error(`Nothing to stage for ${key} from ${buildDir}`);
  await writeManifest(manifest);
  console.log(`staged ${key} ${staged.join(", ")}`);
} else {
  throw new Error(
    "Usage: manage-host-compilers.mjs {" +
    `fingerprint <${hostArtifactFamilyNames.join("|")}>|` +
    `tag <${hostArtifactFamilyNames.join("|")}>|` +
    `release-metadata <${hostArtifactFamilyNames.join("|")}>|` +
    `expected-assets <${hostArtifactFamilyNames.join("|")}>|` +
    "report|verify [--complete] [--json]|install <dir>|record <host> [tool]|" +
    "stage <host> <build dir> [tool]|pull [--family <name>] [--tag <tag>] [--partial]}"
  );
}
