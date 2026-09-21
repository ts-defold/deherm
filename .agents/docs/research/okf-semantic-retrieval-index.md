---
type: Design and Verification Report
title: Bounded semantic retrieval index for the OKF bundle
description: A disposable SQLite graph over OKF documents, headings, declared sources, and explicit ownership or verification references.
tags: [okf, sqlite, graph, retrieval, tooling]
status: active
generated: { by: openai/codex, at: 2026-09-20T22:00:00-04:00 }
sources:
  - id: graph-library
    resource: ../../lib/okf-graph.mjs
    title: OKF graph library
    author: project:deherm
  - id: graph-command
    resource: ../../okf-index.mjs
    title: OKF graph command
    author: project:deherm
  - id: graph-tests
    resource: ../../../tests/okf-graph.test.mjs
    title: OKF graph verification
    author: project:deherm
---

# Purpose

The OKF Markdown bundle remains canonical. The retrieval database is a
disposable acceleration structure, not another source of project truth. It can
be deleted at any time and rebuilt from `.agents/docs/`; every normal query
refreshes it first. The default database lives under the ignored
`.deherm/cache/` tree, and `DEHERM_OKF_CACHE` can relocate it.

# Graph model

The graph has document, heading, local-source, external-source, and anchor
nodes. Document identities use their path relative to `.agents/docs/`.
Heading identities use that document path plus a normalized heading anchor and
a deterministic ordinal for duplicate headings; the recorded line is location
metadata, not identity. A document owns its heading nodes through `contains`
edges, and Markdown fragment links resolve directly to those stable heading
nodes. Markdown links and frontmatter `sources[].resource` values become
`links` and `source` edges. Lines that explicitly say a backticked path is
owned, generated, or verified become `owns`, `generates`, or `verifies` edges
from the nearest heading. This is intentionally a narrow semantic grammar: the
tool does not infer architectural authority from proximity or naming alone.

Document nodes and heading sections carry searchable Markdown. Referenced
source nodes carry a normalized path and current SHA-256 digest but no source
body. In particular, generated JSON bodies never enter SQLite. This makes the
index useful for discovering the authority behind a generated artifact without
turning large evidence or policy files into retrieval context.

# Incremental and bounded behavior

Each OKF document is keyed by its content digest. Unchanged documents retain
their graph rows; changed and removed documents replace only their owned rows
and edges. Referenced local files are re-digested independently, so a source
change updates metadata without reparsing unchanged documentation. A schema
version invalidates and recreates the disposable cache before current indexes
are created when extraction rules change. Markdown frontmatter is normalized
for LF, CRLF, and legacy-CR checkouts before parsing.

Cache connections use a bounded five-second SQLite busy timeout. Concurrent
query commands may both refresh the same disposable database; the later writer
waits for the active refresh transaction instead of failing at `BEGIN
IMMEDIATE` with `database is locked`, and a read-only query waits for a
concurrent schema/write phase to clear. This coordination applies to schema
initialization and independent source-digest updates without making the cache
authoritative or its SQL connections writable.

Search returns at most 50 rows, outline returns at most 200 headings, and a
section returns at most 200 lines. Every textual cell and section line also has
a byte cap, and a complete result cannot exceed 64 KiB. SQL blobs are reduced
to length plus a 64-byte hexadecimal prefix rather than serialized byte by
byte. The defaults are smaller. The optional SQL escape hatch opens a
physically read-only SQLite connection, accepts one `SELECT`, non-recursive
`WITH`, or `EXPLAIN QUERY PLAN` statement of at most 16 KiB, and stops iteration
at 50 rows. It is intended for agents that need a precise graph join, not as a
path around bounded context retrieval.

# Verification boundary

`tests/okf-graph.test.mjs` proves content-addressed reuse, one-document
invalidation, independent source-digest refresh, stable line-independent
section identities, fragment-link resolution, all supported edge families,
metadata-only handling for generated JSON, output bounds, and rejection of SQL
writes. It also covers CRLF parity, old-schema cache recreation, single-line
section flooding, BLOB reduction, recursive-query rejection, and deterministic
write-lock contention from a concurrent process. The first implementation uses
deterministic Markdown structure and explicit path language. A later
Tree-sitter adapter may add symbol-level source nodes, but it must preserve the
same bounded query contract and cannot make the cache necessary for
correctness.
