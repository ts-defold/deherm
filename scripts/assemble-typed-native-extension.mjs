#!/usr/bin/env node
// Assemble `shermes -emit-c` output into an extension Bob uploads.
//
// The build-seam decision says the extension's `src/` is not static: a release
// build runs `shermes -typed -emit-c` over the reachable typed-native surface
// and assembles the result into extension sources before Bob packages them, so
// Extender compiles that C like any other extension source and the user needs
// no native toolchain of their own.
//
// It lands as its own materialised extension beside `defold_hermes` because the
// extension Bob uploads is project-specific while `defold_hermes` is the
// package's own shared, per-release tree. Nothing in the shared extension has
// to change per project: the assembled unit announces itself through the
// static-unit registry instead of being named by a hand-edited source list.
//
// One adaptation is unavoidable and is done here rather than pretended away.
// Extender drives every extension source through a C++ driver, and its
// `ext.manifest` contexts merge across the whole build - a `-x c` on this
// extension would land on `defold_hermes`'s C++ too, and `-std=c++17` from
// `defold_hermes` lands here, which clang refuses to combine with a C or
// Objective-C input. `shermes` emits C, and C is not a subset of C++ in three
// specific, enumerable ways that this generated output actually uses. The
// assembler closes exactly those three and asserts it found them, so a fourth
// one appearing upstream fails here instead of at Extender:
//
//   1. a tentative array definition (`static T name[];`) has no C++ spelling,
//      so its real definition is hoisted over the forward declaration;
//   2. `void*` implicitly converts to `T*` in C only, so a generated prelude
//      gives every `extern_c` callee a `void*` overload that casts back;
//   3. `calloc`/`malloc` results need an explicit cast.
//
// None of this rewrites logic. Every transform is structural, derived from the
// pinned declarations, and verified by the assert that follows it.
//
// The unit is a transport of one runtime, not of every target. `shermes` emits
// calls to `_sh_*` entry points that only `libhermes.a` defines, so the unit
// belongs to targets whose runtime is `hermes` and to no others. The assembler
// therefore takes a target, refuses with a machine-readable code for a target
// whose runtime has no Hermes, and reconciles whether Bob may see an already
// materialised unit at all. See `packages/cli/src/typed-native.mjs`.
//
// Usage:
//   node scripts/assemble-typed-native-extension.mjs \
//     --project examples/war-battles-online/defold \
//     [--target arm64-macos] [--profile] [--shermes <path>]
//   node scripts/assemble-typed-native-extension.mjs \
//     --project <dir> --target wasm-web --reconcile

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { recordBuildArtifact, installedToolchain } from "../packages/cli/src/build-artifacts.mjs";
import { hostDefoldPlatform } from "../packages/cli/src/toolchains.mjs";
import {
  TYPED_NATIVE_EXTENSION,
  TYPED_NATIVE_RUNTIME,
  reconcileTypedNativeUpload,
  typedNativeDisposition
} from "../packages/cli/src/typed-native.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const kExtensionName = TYPED_NATIVE_EXTENSION;
const kUnitName = "deherm_typed_native";
// Emitted as C, adapted to compile as C++, because Extender has one merged
// language setting for the whole build. See the note at the top of this file.
const kUnitSource = "deherm_typed_native_unit.cpp";
const kPreludeHeader = "deherm_typed_native_prelude.h";
const kRegistrationSource = "deherm_typed_native_extension.cpp";

// The lane and its JS-facing bridge, concatenated in this order and compiled as
// one sound-typed unit. The lane's `export` statement is stripped because a
// `shermes` unit is not a module.
const kLaneSources = [
  "packages/static-hermes/src/generated/script-universal-value.ts",
  "packages/static-hermes/src/generated/script-typed-native-bridge.ts"
];

/** Packaged Hermes archives whose assert state the emitted unit must match. */
const kVendoredLibraryRoot = "defold/defold_hermes/lib";

