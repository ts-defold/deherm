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

# Revision resolution order

The Defold revision a generation targets is resolved in this order, and the
first that answers wins:

1. **An explicit parameter.** `--defold-sdk <sha>` is a first-class input, not a
   fallback or an escape hatch. A user may be building in CI against several
   Defold versions at once, prebuilding for themselves, or targeting a revision
   their working tree does not name. That is not predictable from the project,
   so an explicit answer must always be accepted and must always win.
2. **Detection from the project.** What the project itself declares -
   `game.project`, its dependency URLs, Bob's resolved state.
3. **Refusal.** If neither answers, generation stops with a diagnostic naming
   what it looked at. It never falls back to whatever revision this package was
   built against.

The failure this ordering exists to prevent is silent, not loud: emitting
bindings for one Defold revision into a project using another produces types
that compile and are wrong.

# Resolving a revision without a Defold checkout

A user is not guaranteed to have Defold source on their machine, and a full
checkout is 1.4 GB. Defold publishes the mapping we need over plain HTTP, so no
git and no source are required to *resolve* a revision.

From the engine's own `scripts/build.py`, which writes these objects:

| Endpoint | Contents |
| --- | --- |
| `https://d.defold.com/<channel>/info.json` | `{"version": "<semver>", "sha1": "<engine sha>"}` |
| `https://d.defold.com/editor2/channels/<channel>/update-v4.json` | the editor side of the same mapping |
| `https://d.defold.com/archive/<sha1>/…` | per-revision artifacts, including `engine/share/ref-doc.zip` and `bob/bob.jar` |

Channels are `stable`, `beta` and `alpha`. This project already consumes the
`archive/<sha1>` form for the reference docs and Bob.

**A channel is a moving pointer, never a pin.** `stable/info.json` resolves to a
different sha over time. A channel may be an *input*, but the resolved sha is
recorded immediately and everything downstream keys on that sha. A project that
regenerates differently next week from unchanged inputs is precisely the
determinism failure this project exists to prevent.

## What still needs source, and what does not

`ref-doc.zip` carries the documented API surface and is digest-pinned. It does
not carry Lua C registration arrays, Bob's builder annotations, the `.proto`
declaration schema, or the dmSDK headers - and those are the ground truth the
documented surface has already been shown to disagree with.

Deriving those needs engine source, but only *once per revision*. That is what
the layered policy cache exists for: a policy is produced from source and
consumed without it, so the common case is a user who needs no Defold source at
all. Source acquisition is the fallback for a revision no policy covers.

When source is required, take the smallest deterministic slice:
`git clone --filter=blob:none --no-checkout --depth 1` followed by
`sparse-checkout` over the paths the generators actually read - `engine/`,
`build_tools/sdk.py`, `share/extender/build_input.yml`, and
`com.dynamo.cr/com.dynamo.cr.bob/src`. That is roughly 115 MB of the 1.4 GB
tree.

Do **not** pin a GitHub codeload tarball by content digest. GitHub has changed
tarball generation before and broken checksums across the ecosystem; the bytes
are not guaranteed stable for a given ref. A git commit SHA is stable and
self-verifying, and anything this project mirrors carries its own published
digest.

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
`.deherm/`; a small tracked `deherm.lock` records the selected SHA
and generator inputs.

# Coverage states

Discovery, generated TypeScript, runtime implementation, native linking, and
semantic conformance are separate counts. The CLI must never describe the full
API as executable merely because every declaration has a TypeScript signature.

# What the CLI implements today

`packages/cli/src/defold-revision.mjs` resolves the revision before anything
version-specific is read. It collects every independent observation rather than
stopping at the first, because a silent precedence win between two
contradictory claims is the same failure in a quieter form.

| Source | Authority | Evidence |
| --- | --- | --- |
| `--defold-sdk <sha>` | live | the user or CI stated it |
| `DEHERM_DEFOLD_ENGINE_SHA1` | live | the optional Defold editor hook |
| Bob `--version` | live | the jar reports its own `EngineVersion.sha1` |
| `game.project` `[defold_hermes] defold_sdk` | declared | the project states what it targets |
| a `game.project` dependency naming a Defold engine archive | declared | `archive/<sha>` path segment on a defold.com or defold/defold URL |
| `.internal/cache/<platform>/build.zip` | historical | Extender's build log names `sdk/<sha>/defoldsdk` for every compile |
| `deherm.lock` | historical | a previous resolution, and only if it recorded its own source |

`authority` is not rank. It says whether an observation witnesses the engine in
use now, is a claim the project makes about itself, or is a record of something
that already happened. Two disagreeing live or declared observations are a
`defold-revision-conflict` blocker. A disagreeing historical one is a warning
naming both revisions. `--defold-sdk` is the one source that overrides rather
than conflicts, per the ordering above, and what it overrode is still reported.

Three properties that are load-bearing rather than incidental:

* **A lock is evidence only when it records how it decided.** A `deherm.lock`
  without a `defoldResolution` block was written by a generator that assumed the
  packaged revision, so it is ignored. Trusting it would launder the old
  assumption through a file that looks like a decision.
* **Nothing falls back to the packaged revision.** An unresolvable revision is a
  `defold-revision-unresolved` blocker that lists every source it checked. The
  refusal deliberately does not name the packaged SHA, because offering it is
  how a user ends up pasting it into `--defold-sdk` without knowing whether it
  is theirs.
* **Expensive sources are lazy, not optional.** Bob is a JVM start and an
  Extender archive is tens of megabytes, so neither runs when something live or
  declared already answered. A lock alone never suppresses them - an engine
  upgrade would then be invisible forever - unless the lock's own evidence file
  is byte-identical on disk, in which case re-reading it cannot say anything
  new. Naming `--bob`/`DEHERM_BOB` always asks Bob, which is the only way a
  drifted `game.project` declaration gets caught.

`deherm create` writes `[defold_hermes] defold_sdk` into the scaffolded
`game.project`. A scaffold has no editor, no Bob and no build to witness
anything, so it states the revision it can actually generate for - a declaration
the project makes and that Bob or a real build then checks, not a default
applied silently at generation time.
