import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ensureHostFamily } from "../packages/cli/src/ensure-host-tool.mjs";

const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("a digest-mismatched host-tool cache is replaced and the repaired cache is reused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-host-tool-cache."));
  const originalFetch = globalThis.fetch;
  try {
    const tag = "tools-test";
    const host = "test-host";
    const asset = "dehermc-test-host.tar.gz";
    const member = "dehermc";
    const goodBytes = Buffer.from("authenticated dehermc\n");
    const expected = sha256(goodBytes);
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, member), goodBytes);
    const archive = path.join(root, asset);
    await execFileAsync("tar", ["-czf", archive, "-C", source, member]);

    const releaseTagsPath = path.join(root, "release-tags.json");
    await writeFile(releaseTagsPath, JSON.stringify({
      repository: "ts-defold/deherm",
      families: {
        dehermc: {
          tag,
          assets: { [host]: asset },
          contents: { [host]: [member] }
        }
      }
    }));

    const destination = path.join(root, ".deherm", "cache", "toolchains", tag, host);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, member), "corrupt but present\n");

    const archiveBytes = await readFile(archive);
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(archiveBytes, { status: 200 });
    };

    const options = {
      expectedDigests: { [member]: expected },
      cacheRoot: path.join(root, ".deherm", "cache", "toolchains"),
      releaseTagsPath
    };
    const repaired = await ensureHostFamily("dehermc", host, options);
    assert.equal(repaired.cached, false);
    assert.equal(fetches, 1);
    assert.equal(sha256(await readFile(path.join(destination, member))), expected);

    const reused = await ensureHostFamily("dehermc", host, options);
    assert.equal(reused.cached, true);
    assert.equal(fetches, 1, "an authenticated cache hit must not download again");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("a downloaded member with the wrong digest never replaces the existing cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-host-tool-download."));
  const originalFetch = globalThis.fetch;
  try {
    const tag = "tools-test";
    const host = "test-host";
    const asset = "dehermc-test-host.tar.gz";
    const member = "dehermc";
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, member), "wrong release bytes\n");
    const archive = path.join(root, asset);
    await execFileAsync("tar", ["-czf", archive, "-C", source, member]);
    const releaseTagsPath = path.join(root, "release-tags.json");
    await writeFile(releaseTagsPath, JSON.stringify({
      repository: "ts-defold/deherm",
      families: {
        dehermc: {
          tag,
          assets: { [host]: asset },
          contents: { [host]: [member] }
        }
      }
    }));
    const destination = path.join(root, ".deherm", "cache", "toolchains", tag, host);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, member), "original corrupt cache\n");
    const archiveBytes = await readFile(archive);
    globalThis.fetch = async () => new Response(archiveBytes, { status: 200 });

    await assert.rejects(ensureHostFamily("dehermc", host, {
      expectedDigests: { [member]: sha256(Buffer.from("expected release bytes\n")) },
      cacheRoot: path.join(root, ".deherm", "cache", "toolchains"),
      releaseTagsPath
    }), /manifest expects/);
    assert.equal(await readFile(path.join(destination, member), "utf8"), "original corrupt cache\n");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
