import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const mirror = resolve(root, "defold/src/generated-war-battles/client.ts");
const sync = resolve(root, "integration/sync-defold-sources.mjs");

test("shared gameplay source synchronizes once and no-op sync preserves mirror mtime", () => {
  execFileSync(process.execPath, [sync], { cwd: root });
  const before = statSync(mirror, { bigint: true }).mtimeNs;
  execFileSync(process.execPath, [sync], { cwd: root });
  assert.equal(statSync(mirror, { bigint: true }).mtimeNs, before);
});
