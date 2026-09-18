const defoldToolchains = Object.freeze({
  "7f0f554f41f9dce1e0ddff99bf08200657d1ee05": Object.freeze({
    bob: Object.freeze({
      url: "https://d.defold.com/archive/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/bob/bob.jar",
      sha256: "8a8a8c4ebc725279d8ddae17c4eb3d72d6db90a498302960ca341e61fa489cb8"
    })
  })
});

export function defoldToolchain(revision) {
  const toolchain = defoldToolchains[revision];
  if (!toolchain) {
    throw new Error(`The installed déherm package has no verified Bob artifact for Defold ${revision}`);
  }
  return { bob: { ...toolchain.bob } };
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

export function extensionPlatform(defoldPlatform) {
  return defoldPlatform.endsWith("-macos") ? `${defoldPlatform.slice(0, -"-macos".length)}-osx` : defoldPlatform;
}

export async function assertProjectNativeArtifact(projectRoot, defoldPlatform) {
  const target = extensionPlatform(defoldPlatform);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "packages", "toolchains", "native-artifacts.json"), "utf8"));
  const artifact = manifest.targets?.[target];
  if (!artifact) throw new Error(`The installed déherm package does not declare a ${target} Hermes artifact`);
  if (artifact.status !== "vendored") {
    throw new Error(`The installed déherm package does not contain the required ${target} Hermes artifact (status: ${artifact.status})`);
  }
  const file = path.join(projectRoot, "defold_hermes", "lib", target, path.basename(artifact.library));
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    throw new Error(`The installed déherm extension is missing ${path.relative(projectRoot, file)}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256) throw new Error(`Vendored ${target} Hermes artifact checksum mismatch`);
  return { target, file, sha256: actual };
}
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "../../..");
