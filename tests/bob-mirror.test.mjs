import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bobMirrorUrl } from "../packages/cli/src/dev/bob-mirror.mjs";
import { ensureRepositoryBob } from "../scripts/ensure-repository-bob.mjs";
import { ensureDefoldFixture } from "../scripts/ensure-defold-fixture.mjs";
import { publishDefoldFixtureMirror } from "../scripts/publish-defold-fixture-mirror.mjs";
import {
  expectedBobFromLock,
  missingBobReleaseAssets,
  publishBobMirror,
  verifyBobMirrorDownload,
  verifyBobReleaseAssets,
} from "../scripts/publish-defold-bob-mirror.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revision = "c".repeat(40);

test("pinned test inputs reuse verified caches and recover from retired upstream archives", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-test-inputs-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, "upstream/defold"), { recursive: true });
  const inputs = [
    { kind: "ref-doc", asset: "ref-doc.zip", pin: "DEFOLD_REF_DOC", bytes: Buffer.from("reference docs") },
    { kind: "defold-sdk", asset: "defoldsdk.zip", pin: "DEFOLD_SDK", bytes: Buffer.from("engine SDK") },
  ];
  await writeFile(
    path.join(workspace, "upstream.lock"),
    `DEFOLD_REV=${revision}\n` +
      inputs
        .map(
          (input) =>
            `${input.pin}_URL=https://example.invalid/${input.asset}\n${input.pin}_SHA256=${sha256(input.bytes)}\n`,
        )
        .join(""),
  );
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    const input = inputs.find((item) => url.endsWith(`/${item.asset}`));
    return url.startsWith("https://example.invalid") ? new Response(null, { status: 404 }) : new Response(input.bytes);
  };
  for (const input of inputs) {
    const file = await ensureDefoldFixture(input.kind, workspace, fetch);
    assert.deepEqual(await readFile(file), input.bytes);
    await ensureDefoldFixture(input.kind, workspace, async () => {
      throw new Error("warm cache fetched");
    });
    assert.ok(
      requests.includes(
        `https://github.com/ts-defold/deherm/releases/download/defold-fixtures-${revision}/${input.asset}`,
      ),
    );
  }
  assert.equal(requests.length, 4);
  const assets = [];
  for (const input of inputs) {
    assets.push({
      name: input.asset,
      digest: `sha256:${sha256(input.bytes)}`,
      size: input.bytes.length,
      state: "uploaded",
    });
    const sidecar = `${sha256(input.bytes)}  ${input.asset}\n`;
    assets.push({
      name: `${input.asset}.sha256`,
      digest: `sha256:${sha256(sidecar)}`,
      size: Buffer.byteLength(sidecar),
      state: "uploaded",
    });
  }
  for (const name of ["LICENSE.txt", "NOTICE", "TOOLS_LICENSES.md", "COMPLYING_WITH_LICENSES.md"]) {
    await writeFile(path.join(workspace, "upstream/defold", name), name);
    assets.push({ name, digest: `sha256:${sha256(name)}`, size: Buffer.byteLength(name), state: "uploaded" });
  }
  const downloads = [];
  const published = await publishDefoldFixtureMirror({
    workspace,
    run: async (_command, args) => ({
      stdout:
        args[1] === "view" ? JSON.stringify({ tagName: `defold-fixtures-${revision}`, isDraft: false, assets }) : "",
    }),
    verifyDownload: async (url, digest) => downloads.push({ url, digest }),
  });
  assert.equal(published.reused, true);
  assert.deepEqual(
    downloads.map((item) => item.digest),
    inputs.map((input) => sha256(input.bytes)),
  );
  const file = path.join(workspace, "upstream/ref-doc.zip");
  await writeFile(file, "corrupt");
  await assert.rejects(
    ensureDefoldFixture("ref-doc", workspace, async () => new Response("wrong")),
    /SHA-256 mismatch/,
  );
  await assert.rejects(stat(`${file}.download-${process.pid}`), { code: "ENOENT" });
  await assert.rejects(publishDefoldFixtureMirror({ workspace }), /input digest mismatch/);
});

