---
type: Architecture Decision
title: Resolve API ground truth from the exact Defold engine SHA
description: Use matching generated reference artifacts and packaged public headers, then merge resolved project extensions without mixing engine versions.
tags: [decision, api, versioning, editor, bob, dmsdk, generation]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T18:00:00-04:00 }
sources:
  - id: defold-bob
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/Bob.java
    title: Bob engine SDK selection
    author: team:defold
  - id: defold-editor-engine
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/editor/src/clj/editor/system.clj
    title: Defold editor engine SHA
    author: team:defold
---

# Decision

The immutable Defold engine SHA is the API-version key. A release label is
display information, and `game.project` does not independently select the SDK
used by an ordinary editor build. The editor carries `defold.engine.sha1`; Bob
reports the matching `EngineVersion.sha1` and accepts `--defoldsdk` explicitly.

The CLI resolves the engine SHA in this order:

1. explicit `--defold-sdk <sha>` from CI or the user;
2. the SHA passed by the optional Defold editor hook from `editor.engine_sha1`;
3. the SHA reported by the configured Bob executable or JAR;
4. a previously locked project SHA whose artifact hashes still verify.

Resolution fails rather than combining inputs from different SHAs.

# Canonical inputs

For one resolved SHA, generation consumes:

* `engine/share/ref-doc.zip` from Defold's immutable archive for Lua
  annotations, structured dmSDK documentation, examples, and source links;
* packaged public `dmsdk/**/*.h(pp)` headers for native declarations, layouts,
  overloads, visibility, templates, and platform gates;
* local and Bob-resolved dependency extensions: `.script_api`, public headers,
  `ext.manifest`, and an optional Defold-Hermes semantic schema.

Clang's JSON AST—not a C++ text parser—produces the dmSDK declaration IR. A
depth-aware annotation/type parser consumes the generated Lua stubs. Structured
reference JSON is merged onto the Clang symbols for TSDoc. Every input path,
SHA-256, engine SHA, generator version, platform profile, and diagnostic is
written to the generation manifest.

# Cache and output

The CLI prefers matching local editor/Bob artifacts, then a content-addressed
user cache, then the immutable Defold archive. Cached bytes are accepted only
when their engine SHA and checksum match. Project-local output lives under
`.defold-hermes/`; a small tracked `defold-hermes.lock` records the selected SHA
and generator inputs.

# Coverage states

Discovery, generated TypeScript, runtime implementation, native linking, and
semantic conformance are separate counts. The CLI must never describe the full
API as executable merely because every declaration has a TypeScript signature.
