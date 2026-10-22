import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { authoredFrameScopes } from "../packages/cli/src/dev/debug-source-scopes.mjs";

test("authored debugger scopes follow active TypeScript blocks and parameter names", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-debug-scopes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "player.script.ts");
  const sourceText = [
    "const MODULE = 4;",
    "export function update(instance: object, dt: number) {",
    "  const outer = dt;",
    "  if (outer) {",
    "    const inner = MODULE;",
    "    return inner;",
    "  }",
    "  return outer;",
    "}",
    "",
  ].join("\n");
  await writeFile(sourcePath, sourceText);
  const inner = await authoredFrameScopes({ sourcePath, sourceText, line: 6, column: 12 });
  assert.deepEqual(inner.arguments, ["instance", "dt"]);
  assert.deepEqual(inner.locals, ["outer", "inner"]);
  assert.deepEqual(inner.module, ["MODULE", "update"]);
  const outer = await authoredFrameScopes({ sourcePath, sourceText, line: 8, column: 12 });
  assert.deepEqual(outer.locals, ["outer"], "nested block bindings do not leak into a sibling location");
  await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\n// changed after bundle\n`);
  assert.equal(await authoredFrameScopes({ sourcePath, sourceText, line: 6, column: 12 }), null);
});
