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

# Release gate and community example

The 0.1 archive carries the extension's MIT license, pinned third-party
attribution, and the exact MIT, Apache-2.0, BSD-2-Clause, and CC0 texts needed
by its statically linked native dependencies. Packaging fails closed if any
required license file or `CHANGELOG.md` is absent. Release notes come from that
changelog; a tag never overwrites an existing non-identical asset.

The release workflow first requires its commit to be reachable from `main`; a
tag-triggered run also requires the tag to point at that exact commit and match
the extension's `VERSION`. It assembles all content-addressed native targets,
runs the generic JSI and Static Hermes facades, executes the native
fixed-storage core under ASan and UBSan, and packages the dependency ZIP. The
workflow then stages the minimal Lua example from the exact ZIP it will attach
and uses Bob to compile it for x86_64 Linux and HTML5 before attaching the ZIP.
The staging script accepts only the ZIP's root `game.project` and
`defold_webtransport/` members, but deliberately takes the project files from
the minimal example; the installed extension bytes therefore come exclusively
from the exact release candidate. This verifies the archive is accepted by Bob
through the ordinary Lua project layout.

After attaching the immutable ZIP, the same release job runs Bob again from
the unmodified minimal example, which declares the published release URL in
`game.project` and has no vendored extension tree. This second native/HTML5
build tests actual dependency resolution from GitHub; the pre-upload staged
build alone cannot prove that URL works. A failed post-upload build leaves the
workflow red even though the immutable asset has already been attached, and a
retry must verify that the existing asset is byte-identical before proceeding.

This compile gate is not a live echo smoke. The example's certificate hash is
an editor-set script property with a deliberate placeholder, and this workflow
has no existing packaged-engine runner that provisions that property, starts
the Deno TLS echo server, launches the native game, and waits for both Lua echo
events. Keep the live gate explicit: generate a temporary certificate and key,
start the example's Deno server with those files, set the client hash to the
certificate SHA-256, install the exact release ZIP into a clean copy of the
example, build and launch the packaged Linux game under a virtual display, then
require both `datagram echo: hello datagram` and `stream echo: hello stream`
before a bounded timeout. HTML5 needs the same ZIP install plus a secure-origin
browser runner and browser WebTransport support; Bob compilation alone does
not prove either runtime exchange.

The minimal example owns only a Lua client and Deno WebTransport echo server;
it does not depend on déherm or any War Battles transport or protocol module.

## 2026-10-12 release-candidate verification

The published native release `defold-webtransport-native-23dffc55201c` was
downloaded and verified against its immutable per-target metadata (10 targets,
fingerprint `23dffc55201c53783e5c1aed9a35fd81e2ef62c7e5cfa9d4f2e89ec280fb8445`,
ABI SHA-256 `f43dda649b3e44ff177666b62ac69a81ba420dc0764a0ed63b9de25e3546b8bc`).
Packaging those artifacts with extension `VERSION` 0.1.0 produced
`defold-webtransport-0.1.0.zip`, SHA-256
`1d420b33ec47e638d5292f440ed1b0c5516e3c1f42794d0c04695fb8c6dabb62`.
The exact ZIP was extracted through the release staging script into a fresh
minimal project; its 138 extension members are archive bytes, and its project
files are from the minimal example. This is a local candidate only: the
`defold-webtransport-v0.1.0` release/tag does not exist yet, so the README's
resolved dependency URL cannot currently succeed. No release was published
as part of this verification.

The native live echo and HTML5 browser echo remain explicit release gates, not
passes. The previous host-prerequisite note was incorrect: this macOS arm64
host has Java 25.0.4.1 at `/opt/homebrew/opt/openjdk@25/bin/java`, the Defold
editor at `/Applications/Defold.app`, Bob at `build/tooling/bob.jar`, Deno, and
Google Chrome 154.0.8037.99 at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. These tools
are available for an arm64 macOS and browser attempt; their presence alone is
not runtime evidence. Docker is installed, but its Colima daemon is inaccessible
(`permission denied` on the Colima Docker socket), so the x86_64 Linux
packaged-game/virtual-display route is unavailable here. The server requires
Deno plus temporary OpenSSL-generated `cert.pem`/`key.pem`. A live test must
stage the exact release ZIP, set the client certificate SHA-256 property,
launch the Deno server, and observe both exact Lua echo lines before a bounded
timeout. HTML5 also requires serving the package from a secure origin and
observing the native browser WebTransport exchange. Record each of these as
separate outcomes; Bob compilation, tool availability, and Deno typechecking
are not live echo evidence. The 0.1.0 dependency URL remains unresolved until
the independently versioned release is published, so local tests using the
staged ZIP do not prove dependency-URL resolution.

The corrected smoke attempt confirmed those are execution constraints rather
than missing host tools. `deno task check` passes with Deno 2.9.7, but starting
the loopback Deno echo server in this sandbox fails at `new QuicEndpoint(...)`
with `PermissionDenied: Operation not permitted (os error 1)`. Java, Bob, and
Chrome are installed, but the first Bob attempt also exposed that the minimal
project was missing its default `/input/game.input_binding` resource. The
example and ZIP staging now include that resource, and the staging test checks
it resolves. Retrying Bob after adding the standard binding to the temporary
staged project reached the native engine-build step and then required
`build.defold.com`; the sandbox denied that request because Bob uploads the
staged project and extension contents to the public build service. It was not
retried through another route. Therefore
neither the native Lua echo nor the HTML5 secure-origin browser echo was
executed; Chrome is present, but the packaged HTML5 bundle cannot be produced
within the approved boundary. These gates remain explicit and unpassed.

The browser backend treats `datagrams.createWritable()` as the current
WebTransport contract and retains `datagrams.writable` as an explicit legacy
compatibility input. A missing browser WebTransport implementation is an
application routing condition, not permission for the extension to substitute
a different transport silently.
