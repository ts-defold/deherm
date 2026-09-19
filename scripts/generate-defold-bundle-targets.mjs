#!/usr/bin/env node

// Every Defold bundle target this project must answer for is derived from the
// pinned engine sources, never hand-listed. `share/extender/build_input.yml` is
// the file Extender itself reads to decide what it can build, so its `platforms`
// map is the authoritative enumeration: a platform Extender accepts and we do
// not mention is a target a user can select and get silence for.
//
// The structural rule, taken from how Extender resolves a bundle platform:
//
//   * a key without `-` is a shared group context (`common`, `osx`, `android`,
//     ... ), inherited by its members and never selectable on its own;
//   * a key with `-` is `<arch>-<group>` and is selectable;
//   * a selectable key with an empty body carries no toolchain at all. Upstream
//     keeps those only so old manifests still parse, so they are enumerated as
//     retired rather than dropped.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const buildInputPath = path.join(root, "upstream", "defold", "share", "extender", "build_input.yml");
export const sdkVersionsPath = path.join(root, "upstream", "defold", "build_tools", "sdk.py");
export const generatedPath = path.join(root, "packages", "toolchains", "defold-bundle-targets.json");

// The SDK levels each cross build has to match are pinned by the engine, not by
// us: an Android archive built against a different NDK API level or a different
// libc++ than the engine's own is an ABI mismatch Extender only discovers at
// link time. Reading them keeps a Defold bump that moves them a `--check`
// failure here rather than a silent divergence in the container definitions.
const sdkFields = Object.freeze({
  androidNdkVersion: /^ANDROID_NDK_VERSION\s*=\s*'([^']+)'/m,
  androidNdkApiVersion: /^ANDROID_NDK_API_VERSION\s*=\s*'([^']+)'/m,
  android64NdkApiVersion: /^ANDROID_64_NDK_API_VERSION\s*=\s*'([^']+)'/m,
  androidTargetApiLevel: /^ANDROID_TARGET_API_LEVEL\s*=\s*(\d+)/m,
  iphoneosVersionMin: /^VERSION_IPHONEOS_MIN\s*=\s*"([^"]+)"/m,
  macosxVersionMin: /^VERSION_MACOSX_MIN\s*=\s*"([^"]+)"/m
});

async function deriveSdkVersions() {
  const text = await readFile(sdkVersionsPath, "utf8");
  const versions = {};
  for (const [name, pattern] of Object.entries(sdkFields)) {
    const match = text.match(pattern);
    if (!match) throw new Error(`upstream/defold/build_tools/sdk.py no longer declares ${name}`);
    versions[name] = match[1];
  }
  return versions;
}

export async function deriveBundleTargets() {
  const text = await readFile(buildInputPath, "utf8");
  const document = parse(text);
  const platforms = document?.platforms;
  if (!platforms || typeof platforms !== "object") {
    throw new Error(`${path.relative(root, buildInputPath)} declares no platforms map`);
  }
  const groups = [];
  const targets = [];
  for (const [name, body] of Object.entries(platforms)) {
    if (!name.includes("-")) {
      if (name !== "common") groups.push(name);
      continue;
    }
    const separator = name.indexOf("-");
    targets.push({
      target: name,
      architecture: name.slice(0, separator),
      group: name.slice(separator + 1),
      // An empty body means upstream kept the key for manifest compatibility and
      // removed its toolchain; `x86-osx` is the current example.
      kind: body === null || body === undefined ? "retired" : "bundle"
    });
  }
  const lock = await readFile(path.join(root, "upstream.lock"), "utf8");
  const sdkText = await readFile(sdkVersionsPath, "utf8");
  return {
    schemaVersion: 1,
    source: path.relative(root, buildInputPath).split(path.sep).join("/"),
    // Covers both derived sources, so either one moving is a `--check` failure.
    sourceSha256: createHash("sha256").update(text).update("\0").update(sdkText).digest("hex"),
    defoldRevision: lock.match(/^DEFOLD_REV=(.+)$/m)?.[1] ?? null,
    sdk: await deriveSdkVersions(),
    groups: groups.sort(),
    targets: targets.sort((left, right) => left.target.localeCompare(right.target))
  };
}

export async function readBundleTargets() {
  return JSON.parse(await readFile(generatedPath, "utf8"));
}

export function bundleTargetNames(document) {
  return document.targets.filter(({ kind }) => kind === "bundle").map(({ target }) => target);
}

export function allTargetNames(document) {
  return document.targets.map(({ target }) => target);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const derived = await deriveBundleTargets();
  const serialized = `${JSON.stringify(derived, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const current = await readFile(generatedPath, "utf8").catch(() => "");
    if (current !== serialized) {
      throw new Error(`${path.relative(root, generatedPath)} is stale; run node scripts/generate-defold-bundle-targets.mjs`);
    }
    console.log(`ok Defold bundle targets: ${bundleTargetNames(derived).length} bundle, ${derived.targets.length - bundleTargetNames(derived).length} retired`);
  } else {
    await writeFile(generatedPath, serialized);
    console.log(`wrote ${path.relative(root, generatedPath)}: ${derived.targets.map(({ target }) => target).join(", ")}`);
  }
}
