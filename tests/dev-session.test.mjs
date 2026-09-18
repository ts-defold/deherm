import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runDevSession } from "../packages/cli/src/dev/session.mjs";

test("one-shot dev session compiles a typed resource generation without claiming activation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dev-session-"));
  const entry = path.join(root, "src", "main.ts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, 'declare const __DEFOLD_HERMES_BUILD_FINGERPRINT__: string; console.log(`bundle:${__DEFOLD_HERMES_BUILD_FINGERPRINT__}`);\n');
  const snapshot = await runDevSession({ project: root, entry, once: true, useTtsc: false });
  assert.equal(snapshot.phase, "built");
  assert.equal(snapshot.lastSuccessfulGeneration, 1);
  assert.equal(snapshot.targets.length, 0);
  assert.match(await readFile(path.join(root, "deherm", "app.dehermc"), "utf8"), /bundle:/);
  assert.match(await readFile(path.join(root, "build", "default", "deherm", "app.dehermc"), "utf8"), /bundle:/);
});
