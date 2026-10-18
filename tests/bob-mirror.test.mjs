import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bobMirrorUrl } from "../packages/cli/src/dev/bob-mirror.mjs";
import {
  expectedBobFromLock,
  missingBobReleaseAssets,
  publishBobMirror,
  verifyBobMirrorDownload,
  verifyBobReleaseAssets,
} from "../scripts/publish-defold-bob-mirror.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revision = "c".repeat(40);

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
    if (args[0] === "api") {
      if (!releaseState.release) throw { stderr: "HTTP 404: Not Found" };
      return { stdout: JSON.stringify(releaseState.release) };
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
      releaseState.calls.slice(callsBeforeReuse).map((args) => args[0]),
      ["api"],
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
