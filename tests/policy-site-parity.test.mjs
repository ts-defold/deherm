import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { policySiteParity } from "../scripts/check-policy-site-parity.mjs";

const run = promisify(execFile);

test("policy site parity is byte- and path-sensitive without source archives", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-policy-site-parity-"));
  const site = path.join(root, "site");
  const baseline = path.join(root, "baseline.json");
  const script = path.resolve(import.meta.dirname, "../scripts/check-policy-site-parity.mjs");
  try {
    await mkdir(path.join(site, "v1/index"), { recursive: true });
    await writeFile(path.join(site, "v1/index/manifest.json"), '{"revision":"one"}\n');
    const first = await policySiteParity(site);
    assert.equal(first.files, 1);
    await run(process.execPath, [script, "--root", site, "--write", baseline]);
    assert.deepEqual(JSON.parse(await readFile(baseline, "utf8")), first);
    await run(process.execPath, [script, "--root", site, "--expected", baseline]);
    await writeFile(path.join(site, "v1/index/manifest.json"), '{"revision":"two"}\n');
    const changedBytes = await policySiteParity(site);
    assert.notEqual(changedBytes.sha256, first.sha256);
    await assert.rejects(
      run(process.execPath, [script, "--root", site, "--expected", baseline]),
      /differs from Linux canonical bytes/u,
    );
    await writeFile(path.join(site, "v1/index/manifest.json"), '{"revision":"one"}\n');
    await writeFile(path.join(site, "v1/extra.json"), "{}\n");
    assert.notEqual((await policySiteParity(site)).sha256, first.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
