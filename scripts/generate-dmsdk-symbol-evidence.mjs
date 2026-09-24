#!/usr/bin/env node

// Answer, from evidence, whether a declared dmSDK function actually links -
// and under which bundle target and which build variant.
//
// Every dmSDK unit carries `native-symbol-linkage` and
// `target-feature-symbol-matrix` as blockers, and both were applied WHOLESALE:
// the first unconditionally before any declaration was examined, and the second
// because availability was never resolved past "unverified-all-targets".
// Neither describes the API. They describe our not having looked, and together
// they gate every dmSDK unit - so no amount of per-unit lowering work can emit
// anything while they stand.
//
// They are answerable, because Defold publishes the very archives Extender
// links against: `engine/defoldsdk.zip` for the pinned revision, carrying
// `defoldsdk/lib/<dir>/lib*.a` (and `*.lib` on win32) for every bundle target.
//
// ── Only the archives Extender actually links ─────────────────────────────
//
// A directory listing is not a link line. `defoldsdk/lib/<dir>` also ships the
// sanitizer-free `_noasan` duplicates, unit-test archives, and both halves of
// every either/or pair. Scanning all of them indiscriminately reports symbols
// as available that no shipped game ever links. So the archive set is READ from
// the SDK's own `defoldsdk/extender/build.yml` - the file Extender itself
// consumes - as that platform's `engineLibs`, and the directory those names
// resolve in is read from the same file's `libPaths`. That also settles a
// naming trap: the bundle target is `arm64-osx` and its archive directory is
// `lib/arm64-macos`, and only Defold gets to say so.
//
// ── The variant axis ──────────────────────────────────────────────────────
//
// Defold ships both halves of the profiler as separate archives -
// `libprofile.a`/`libprofile_null.a`, `libprofilerext.a`/`libprofilerext_null.a`
// - and a release bundle links the `_null` set. Which swaps happen is not
// inferred here either: it is read from the SDK's own
// `defoldsdk/extender/variants/<variant>.appmanifest`, whose `excludeLibs` and
// `libs` are exactly the edit Extender applies to the link line. Linkage is
// therefore recorded per (target, variant), and a declaration that links in one
// variant and not the other is reported as variant-conditional rather than
// silently resolved by whichever archive happened to be scanned first.
//
// ── What a missing symbol means ───────────────────────────────────────────
//
// A declaration is NOT automatically a symbol - inline functions, templates and
// platform-gated code are declared and never land in an archive - which is
// exactly why this is measured rather than assumed. A missing symbol is a real
// finding and stays blocked; the point is to stop blocking the ones that are
// demonstrably there.

import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";

const run = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = Object.freeze({
  lock: "upstream.lock",
  sdkArchive: "upstream/defoldsdk.zip",
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  bundleTargets: "packages/toolchains/defold-bundle-targets.json",
  output: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json"
});

export const evidencePath = path.join(root, paths.output);

/** Members of the SDK archive this pass reads, all of them Defold's own declarations. */
export const sdkMembers = Object.freeze({
  buildConfig: "defoldsdk/extender/build.yml",
  variantManifest: (variant) => `defoldsdk/extender/variants/${variant}.appmanifest`
});

/**
 * The build variants Defold ships an appmanifest for.
 *
 * `debug` is the base link line with nothing excluded; the other two are edits
 * to it. Listing them here decides only WHICH manifests are read - every
 * exclusion, addition and define comes out of the manifest itself.
 */
export const variants = Object.freeze(["debug", "release", "headless"]);

/**
 * The declaration kinds that denote a symbol. A function template is callable
 * in source but denotes no symbol until it is instantiated, so clang names
 * none and it is reported unmeasured rather than absent.
 */
export const callableKinds = new Set(["function", "method", "constructor", "destructor"]);

/**
 * How to invoke one LLVM binutil on this host.
 *
 * `xcrun` is Apple's tool locator and exists on no other operating system, so
 * hardcoding it made this pass macOS-only. The measurement itself is not: it
 * reads Mach-O, ELF and COFF archives out of Defold's own SDK zip, which is the
 * same zip everywhere. A tool on PATH is used directly; `xcrun` is the fallback
 * for a Mac where the binutils live inside Xcode rather than on PATH.
 */
