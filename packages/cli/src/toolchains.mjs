import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { downloadReleaseAssets, extractReleaseArchive } from "./release-assets.mjs";
import { defoldSurfaceCacheHome } from "./defold-surface.mjs";

const packageRoot = path.resolve(import.meta.dirname, "../../..");
const targetCacheReceiptName = ".deherm-target-cache.json";
const targetInstallReceiptName = ".deherm-artifact.json";
const targetVariantHeader = "defold_hermes/include/defold_hermes/generated_runtime_variant.h";
const webRuntimeVariantFiles = [
  {
    source: "packages/cli/templates/web-runtime/component_bridge.js",
    destination: "defold_hermes/lib/web/component_bridge.js"
  },
  {
    source: "packages/cli/templates/web-runtime/library_defold_hermes.js",
    destination: "defold_hermes/lib/web/library_defold_hermes.js"
  }
];
const webDebugBegin = "/* DEHERM_DEBUG_SNAPSHOT_BEGIN */";
const webDebugEnd = "/* DEHERM_DEBUG_SNAPSHOT_END */";

async function replaceProjectFile(destination, writeTemporary) {
  const temporary = `${destination}.deherm-replace-${process.pid}-${randomBytes(5).toString("hex")}`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeTemporary(temporary);
    // Never truncate the destination in place: package-manager/project copies
    // can be hard-linked or clone-backed. Replacing the directory entry keeps
    // selecting a debug artifact in one project from mutating the package
    // template or another project sharing the old inode.
    // rename replaces the destination entry atomically without touching the
    // old inode shared by any hard-linked package/project copy.
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function replaceProjectCopy(source, destination) {
  await replaceProjectFile(destination, (temporary) => cp(source, temporary, {
    errorOnExist: true,
    force: false
  }));
}

async function replaceProjectText(destination, source) {
  await replaceProjectFile(destination, (temporary) => writeFile(temporary, source, { flag: "wx" }));
}

function requestedArtifactVariant(options = {}) {
  const variant = options.variant ?? "release";
  if (variant !== "release" && variant !== "debug") {
    throw new Error(`Unknown Hermes target-artifact variant ${JSON.stringify(variant)}`);
  }
  return variant;
}

export function hostDefoldPlatform(platform = process.platform, architecture = process.arch) {
  const mapped = {
    "darwin:arm64": "arm64-macos",
    "darwin:x64": "x86_64-macos",
    "linux:arm64": "arm64-linux",
    "linux:x64": "x86_64-linux",
    "win32:x64": "x86_64-win32"
  }[`${platform}:${architecture}`];
  if (!mapped) throw new Error(`No Defold development platform mapping exists for ${platform}/${architecture}`);
  return mapped;
}

async function projectLock(projectRoot) {
  return JSON.parse(await readFile(path.join(path.resolve(projectRoot), "deherm.lock"), "utf8"));
}

function targetRecord(lock, requested) {
  const matrix = lock.toolchain?.targetMatrix;
  if (!matrix?.targets || !matrix?.platformPairs) {
    throw new Error("deherm.lock has no authenticated Defold target matrix; run 'deherm generate'");
  }
  const pair = matrix.platformPairs.find(
    (entry) => entry.bobPlatform === requested || entry.extenderTarget === requested
  );
  const extenderTarget = pair?.extenderTarget ?? requested;
  if (!/^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/u.test(extenderTarget)) {
    throw new Error(`Defold policy declared an unsafe bundle target ${JSON.stringify(extenderTarget)}`);
  }
  const record = matrix.targets.find(({ target }) => target === extenderTarget);
  if (!record) throw new Error(`${requested} is not a Defold bundle target declared by ${matrix.authority.targets}`);
  return { ...record, requested, extenderTarget };
}

/**
 * Resolve Bob's command-line platform and Extender's bundle target from the
 * authenticated target matrix generated for one project. Defold owns both
 * spellings; this function deliberately carries no package-level allowlist.
 */
export async function resolveDefoldPlatform(projectRoot, requested, options = {}) {
  if (typeof requested !== "string" || !requested) {
    throw new TypeError("A Bob or Extender platform is required");
  }
  const root = path.resolve(projectRoot);
  const lock = options.lock ?? await projectLock(root);
  const target = targetRecord(lock, requested);
  if (target.kind !== "bundle") throw new Error(`${target.extenderTarget} is retired by this Defold revision`);
  const pair = lock.toolchain.targetMatrix.platformPairs.find(
    (entry) => entry.extenderTarget === target.extenderTarget
  );
  if (!pair) {
    throw new Error(
      `${target.extenderTarget} has no Bob platform declared by ${lock.toolchain.targetMatrix.authority.pairs}`
    );
  }
  return { ...target, bobPlatform: pair.bobPlatform };
}

function nativeArtifactFamily(lock) {
  const family = lock.artifacts?.artifacts?.["native-artifacts"];
  if (!family || family.indexedBy !== "bundleTarget" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(family.tag ?? "") ||
      !/^[a-f0-9]{64}$/u.test(family.fingerprint ?? "")) {
    throw new Error("deherm.lock has no published target-artifact mapping; run 'deherm policy' and 'deherm generate'");
  }
  return family;
}

function releaseArtifactMembers(family, target) {
  const members = family.contents?.[target] ?? [];
  return members.filter((member) => member === "libhermes.a" || member === "hermes.lib" ||
    member === "libhermes.debug.a" || member === "hermes.debug.lib" ||
    member === "libhermesvm-config.h");
}

function variantLibraryMember(members, variant) {
  const debug = variant === "debug";
  const member = members.find((candidate) =>
    (candidate.endsWith(".a") || candidate.endsWith(".lib")) &&
    candidate.includes("debug") === debug);
  if (!member) throw new Error(`Published Hermes archive has no ${variant} library member`);
  return member;
}

function canonicalLibraryMember(members) {
  return variantLibraryMember(members, "release");
}

function renderRuntimeVariantHeader(variant, target, fingerprint) {
  return `// Generated by @ts-defold/deherm target-artifact installation. Do not edit.\n` +
    `// target=${target} fingerprint=${fingerprint} variant=${variant}\n` +
    `#pragma once\n` +
    `#define DEHERM_HERMES_DEBUGGER ${variant === "debug" ? 1 : 0}\n`;
}

export function renderWebRuntimeVariant(source, variant) {
  if (variant !== "debug" && variant !== "release") throw new Error(`Unknown web runtime variant ${JSON.stringify(variant)}`);
  const starts = source.split(webDebugBegin).length - 1;
  const ends = source.split(webDebugEnd).length - 1;
  if (starts === 0 || starts !== ends) throw new Error("Web runtime snapshot variant markers are missing or unbalanced");
  const rendered = variant === "debug"
    ? source
      .replace(/^[\t ]*\/\* DEHERM_DEBUG_SNAPSHOT_BEGIN \*\/[\t ]*\r?\n/gmu, "")
      .replace(/^[\t ]*\/\* DEHERM_DEBUG_SNAPSHOT_END \*\/[\t ]*\r?\n/gmu, "")
    : source.replace(
      /^[\t ]*\/\* DEHERM_DEBUG_SNAPSHOT_BEGIN \*\/[\t ]*\r?\n[\s\S]*?^[\t ]*\/\* DEHERM_DEBUG_SNAPSHOT_END \*\/[\t ]*\r?\n/gmu,
      ""
    );
  if (rendered.includes(webDebugBegin) || rendered.includes(webDebugEnd)) {
    throw new Error("Web runtime snapshot variant markers survived rendering");
  }
  return rendered;
}

async function webRuntimeVariantSources(variant) {
  return Object.fromEntries(await Promise.all(webRuntimeVariantFiles.map(async ({ source, destination }) => [
    destination,
    renderWebRuntimeVariant(await readFile(path.join(packageRoot, source), "utf8"), variant)
  ])));
}

async function installProjectWebRuntimeVariant(root, variant) {
  const sources = await webRuntimeVariantSources(variant);
  const installed = [];
  for (const [relative, source] of Object.entries(sources)) {
    const destination = path.join(root, relative);
    const current = await readFile(destination, "utf8").catch(() => null);
    if (current !== source) {
      await replaceProjectText(destination, source);
      installed.push(destination);
    }
  }
  return installed;
}

function targetLibraryPath(projectRoot, target, member) {
  return path.join(path.resolve(projectRoot), "defold_hermes", "lib", target, member);
}

function targetArtifactPath(projectRoot, target, member) {
  if (member === "libhermesvm-config.h") {
    return path.join(path.resolve(projectRoot), "defold_hermes", "include", member);
  }
  return targetLibraryPath(projectRoot, target, member);
}

async function allFilesExist(root, members) {
  for (const member of members) {
    if (!await stat(path.join(root, member)).then((value) => value.isFile(), () => false)) return false;
  }
  return members.length > 0;
}

async function memberDigests(root, members) {
  return Object.fromEntries(await Promise.all(members.map(async (member) => [
    member,
    createHash("sha256").update(await readFile(path.join(root, member))).digest("hex")
  ])));
}

async function cachedTargetArtifact(destination, family, target, asset, members) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path.join(destination, targetCacheReceiptName), "utf8"));
  } catch {
    return null;
  }
  if (receipt?.schemaVersion !== 1 || receipt.kind !== "deherm.target-artifact-cache" ||
      receipt.target !== target || receipt.tag !== family.tag ||
      receipt.fingerprint !== family.fingerprint || receipt.asset !== asset ||
      !/^[a-f0-9]{64}$/u.test(receipt.assetSha256 ?? "") ||
      JSON.stringify(receipt.members) !== JSON.stringify(members)) return null;
  for (const member of members) {
    const expected = receipt.hashes?.[member];
    if (!/^[a-f0-9]{64}$/u.test(expected ?? "")) return null;
    const actual = await readFile(path.join(destination, member))
      .then((bytes) => createHash("sha256").update(bytes).digest("hex"), () => null);
    if (actual !== expected) return null;
  }
  return receipt;
}

