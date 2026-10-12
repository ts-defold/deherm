import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verifyHostCompilerReleasePins } from "../scripts/lib/host-compiler-release-pins.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture({
  mismatchPin = false,
  missingSidecar = false,
  incomplete = false,
  unexpectedMember = false,
  identityMismatch = false,
  unavailable = false,
  publisherDigestMismatch = false,
  transientFetchFailures = 0,
  missingAssetResponse = false,
} = {}) {
  const manifest = { hosts: {} };
  const releases = [];
  const releaseTags = { families: {} };
  const sidecars = new Map();
  let assetFetchCount = 0;

  for (const [family, tag, tools] of [
    ["hermes-host", "hermes-123456789abc", ["hermesc", "shermes"]],
    ["dehermc", "tools-abcdef123456", ["dehermc"]],
  ]) {
    const fingerprint = tag.slice(tag.indexOf("-") + 1).padEnd(64, "0");
    const host = "linux-x64";
    const asset = `${family}-${host}.tar.gz`;
    const members = tools.map((tool) => {
      const name = tool === "hermesc" || tool === "shermes" ? tool : tool;
      const content = `${host}/${tool}`;
      const member = { name, bytes: Buffer.byteLength(content), sha256: digest(content) };
      const pin = { file: `bin/${name}`, status: "vendored", sha256: member.sha256, bytes: member.bytes };
      if (mismatchPin && tool === "shermes") pin.sha256 = "f".repeat(64);
      manifest.hosts[host] ??= { tools: {} };
      manifest.hosts[host].tools[tool] = pin;
      return member;
    });
    if (unexpectedMember && family === "hermes-host") members.push({ name: "surprise", bytes: 1, sha256: digest("x") });
    const sidecarName = `${asset}.integrity.json`;
    const document = {
      schemaVersion: 1,
      kind: "deherm.release-asset-integrity",
      family,
      tag,
      fingerprint,
      asset,
      archive: { bytes: 10, sha256: digest("archive") },
      members,
    };
    const bytes = Buffer.from(JSON.stringify(document));
    sidecars.set(sidecarName, bytes);
    releases.push({ family, tag, fingerprint, row: { host, asset, files: tools.map((tool) => tool), tools } });
    releaseTags.families[family] = {
      tag,
      fingerprint,
      assets: { [host]: asset },
      contents: { [host]: tools },
      integrity: {
        [host]: {
          asset: sidecarName,
          sha256: digest(bytes),
          archiveSha256: document.archive.sha256,
          archiveBytes: document.archive.bytes,
        },
      },
    };
  }

  const resolveAsset = async ({ tag, asset }) => {
    if (unavailable) throw new TypeError("fetch failed");
    if (missingSidecar && asset.startsWith("hermes-host")) throw new Error(`${tag}/${asset} was not published`);
    const bytes = sidecars.get(asset);
    assert.ok(bytes, `fixture has ${asset}`);
    return {
      url: `https://fixture.invalid/${tag}/${asset}`,
      sha256: publisherDigestMismatch ? "0".repeat(64) : digest(bytes),
      bytes: bytes.length,
    };
  };
  const fetchAsset = async (url) => {
    assetFetchCount += 1;
    if (missingAssetResponse) return new Response("missing", { status: 404 });
    if (assetFetchCount <= transientFetchFailures) return new Response("temporarily unavailable", { status: 503 });
    const name = url.split("/").at(-1);
    const bytes = sidecars.get(name);
    return bytes ? new Response(bytes, { status: 200 }) : new Response("missing", { status: 404 });
  };
  if (incomplete) delete releaseTags.families["hermes-host"].integrity["linux-x64"];
  if (identityMismatch) releaseTags.families["hermes-host"].tag = "hermes-wrong";
  return { manifest, releases, releaseTags, resolveAsset, fetchAsset, assetFetchCount: () => assetFetchCount };
}

test("host compiler pins match exact published sidecar members and publisher digests", async () => {
  const input = fixture();
  const checked = await verifyHostCompilerReleasePins(input);
  assert.deepEqual(checked.sort(), ["linux-x64/dehermc", "linux-x64/hermesc", "linux-x64/shermes"]);
});

test("host compiler pin drift reports the host and tool", async () => {
  await assert.rejects(
    verifyHostCompilerReleasePins(fixture({ mismatchPin: true })),
    /linux-x64\/shermes: host-compilers\.json pins/u,
  );
});

test("missing or incomplete release sidecars fail with a release-specific diagnostic", async (t) => {
  await t.test("missing published sidecar", async () => {
    await assert.rejects(
      verifyHostCompilerReleasePins(fixture({ missingSidecar: true })),
      /hermes-host\/linux-x64: cannot authenticate published/u,
    );
  });
  await t.test("missing pinned sidecar digest", async () => {
    await assert.rejects(
      verifyHostCompilerReleasePins(fixture({ incomplete: true })),
      /hermes-host\/linux-x64: release-tags\.json has no publisher digest/u,
    );
  });
});

test("unexpected archive member fails exact-member validation", async () => {
  await assert.rejects(
    verifyHostCompilerReleasePins(fixture({ unexpectedMember: true })),
    /integrity members mismatch/u,
  );
});

test("release identity drift is rejected before accepting the sidecar", async () => {
  await assert.rejects(
    verifyHostCompilerReleasePins(fixture({ identityMismatch: true })),
    /release-tags\.json identity does not match/u,
  );
});

test("transport failures are reported as publisher availability, not pin drift", async () => {
  await assert.rejects(verifyHostCompilerReleasePins(fixture({ unavailable: true })), /GitHub availability failure/u);
});

test("a sidecar that differs from its publisher digest is rejected", async () => {
  const input = fixture({ publisherDigestMismatch: true });
  await assert.rejects(verifyHostCompilerReleasePins(input), /does not match GitHub's publisher-side release digest/u);
  assert.equal(input.assetFetchCount(), 1, "integrity failures are not retried");
});

test("transient publisher asset failures retry with bounded injected delays", async () => {
  const input = fixture({ transientFetchFailures: 1 });
  const waits = [];
  const checked = await verifyHostCompilerReleasePins({
    ...input,
    retryDelaysMs: [7],
    waitImpl: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(checked.length, 3);
  assert.equal(input.assetFetchCount(), 3, "one failed request is retried before the second sidecar");
  assert.deepEqual(waits, [7]);
});

test("missing release assets are not retried", async () => {
  const input = fixture({ missingAssetResponse: true });
  await assert.rejects(verifyHostCompilerReleasePins(input), /responded 404/u);
  assert.equal(input.assetFetchCount(), 1);
});
