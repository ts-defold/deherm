import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { zipSync } from "fflate";

import {
  fetchWebTransportArtifactOverlay,
  hostWebTransportArtifactTarget,
  nativeArtifactAbiSha256,
  readExpectedWebTransportArtifactRelease,
  resolveWebTransportArtifactRoot,
  selectWebTransportArtifactTarget,
  validateWebTransportArtifactOverlay
} from "../packages/cli/src/webtransport-artifacts.mjs";

const fingerprint = "a".repeat(64);
const target = "arm64-osx";
const asset = `defold-webtransport-native-${target}.zip`;
const filename = "libdefold_webtransport_core.a";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-webtransport-consumer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function extensionFixture(root) {
  await mkdir(path.join(root, "include/defold_webtransport"), { recursive: true });
  await mkdir(path.join(root, "webtransport"), { recursive: true });
  await writeFile(path.join(root, "ext.manifest"), "name: defold_webtransport\nplatforms:\n  arm64-osx:\n    context:\n      libs: [defold_webtransport_core]\n");
  await writeFile(path.join(root, "include/defold_webtransport/native_v1.h"), "#pragma once\n");
  const abiSha256 = await nativeArtifactAbiSha256(root);
  await writeFile(path.join(root, "webtransport/native-artifacts.json"), `${JSON.stringify({
    schemaVersion: 1,
    repository: "ts-defold/deherm",
    tag: `defold-webtransport-native-${fingerprint.slice(0, 12)}`,
    fingerprint,
    abiSha256,
    assets: [{ target, asset }]
  }, null, 2)}\n`);
  return abiSha256;
}

function archiveFixture(content = "native archive fixture\n") {
  const bytes = Buffer.from(content);
  const metadata = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    target,
    fingerprint,
    files: [{ name: filename, sha256: sha256(bytes), bytes: bytes.byteLength }]
  }, null, 2)}\n`);
  return zipSync({
    "artifact.json": metadata,
    [`lib/${target}/${filename}`]: bytes
  });
}

function githubReleaseFixture(archive, { digest = sha256(archive) } = {}) {
  const tag = `defold-webtransport-native-${fingerprint.slice(0, 12)}`;
  return {
    tag_name: tag,
    assets: [{
      name: asset,
      state: "uploaded",
      digest: `sha256:${digest}`,
      browser_download_url: `https://github.com/ts-defold/deherm/releases/download/${tag}/${asset}`
    }]
  };
}

function publishedFetch(archive, options = {}) {
  const release = githubReleaseFixture(archive, options);
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      if (String(url).startsWith("https://api.github.com/")) {
        return { ok: true, status: 200, json: async () => release };
      }
      return { ok: true, status: 200, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) };
    }
  };
}

test("packaged consumer downloads, verifies, caches, and stages a published target", async (t) => {
  const directory = await scratch(t);
  const extensionSource = path.join(directory, "extension");
  const cacheRoot = path.join(directory, "cache");
  await extensionFixture(extensionSource);
  const archive = archiveFixture();
  const { calls, fetchImpl } = publishedFetch(archive);

  const first = await fetchWebTransportArtifactOverlay({ extensionSource, target, cacheRoot, fetchImpl });
  assert.equal(first.source, "download");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /api\.github\.com\/repos\/ts-defold\/deherm\/releases\/tags\/defold-webtransport-native-aaaaaaaaaaaa$/u);
  assert.match(calls[1], /releases\/download\/defold-webtransport-native-aaaaaaaaaaaa\/defold-webtransport-native-arm64-osx\.zip$/u);
  assert.equal(await readFile(path.join(first.root, "lib", target, filename), "utf8"), "native archive fixture\n");
  assert.equal((await validateWebTransportArtifactOverlay({ extensionSource, overlayRoot: first.root })).identity.fingerprint, fingerprint);

  const second = await fetchWebTransportArtifactOverlay({ extensionSource, target, cacheRoot, fetchImpl });
  assert.equal(second.source, "cache");
  assert.equal(calls.length, 2);
});

test("consumer rejects an arbitrary release fingerprint and ABI drift", async (t) => {
  const directory = await scratch(t);
  await extensionFixture(directory);
  const indexFile = path.join(directory, "webtransport/native-artifacts.json");
  const index = JSON.parse(await readFile(indexFile, "utf8"));
  index.fingerprint = "b".repeat(64);
  index.tag = "defold-webtransport-native-bbbbbbbbbbbb";
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  const overlay = path.join(directory, "overlay");
  await mkdir(path.join(overlay, "lib", target), { recursive: true });
  await writeFile(path.join(overlay, "lib", target, filename), "native archive fixture\n");
  await writeFile(path.join(overlay, ".defold-webtransport-native-artifacts.json"), `${JSON.stringify({
    schemaVersion: 1,
    tag: `defold-webtransport-native-${fingerprint.slice(0, 12)}`,
    fingerprint,
    abiSha256: index.abiSha256,
    artifacts: []
  })}\n`);
  await assert.rejects(validateWebTransportArtifactOverlay({ extensionSource: directory, overlayRoot: overlay }), /does not match selected extension release|inventory is invalid/u);

  await writeFile(path.join(directory, "include/defold_webtransport/native_v1.h"), "#pragma once\n// ABI drift\n");
  await assert.rejects(readExpectedWebTransportArtifactRelease(directory), /not bound to the selected extension ABI/u);
});

