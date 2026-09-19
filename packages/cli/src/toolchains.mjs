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

export async function readNativeArtifactManifest() {
  return JSON.parse(await readFile(path.join(packageRoot, "packages", "toolchains", "native-artifacts.json"), "utf8"));
}

export async function readDefoldBundleTargets() {
  return JSON.parse(await readFile(path.join(packageRoot, "packages", "toolchains", "defold-bundle-targets.json"), "utf8"));
}

// What this installed package can and cannot bundle, per Defold bundle target.
// Every platform the pinned engine's Extender accepts appears here with an
// explicit status: a target that is absent from the manifest would leave a user
// who selects it with silence instead of a blocker naming the platform, which is
// worse than saying the archive is missing.
export async function nativeArtifactReport(projectRoot) {
  const manifest = await readNativeArtifactManifest();
  const bundleTargets = await readDefoldBundleTargets();
  const rows = [];
  for (const entry of bundleTargets.targets) {
    const artifact = manifest.targets?.[entry.target];
    if (!artifact) {
      rows.push({
        target: entry.target,
        kind: entry.kind,
        status: "undeclared",
        ok: false,
        detail: `${bundleTargets.source} declares ${entry.target} and the installed déherm package does not mention it`
      });
      continue;
    }
    const row = {
      target: entry.target,
      kind: entry.kind,
      status: artifact.status,
      builder: artifact.builder ?? null,
      library: artifact.library ?? null,
      blocker: artifact.blocker ?? null,
      bundleable: artifact.status === "vendored" || artifact.status === "vendored-source",
      ok: artifact.status === "vendored" || artifact.status === "vendored-source",
      detail: ""
    };
    if (artifact.status === "vendored") {
      try {
        const bytes = await readFile(path.join(packageRoot, artifact.library));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        row.sha256 = sha256;
        row.ok = sha256 === artifact.sha256;
        row.detail = row.ok ? `${sha256.slice(0, 12)} (${bytes.byteLength} bytes)` : "vendored archive does not match its pinned digest";
      } catch {
        row.ok = false;
        row.detail = `vendored archive missing at ${artifact.library}`;
      }
      if (row.ok && projectRoot) {
        row.project = await assertProjectNativeArtifact(projectRoot, entry.target).then(
          (installed) => ({ ok: true, file: installed.file }),
          (error) => ({ ok: false, detail: error.message })
        );
      }
    } else if (artifact.status === "vendored-source") {
      row.detail = artifact.library;
    } else if (artifact.status === "required-missing") {
      row.detail = `no ${path.basename(artifact.library)} in this package; CI builds it with ${artifact.builder}`;
    } else {
      row.detail = `${artifact.blocker?.code ?? artifact.status}: ${artifact.blocker?.reason ?? "no reason recorded"}`;
    }
    rows.push(row);
  }
  return {
    schemaVersion: 1,
    defoldRevision: manifest.defoldRevision,
    hermesRevision: manifest.hermesRevision,
    source: bundleTargets.source,
    targets: rows
  };
}

export async function assertProjectNativeArtifact(projectRoot, defoldPlatform) {
  const target = extensionPlatform(defoldPlatform);
  const manifest = await readNativeArtifactManifest();
  const artifact = manifest.targets?.[target];
  if (!artifact) throw new Error(`The installed déherm package does not declare a ${target} Hermes artifact`);
  if (artifact.status === "blocked" || artifact.status === "retired-upstream") {
    throw new Error(`The installed déherm package cannot bundle for ${target} (${artifact.blocker?.code ?? artifact.status}): ${artifact.blocker?.reason ?? "no reason recorded"}`);
  }
  if (artifact.status !== "vendored") {
    throw new Error(`The installed déherm package does not contain the required ${target} Hermes artifact (status: ${artifact.status}; CI builds it with ${artifact.builder ?? "no declared builder"})`);
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