const llvmToolCache = new Map();
function llvmTool(name) {
  if (!llvmToolCache.has(name)) {
    const onPath = spawnSync(name, ["--version"], { stdio: "ignore" });
    llvmToolCache.set(name, onPath.error ? ["xcrun", name] : [name]);
  }
  return llvmToolCache.get(name);
}

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(`dmSDK symbol evidence: ${message}`);
}

function parseLock(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

/** Text of one member of the pinned SDK archive. */
async function sdkText(archive, member) {
  const { stdout } = await run("unzip", ["-p", archive, member], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * The `context` maps a platform key contributes, in Extender's own merge order:
 * `common`, then the platform group, then the exact target. A key absent from a
 * level contributes nothing rather than clearing what an earlier level said.
 */
function contextChain(platforms, target) {
  return [platforms.common, platforms[target.group], platforms[target.target]]
    .map((entry) => entry?.context ?? {});
}

function mergedList(contexts, key) {
  return contexts.flatMap((context) => context[key] ?? []);
}

/**
 * The archive directories one bundle target links from.
 *
 * Read from that target's own `libPaths`, keeping the entries rooted at
 * `{{dynamo_home}}` - those are the SDK's own directories, and they are the
 * only ones the published archive carries. This is also the single place that
 * knows `arm64-osx` builds link `lib/arm64-macos`, and it knows it because
 * Defold says so rather than because we transcribed it.
 */
export function archiveDirectories(contexts) {
  const prefix = "{{dynamo_home}}/";
  return [...new Set(mergedList(contexts, "libPaths")
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length)))].sort(compare);
}

/**
 * The library names one (target, variant) links.
 *
 * `engineLibs` is the base set; a variant manifest removes names with
 * `excludeLibs` and adds names with `libs`. Exclusion is applied before
 * addition because that is the order the manifests are written for:
 * `release` excludes `profile` and adds `profile_null`.
 */
export function variantLibraries({ platformContexts, variantContexts }) {
  const base = mergedList(platformContexts, "engineLibs");
  const excluded = new Set(mergedList(variantContexts, "excludeLibs"));
  const added = mergedList(variantContexts, "libs");
  const names = [];
  for (const name of [...base.filter((entry) => !excluded.has(entry)), ...added]) {
    if (!names.includes(name)) names.push(name);
  }
  return names.sort(compare);
}

/** The defines a variant compiles an extension with, as the manifest declares them. */
export function variantDefines(variantContexts) {
  return [...new Set(mergedList(variantContexts, "defines"))].sort(compare);
}

/**
 * The archive member one library name resolves to inside one directory.
 *
 * Every spelling Extender's own `allowedLibs` list admits is tried, so a
 * Windows `.lib` and a POSIX `lib*.a` are found by the same rule. A name that
 * resolves in none of the target's directories is RECORDED as missing rather
 * than skipped: an unread archive would otherwise be indistinguishable from an
 * archive that genuinely defines nothing.
 */
export function resolveArchive({ members, directories, name }) {
  for (const directory of directories) {
    for (const spelling of [`lib${name}.a`, `${name}.a`, `lib${name}.lib`, `${name}.lib`, name]) {
      const member = `defoldsdk/${directory}/${spelling}`;
      if (members.has(member)) return member;
    }
  }
  return null;
}

async function archiveMembers(archive) {
  const { stdout } = await run("unzip", ["-Z1", archive, "defoldsdk/lib/*", "defoldsdk/ext/lib/*"],
    { maxBuffer: 256 * 1024 * 1024 });
  return new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean));
}

/**
 * The qualified name out of a demangled symbol.
 *
 * Itanium emits `dmRender::SetNamedConstant(dmRender::NamedConstantBuffer*, ...)`,
 * so everything before `(` is the name - scanned BACKWARDS from the parameter
 * list, stopping at the first top-level space, because a return type may
 * precede it and a template argument list legitimately contains spaces.
 */
export function qualifiedName(demangled) {
  const withoutSuffix = demangled.replace(/\s*\(\.[a-z_.0-9]+\)\s*$/, "");
  const open = withoutSuffix.indexOf("(");
  const base = (open >= 0 ? withoutSuffix.slice(0, open) : withoutSuffix).trim();
  let depth = 0;
  for (let index = base.length - 1; index >= 0; index -= 1) {
    const character = base[index];
    if (character === ">") depth += 1;
    else if (character === "<") depth -= 1;
    else if (character === " " && depth <= 0) return base.slice(index + 1);
  }
  return base;
}