test("corrupt immutable downloads fail with digest and recovery guidance", async (t) => {
  const directory = await scratch(t);
  const extensionSource = path.join(directory, "extension");
  await extensionFixture(extensionSource);
  const corrupt = new TextEncoder().encode("not zip");
  const { fetchImpl } = publishedFetch(corrupt);
  await assert.rejects(
    fetchWebTransportArtifactOverlay({
      extensionSource,
      target,
      cacheRoot: path.join(directory, "cache"),
      fetchImpl
    }),
    /Immutable asset .* SHA-256 .* cannot be overwritten in place.*Quarantine\/delete/u
  );
});

test("consumer rejects bytes that differ from GitHub's release-computed digest", async (t) => {
  const directory = await scratch(t);
  const extensionSource = path.join(directory, "extension");
  await extensionFixture(extensionSource);
  const archive = archiveFixture();
  const { fetchImpl } = publishedFetch(archive, { digest: "0".repeat(64) });
  await assert.rejects(
    fetchWebTransportArtifactOverlay({ extensionSource, target, cacheRoot: path.join(directory, "cache"), fetchImpl }),
    /GitHub release digest mismatch.*expected 0{64}.*observed [0-9a-f]{64}/u
  );
});

test("consumer rejects ambiguous or digest-less release metadata", async (t) => {
  const directory = await scratch(t);
  const extensionSource = path.join(directory, "extension");
  await extensionFixture(extensionSource);
  const archive = archiveFixture();
  const release = githubReleaseFixture(archive);
  release.assets[0].digest = null;
  await assert.rejects(
    fetchWebTransportArtifactOverlay({
      extensionSource,
      target,
      cacheRoot: path.join(directory, "cache"),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => release })
    }),
    /no usable GitHub-computed SHA-256 identity/u
  );
});

test("release metadata lookup authenticates when configured and wraps network failures", async (t) => {
  const directory = await scratch(t);
  const extensionSource = path.join(directory, "extension");
  await extensionFixture(extensionSource);
  const prior = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "fixture-token";
  t.after(() => {
    if (prior === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prior;
  });
  let authorization;
  await assert.rejects(fetchWebTransportArtifactOverlay({
    extensionSource,
    target,
    cacheRoot: path.join(directory, "cache"),
    fetchImpl: async (_url, init) => {
      authorization = init.headers.Authorization;
      throw new Error("offline fixture");
    }
  }), /release metadata lookup failed.*offline fixture/u);
  assert.equal(authorization, "Bearer fixture-token");
});

test("download content-length is rejected before archive allocation", async (t) => {
  const directory = await scratch(t);
  const extensionSource = path.join(directory, "extension");
  await extensionFixture(extensionSource);
  const archive = archiveFixture();
  const release = githubReleaseFixture(archive);
  let arrayBufferCalled = false;
  await assert.rejects(fetchWebTransportArtifactOverlay({
    extensionSource,
    target,
    cacheRoot: path.join(directory, "cache"),
    fetchImpl: async (url) => String(url).startsWith("https://api.github.com/")
      ? { ok: true, status: 200, json: async () => release }
      : {
          ok: true,
          status: 200,
          headers: { get: () => String(129 * 1024 * 1024) },
          arrayBuffer: async () => { arrayBufferCalled = true; return archive.buffer; }
        }
  }), /declares .* above the .* limit/u);
  assert.equal(arrayBufferCalled, false);
});

test("artifact root resolution is explicit: environment is cwd-relative, project config is project-relative", () => {
  assert.equal(
    resolveWebTransportArtifactRoot({ environmentValue: "build/overlay", projectValue: "ignored", cwd: "/repo", projectRoot: "/repo/game" }),
    "/repo/build/overlay"
  );
  assert.equal(
    resolveWebTransportArtifactRoot({ projectValue: "../../build/overlay", cwd: "/elsewhere", projectRoot: "/repo/examples/game" }),
    "/repo/build/overlay"
  );
});

test("normal native generation has a deterministic per-host Defold target mapping", () => {
  assert.equal(hostWebTransportArtifactTarget("darwin", "arm64"), "arm64-osx");
  assert.equal(hostWebTransportArtifactTarget("darwin", "x64"), "x86_64-osx");
  assert.equal(hostWebTransportArtifactTarget("linux", "arm64"), "arm64-linux");
  assert.equal(hostWebTransportArtifactTarget("linux", "x64"), "x86_64-linux");
  assert.equal(hostWebTransportArtifactTarget("win32", "x64"), "x86_64-win32");
  assert.equal(selectWebTransportArtifactTarget({ hasSource: true, hasArtifactRoot: false, platform: "darwin", architecture: "arm64" }), "arm64-osx");
  assert.equal(selectWebTransportArtifactTarget({ configuredTarget: "web", hasSource: true, hasArtifactRoot: false, platform: "darwin", architecture: "arm64" }), null);
  assert.equal(selectWebTransportArtifactTarget({ hasSource: true, hasArtifactRoot: true, platform: "linux", architecture: "x64" }), null);
});

test("Web target markers are synchronized and the common backend is the only implementation", async () => {
  const root = path.resolve("extensions/defold-webtransport/defold_webtransport/lib");
  const wasm = await readFile(path.join(root, "wasm-web/library_defold_webtransport.js"), "utf8");
  const pthread = await readFile(path.join(root, "wasm_pthread-web/library_defold_webtransport.js"), "utf8");
  const common = await readFile(path.join(root, "web/library_defold_webtransport.js"), "utf8");
  assert.equal(wasm, pthread);
  assert.match(wasm, /Target marker only/u);
  assert.doesNotMatch(wasm, /byte-identical/u);
  assert.match(common, /addToLibrary\(LibraryDefoldWebTransport\)/u);
});