function releaseRepository(lock) {
  const template = lock.artifacts?.releaseAsset;
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/\{tag\}\/\{asset\}$/u.exec(template ?? "");
  if (!match) throw new Error("deherm.lock has no valid GitHub release asset template");
  return match[1];
}

/** Fetch exactly one target archive into the project cache, then install it. */
export async function ensureProjectNativeArtifact(projectRoot, defoldPlatform, options = {}) {
  const root = path.resolve(projectRoot);
  const lock = options.lock ?? await projectLock(root);
  const target = targetRecord(lock, defoldPlatform);
  if (target.kind !== "bundle") throw new Error(`${target.extenderTarget} is retired by this Defold revision`);
  if (target.group === "web") {
    const variant = requestedArtifactVariant(options);
    const installed = await installProjectWebRuntimeVariant(root, variant);
    const verified = await assertProjectNativeArtifact(root, defoldPlatform, { lock, fetch: false, variant });
    return { ...verified, installed, reused: installed.length === 0 };
  }

  const family = nativeArtifactFamily(lock);
  const variant = requestedArtifactVariant(options);
  const current = await assertProjectNativeArtifact(root, defoldPlatform, {
    lock,
    fetch: false,
    variant,
    // This is the keyed/idempotent fast path used before every development
    // build. The explicit assertion command still hashes bytes; repeated
    // builds trust the authenticated receipt plus exact file sizes.
    verifyDigests: false
  }).catch(() => null);
  if (current) return { ...current, cache: null, installed: [], reused: true };
  const asset = family.assets?.[target.extenderTarget];
  const members = releaseArtifactMembers(family, target.extenderTarget);
  if (!asset || members.length === 0) {
    throw new Error(`No published Hermes archive is declared for ${target.extenderTarget} in ${family.tag}`);
  }
  const cacheRoot = options.cacheRoot
    ? path.resolve(options.cacheRoot)
    : path.join(defoldSurfaceCacheHome(options.env), "artifacts");
  const destination = path.join(cacheRoot, family.tag, target.extenderTarget);
  let cacheReceipt = await cachedTargetArtifact(
    destination, family, target.extenderTarget, asset, members);
  if (!cacheReceipt) {
    if (options.offline || process.env.DEHERM_OFFLINE === "1") {
      throw new Error(
        `${target.extenderTarget} Hermes archive has no valid cache receipt at ${destination} and DEHERM_OFFLINE=1`
      );
    }
    const staging = `${destination}.incoming-${process.pid}-${randomBytes(5).toString("hex")}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      const { downloaded } = await downloadReleaseAssets({
        repository: releaseRepository(lock),
        tag: family.tag,
        assets: [asset],
        destination: staging,
        onProgress: options.onProgress
      });
      const assetSha256 = createHash("sha256").update(await readFile(downloaded[0])).digest("hex");
      await extractReleaseArchive({ archive: downloaded[0], destination: staging });
      await rm(downloaded[0], { force: true });
      if (!await allFilesExist(staging, members)) throw new Error(`${asset} does not contain ${members.join(", ")}`);
      const hashes = await memberDigests(staging, members);
      cacheReceipt = {
        schemaVersion: 1,
        kind: "deherm.target-artifact-cache",
        target: target.extenderTarget,
        tag: family.tag,
        fingerprint: family.fingerprint,
        asset,
        assetSha256,
        members,
        hashes
      };
      await writeFile(path.join(staging, targetCacheReceiptName), `${JSON.stringify(cacheReceipt, null, 2)}\n`);
      await mkdir(path.dirname(destination), { recursive: true });
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const hashes = cacheReceipt.hashes;
  const selectedMember = variantLibraryMember(members, variant);
  const canonicalMember = canonicalLibraryMember(members);
  const configMember = members.find((member) => member === "libhermesvm-config.h");
  if (!configMember) throw new Error(`${asset} does not contain libhermesvm-config.h`);
  const installed = [];
  const installedBytes = {};
  for (const [source, targetMember] of [[selectedMember, canonicalMember], [configMember, configMember]]) {
    const output = targetArtifactPath(root, target.extenderTarget, targetMember);
    await replaceProjectCopy(path.join(destination, source), output);
    installed.push(output);
    installedBytes[targetMember] = (await stat(output)).size;
  }
  // Older installs copied the sibling debugger archive beside the canonical
  // library. Extender discovers every static archive recursively, so leaving
  // it there makes link selection depend on archive order. The cache retains
  // both variants; the project extension contains exactly one.
  for (const member of members.filter((member) => member !== canonicalMember &&
      member !== configMember && (member.endsWith(".a") || member.endsWith(".lib")))) {
    await rm(targetArtifactPath(root, target.extenderTarget, member), { force: true });
  }
  const header = path.join(root, targetVariantHeader);
  await replaceProjectText(header, renderRuntimeVariantHeader(variant, target.extenderTarget, family.fingerprint));
  installed.push(header);
  await replaceProjectText(path.join(root, "defold_hermes", "lib", target.extenderTarget, targetInstallReceiptName), `${JSON.stringify({
    schemaVersion: 2,
    kind: "deherm.installed-target-artifact",
    target: target.extenderTarget,
    variant,
    selectedMember,
    canonicalMember,
    tag: family.tag,
    fingerprint: family.fingerprint,
    asset,
    assetSha256: cacheReceipt.assetSha256,
    cacheMembers: members,
    installed: {
      [canonicalMember]: hashes[selectedMember],
      [configMember]: hashes[configMember]
    },
    installedBytes
  }, null, 2)}\n`);
  return { target: target.extenderTarget, variant, tag: family.tag, fingerprint: family.fingerprint, cache: destination, installed };
}

export async function assertProjectNativeArtifact(projectRoot, defoldPlatform, options = {}) {
  const root = path.resolve(projectRoot);
  const lock = options.lock ?? await projectLock(root);
  const target = targetRecord(lock, defoldPlatform);
  if (target.group === "web") {
    const variant = requestedArtifactVariant(options);
    const expected = await webRuntimeVariantSources(variant);
    const files = [];
    for (const [relative, source] of Object.entries(expected)) {
      const file = path.join(root, relative);
      const actual = await readFile(file, "utf8").catch(() => null);
      if (actual === null) throw new Error(`The installed déherm extension is missing ${path.relative(root, file)}`);
      if (actual !== source) throw new Error(`The installed ${target.extenderTarget} ${variant} browser source checksum mismatch`);
      files.push(file);
    }
    return {
      target: target.extenderTarget,
      variant,
      file: files.at(-1),
      files,
      source: "package-browser-adapter"
    };
  }
  const family = nativeArtifactFamily(lock);
  const variant = requestedArtifactVariant(options);
  const members = releaseArtifactMembers(family, target.extenderTarget);
  const selectedMember = variantLibraryMember(members, variant);
  const canonicalMember = canonicalLibraryMember(members);
  const configMember = members.find((member) => member === "libhermesvm-config.h");
  if (!configMember) throw new Error(`No published Hermes config is declared for ${target.extenderTarget}`);
  const file = targetLibraryPath(root, target.extenderTarget, canonicalMember);
  let receipt = null;
  try {
    receipt = JSON.parse(await readFile(path.join(root, "defold_hermes", "lib", target.extenderTarget, targetInstallReceiptName), "utf8"));
  } catch {}
  const installedPaths = [canonicalMember, configMember];
  const verifyDigests = options.verifyDigests !== false;
  const installedState = Object.fromEntries(await Promise.all(installedPaths.map(async (member) => {
    const installed = targetArtifactPath(root, target.extenderTarget, member);
    const value = await stat(installed).catch(() => null);
    if (!value?.isFile()) return [member, null];
    return [member, {
      bytes: value.size,
      digest: verifyDigests
        ? createHash("sha256").update(await readFile(installed)).digest("hex")
        : null
    }];
  })));
  const variantHeader = await readFile(path.join(root, targetVariantHeader), "utf8").catch(() => "");
  const installedMembersMatch = installedPaths.every((member) =>
    installedState[member]?.bytes === receipt?.installedBytes?.[member] &&
    (!verifyDigests || installedState[member]?.digest === receipt?.installed?.[member]));
  if (installedMembersMatch &&
      receipt?.schemaVersion === 2 && receipt?.kind === "deherm.installed-target-artifact" &&
      receipt.variant === variant && receipt.selectedMember === selectedMember &&
      receipt.canonicalMember === canonicalMember && receipt.target === target.extenderTarget &&
      receipt.tag === family.tag && receipt.fingerprint === family.fingerprint &&
      receipt.asset === family.assets?.[target.extenderTarget] &&
      /^[a-f0-9]{64}$/u.test(receipt.assetSha256 ?? "") &&
      members.every((member) => receipt.cacheMembers?.includes(member)) &&
      new RegExp(`^#define DEHERM_HERMES_DEBUGGER ${variant === "debug" ? 1 : 0}$`, "m").test(variantHeader)) {
    return { target: target.extenderTarget, variant, file, tag: family.tag, fingerprint: family.fingerprint };
  }
  if (options.fetch === false) {
    throw new Error(`The installed déherm extension is missing or does not match its receipt: ${path.relative(root, file)}`);
  }
  await ensureProjectNativeArtifact(root, defoldPlatform, { ...options, lock, variant });
  return { target: target.extenderTarget, variant, file, tag: family.tag, fingerprint: family.fingerprint };
}

