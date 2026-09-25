---
type: Architecture Decision
title: Publish Defold WebTransport native libraries as content-addressed target archives
description: Build and immutably publish one verified archive per ext.manifest native target, then assemble the independently versioned extension only from a complete artifact set.
tags: [decision, defold, webtransport, native-artifacts, release, reproducibility]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-24T00:00:00-04:00 }
sources:
  - id: standalone-release
    resource: ./standalone-defold-webtransport-release.md
    title: Standalone Defold WebTransport release decision
    author: team:deherm
  - id: artifact-workflow
    resource: ../../../.github/workflows/defold-webtransport-native-artifacts.yml
    title: Defold WebTransport native artifact workflow
    author: team:deherm
  - id: extension-manifest
    resource: ../../../extensions/defold-webtransport/defold_webtransport/ext.manifest
    title: Defold WebTransport extension manifest
    author: team:deherm
---

# Decision

The native artifact matrix is derived from the non-Web platforms and bundled
libraries in `ext.manifest`. The matrix is not a second handwritten target or
library catalog. A small executor map assigns each derived target to Linux,
Android, Apple, or Windows build infrastructure and fails when a newly declared
target lacks an executor.

Every row produces one deterministic ZIP named
`defold-webtransport-native-<target>.zip`. It contains only `artifact.json` and
the target's exact `.a` or `.lib` members. `artifact.json` records the complete
input fingerprint plus the byte count and SHA-256 of every library. Windows
system libraries such as `ws2_32` and `bcrypt` are manifest link inputs, not
bundled members.

The artifact release tag is
`defold-webtransport-native-<fingerprint-prefix>`. The full SHA-256 covers the
pinned native CMake graph and revisions, compatibility patches, extension ABI
headers, archive code, workflow build recipe, and only the Defold SDK settings
that the native build consumes: Android NDK/version floors and Apple deployment
targets. It excludes the package-manager lock and unrelated Defold revision
metadata, so an API-policy refresh cannot rotate byte-identical transport
archives.
Assets are uploaded through the repository's immutable release helper: an
existing exact-name asset is retained and is never overwritten with
`--clobber`. A partial failed release is repairable because planning schedules
only absent target assets.

# Release assembly

The independently versioned extension workflow waits for the content-addressed
native workflow, downloads every expected target archive, verifies its embedded
identity and member digests, and stages all libraries into a clean copy of the
extension source. Only that assembled tree is passed to the strict standalone
packager. The packager independently parses `ext.manifest` and rejects a
missing declared member, so a source-only or partial ZIP cannot publish.

Local tests never require cross compilers or pretend placeholder bytes are
release evidence. They create synthetic complete target archives, exercise the
same verification and assembly functions, and prove the resulting tree passes
strict package validation. Running the real package command against the source
checkout continues to fail closed until real target artifacts are assembled.

# Project-local consumption

The artifact manager can stage one verified target archive as a local overlay.
`installProjectWebTransportExtension` validates every inventoried member and
overlays it onto the managed extension copy. The managed identity includes the
artifact manifest hash, content fingerprint, and overlay tree hash. This lets a
targeted Bob build consume, for example, `arm64-osx` without committing binary
archives. Defold/Bob selects one bundle target and therefore does not require
irrelevant platform directories for that local build; the release assembler is
deliberately stricter and always requires the complete native matrix.

The npm package carries the consumer implementation under
`packages/cli/src/webtransport-artifacts.mjs`; no repository-only script is
needed at runtime. The selected extension carries
`webtransport/native-artifacts.json`, whose expected release tag and full
fingerprint were derived and generator-checked against the complete native
build inputs before packaging. The installed CLI deliberately does not
recompute that source-build fingerprint: those picoquic/picotls sources and CI
recipes are not npm runtime payloads. The npm package's registry integrity is
the trust boundary for its generated index, just as it is for the downloader
code itself; a local attacker able to replace both is already able to replace
the executable CLI. The consumer independently recomputes the shipped
extension ABI digest and target inventory, then requires release metadata,
GitHub's asset digest, embedded fingerprint, exact archive members, and each
library digest to agree with the trusted index. An overlay with a fingerprint
different from that selected index, an ABI from another extension version, an
extra target, or an uninventoried member is rejected. Installation copies each
verified inventory entry individually, so a hostile overlay cannot replace the
common HTML5 backend.

Normal generation selects the current host's extension target (`arm64-osx`,
`x86_64-osx`, Linux equivalents, or `x86_64-win32`) and downloads it into the
shared user cache. `artifact_target = web` is the explicit web-only opt-out. Local
artifact-root environment values are working-directory-relative; project
configuration values are project-relative.

`deherm generate` and `deherm dev` call the same configured-extension installer
before project inventory. This is a lifecycle invariant: the first development
launch must inventory, bind, compile, and give Bob the exact same validated
source-plus-artifact tree as explicit generation. A project must not need to run
`generate` as an undocumented prerequisite before `dev`, and the watch/TUI path
must not silently fall back to a source-only native extension.

Generated C/C++ include fragments consumed by the extension live below
`include/defold_webtransport/`, never beside the Lua documentation under
`script/`. Local syntax checks can see either location, but Bob/Extender uploads
the declared include tree to the remote compiler. A real pinned local-Extender
build on 2026-09-24 caught the original `script/*.inc` location as absent,
then compiled and linked the generated include from the public header tree.
The resulting arm64 macOS engine exported the connect, stream, datagram, and
callback-pump C symbols and completed the War Battles packaged runtime gate with
a graceful component shutdown.

Downloaded archives use déherm's platform-native user cache (or the explicit
`DEHERM_CACHE_HOME`/XDG cache) and are keyed by the full input fingerprint, so
multiple projects share one immutable target archive. Each reuse revalidates
the exact archive member inventory and embedded library digests. On a cache
miss the CLI first resolves the unique named asset from GitHub's release API
and requires its server-computed `sha256:` digest, then checks the downloaded
ZIP against that digest before trusting its embedded per-library inventory.
The release asset therefore does not attest only to itself. A digest-less,
ambiguous, non-uploaded, or redirected asset identity fails closed.
Staging writes a complete sibling tree and renames it into place only after the
manifest and every library are present, so Bob cannot observe a half-written
overlay.

Concurrent processes sharing an empty cache key are not yet serialized with a
cross-process lock. Every writer validates bytes before publishing and uses a
sibling temporary path, but two simultaneous first downloads can race the
final archive rename. Cache concurrency is therefore an explicit operational
follow-up; callers may retry, and no raced result is trusted without a fresh
full validation.

Build jobs run with read-only repository permission and checkouts do not retain
credentials. A separate publisher job is the sole write-capable job. Published
same-name assets are downloaded and audited before planning; a digest mismatch
fails with the local and published identities plus quarantine/rotation guidance
because immutable content-addressed assets are never silently overwritten.
Runnable Linux, macOS, and Windows artifact rows also build and execute the
native fixed-storage/unit binary before packaging. Android and iOS rows remain
cross-compile/link evidence; the same source is runtime-tested on the host
lanes and sanitizer-tested by the native verification suite.

# Public API invariant

Artifact selection does not change application code. TypeScript exports one
standard WebTransport-shaped facade on every target: browsers delegate to the
global implementation, while dynamic and Static Hermes adapt to their provider
underneath. Provider handles, polling, artifact identities, and build-target
selection are not public application APIs.
