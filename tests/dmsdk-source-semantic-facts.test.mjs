import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json";

function run(args) {
  return execFileSync(process.execPath, ["scripts/generate-dmsdk-source-semantic-facts.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("bounded-span source facts regenerate deterministically from pinned C/C++ implementations", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-source-semantic-facts-"));
  try {
    run(["--out-root", output]);
    const [expected, actual] = await Promise.all([
      readFile(path.join(root, artifact), "utf8"),
      readFile(path.join(output, artifact), "utf8"),
    ]);
    assert.equal(actual, expected);
    const report = JSON.parse(actual);
    assert.deepEqual(report.coverage, { requested: 10, observed: 10, missing: 0 });
    assert.equal(report.extraction, "clang-json-ast/compact-dataflow-v1");
    assert.ok(report.sources.every(({ path, sha256 }) => path.startsWith("upstream/defold/") && /^[0-9a-f]{64}$/u.test(sha256)));
    run(["--out-root", output, "--check"]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