export async function nativeArtifactReport(projectRoot) {
  if (!projectRoot) {
    const tags = JSON.parse(await readFile(path.join(packageRoot, "packages", "toolchains", "release-tags.json"), "utf8"));
    const family = tags.families?.["native-artifacts"];
    return {
      schemaVersion: 2,
      source: "published native-artifacts release (target authority requires a generated project)",
      targets: Object.keys(family?.assets ?? {}).sort().map((target) => ({
        target, kind: "published", status: "published", bundleable: true, ok: true,
        detail: `${family.tag}/${family.assets[target]}`
      }))
    };
  }
  const lock = await projectLock(projectRoot);
  const family = nativeArtifactFamily(lock);
  const rows = [];
  for (const record of lock.toolchain.targetMatrix.targets) {
    if (record.kind !== "bundle") continue;
    const asset = family.assets?.[record.target] ?? null;
    const web = record.group === "web";
    const inspected = await assertProjectNativeArtifact(projectRoot, record.target, { lock, fetch: false })
      .then((value) => ({ ok: true, file: value.file }))
      .catch((error) => ({ ok: false, detail: error.message }));
    rows.push({
      target: record.target,
      kind: web ? "package-browser-adapter" : asset ? "published" : "unavailable",
      status: web ? "package-browser-adapter" : asset ? "published" : "unavailable",
      bundleable: web || Boolean(asset),
      ok: web || Boolean(asset),
      detail: web ? "browser-host source adapter" : asset ? `${family.tag}/${asset}` : "no published archive",
      project: inspected
    });
  }
  return { schemaVersion: 2, source: lock.toolchain.targetMatrix.authority.targets, targets: rows };
}
