import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nativeArtifactCompatibility } from "../../../compiler/src/defold-toolchain-pins.mjs";
import {
  releaseIntegrityAssetName,
  sha256 as releaseSha256,
  validateReleaseIntegrity,
} from "../../../cli/src/release-integrity.mjs";
import {
  artifactFamilies,
  artifactFamilyNames,
  artifactReleaseForRow,
  familyRelease,
  publishedAssets,
} from "../../../../scripts/lib/artifact-releases.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Build-recipe release metadata lives outside the Defold source-policy generator identity. */
export async function buildArtifactReferences(options = {}) {
  const sourceRoot = options.sourceRoot ?? repositoryRoot;
  const bundleTargets = JSON.parse(
    await readFile(path.join(sourceRoot, "packages", "toolchains", "defold-bundle-targets.json"), "utf8"),
  );
  const compatibility = nativeArtifactCompatibility({
    pins: {
      ANDROID_NDK_VERSION: bundleTargets.sdk.androidNdkVersion,
      ANDROID_NDK_API_VERSION: bundleTargets.sdk.androidNdkApiVersion,
      ANDROID_64_NDK_API_VERSION: bundleTargets.sdk.android64NdkApiVersion,
      ANDROID_TARGET_API_LEVEL: bundleTargets.sdk.androidTargetApiLevel,
      VERSION_IPHONEOS_MIN: bundleTargets.sdk.iphoneosVersionMin,
      VERSION_MACOSX_MIN: bundleTargets.sdk.macosxVersionMin,
    },
    targetMatrix: { targets: bundleTargets.targets },
  });
  const families = {};
  const selectedFamilies = options.families ?? artifactFamilyNames;
  for (const name of selectedFamilies) {
    if (!artifactFamilyNames.includes(name)) throw new Error(`Unknown artifact family ${name}`);
    const family = artifactFamilies[name];
    const rows = await publishedAssets(name, { root: sourceRoot });
    const assets = {};
    const contents = {};
    const releases = {};
    for (const row of rows) {
      const key = row.host ?? row.target;
      assets[key] = row.asset;
      contents[key] = row.files;
      if (name === "native-artifacts") {
        const rowRelease = await artifactReleaseForRow(name, row, { root: sourceRoot });
        releases[key] = {
          recipe: rowRelease.recipe,
          tag: rowRelease.tag,
          fingerprint: rowRelease.fingerprint,
        };
      }
    }
    const nativeCoordinates = Object.values(releases);
    const nativeUsesOneRelease =
      name === "native-artifacts" &&
      new Set(nativeCoordinates.map(({ tag, fingerprint }) => `${tag}\0${fingerprint}`)).size === 1;
    const release =
      name === "native-artifacts"
        ? nativeUsesOneRelease
          ? nativeCoordinates[0]
          : null
        : await familyRelease(name, { root: sourceRoot });
    families[name] = {
      ...(release
        ? { tag: release.tag, fingerprint: release.fingerprint }
        : name === "native-artifacts"
          ? { releases }
          : {}),
      indexedBy: family.tools ? "host" : "bundleTarget",
      summary: family.summary,
      assets,
      contents,
    };
    if (options.integrityRoot) {
      const integrity = {};
      for (const row of rows) {
        const key = row.host ?? row.target;
        const rowRelease = await artifactReleaseForRow(name, row, { root: sourceRoot });
        const sidecar = releaseIntegrityAssetName(row.asset);
        const bytes = await readFile(path.join(options.integrityRoot, name, sidecar));
        const document = validateReleaseIntegrity(JSON.parse(bytes), {
          family: name,
          tag: rowRelease.tag,
          fingerprint: rowRelease.fingerprint,
          asset: row.asset,
          members: row.files,
        });
        integrity[key] = {
          asset: sidecar,
          sha256: releaseSha256(bytes),
          archiveSha256: document.archive.sha256,
          archiveBytes: document.archive.bytes,
        };
      }
      families[name].integrity = integrity;
    }
    if (name === "native-artifacts") families[name].compatibility = compatibility;
  }
  return families;
}