test("repository Bob bootstrap uses the same verified mirror and cache as the installed CLI", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-repository-bob-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bytes = Buffer.from("pinned repository Bob");
  const url = `https://d.defold.com/archive/${revision}/bob/bob.jar`;
  await writeFile(
    path.join(workspace, "upstream.lock"),
    `DEFOLD_REV=${revision}\nDEFOLD_BOB_URL=${url}\nDEFOLD_BOB_SHA256=${sha256(bytes)}\n`,
  );
  const requests = [];
  const fetch = async (candidate) => {
    requests.push(candidate);
    return candidate === url ? new Response(null, { status: 404 }) : new Response(bytes);
  };
  const target = await ensureRepositoryBob(workspace, { fetch });
  assert.equal(target, path.join(workspace, "build/tooling/bob.jar"));
  assert.deepEqual(requests, [url, bobMirrorUrl(revision)]);
  assert.deepEqual(await readFile(target), bytes);
  await ensureRepositoryBob(workspace, { fetch });
  assert.equal(requests.length, 2, "verified cached Bob must not require the expired source");
  await writeFile(target, "corrupted");
  await assert.rejects(
    ensureRepositoryBob(workspace, { fetch: async () => new Response("wrong") }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(stat(target), { code: "ENOENT" });
});

test("Bob mirror publisher validates the pinned bytes, drafts, verifies, publishes, and reuses", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-bob-publish-test-"));
  const bytes = Buffer.from("pinned Bob fixture");
  const digest = sha256(bytes);
  const releaseState = { release: null, calls: [] };
  const downloads = [];
  const verifyDownload = async (url, expectedDigest) => {
    downloads.push(url);
    assert.equal(expectedDigest, digest);
  };
  const run = async (_command, args) => {
    releaseState.calls.push(args);
    if (args[1] === "view") {
      if (!releaseState.release) throw { stderr: "release not found" };
      return {
        stdout: JSON.stringify({
          isDraft: releaseState.release.draft,
          assets: releaseState.release.assets,
          body: releaseState.release.body,
          tagName: args[2],
        }),
      };
    }
    if (args[1] === "create") {
      releaseState.release = { draft: true, assets: [], body: args[args.indexOf("--notes") + 1] };
      return { stdout: "" };
    }
    if (args[1] === "upload") {
      for (const file of args.slice(3, args.indexOf("--repo"))) {
        const content = await readFile(file);
        releaseState.release.assets.push({
          name: path.basename(file),
          digest: `sha256:${sha256(content)}`,
          size: (await stat(file)).size,
          state: "uploaded",
        });
      }
      return { stdout: "" };
    }
    if (args[1] === "edit") {
      if (args.includes("--draft=false")) releaseState.release.draft = false;
      if (args.includes("--notes")) releaseState.release.body = args[args.indexOf("--notes") + 1];
      return { stdout: "" };
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  try {
    await mkdir(path.join(workspace, "upstream/defold"), { recursive: true });
    await writeFile(path.join(workspace, "upstream/bob.jar"), bytes);
    await writeFile(path.join(workspace, "upstream.lock"), `DEFOLD_REV=${revision}\nDEFOLD_BOB_SHA256=${digest}\n`);
    const expectedAssets = [
      { name: "bob.jar", digest, size: bytes.length },
      {
        name: "bob.jar.sha256",
        digest: sha256(`${digest}  bob.jar\n`),
        size: Buffer.byteLength(`${digest}  bob.jar\n`),
      },
    ];
    for (const name of ["LICENSE.txt", "NOTICE", "TOOLS_LICENSES.md", "COMPLYING_WITH_LICENSES.md"]) {
      const content = `Pinned Defold ${name}\n`;
      await writeFile(path.join(workspace, "upstream/defold", name), content);
      expectedAssets.push({ name, digest: sha256(content), size: Buffer.byteLength(content) });
    }
    assert.equal(expectedBobFromLock(await readFile(path.join(workspace, "upstream.lock"), "utf8"), revision), digest);
    const created = await publishBobMirror({ workspace, revision, target: "d".repeat(40), run, verifyDownload });
    assert.deepEqual(created, { tag: `defold-bob-${revision}`, url: bobMirrorUrl(revision), reused: false });
    assert.equal(releaseState.release.draft, false);
    assert.deepEqual(downloads, [bobMirrorUrl(revision)]);
    assert.deepEqual(
      releaseState.release.assets.map(({ name }) => name).sort(),
      expectedAssets.map(({ name }) => name).sort(),
    );
    verifyBobReleaseAssets(releaseState.release, expectedAssets);
    assert.deepEqual(missingBobReleaseAssets(releaseState.release, expectedAssets), []);
    const callsBeforeReuse = releaseState.calls.length;
    assert.equal((await publishBobMirror({ workspace, revision, run, verifyDownload })).reused, true);
    assert.equal(downloads.length, 1, "a reused mirror does not re-download Bob on every canary");
    assert.deepEqual(
      releaseState.calls.slice(callsBeforeReuse).map((args) => args[1]),
      ["view"],
    );
    releaseState.release.draft = true;
    releaseState.release.assets = releaseState.release.assets.filter((asset) => asset.name !== "bob.jar.sha256");
    const resumed = await publishBobMirror({ workspace, revision, run, verifyDownload });
    assert.equal(resumed.reused, false);
    assert.equal(releaseState.release.draft, false);
    verifyBobReleaseAssets(releaseState.release, expectedAssets);
    releaseState.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
    await assert.rejects(publishBobMirror({ workspace, revision, run, verifyDownload }), /invalid bob\.jar asset/);
    await writeFile(path.join(workspace, "upstream/bob.jar"), "wrong Bob");
    await assert.rejects(publishBobMirror({ workspace, revision, run, verifyDownload }), /input digest mismatch/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a public Bob mirror download is accepted only with the exact digest", async () => {
  const bytes = Buffer.from("mirrored Bob");
  await verifyBobMirrorDownload("https://example.invalid/bob.jar", sha256(bytes), async () => new Response(bytes));
  await assert.rejects(
    verifyBobMirrorDownload("https://example.invalid/bob.jar", sha256("other"), async () => new Response(bytes)),
    /download digest mismatch/,
  );
  await assert.rejects(
    verifyBobMirrorDownload(
      "https://example.invalid/bob.jar",
      sha256(bytes),
      async () => new Response(null, { status: 404 }),
    ),
    /HTTP 404/,
  );
});

test("policy derivation retains Bob bytes and mirrors only on writable main runs", async () => {
  const derive = await readFile(new URL("../scripts/derive-revision.mjs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8");
  assert.match(derive, /"--bob-output", "upstream\/bob\.jar"/u);
  assert.match(workflow, /MIRROR_BOB:.*github\.ref == 'refs\/heads\/main'/u);
  assert.match(
    workflow,
    /node scripts\/publish-defold-bob-mirror\.mjs --workspace "\$workspace" --revision "\$revision"/u,
  );
});
