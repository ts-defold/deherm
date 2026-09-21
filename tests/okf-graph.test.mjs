import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  outlineOkfIndex,
  queryOkfSql,
  refreshOkfIndex,
  searchOkfIndex,
  sectionOkfIndex
} from "../.agents/lib/okf-graph.mjs";

async function fixture() {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), "deherm-okf-")));
  const docs = path.join(root, ".agents", "docs", "research");
  const databasePath = path.join(root, "cache", "okf.sqlite");
  await Promise.all([
    mkdir(docs, { recursive: true }),
    mkdir(path.join(root, "src"), { recursive: true }),
    mkdir(path.join(root, "generated"), { recursive: true }),
    mkdir(path.join(root, "tests"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, "src", "engine.ts"), "export const engine = 1;\n"),
    writeFile(path.join(root, "src", "owned.ts"), "export const owned = true;\n"),
    writeFile(path.join(root, "generated", "data.json"), `${JSON.stringify({ large: "body must not be indexed" })}\n`),
    writeFile(path.join(root, "tests", "check.test.mjs"), "// verification\n"),
    writeFile(path.join(docs, "b.md"), `---
type: Note
title: Beta reference
description: Linked fixture.
---

# Beta

## Shared heading

Beta body.
`),
    writeFile(path.join(docs, "a.md"), `---
type: Note
title: Alpha graph
description: Graph fixture.
sources:
  - id: engine
    resource: ../../../src/engine.ts
    title: Engine
    author: project:test
---

# Alpha

[Beta](b.md)
[Shared beta section](b.md#shared-heading)

## Ownership

[This section](#ownership)

This document owns \`src/owned.ts\`.
It generates \`generated/data.json\`.
It verifies the graph through \`tests/check.test.mjs\`.

## Long section

one
two
three
four
`)
  ]);
  return { root, docs, databasePath };
}

async function waitForOutput(stream, expected) {
  stream.setEncoding("utf8");
  let output = "";
  for await (const chunk of stream) {
    output += chunk;
    if (output.includes(expected)) return;
  }
  throw new Error(`child exited before emitting ${JSON.stringify(expected)}; received ${JSON.stringify(output)}`);
}

