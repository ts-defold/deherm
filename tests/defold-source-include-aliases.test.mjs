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
      aliases.map(({ kind, include, source }) => ({ kind, include, source })),
      [
        { kind: "include-search", include: "alpha/tool.h", source: "upstream/defold/engine/alpha/src/tool.h" },
        {
          kind: "include-search",
          include: "beta/detail.h",
          source: "upstream/defold/engine/beta/src/dmsdk/beta/detail.h",
        },
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
    assert.deepEqual(aliases.map(({ kind, include, source }) => ({ kind, include, source })), [
      { kind: "include-search", include: "alpha/tool.h", source: "upstream/defold/engine/alpha/src/tool.h" },
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("projected module headers retain their source-local include closure", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "deherm-source-aliases-"));
  try {
    const engineRoot = path.join(repositoryRoot, "upstream/defold/engine");
    await mkdir(path.join(engineRoot, "font/src"), { recursive: true });
    await writeFile(path.join(engineRoot, "font/src/text_layout.h"), '#include "markup.h"\n');
    await writeFile(path.join(engineRoot, "font/src/markup.h"), "#define MARKUP 1\n");
    const aliases = await deriveDefoldSourceIncludeAliases({
      repositoryRoot,
      engineRoot,
      sources: [{ path: "source.cpp", text: "#include <font/text_layout.h>\n" }],
    });
    assert.deepEqual(aliases.map(({ kind, include, source }) => ({ kind, include, source })), [
      {
        kind: "include-search",
        include: "font/markup.h",
        source: "upstream/defold/engine/font/src/markup.h",
      },
      {
        kind: "include-search",
        include: "font/text_layout.h",
        source: "upstream/defold/engine/font/src/text_layout.h",
      },
      {
        kind: "source-local",
        include: "upstream/defold/engine/font/src/markup.h",
        source: "upstream/defold/engine/font/src/markup.h",
      },
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Defold generated relative includes project SDK bytes into their build-tree path", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "deherm-source-aliases-"));
  try {
    const engineRoot = path.join(repositoryRoot, "upstream/defold/engine");
    const sdkRoot = path.join(repositoryRoot, "upstream/sdk/include");
    const sourcePath = "upstream/defold/engine/gameobject/src/gameobject/gameobject.h";
    await mkdir(path.dirname(path.join(repositoryRoot, sourcePath)), { recursive: true });
    await mkdir(path.join(sdkRoot, "gameobject"), { recursive: true });
    await writeFile(path.join(repositoryRoot, sourcePath), '#include "../proto/gameobject/lua_ddf.h"\n');
    await writeFile(path.join(sdkRoot, "gameobject/lua_ddf.h"), "#define GENERATED_DDF 1\n");
    const aliases = await deriveDefoldSourceIncludeAliases({
      repositoryRoot,
      engineRoot,
      sdkIncludeRoots: [sdkRoot],
      sources: [{ path: sourcePath, text: await readFile(path.join(repositoryRoot, sourcePath), "utf8") }],
    });
    assert.deepEqual(aliases.map(({ kind, include, source }) => ({ kind, include, source })), [
      {
        kind: "virtual-file",
        include: "upstream/defold/engine/gameobject/src/proto/gameobject/lua_ddf.h",
        source: "upstream/sdk/include/gameobject/lua_ddf.h",
      },
    ]);
    const overlay = await materializeDefoldSourceIncludeAliases({ repositoryRoot, aliases });
    const vfs = JSON.parse(await readFile(overlay.vfsOverlay, "utf8"));
    assert.deepEqual(vfs.roots, [
      {
        type: "file",
        name: path.join(repositoryRoot, "upstream/defold/engine/gameobject/src/proto/gameobject/lua_ddf.h"),
        "external-contents": path.join(repositoryRoot, "upstream/sdk/include/gameobject/lua_ddf.h"),
      },
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Defold module quote roots authenticate non-header source include closure", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "deherm-source-aliases-"));
  try {
    const engineRoot = path.join(repositoryRoot, "upstream/defold/engine");
    const sourcePath = "upstream/defold/engine/sound/src/decoders/decoder.cpp";
    const headerPath = "upstream/defold/engine/sound/src/codec/codec.h";
    const implementationPath = "upstream/defold/engine/sound/src/codec/codec.c";
    await mkdir(path.dirname(path.join(repositoryRoot, sourcePath)), { recursive: true });
    await mkdir(path.dirname(path.join(repositoryRoot, headerPath)), { recursive: true });
    await writeFile(path.join(repositoryRoot, sourcePath), '#include "codec/codec.h"\n');
    await writeFile(path.join(repositoryRoot, headerPath), '#include "codec.c"\n');
    await writeFile(path.join(repositoryRoot, implementationPath), "int codec(void) { return 1; }\n");
    const aliases = await deriveDefoldSourceIncludeAliases({
      repositoryRoot,
      engineRoot,
      sources: [{ path: sourcePath, text: await readFile(path.join(repositoryRoot, sourcePath), "utf8") }],
    });
    assert.deepEqual(
      aliases.filter(({ kind }) => kind === "source-local").map(({ include }) => include),
      [implementationPath, headerPath],
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
