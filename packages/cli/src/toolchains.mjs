import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { downloadReleaseAssets, extractReleaseArchive } from "./release-assets.mjs";
import { defoldSurfaceCacheHome } from "./defold-surface.mjs";

const packageRoot = path.resolve(import.meta.dirname, "../../..");
const targetCacheReceiptName = ".deherm-target-cache.json";

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
  if (target.group === "web") return assertProjectNativeArtifact(root, defoldPlatform, { lock, fetch: false });

  const family = nativeArtifactFamily(lock);
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
  const installed = [];
  for (const member of members) {
    const output = targetArtifactPath(root, target.extenderTarget, member);
    await mkdir(path.dirname(output), { recursive: true });
    await cp(path.join(destination, member), output);
    installed.push(output);
  }
  await writeFile(path.join(root, "defold_hermes", "lib", target.extenderTarget, ".deherm-artifact.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "deherm.installed-target-artifact",
    target: target.extenderTarget,
    tag: family.tag,
    fingerprint: family.fingerprint,
    asset,
    assetSha256: cacheReceipt.assetSha256,
    members,
    hashes
  }, null, 2)}\n`);
  return { target: target.extenderTarget, tag: family.tag, fingerprint: family.fingerprint, cache: destination, installed };
}

export async function assertProjectNativeArtifact(projectRoot, defoldPlatform, options = {}) {
  const root = path.resolve(projectRoot);
  const lock = options.lock ?? await projectLock(root);
  const target = targetRecord(lock, defoldPlatform);
  if (target.group === "web") {
    const file = path.join(root, "defold_hermes", "lib", "web", "library_defold_hermes.js");
    let actual;
    try {
      actual = await readFile(file);
    } catch {
      throw new Error(`The installed déherm extension is missing ${path.relative(root, file)}`);
    }
    const expected = await readFile(path.join(packageRoot, "defold", "defold_hermes", "lib", "web", "library_defold_hermes.js"));
    if (!actual.equals(expected)) throw new Error(`The installed ${target.extenderTarget} browser source checksum mismatch`);
    return { target: target.extenderTarget, file, source: "package-browser-adapter" };
  }
  const family = nativeArtifactFamily(lock);
  const members = releaseArtifactMembers(family, target.extenderTarget);
  const releaseMember = members.find((member) =>
    (member.endsWith(".a") || member.endsWith(".lib")) && !member.includes("debug"));
  if (!releaseMember) throw new Error(`No published Hermes library is declared for ${target.extenderTarget}`);
  const file = targetLibraryPath(root, target.extenderTarget, releaseMember);
  let receipt = null;
  try {
    receipt = JSON.parse(await readFile(path.join(root, "defold_hermes", "lib", target.extenderTarget, ".deherm-artifact.json"), "utf8"));
  } catch {}
  const installedHashes = await Promise.all(members.map(async (member) => {
    const installed = targetArtifactPath(root, target.extenderTarget, member);
    return stat(installed).then(async (value) => value.isFile()
      ? createHash("sha256").update(await readFile(installed)).digest("hex")
      : null, () => null);
  }));
  const installedMembersMatch = members.every((member, index) =>
    installedHashes[index] !== null && receipt?.hashes?.[member] === installedHashes[index]);
  if (installedMembersMatch &&
      receipt?.kind === "deherm.installed-target-artifact" && receipt.target === target.extenderTarget &&
      receipt.tag === family.tag && receipt.fingerprint === family.fingerprint &&
      receipt.asset === family.assets?.[target.extenderTarget] &&
      /^[a-f0-9]{64}$/u.test(receipt.assetSha256 ?? "") &&
      members.every((member) => receipt.members?.includes(member))) {
    return { target: target.extenderTarget, file, tag: family.tag, fingerprint: family.fingerprint };
  }
  if (options.fetch === false) {
    throw new Error(`The installed déherm extension is missing or does not match its receipt: ${path.relative(root, file)}`);
  }
  await ensureProjectNativeArtifact(root, defoldPlatform, { ...options, lock });
  return { target: target.extenderTarget, file, tag: family.tag, fingerprint: family.fingerprint };
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
