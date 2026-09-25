---
type: Architecture Decision
title: Publish Defold WebTransport as a standalone deterministic dependency
description: Package the Lua-first extension independently from deherm while retaining an additive public C ABI integration seam.
tags: [decision, defold, webtransport, extension, release]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-24T00:00:00-04:00 }
---

# Decision

Defold WebTransport is an independently versioned Defold library. Its release
ZIP is installable by an ordinary Defold project and does not require déherm.
The archive root contains exactly `game.project` and `defold_webtransport/`.
The extension directory carries its manifest, native implementation and target
libraries, Lua registration, `.script_api` documentation, and public C ABI
headers. Déherm integration consumes that public descriptor as an additive
route; it is not the extension's ownership or installation boundary.

TypeScript consumers see one WebTransport-shaped facade. Native builds supply
it through the provider and browser builds delegate to the browser's native
`WebTransport`; applications do not select an adapter by target. Provider
handles, polling, and event-envelope details stay internal. The separately
documented Lua API is idiomatic and event-driven around sessions, streams,
datagrams, and lifecycle events rather than exposing a game's reliable-channel
semantics.

`extensions/defold-webtransport/VERSION` is the release version authority. The
asset is named `defold-webtransport-<version>.zip` and is published under
`defold-webtransport-v<version>`, independently of the npm package version and
the content-addressed Hermes artifact releases.

# Deterministic archive contract

The packager sorts members, fixes ZIP timestamps and Unix modes, rejects
symbolic links, and includes only root `game.project` plus files below
`defold_webtransport/`. It requires `ext.manifest`, the Lua `.script_api`
document, the additive `webtransport/defold-hermes.bindings.json` descriptor,
and public headers below `include/defold_webtransport/`. It parses
`ext.manifest`, requires the functional `lib/web/library_defold_webtransport.js`
backend, and requires each non-system library declared for each native target
under that target's `lib/<platform>/` directory. Source-only and partially
staged archives fail closed.
Repackaging equal bytes from another checkout must produce the same archive
bytes.

Compilation and packaging remain separate evidence stages. The packager never
builds native code; it verifies staged target coverage against the manifest. A
release job may attach an existing asset only when its bytes are
identical; it never overwrites an independently versioned release asset.

Native compilation is an independently content-addressed prerequisite. One
immutable archive per `ext.manifest` native target carries the exact bundled
libraries and an embedded digest inventory. Release assembly downloads and
verifies the complete target set into a clean tree before invoking this
packager. See [the native artifact decision](./defold-webtransport-native-artifacts.md).

# Local dogfood

The packaging command can materialize a staging directory from the same member
map used to construct the ZIP. Local Defold dogfood therefore consumes either
the produced archive or a byte-equivalent staged tree with the release's real
root layout, rather than a repository-only source layout.

For monorepo dogfood, `[defold_webtransport] source = ...` selects an explicit
local source. `deherm generate` copies it into a content-keyed, manifest-owned
`defold_webtransport/` tree before inventory, so Bob and SDK generation consume
the same descriptor. Published projects can instead use an ordinary resolved
Defold dependency; no application target branch is introduced.