/**
 * The qualified names an archive set defines, whatever signature they carry.
 *
 * This exists to keep one particular wrong answer out of the report. When the
 * declaration's PARSED signature disagrees with the engine's - `dmRender::`
 * `SetNamedConstant`'s last parameter is `dmRenderDDF::MaterialDesc::`
 * `ConstantType`, and a parse that cannot reach the generated DDF header
 * recovers it as `int` - the mangled names differ and an exact join reports
 * "absent". The name IS there. Calling that an absence would blame the engine
 * for our own type resolution, so it is reported as `signature-mismatch`, which
 * blocks just as firmly and says something true.
 */
async function demangledNames(symbols) {
  const itanium = [...symbols].filter((name) => name.startsWith("_Z") || name.startsWith("__Z"));
  if (itanium.length === 0) return new Set();
  // `spawn`, not `execFile`: `execFile` has no `input` option, so the names were
  // never written and the demangler sat waiting for an end of input that never
  // came. Every run of this pass hung there.
  const stdout = await new Promise((resolve) => {
    const [command, ...prefix] = llvmTool("llvm-cxxfilt");
    const child = spawn(command, prefix, { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output));
    child.stdin.on("error", () => {});
    child.stdin.end(itanium.join("\n"));
  });
  return new Set(stdout.split("\n").map((line) => qualifiedName(line.trim())).filter(Boolean));
}

/** Externally visible definitions in one archive file. */
async function definedSymbols(file) {
  const names = new Set();
  let stdout = "";
  try {
    // llvm-nm reads Mach-O, ELF and COFF alike, so one tool covers every target
    // rather than needing a per-platform binutils. RAW symbols, not demangled:
    // the IR carries the compiler's own mangled name per ABI, so the join is
    // exact and needs no name reconstruction.
    const [command, ...prefix] = llvmTool("llvm-nm");
    ({ stdout } = await run(command, [...prefix, "--defined-only", file], { maxBuffer: 512 * 1024 * 1024 }));
  } catch {
    return null;
  }
  for (const line of stdout.split("\n")) {
    // `<addr> <type> <name>`; only externally visible definitions count, so
    // lowercase (local) types are skipped.
    const match = /^[0-9a-fA-F]*\s+([A-Za-z])\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, type, name] = match;
    if (type !== type.toUpperCase()) continue;
    names.add(name.trim());
  }
  return names;
}

/**
 * How a declaration's availability reads once every (target, variant) has
 * answered. These are shapes, not names: a lowering policy selects on them
 * without ever naming a declaration.
 *
 * `partially-measured` is the one that matters most, because it is the answer
 * that is easiest to get wrong. A cross-target parse on this host cannot find
 * another platform's hosted system headers, so clang declines to name the
 * symbol a Linux or Windows or Emscripten build would emit for a handful of
 * declarations - `dmGraphics::WebGPUGetDevice` on the two web targets,
 * `GetNativeX11Window` on Linux and Android, `dmStrlCpy` wherever `<stdio.h>`
 * is missing. Those are exactly the targets the declaration is FOR. Folding
 * them in with the targets that were asked and said no would report a platform
 * gate that does not exist, so they are called out and stay blocked.
 */
export function availabilityOf({ headerOnly, measuredTargets, unmeasuredTargets, linkedIn, variantCount }) {
  if (headerOnly) return "header-only";
  if (measuredTargets === 0) return "unmeasured";
  if (unmeasuredTargets > 0) return "partially-measured";
  if (linkedIn.length === 0) return "unlinked";
  if (linkedIn.length === measuredTargets * variantCount) return "all-targets-all-variants";
  const perVariant = new Map();
  for (const { target, variant } of linkedIn) {
    if (!perVariant.has(variant)) perVariant.set(variant, new Set());
    perVariant.get(variant).add(target);
  }
  if (perVariant.size < variantCount) return "variant-conditional";
  const signatures = new Set([...perVariant.values()].map((targets) => [...targets].sort(compare).join(",")));
  return signatures.size > 1 ? "variant-conditional" : "target-subset";
}