/** Declarations the emitted unit calls through `extern_c`, by header. */
const kExternHeaders = [
  "defold/defold_hermes/include/defold_hermes/generated_script_universal_static_frame.h",
  "upstream/hermes/include/hermes/VM/static_h.h"
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Prefer the SHIPPED shermes over a local build.
//
// This path used to hardcode build/native/bin/shermes, so the artifact CI
// publishes and users download was never the one that actually ran - the
// toolchain was declared, built and vendored, and then bypassed. Resolving
// through the host-compiler manifest makes the repository dogfood the same
// binary a user gets, which is the only way a regression in the published tool
// is discoverable here rather than in someone's project.
//
// The local build stays as a fallback, because a checkout that has built Hermes
// but not yet vendored the release still has to work.
async function resolveShermes(explicit) {
  if (explicit) return explicit;
  try {
    const { requireHostTool } = await import("../packages/cli/src/host-compilers.mjs");
    const tool = await requireHostTool("shermes");
    if (tool?.path) return tool.path;
  } catch {
    // Fall through: an unvendored checkout is a normal development state.
  }
  return path.join(repositoryRoot, "build/native/bin/shermes");
}

function parseArguments(argv) {
  const options = {
    project: null,
    target: process.env.DEFOLD_HERMES_PLATFORM || hostDefoldPlatform(),
    reconcile: false,
    profile: false,
    shermes: null,
    hermesInclude: path.join(repositoryRoot, "upstream/hermes/include"),
    hermesConfigInclude: path.join(repositoryRoot, "build/native/hermes/lib/config")
  };
  for (let index = 2; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === "--profile") { options.profile = true; continue; }
    // Decide and apply the upload disposition without running `shermes`. This
    // is what a build wrapper calls before Bob walks the project.
    if (argument === "--reconcile") { options.reconcile = true; continue; }
    if (argument === "--target") {
      const value = argv[++index];
      assert.ok(value, "--target requires a value");
      options.target = value;
      continue;
    }
    if (argument === "--project" || argument === "--shermes" ||
        argument === "--hermes-include" || argument === "--hermes-config-include") {
      const value = argv[++index];
      assert.ok(value, `${argument} requires a value`);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      options[key] = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  assert.ok(options.project, "--project is required");
  return options;
}

/**
 * Transitive closure of the quoted/angled `hermes/...` includes the emitted C
 * needs, walked from `static_h.h`. Derived rather than listed so an upstream
 * header that gains an include fails here instead of at Extender.
 */
export async function resolveHermesHeaderClosure(includeRoot, configRoot) {
  const pending = ["hermes/VM/static_h.h"];
  const resolved = new Map();
  while (pending.length) {
    const relative = pending.pop();
    if (resolved.has(relative)) continue;
    let base = includeRoot;
    let source;
    try {
      source = await readFile(path.join(includeRoot, relative), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      base = configRoot;
      source = await readFile(path.join(configRoot, relative), "utf8");
    }
    resolved.set(relative, { source, base });
    for (const match of source.matchAll(/^\s*#\s*include\s*["<]([^">]+)[">]/gm)) {
      const target = match[1];
      // Only project-internal headers travel with the extension; libc and
      // compiler headers come from the target SDK.
      if (!target.startsWith("hermes/") && target !== "libhermesvm-config.h") continue;
      if (!resolved.has(target)) pending.push(target);
    }
  }
  return resolved;
}

function renderExtensionManifest() {
  return `# Materialised by scripts/assemble-typed-native-extension.mjs. Do not edit.
#
# This extension exists to carry \`shermes -emit-c\` output for one project. It
# declares no context of its own: Extender merges every extension's
# \`ext.manifest\` context into one per-build setting, so the C++ standard and
# exception flags \`defold_hermes\` already asks for are the ones this unit is
# compiled under, and a flag added here would land on \`defold_hermes\` too.
#
# RUNTIME: ${TYPED_NATIVE_RUNTIME}. This extension is a transport of the Hermes
# runtime, not a platform-neutral one. Its sources call \`_sh_*\` entry points
# that only \`libhermes.a\` defines, and an \`ext.manifest\` cannot exclude a
# platform - Extender compiles every \`src/\` file it is given. The upload gate
# is therefore \`.defignore\`, maintained by
# \`packages/cli/src/typed-native.mjs\`, and each generated source additionally
# fails closed with a named #error if it ever reaches a non-Hermes toolchain.
name: "${kExtensionName}"
`;
}

/**
 * Fail closed, by name, if this unit reaches a toolchain whose target has no
 * Hermes. The upload gate is `.defignore`; this is what happens when something
 * bypasses it. `__EMSCRIPTEN__` is defined by the compiler itself, so the guard
 * needs no Defold header and works in the emitted C unit as well as in the
 * registration shell.
 */
export function renderRuntimeGuard() {
  return `// A \`shermes -emit-c\` unit is a transport of the '${TYPED_NATIVE_RUNTIME}' runtime. The web
// targets run game code on the browser's own JavaScript engine and embed no
// Hermes, so this translation unit has nothing to call there. Saying so here
// turns a pile of undefined _sh_* symbols at link time into one named refusal
// at compile time. The build-time gate that normally prevents this is the
// .defignore entry maintained by packages/cli/src/typed-native.mjs.
#if defined(__EMSCRIPTEN__) || defined(DM_PLATFORM_HTML5)
#error "deherm typed-native-requires-hermes-runtime: this unit is a Hermes-runtime transport and cannot be compiled for a browser-runtime target"
#endif

`;
}

/**
 * The C++ adaptation prelude.
 *
 * `shermes` types every native pointer as `void*`, which C converts to any
 * object pointer implicitly and C++ does not. Rather than edit the call sites,
 * each `extern_c` callee gains one overload whose pointer parameters are
 * `void*` and which casts them back to the declared type. The overloads are
 * derived from the pinned declarations, so a changed signature changes them.
 */
export function renderPrelude(declarations) {
  const overloads = [];
  for (const { returnType, name, parameters } of declarations) {
    if (!parameters.some(({ pointer }) => pointer)) continue;
    const signature = parameters
      .map(({ pointer, type, name: parameterName }) => (pointer ? `void* ${parameterName}` : `${type} ${parameterName}`))
      .join(", ");
    const call = parameters
      .map(({ pointer, type, name: parameterName }) => (pointer ? `static_cast<${type}>(${parameterName})` : parameterName))
      .join(", ");
    const body = returnType === "void" ? `${name}(${call});` : `return ${name}(${call});`;
    overloads.push(`static inline ${returnType} ${name}(${signature}) { ${body} }`);
  }
  return `// Materialised by scripts/assemble-typed-native-extension.mjs. Do not edit.
//
// C++ adaptation for one \`shermes -emit-c\` unit. See the note at the top of
// the assembler: Extender compiles this extension's sources with the same C++
// settings as \`defold_hermes\`, and \`void*\` does not implicitly convert to a
// typed pointer there. One overload per \`extern_c\` callee restores the exact
// call, with the cast written out instead of implied.
#pragma once

#include <defold_hermes/generated_script_universal_static_frame.h>
#include <hermes/VM/static_h.h>

${overloads.join("\n")}
`;
}

/**
 * Parse the C declarations the emitted unit calls. Comments are stripped and
 * newlines collapsed first, because the pinned headers wrap declarations.
 */
export function parseDeclarations(source, names) {
  const flat = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ");
  const found = new Map();
  for (const name of names) {
    const pattern = new RegExp(`(?:SHERMES_EXPORT )?([A-Za-z_][\\w ]*?[\\w*]) ${name} ?\\(([^)]*)\\) ?;`);
    const match = pattern.exec(flat);
    if (!match) continue;
    const returnType = match[1].trim();
    const rawParameters = match[2].trim();
    if (rawParameters === "void" || rawParameters === "") { found.set(name, { returnType, name, parameters: [] }); continue; }
    if (rawParameters.includes("...")) continue;
    const parameters = rawParameters.split(",").map((parameter, index) => {
      const text = parameter.trim();
      const identifier = /([A-Za-z_]\w*)$/.exec(text);
      const declarator = identifier ? text.slice(0, identifier.index).trim() : text;
      return {
        type: declarator,
        name: identifier ? identifier[1] : `argument${index}`,
        pointer: declarator.endsWith("*")
      };
    });
    found.set(name, { returnType, name, parameters });
  }
  return found;
}

/** Names the lane declares through `$SHBuiltin.extern_c`. */
export function externCalleeNames(laneSource) {
  const names = new Set();
  for (const match of laneSource.matchAll(/\$SHBuiltin\.extern_c\(\s*\{[^}]*\}\s*,\s*function\s+([A-Za-z_]\w*)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * Close the three C-only constructs the emitted unit uses. Each transform
 * asserts it applied, so an upstream emitter change is a failure here rather
 * than a compile error inside Extender.
 */
export function adaptEmittedCToCxx(emitted, preludeHeader) {
  let source = emitted;

  // 1. A tentative array definition has no C++ spelling. The real definition
  //    is moved over the forward declaration instead of being duplicated.
  const tentative = [...source.matchAll(/^static (?:const )?[A-Za-z_][\w:]* [A-Za-z_]\w*\[\];$/gm)].map((match) => match[0]);
  assert.ok(tentative.length > 0, "Emitted unit has no tentative array definition; the emitter shape changed");
  for (const declaration of tentative) {
    const head = `${declaration.slice(0, -1)} = {`;
    const start = source.indexOf(head);
    assert.ok(start >= 0, `No definition for tentative declaration: ${declaration}`);
    const end = source.indexOf("\n};\n", start);
    assert.ok(end >= 0, `Unterminated definition for tentative declaration: ${declaration}`);
    const definition = source.slice(start, end + 4);
    source = `${source.slice(0, start)}${source.slice(start + definition.length)}`;
    assert.ok(source.includes(`${declaration}\n`), "Forward declaration disappeared before hoisting");
    source = source.replace(`${declaration}\n`, definition);
  }

  // 2. Allocation results are `void*`.
  const allocations = source.match(/^(\s*)(struct \w+) \*(\w+) = (calloc|malloc)\(/gm) ?? [];
  assert.ok(allocations.length > 0, "Emitted unit allocates nothing; the emitter shape changed");
  source = source.replace(/^(\s*)(struct \w+) \*(\w+) = (calloc|malloc)\(/gm, "$1$2 *$3 = ($2 *)$4(");

  // 3. Route the `extern_c` declarations through the adaptation prelude.
  const includePattern = /^#include <defold_hermes\/generated_script_universal_static_frame\.h>$/m;
  assert.match(source, includePattern, "Emitted unit no longer includes the universal static frame header");
  source = source.replace(includePattern, `#include <${preludeHeader}>`);

  return source;
}

/**
 * Whether the packaged Hermes archives were built with asserts off.
 *
 * Hermes enforces that a client translation unit and `libhermes.a` agree about
 * asserts, through a model symbol whose name ends in `_rel` or `_dbg`
 * (`libhermesvm-config.h` selects it from `NDEBUG`). Extender's debug variant
 * defines no `NDEBUG`, so an assembled unit would ask for `_dbg` and fail to
 * link against a release archive. The answer is read out of the archives'
 * own symbol tables rather than assumed, because it is a property of the
 * vendored binary and nothing else records it.
 */
export async function resolveArchiveAssertState(libraryRoot) {
  const models = new Set();
  let archives = [];
  try {
    archives = await readdir(libraryRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of archives) {
    if (!entry.isDirectory()) continue;
    const archive = path.join(libraryRoot, entry.name, "libhermes.a");
    let bytes;
    try {
      bytes = await readFile(archive);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const match of bytes.toString("latin1").matchAll(/_sh_model_[\w]*_(rel|dbg)\b/g)) {
      models.add(match[1]);
    }
  }
  assert.ok(models.size <= 1,
    `Vendored Hermes archives disagree about asserts: ${[...models].sort().join(", ")}`);
  // With nothing vendered to read, the project's own CI configuration is the
  // only claim available, and it builds Release.
  return { assertsOff: models.size === 0 || models.has("rel"), observed: [...models][0] ?? null };
}

function renderArchiveMatchPrologue({ assertsOff, observed }) {
  if (!assertsOff) {
    return `// The packaged libhermes.a exports an asserts-on model symbol` +
      ` (_sh_model..._${observed ?? "dbg"}), which Extender's debug variant already matches.\n`;
  }
  return `// The packaged libhermes.a is an asserts-off build: its symbol table exports
// _sh_model..._${observed ?? "rel"}. Hermes turns that into a link-time check that a client
// translation unit agrees, and \`libhermesvm-config.h\` picks the suffix from
// NDEBUG. Extender's debug variant defines no NDEBUG, so this one translation
// unit - not the engine, not the rest of the extension - declares the state of
// the archive it is being linked against.
#ifndef NDEBUG
#define NDEBUG 1
#endif
`;
}

function renderRegistrationSource() {
  return `${renderRuntimeGuard()}// Materialised by scripts/assemble-typed-native-extension.mjs. Do not edit.
//
// Two jobs, both small.
//
// Defold requires every extension directory to declare an extension symbol
// named after itself - the engine's exported-symbol table references it - so
// this unit-carrying extension declares one.
//
// It also hands the emitted unit to \`defold_hermes\` through the static-unit
// registry. \`AppInitialize\` runs before any game code and long before the
// bundle is activated, which is the only ordering that matters: the registry is
// read when a Hermes runtime is constructed for the bundle. Declaring the unit
// here rather than editing \`defold_hermes\`'s sources is what keeps the shared
// extension identical across projects.
#define LIB_NAME "${kExtensionName}"
#ifndef DLIB_LOG_DOMAIN
#define DLIB_LOG_DOMAIN LIB_NAME
#endif

#include <dmsdk/dlib/log.h>
#include <dmsdk/extension/extension.hpp>

#include <defold_hermes/static_unit_registry.h>

// Declared with C++ linkage to match the emitted unit, which \`shermes\` writes
// as an ordinary function and the assembler compiles as C++.
SHUnit* sh_export_${kUnitName}(void);

namespace {

dmExtension::Result AppInitializeTypedNative(dmExtension::AppParams*) {
  if (!deherm_register_static_unit(sh_export_${kUnitName})) {
    dmLogError("deherm typed-native unit could not be registered; the static unit table is full");
    return dmExtension::RESULT_INIT_ERROR;
  }
  dmLogInfo("DEHERM_EVENT typed-native-unit-registered unit=sh_export_${kUnitName}");
  return dmExtension::RESULT_OK;
}

dmExtension::Result AppFinalizeTypedNative(dmExtension::AppParams*) { return dmExtension::RESULT_OK; }
dmExtension::Result InitializeTypedNative(dmExtension::Params*) { return dmExtension::RESULT_OK; }
dmExtension::Result FinalizeTypedNative(dmExtension::Params*) { return dmExtension::RESULT_OK; }

}  // namespace

namespace deherm_typed_native_registration {
DM_DECLARE_EXTENSION(
    ${kExtensionName},
    LIB_NAME,
    AppInitializeTypedNative,
    AppFinalizeTypedNative,
    InitializeTypedNative,
    0,
    0,
    FinalizeTypedNative)
}  // namespace deherm_typed_native_registration
`;
}

// The shipped default is telemetry OFF. `checkShippedProfileDefault` in
// scripts/check-profile-compile-out.mjs re-renders this with `profile` false
// and refuses a checkout whose committed header says anything else, so an
// instrumented header cannot reach a commit by being left behind after a
// profiling run.
export function renderBuildConfig(profile) {
  const header = `// Materialised by scripts/assemble-typed-native-extension.mjs. Do not edit.
//
// The extension Bob uploads is project-specific: a build materialises the
// emitted C and, with it, the build-time switches that C was assembled under.
// Extender has no equivalent of a CMake option, and \`ext.manifest\` defines are
// per-extension rather than per-build, so the switch travels as a generated
// header every instrumented translation unit already reaches through
// \`deherm_profile.hpp\`.
`;
  if (!profile) {
    return `${header}//
// This is the skeleton the package ships: it defines nothing, so an unassembled
// extension compiles exactly as it did before the seam existed.
#pragma once
`;
  }
  return `${header}//
// Assembled with telemetry ON. Every generated dispatcher and the JSI bridge
// open a transport span, and the extension update drains the producer ring into
// a per-route census on stdout. This is the instrument that says which
// transport a call actually took; it is off in the shipped skeleton.
//
// The guard keeps the two build systems from fighting over one switch: this
// checkout's CMake build always defines \`DEHERM_PROFILE_BUILD_SYSTEM\`, so its
// own \`DEHERM_PROFILE\` option stays the only authority there, and this header
// governs only the packaged extension that Bob and Extender compile.
#pragma once

#if !defined(DEHERM_PROFILE_BUILD_SYSTEM) && !defined(DEHERM_PROFILE)
#define DEHERM_PROFILE 1
#endif
`;
}

/**
 * The disposition of an already-materialised unit for one target, applied to
 * the project on disk. No `shermes`, no emission, no removal of files: a unit
 * a native build paid for stays on disk and is hidden from a web build.
 */
export async function reconcile(options) {
  const projectRoot = path.resolve(options.project);
  const result = await reconcileTypedNativeUpload({ projectRoot, platform: options.target });
  return { ...result, extensionRoot: path.join(projectRoot, kExtensionName) };
}

export async function assemble(options) {
  const projectRoot = path.resolve(options.project);
  const extensionRoot = path.join(projectRoot, kExtensionName);

  // A typed-native unit is a transport of the `hermes` runtime. Deciding this
  // before anything is emitted is what keeps a browser-runtime target from
  // acquiring a unit whose symbols its link can never resolve.
  const disposition = await typedNativeDisposition(options.target);
  if (!disposition.eligible) {
    const refusal = {
      schemaVersion: 1,
      refused: true,
      code: disposition.code,
      generator: "scripts/assemble-typed-native-extension.mjs",
      extension: kExtensionName,
      requiresRuntime: TYPED_NATIVE_RUNTIME,
      target: disposition.platform,
      extenderTarget: disposition.extenderTarget,
      runtime: disposition.runtimeId,
      reason: disposition.reason,
      // The refusal is not the whole answer: an earlier native build may have
      // left a unit on disk, and that unit must not reach this target's upload.
      reconciled: await reconcileTypedNativeUpload({ projectRoot, platform: options.target })
    };
    return { extensionRoot, refusal, manifest: null, written: [], recorded: null };
  }

  const laneSources = [];
  for (const relative of kLaneSources) {
    const absolute = path.join(repositoryRoot, relative);
    const source = await readFile(absolute, "utf8");
    laneSources.push({ relative, absolute, source });
  }
  // `export { ... }` makes the lane a module; a `shermes` unit is not one.
  const unitSource = laneSources
    .map(({ source }) => source.replace(/^export \{.*\};$/m, ""))
    .join("\n");

  // `shermes` writes the input path it was given into the emitted source
  // locations, so a temporary directory would make identical TypeScript emit
  // different C on every run and on every host. The lane is staged at a fixed
  // repository-relative path and compiled with the repository as the working
  // directory, which makes the emission content-addressed by its inputs.
  const stagingDirectory = path.join(repositoryRoot, "build/generated/typed-native");
  const relativeInput = `build/generated/typed-native/${kUnitName}.ts`;
  await mkdir(stagingDirectory, { recursive: true });
  const output = path.join(stagingDirectory, `${kUnitName}.c`);
  await writeFile(path.join(repositoryRoot, relativeInput), unitSource);
  const shermesPath = await resolveShermes(options.shermes);
  const result = spawnSync(shermesPath, [
    "-typed", "-strict", "-O", "-emit-c",
    `-exported-unit=${kUnitName}`,
    relativeInput, "-o", output
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || "shermes did not run");
  const emittedC = await readFile(output, "utf8");
  assert.ok(emittedC.includes(`// ${relativeInput}:`),
    "Emitted C does not name the staged lane; source locations changed shape");
  assert.doesNotMatch(emittedC, /^\/\/ \//m,
    "Emitted C carries an absolute source path, so the emission is not reproducible across hosts");

  // The emission is only useful if it really lowered the `extern_c`
  // declarations to direct C calls. Assert that from the artifact rather than
  // assuming it: a JSI fallback inside the unit would leave no such symbol.
  assert.match(emittedC, /#define CREATE_THIS_UNIT sh_export_deherm_typed_native/,
    "shermes did not emit a library-shaped unit");
  assert.doesNotMatch(emittedC, /\bint\s+main\s*\(/, "shermes emitted an executable unit");
  const externCallSites = (emittedC.match(/\bdeherm_script_static_[a-z_0-9]*\(/g) ?? []).length;
  assert.ok(externCallSites > 0,
    "Emitted C contains no direct call to the universal static frame; extern_c did not lower");

  // The prelude is derived from the same declarations the lane pointed
  // `extern_c` at, so a changed signature changes the overload rather than
  // silently mismatching at the ABI.
  const calleeNames = externCalleeNames(unitSource);
  assert.ok(calleeNames.length > 0, "The lane declares no extern_c callee");
  const declarations = new Map();
  for (const relative of kExternHeaders) {
    const header = await readFile(path.join(repositoryRoot, relative), "utf8");
    for (const [name, declaration] of parseDeclarations(header, calleeNames)) {
      if (!declarations.has(name)) declarations.set(name, declaration);
    }
  }
  const unresolved = calleeNames.filter((name) => !declarations.has(name));
  assert.deepEqual(unresolved, [],
    `extern_c callees have no parsed C declaration: ${unresolved.join(", ")}`);
  const prelude = renderPrelude([...declarations.values()]);
  const assertState = await resolveArchiveAssertState(path.join(repositoryRoot, kVendoredLibraryRoot));
  const adapted = `${renderRuntimeGuard()}${renderArchiveMatchPrologue(assertState)}${adaptEmittedCToCxx(emittedC, kPreludeHeader)}`;

  const headers = await resolveHermesHeaderClosure(options.hermesInclude, options.hermesConfigInclude);

  await rm(extensionRoot, { recursive: true, force: true });
  await mkdir(path.join(extensionRoot, "src"), { recursive: true });

  const written = [];
  const write = async (relative, content) => {
    const absolute = path.join(extensionRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    written.push(absolute);
  };

  await write("ext.manifest", renderExtensionManifest());
  await write(path.join("include", kPreludeHeader), prelude);
  await write(path.join("src", kUnitSource), adapted);
  await write(path.join("src", kRegistrationSource), renderRegistrationSource());
  for (const [relative, { source }] of [...headers].sort(([left], [right]) => (left < right ? -1 : 1))) {
    await write(path.join("include", relative), source);
  }

  // The profile switch is a property of the assembled build, so it is
  // materialised with it and lives in the extension whose dispatchers it
  // instruments.
  const buildConfig = path.join(repositoryRoot,
    "defold/defold_hermes/include/defold_hermes/generated_build_config.h");
  await writeFile(buildConfig, renderBuildConfig(options.profile));

  const manifest = {
    schemaVersion: 1,
    generator: "scripts/assemble-typed-native-extension.mjs",
    extension: kExtensionName,
    unit: `sh_export_${kUnitName}`,
    transport: "typed-native",
    // The unit executes only where a Hermes runtime exists. Recorded next to
    // the artifact so a consumer can answer the question without re-deriving
    // it, and so an upload gate can be checked against the artifact it guards.
    requiresRuntime: TYPED_NATIVE_RUNTIME,
    assembledForTarget: disposition.platform,
    assembledForExtenderTarget: disposition.extenderTarget,
    uploadGate: {
      mechanism: ".defignore",
      entry: `/${kExtensionName}`,
      appliedBy: "packages/cli/src/typed-native.mjs",
      note: "Bob filters extension discovery through .defignore, and an ext.manifest cannot exclude a platform."
    },
    profile: options.profile,
    laneSources: Object.fromEntries(laneSources.map(({ relative, source }) => [relative, sha256(source)])),
    vendoredHeaders: Object.fromEntries([...headers]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([relative, { source }]) => [relative, sha256(source)])),
    hermesArchiveModel: assertState.observed,
    compiledWithAssertsOff: assertState.assertsOff,
    externCalleeCount: calleeNames.length,
    externCallSiteCount: externCallSites,
    emittedCSha256: sha256(emittedC),
    emittedCBytes: Buffer.byteLength(emittedC),
    adaptedSourceSha256: sha256(adapted),
    evidenceBoundary: {
      cEmission: "observed",
      compilation: "requires-extender",
      linkage: "requires-extender",
      runtime: "not-claimed"
    }
  };
  await write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  let recorded = null;
  try {
    recorded = await recordBuildArtifact({
      projectRoot,
      kind: "generated-sources",
      artifacts: written,
      sources: laneSources.map(({ absolute }) => absolute),
      build: {
        generator: "scripts/assemble-typed-native-extension.mjs",
        transport: "typed-native",
        unit: `sh_export_${kUnitName}`,
        profile: options.profile,
        toolchain: await installedToolchain()
      }
    });
  } catch (error) {
    // A project without a lock is still assembled; the binding is the part
    // that is missing, and saying so is more useful than refusing.
    recorded = { record: null, written: false, reason: error.message };
  }

  // A target that can carry the unit must not be left with the exclusion a
  // previous web build applied.
  const reconciled = await reconcileTypedNativeUpload({ projectRoot, platform: options.target });

  return { extensionRoot, manifest, written, recorded, reconciled, refusal: null };
}

export async function run(argv = process.argv) {
  const options = parseArguments(argv);
  if (options.reconcile) {
    const result = await reconcile(options);
    console.log(`typed-native: ${result.message}`);
    return result;
  }
  const result = await assemble(options);
  if (result.refusal) {
    // Machine-readable on stdout, and a non-zero exit, because asking for this
    // artifact for this target is a request that cannot be satisfied - not a
    // build step that silently did nothing.
    console.log(JSON.stringify(result.refusal, null, 2));
    process.exitCode = 3;
    return result;
  }
  const files = await readdir(path.join(result.extensionRoot, "src"));
  console.log(
    `assembled ${kExtensionName} into ${path.relative(repositoryRoot, result.extensionRoot)}: ` +
    `${files.length} C source(s), ${Object.keys(result.manifest.vendoredHeaders).length} vendored header(s), ` +
    `${result.manifest.emittedCBytes} bytes of emitted C, profile=${options.profile ? "on" : "off"}`);
  if (result.recorded?.reason) console.log(`deherm.lock binding skipped: ${result.recorded.reason}`);
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await run();
