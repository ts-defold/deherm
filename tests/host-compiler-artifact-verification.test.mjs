import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPinnedHostToolFile } from "../scripts/lib/host-compiler-artifact-verification.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the producer accepts only the exact host-tool bytes and size consumers pin", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-host-tool-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "dehermc");
  const expected = Buffer.from("exact compiler artifact\n");
  const manifest = {
    hosts: {
      "linux-x64": {
        tools: {
          dehermc: {
            status: "vendored",
            sha256: sha256(expected),
            bytes: expected.byteLength
          }
        }
      }
    }
  };

  await writeFile(file, expected);
  assert.deepEqual(await verifyPinnedHostToolFile({
    manifest,
    host: "linux-x64",
    tool: "dehermc",
    file
  }), {
    host: "linux-x64",
    tool: "dehermc",
    file,
    bytes: expected.byteLength,
    sha256: sha256(expected)
  });

  await writeFile(file, Buffer.from("wrong compiler artifact\n"));
  await assert.rejects(
    verifyPinnedHostToolFile({ manifest, host: "linux-x64", tool: "dehermc", file }),
    /hashes .* manifest expects/u
  );

  await writeFile(file, Buffer.from("short\n"));
  await assert.rejects(
    verifyPinnedHostToolFile({ manifest, host: "linux-x64", tool: "dehermc", file }),
    /manifest expects \d+/u
  );
});

test("the producer refuses undeclared and unpublished host-tool rows", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-host-tool-row-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "dehermc");
  await writeFile(file, "anything");
  await assert.rejects(
    verifyPinnedHostToolFile({ manifest: { hosts: {} }, host: "linux-x64", tool: "dehermc", file }),
    /declares no dehermc/u
  );
  await assert.rejects(
    verifyPinnedHostToolFile({
      manifest: { hosts: { "linux-x64": { tools: { dehermc: { status: "required-missing" } } } } },
      host: "linux-x64",
      tool: "dehermc",
      file
    }),
    /not a publishable vendored tool/u
  );
});
