import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveDefoldSourceIncludeAliases,
  materializeDefoldSourceIncludeAliases,
} from "../packages/compiler/src/defold-source-include-aliases.mjs";

test("Defold source aliases recursively reconstruct module include layout", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "deherm-source-aliases-"));
  try {
    const engineRoot = path.join(repositoryRoot, "upstream/defold/engine");
    await mkdir(path.join(engineRoot, "alpha/src"), { recursive: true });
    await mkdir(path.join(engineRoot, "beta/src/dmsdk/beta"), { recursive: true });
    await writeFile(path.join(engineRoot, "alpha/src/tool.h"), "#include <beta/detail.h>\n");
    await writeFile(path.join(engineRoot, "beta/src/dmsdk/beta/detail.h"), "#define DETAIL 1\n");
    const aliases = await deriveDefoldSourceIncludeAliases({
      repositoryRoot,
      engineRoot,
      sources: [{ path: "source.cpp", text: "#include <alpha/tool.h>\n" }],
    });
    assert.deepEqual(
      aliases.map(({ include, source }) => ({ include, source })),
      [
        { include: "alpha/tool.h", source: "upstream/defold/engine/alpha/src/tool.h" },
        { include: "beta/detail.h", source: "upstream/defold/engine/beta/src/dmsdk/beta/detail.h" },
      ],
    );
    const overlay = await materializeDefoldSourceIncludeAliases({ repositoryRoot, aliases });
    assert.equal(await readFile(path.join(overlay.directory, "beta/detail.h"), "utf8"), "#define DETAIL 1\n");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Defold internal module layout precedes its public dmsdk projection", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "deherm-source-aliases-"));
  try {
    const engineRoot = path.join(repositoryRoot, "upstream/defold/engine");
    await mkdir(path.join(engineRoot, "alpha/src/dmsdk/alpha"), { recursive: true });
    await writeFile(path.join(engineRoot, "alpha/src/tool.h"), "#define VALUE 1\n");
    await writeFile(path.join(engineRoot, "alpha/src/dmsdk/alpha/tool.h"), "#define VALUE 2\n");
    const aliases = await deriveDefoldSourceIncludeAliases({
      repositoryRoot,
      engineRoot,
      sources: [{ path: "source.cpp", text: "#include <alpha/tool.h>\n" }],
    });
    assert.deepEqual(aliases.map(({ include, source }) => ({ include, source })), [
      { include: "alpha/tool.h", source: "upstream/defold/engine/alpha/src/tool.h" },
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