async function holdDatabaseLock(databasePath, begin) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(process.argv[1]);
      database.exec(process.argv[2]);
      process.stdout.write("database-locked\\n");
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
      }, 300);
    `,
    databasePath,
    begin
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForOutput(child.stdout, "database-locked\n");
  return { child, exit, stderr: () => stderr };
}

test("OKF graph refresh is content-addressed and updates source digests incrementally", async () => {
  const value = await fixture();
  try {
    const first = await refreshOkfIndex(value);
    assert.deepEqual({ indexed: first.indexed, reused: first.reused, removed: first.removed },
      { indexed: 2, reused: 0, removed: 0 });

    const second = await refreshOkfIndex(value);
    assert.deepEqual({ indexed: second.indexed, reused: second.reused, sourceUpdated: second.sourceUpdated },
      { indexed: 0, reused: 2, sourceUpdated: 0 });

    await writeFile(path.join(value.docs, "a.md"), `${await readFile(path.join(value.docs, "a.md"), "utf8")}\nchanged\n`);
    const changedDocument = await refreshOkfIndex(value);
    assert.deepEqual({ indexed: changedDocument.indexed, reused: changedDocument.reused }, { indexed: 1, reused: 1 });

    await writeFile(path.join(value.root, "src", "engine.ts"), "export const engine = 2;\n");
    const changedSource = await refreshOkfIndex(value);
    assert.equal(changedSource.indexed, 0);
    assert.equal(changedSource.sourceUpdated, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("OKF refresh and read operations wait for concurrent locks instead of failing", async () => {
  const value = await fixture();
  let lock;
  try {
    await refreshOkfIndex(value);
    lock = await holdDatabaseLock(value.databasePath, "BEGIN IMMEDIATE");
    const stats = await refreshOkfIndex(value);
    assert.deepEqual(
      { indexed: stats.indexed, reused: stats.reused, documents: stats.documents },
      { indexed: 0, reused: 2, documents: 2 }
    );
    let [code] = await lock.exit;
    assert.equal(code, 0, lock.stderr());
    lock = undefined;

    lock = await holdDatabaseLock(value.databasePath, "PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    const section = await sectionOkfIndex({
      databasePath: value.databasePath,
      document: "research/a.md",
      terms: ["ownership"]
    });
    assert.equal(section.title, "Ownership");
    [code] = await lock.exit;
    assert.equal(code, 0, lock.stderr());
    lock = undefined;
  } finally {
    if (lock) {
      lock.child.kill();
      await lock.exit;
    }
    await rm(value.root, { recursive: true, force: true });
  }
});

test("OKF graph connects links, declared sources, and semantic ownership edges without JSON bodies", async () => {
  const value = await fixture();
  try {
    await refreshOkfIndex(value);
    const edges = await queryOkfSql({
      databasePath: value.databasePath,
      sql: "SELECT kind, target FROM edges WHERE source_doc = 'research/a.md' ORDER BY kind, target",
      max: 50
    });
    assert.ok(edges.some((edge) => edge.kind === "links" && edge.target === "doc:research/b.md"));
    assert.ok(edges.some((edge) => edge.kind === "links" && edge.target === "heading:research/b.md#shared-heading"));
    assert.ok(edges.some((edge) => edge.kind === "links" && edge.target === "heading:research/a.md#ownership"));
    assert.ok(edges.some((edge) => edge.kind === "source" && edge.target === "source:src/engine.ts"));
    assert.ok(edges.some((edge) => edge.kind === "owns" && edge.target === "source:src/owned.ts"));
    assert.ok(edges.some((edge) => edge.kind === "generates" && edge.target === "source:generated/data.json"));
    assert.ok(edges.some((edge) => edge.kind === "verifies" && edge.target === "source:tests/check.test.mjs"));

    const [generated] = await queryOkfSql({
      databasePath: value.databasePath,
      sql: "SELECT path, digest, content FROM nodes WHERE id = 'source:generated/data.json'",
      max: 1
    });
    assert.equal(generated.path, "generated/data.json");
    assert.match(generated.digest, /^[a-f0-9]{64}$/);
    assert.equal(generated.content, "", "generated JSON bodies must not enter the index");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("heading identities are line-independent anchors with deterministic duplicate ordinals", async () => {
  const value = await fixture();
  try {
    const documentPath = path.join(value.docs, "a.md");
    await writeFile(documentPath, `${await readFile(documentPath, "utf8")}\n## Ownership\n\nDuplicate.\n`);
    await refreshOkfIndex(value);
    const before = await queryOkfSql({
      databasePath: value.databasePath,
      sql: "SELECT id, line FROM nodes WHERE kind = 'heading' AND path = 'research/a.md' ORDER BY line",
      max: 20
    });
    assert.ok(before.some((heading) => heading.id === "heading:research/a.md#ownership"));
    assert.ok(before.some((heading) => heading.id === "heading:research/a.md#ownership-2"));
    const ownershipLine = before.find((heading) => heading.id === "heading:research/a.md#ownership").line;

    const source = await readFile(documentPath, "utf8");
    await writeFile(documentPath, source.replace("# Alpha\n", "# Alpha\n\nInserted prose does not rename sections.\n"));
    await refreshOkfIndex(value);
    const after = await queryOkfSql({
      databasePath: value.databasePath,
      sql: "SELECT id, line FROM nodes WHERE kind = 'heading' AND path = 'research/a.md' ORDER BY line",
      max: 20
    });
    assert.deepEqual(after.map((heading) => heading.id), before.map((heading) => heading.id));
    assert.equal(after.find((heading) => heading.id === "heading:research/a.md#ownership").line, ownershipLine + 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("heading identities do not alias duplicate ordinals with literal suffixed headings", async () => {
  const value = await fixture();
  try {
    const documentPath = path.join(value.docs, "a.md");
    await writeFile(documentPath, `${await readFile(documentPath, "utf8")}\n## Ownership\n\nDuplicate body.\n\n## Ownership-2\n\nLiteral suffix body.\n`);
    await refreshOkfIndex(value);
    const headings = await queryOkfSql({
      databasePath: value.databasePath,
      sql: "SELECT id, content FROM nodes WHERE kind = 'heading' AND path = 'research/a.md' AND id LIKE 'heading:research/a.md#ownership%' ORDER BY line",
      max: 20
    });
    assert.deepEqual(headings.map(({ id }) => id), [
      "heading:research/a.md#ownership",
      "heading:research/a.md#ownership-2",
      "heading:research/a.md#ownership-2-2"
    ]);
    assert.match(headings[1].content, /Duplicate body/);
    assert.match(headings[2].content, /Literal suffix body/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("OKF search, outline, and section results have enforced output bounds", async () => {
  const value = await fixture();
  try {
    await refreshOkfIndex(value);
    assert.equal((await searchOkfIndex({ databasePath: value.databasePath, terms: ["alpha"], max: 2 })).length, 2);
    assert.equal((await outlineOkfIndex({ databasePath: value.databasePath, document: "research/a.md", max: 1 })).length, 1);
    const section = await sectionOkfIndex({
      databasePath: value.databasePath,
      document: "research/a.md",
      terms: ["long", "section"],
      maxLines: 3
    });
    assert.equal(section.content.split("\n").length, 3);
    assert.equal(section.truncated, true);
    await assert.rejects(searchOkfIndex({ databasePath: value.databasePath, terms: ["alpha"], max: 51 }), /1 through 50/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("SQL escape hatch is bounded and physically read-only", async () => {
  const value = await fixture();
  try {
    await refreshOkfIndex(value);
    const rows = await queryOkfSql({ databasePath: value.databasePath, sql: "SELECT id FROM nodes ORDER BY id", max: 2 });
    assert.equal(rows.length, 2);
    await assert.rejects(
      queryOkfSql({ databasePath: value.databasePath, sql: "DELETE FROM nodes", max: 2 }),
      /accepts exactly one/
    );
    await assert.rejects(
      queryOkfSql({ databasePath: value.databasePath, sql: "WITH chosen AS (SELECT id FROM nodes LIMIT 1) DELETE FROM nodes WHERE id IN chosen", max: 2 }),
      /readonly|read-only/i
    );
    const [count] = await queryOkfSql({ databasePath: value.databasePath, sql: "SELECT count(*) AS count FROM nodes", max: 1 });
    assert.ok(Number(count.count) > 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("section and SQL byte budgets reject context-volume bypasses", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.docs, "large.md"), `---
type: Note
title: Large line
description: Byte-bound fixture.
---

# Large

${"x".repeat(250_000)}
`);
    await refreshOkfIndex(value);
    const section = await sectionOkfIndex({
      databasePath: value.databasePath,
      document: "research/large.md",
      terms: ["large"],
      maxLines: 200
    });
    assert.equal(section.truncated, true);
    assert.ok(Buffer.byteLength(section.content, "utf8") <= 64 * 1_024);
    assert.ok(Math.max(...section.content.split("\n").map((line) => Buffer.byteLength(line, "utf8"))) <= 4_096);

    const rows = await queryOkfSql({
      databasePath: value.databasePath,
      sql: "SELECT zeroblob(100000) AS payload",
      max: 1
    });
    assert.deepEqual(rows[0].payload, {
      type: "blob",
      bytes: 100_000,
      hexPrefix: "00".repeat(64),
      truncated: true
    });
    assert.ok(Buffer.byteLength(JSON.stringify(rows), "utf8") < 1_000);
    await assert.rejects(
      queryOkfSql({
        databasePath: value.databasePath,
        sql: "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT n FROM x",
        max: 1
      }),
      /not authorized|authorization denied/u
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("schema changes rebuild disposable caches before creating current indexes", async () => {
  const value = await fixture();
  try {
    await mkdir(path.dirname(value.databasePath), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(value.databasePath);
    database.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO metadata VALUES ('schema', '2');
      CREATE TABLE nodes (id TEXT PRIMARY KEY) STRICT;
    `);
    database.close();
    const stats = await refreshOkfIndex(value);
    assert.equal(stats.indexed, 2);
    assert.ok(stats.nodes > 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("CRLF frontmatter produces the same metadata and source edges", async () => {
  const value = await fixture();
  try {
    const source = `---
type: Note
title: Windows metadata
description: CRLF fixture.
sources:
  - id: engine
    resource: ../../../src/engine.ts
    title: Engine
    author: project:test
---

# Windows
`.replace(/\n/g, "\r\n");
    await writeFile(path.join(value.docs, "windows.md"), source);
    await refreshOkfIndex(value);
    const [document] = await queryOkfSql({
      databasePath: value.databasePath,
      sql: "SELECT label FROM nodes WHERE id = 'doc:research/windows.md'",
      max: 1
    });
    assert.equal(document.label, "Windows metadata");
    const edges = await queryOkfSql({
      databasePath: value.databasePath,
      sql: "SELECT kind, target FROM edges WHERE source_doc = 'research/windows.md'",
      max: 10
    });
    assert.ok(edges.some((edge) => edge.kind === "source" && edge.target === "source:src/engine.ts"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
