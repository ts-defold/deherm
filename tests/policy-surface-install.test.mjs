import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { installPolicySurface, policySurfaceArchivePaths } from "../scripts/policy-surface.mjs";

const run = promisify(execFile);
const transportedFiles = new Set([
  "upstream.lock",
  "packages/toolchains/defold-bundle-targets.json",
  "packages/toolchains/defold-platform-pairs.json",
]);

test("policy surface installation replaces the transported index in a separate checkout", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-policy-install-"));
  const source = path.join(temporary, "source");
  const destination = path.join(temporary, "destination");
  const archive = path.join(temporary, "surface.tar.gz");
  const index = "packages/bindings/generated/defold-policy-index.json";
  try {
    await mkdir(source);
    await mkdir(destination);
    for (const relative of policySurfaceArchivePaths) {
      const file = path.join(source, relative);
      if (transportedFiles.has(relative)) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${relative}\n`);
      } else await mkdir(file, { recursive: true });
    }
    await writeFile(path.join(source, index), '{"entries":["new","revision"]}\n');
    await mkdir(path.dirname(path.join(destination, index)), { recursive: true });
    await writeFile(path.join(destination, index), '{"entries":["stale"]}\n');
    await run("tar", ["-czf", archive, ...policySurfaceArchivePaths], { cwd: source });
    await installPolicySurface(archive, destination);
    assert.equal(await readFile(path.join(destination, index), "utf8"), '{"entries":["new","revision"]}\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