export async function buildSymbolEvidence(options = {}) {
  const sourceRoot = options.root ?? root;
  const read = (relative) => readFile(path.join(sourceRoot, relative), "utf8");
  const archive = options.sdkArchive ?? path.join(sourceRoot, paths.sdkArchive);

  const lock = parseLock(await read(paths.lock));
  const ir = JSON.parse(await read(paths.ir));
  const bundleTargets = JSON.parse(await read(paths.bundleTargets));
  assert(bundleTargets.defoldRevision === ir.defoldRevision,
    "the bundle-target registry and the dmSDK IR describe different Defold revisions");
  assert(lock.DEFOLD_REV === ir.defoldRevision,
    `upstream.lock pins ${lock.DEFOLD_REV} but the dmSDK IR was derived at ${ir.defoldRevision}`);

  const buildConfigText = await sdkText(archive, sdkMembers.buildConfig);
  const platforms = parseYaml(buildConfigText)?.platforms;
  assert(platforms, `${sdkMembers.buildConfig} declares no platforms map`);
  const variantTexts = Object.fromEntries(await Promise.all(variants.map(async (variant) =>
    [variant, await sdkText(archive, sdkMembers.variantManifest(variant))])));
  const variantPlatforms = Object.fromEntries(variants.map((variant) =>
    [variant, parseYaml(variantTexts[variant])?.platforms ?? {}]));

  const targets = bundleTargets.targets
    .filter(({ kind }) => kind === "bundle")
    .sort((left, right) => compare(left.target, right.target));
  assert(targets.length > 0, "the bundle-target registry declares no bundle targets");

  const members = await archiveMembers(archive);
  const plans = [];
  const unavailableTargets = [];
  for (const target of targets) {
    const platformContexts = contextChain(platforms, target);
    const directories = archiveDirectories(platformContexts);
    if (directories.length === 0) {
      // A historical Platform/build_input entry can survive after the
      // published SDK stops carrying a link plan for it (x86-win32 in 1.13.1
      // is one concrete example). That is revision evidence, not a reason to
      // make every other target underivable. Keep it explicit in the report
      // and exclude it from all-target availability denominators: there is no
      // engine archive Defold could link for this target at this revision.
      unavailableTargets.push({
        target: target.target,
        reason: `${sdkMembers.buildConfig} declares no {{dynamo_home}} library path`
      });
      continue;
    }
    const byVariant = {};
    for (const variant of variants) {
      const variantContexts = contextChain(variantPlatforms[variant], target);
      const names = variantLibraries({ platformContexts, variantContexts });
      const resolved = [];
      const missing = [];
      for (const name of names) {
        const member = resolveArchive({ members, directories, name });
        if (member) resolved.push(member);
        else missing.push(name);
      }
      byVariant[variant] = {
        defines: variantDefines(variantContexts),
        libraries: names,
        archives: resolved,
        // Named, never swallowed: these are the external dependencies Defold
        // links from a toolchain SDK rather than from its own published
        // archive, plus anything a platform names but does not ship.
        unresolvedLibraries: missing
      };
    }
    plans.push({ target, directories, byVariant });
  }
  assert(plans.length > 0, "the published SDK declares no measurable bundle target link plans");

  const wanted = new Set(plans.flatMap(({ byVariant }) => Object.values(byVariant).flatMap(({ archives }) => archives)));
  const work = await mkdtemp(path.join(tmpdir(), "deherm-sdk-"));
  const symbolsByMember = new Map();
  const unreadableArchives = [];
  try {
    const extracted = path.join(work, "sdk");
    await mkdir(extracted, { recursive: true });
    for (const batch of chunk([...wanted].sort(compare), 200)) {
      await run("unzip", ["-q", "-o", archive, ...batch, "-d", extracted], { maxBuffer: 64 * 1024 * 1024 });
    }
    for (const member of [...wanted].sort(compare)) {
      const symbols = await definedSymbols(path.join(extracted, member));
      if (symbols === null) unreadableArchives.push(member);
      symbolsByMember.set(member, symbols ?? new Set());
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  assert(unreadableArchives.length === 0,
    `llvm-nm could not read ${unreadableArchives.length} archive(s), starting with ${unreadableArchives[0]}`);

  const symbolsByTargetVariant = new Map();
  for (const { target, byVariant } of plans) {
    for (const variant of variants) {
      const union = new Set();
      for (const member of byVariant[variant].archives) {
        for (const symbol of symbolsByMember.get(member)) union.add(symbol);
      }
      symbolsByTargetVariant.set(`${target.target}/${variant}`, union);
    }
  }

  // One name index over everything any target links, used only to tell an
  // absence apart from a signature disagreement.
  const everySymbol = new Set();
  for (const symbols of symbolsByTargetVariant.values()) for (const symbol of symbols) everySymbol.add(symbol);
  const definedNames = await demangledNames(everySymbol);

  // Keyed by the DECLARATION's id, and joined on the compiler's own mangled
  // name for the ABI each bundle target uses. Overloads therefore separate
  // themselves: dmEndian::ByteSwap is three symbols, not one.
  const declarations = {};
  const counts = { external: 0, headerOnly: 0, absent: 0, unmeasured: 0, signatureMismatch: 0 };
  // Null-prototype tallies: one of the keys counted here is literally
  // `constructor`, and a plain object would hand back Object.prototype's.
  const availabilityCounts = Object.create(null);
  const kindCounts = Object.create(null);
  for (const declaration of ir.declarations ?? []) {
    // Every CALLABLE kind, not only free functions. A constructor, a
    // destructor and an out-of-line method each denote a symbol exactly as a
    // function does, and asking only about functions left 72 of them recorded
    // as unmeasured when clang had already named them.
    if (!callableKinds.has(declaration.kind)) continue;
    // Header-only by design: `static` or `inline` emits no external symbol, and
    // our bindings are C++ that Extender compiles, so it is reached by the thunk
    // we already emit rather than by linking.
    const headerOnly = Boolean(declaration.inline) || declaration.storageClass === "static";
    // A bundle target is MEASURABLE only when clang, parsing for that target's
    // own triple, named the symbol it would emit. Where it could not, that
    // target is unmeasured rather than symbol-free.
    const unmeasured = plans.filter(({ target }) => !declaration.mangledNames?.[target.target])
      .map(({ target }) => target.target).sort(compare);
    const linkedIn = [];
    for (const { target } of plans) {
      const wantedSymbol = declaration.mangledNames?.[target.target];
      if (!wantedSymbol) continue;
      for (const variant of variants) {
        if (symbolsByTargetVariant.get(`${target.target}/${variant}`)?.has(wantedSymbol)) {
          linkedIn.push({ target: target.target, variant });
        }
      }
    }
    const availability = availabilityOf({
      headerOnly,
      measuredTargets: plans.length - unmeasured.length,
      unmeasuredTargets: headerOnly ? 0 : unmeasured.length,
      linkedIn,
      variantCount: variants.length
    });
    // `absent` is a claim that the archives were asked and said no, so it is
    // reserved for declarations that were fully asked. Where clang never named
    // the symbol - a class-template member, or a target whose system headers
    // this host cannot reach - the answer is `unmeasured`, which blocks just
    // the same but does not pretend to a finding.
    // `Namespace::Class::Class` is how the inventory spells a constructor;
    // a demangler spells the same thing `Class::Class`.
    const collapsed = declaration.name?.replace(/(^|::)([A-Za-z_]\w*)::\2::/, "$1$2::") ?? "";
    const nameDefinedElsewhere = !headerOnly && linkedIn.length === 0 &&
      (definedNames.has(declaration.name) || definedNames.has(collapsed));
    const linkage = headerOnly ? "header-only"
      : linkedIn.length ? "external"
        : nameDefinedElsewhere ? "signature-mismatch"
          : ["unmeasured", "partially-measured"].includes(availability) ? "unmeasured"
            : "absent";
    counts[linkage === "header-only" ? "headerOnly" : linkage === "external" ? "external"
      : linkage === "unmeasured" ? "unmeasured"
        : linkage === "signature-mismatch" ? "signatureMismatch" : "absent"] += 1;
    const reported = linkage === "signature-mismatch" ? "signature-mismatch" : availability;
    availabilityCounts[reported] = (availabilityCounts[reported] ?? 0) + 1;
    kindCounts[declaration.kind] = (kindCounts[declaration.kind] ?? 0) + 1;
    declarations[declaration.id] = {
      name: declaration.name,
      kind: declaration.kind,
      header: declaration.header,
      linkage,
      availability: reported,
      ...(headerOnly || unmeasured.length === 0 ? {} : { unmeasuredTargets: unmeasured }),
      linkedIn: Object.fromEntries(variants
        .map((variant) => [variant, linkedIn.filter((entry) => entry.variant === variant)
          .map(({ target }) => target).sort(compare)])
        .filter(([, list]) => list.length > 0))
    };
  }

  return {
    schemaVersion: 2,
    kind: "deherm.dmsdk.symbol-evidence",
    generator: "scripts/generate-dmsdk-symbol-evidence.mjs",
    comment:
      "Which bundle targets' and which build variants' engine archives actually define each declared dmSDK " +
      "function. Measured with llvm-nm over the archives the pinned engine/defoldsdk.zip says Extender links - " +
      "its own extender/build.yml engineLibs, edited by its own extender/variants/<variant>.appmanifest - " +
      "rather than over whatever the lib directory happens to contain. A declaration is not automatically a " +
      "symbol: inline functions, templates and platform-gated code are declared and never land in an archive.",
    derivation: [
      "the archive directory a bundle target links from is that target's {{dynamo_home}} libPaths entry in extender/build.yml",
      "the base archive set is the platform's engineLibs from the same file, merged common then group then target",
      "a variant removes names with its manifest's excludeLibs and then adds names with its manifest's libs",
      "a symbol counts only when the compiler's own mangled name for that target's ABI is defined and externally visible",
      "an inline or static declaration is header-only by design and its absence from every archive is the correct answer",
      "a declaration whose qualified name IS defined but under a different signature is a signature mismatch, not an absence",
      "a library name the published SDK does not carry is recorded as unresolved, never silently skipped"
    ],
    defoldRevision: ir.defoldRevision,
    sdkArchive: { url: lock.DEFOLD_SDK_URL, sha256: lock.DEFOLD_SDK_SHA256 },
    inputEvidence: {
      buildConfig: sdkMembers.buildConfig,
      buildConfigSha256: sha256(buildConfigText),
      variantManifests: Object.fromEntries(variants.map((variant) =>
        [variant, { member: sdkMembers.variantManifest(variant), sha256: sha256(variantTexts[variant]) }]))
    },
    variants,
    ...(unavailableTargets.length > 0 ? { unavailableTargets } : {}),
    targets: plans.map(({ target, directories, byVariant }) => ({
      target: target.target,
      group: target.group,
      architecture: target.architecture,
      archiveDirectories: directories,
      variants: Object.fromEntries(variants.map((variant) => [variant, {
        defines: byVariant[variant].defines,
        libraries: byVariant[variant].libraries.length,
        archives: byVariant[variant].archives.length,
        unresolvedLibraries: byVariant[variant].unresolvedLibraries,
        symbols: symbolsByTargetVariant.get(`${target.target}/${variant}`)?.size ?? 0
      }]))
    })),
    totals: { declarations: Object.keys(declarations).length, ...counts },
    kindCounts: Object.fromEntries(Object.entries(kindCounts).sort(([left], [right]) => compare(left, right))),
    availabilityCounts: Object.fromEntries(Object.entries(availabilityCounts).sort(([left], [right]) => compare(left, right))),
    declarations
  };
}

function chunk(values, size) {
  const batches = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}

export async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const evidence = await buildSymbolEvidence();
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (argv.includes("--check")) {
    const existing = await readFile(evidencePath, "utf8").catch(() => "");
    if (existing !== serialized) {
      throw new Error("defold-dmsdk-symbol-evidence.json is stale; run node scripts/generate-dmsdk-symbol-evidence.mjs");
    }
    console.log("dmSDK symbol evidence is current");
    return evidence;
  }
  await writeFile(evidencePath, serialized);
  const { declarations: measured, external, headerOnly, absent, unmeasured, signatureMismatch } = evidence.totals;
  console.log(`dmSDK symbol evidence: ${measured} callable declarations - ${external} external, ` +
    `${headerOnly} header-only by design, ${absent} absent, ${unmeasured} unmeasured, ` +
    `${signatureMismatch} defined under a different signature, across ` +
    `${evidence.targets.length} bundle targets x ${evidence.variants.length} build variants`);
  return evidence;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
