# Defold WebTransport release source

This directory is the source boundary for the independently versioned Defold
WebTransport extension. Run:

```sh
pnpm package:defold-webtransport
```

to create `build/releases/defold-webtransport-<version>.zip`. The ZIP is an
ordinary Defold library dependency: it contains a root `game.project` and the
`defold_webtransport/` extension directory, and it does not depend on déherm.
`VERSION` controls this asset's version independently of the monorepo package.

For local dogfood, run `pnpm stage:defold-webtransport`. The command emits the
same ZIP and materializes its exact root layout at
`build/defold-webtransport-dogfood/`; the staged files and archived files come
from the same normalized member map.

## Public surfaces

The TypeScript-facing package presents one WebTransport-shaped facade. In a
native Defold build, the installed provider supplies that facade; in a browser
build, it delegates to the browser's native `WebTransport`. Application code
does not branch on the target. Handles, polling, queue envelopes, and provider
registration are implementation details rather than public gameplay APIs.
Native does not assume DOM Web Streams: the generated facade owns bounded
structural streams and registers its frame drain internally. Native 0.1
requires exactly one SHA-256 certificate pin; browser delegation can use normal
browser root trust.
`defold_webtransport/webtransport/public-api-compatibility.json` records the
versioned required waist and the Candidate Recommendation members reserved for
additive implementation; it is not a second native method catalog.

The Lua surface remains idiomatic and event-driven. It models WebTransport
sessions, bidirectional and unidirectional streams, datagrams, readiness, and
close/error events. It does not expose War Battles-specific reliable-channel
operations.

Lua documentation and editor completion are shipped through
`defold_webtransport/script/defold_webtransport.script_api`. Native consumers
may integrate through the versioned public C descriptor under
`defold_webtransport/include/defold_webtransport/`; déherm consumes that seam
additively through
`defold_webtransport/webtransport/defold-hermes.bindings.json`, but is not
required to install or use the extension.

`client.h` is the ergonomic callback C API. Advanced runtimes and provider
authors may instead consume the stable `native_v1.h` handle/poll ABI; that
single explicitly low-level header is not the recommended application API.
Release packaging fails closed unless the HTML5 backend and every native
library declared by `ext.manifest` have been staged.

## Native artifacts

Native archives are published independently under the content-addressed tag
reported by `node scripts/manage-defold-webtransport-artifacts.mjs
release-metadata`. There is one immutable ZIP per native target declared by
`ext.manifest`; each ZIP embeds the full input fingerprint plus a digest and
byte count for every bundled library. The standalone versioned release first
downloads and verifies every target archive, stages them into a clean source
tree, and only then runs the strict extension packager. A source checkout with
no native archives is therefore useful for development but cannot accidentally
be published as an installable release.

For a target-local Bob build, stage a verified archive without committing it:

```sh
node scripts/manage-defold-webtransport-artifacts.mjs stage \
  --target arm64-osx \
  --archive build/native-assets/defold-webtransport-native-arm64-osx.zip \
  --output build/defold-webtransport-native-overlay
DEHERM_WEBTRANSPORT_ARTIFACT_ROOT=build/defold-webtransport-native-overlay \
  deherm generate --project examples/war-battles-online/defold
```

`DEHERM_WEBTRANSPORT_ARTIFACT_ROOT` is resolved from the command's working
directory; `[defold_webtransport] artifacts = ...` is resolved from the Defold
project directory. The command above is therefore exact when run at the
repository root.

Ordinary npm consumers do not need this repository-only staging command.
`deherm generate` reads the extension's ABI-bound
`webtransport/native-artifacts.json`, selects the current host's native target,
downloads its immutable release ZIP, verifies the exact member set and every
digest, caches it in déherm's platform-native user cache (shared by projects),
and installs only the inventoried libraries. `DEHERM_CACHE_HOME` remains the
explicit cache override. Set `[defold_webtransport] artifact_target = web` (or
`DEHERM_WEBTRANSPORT_ARTIFACT_TARGET=web`) for an explicitly web-only project;
otherwise macOS, Linux, and Windows hosts deterministically select their Defold
native target without committing machine-specific configuration.

The managed project copy overlays only the verified target libraries, and its
identity includes the artifact manifest and tree hashes. Bob uploads only the
selected bundle target's extension context; release assembly remains stricter
and always requires all native targets.
