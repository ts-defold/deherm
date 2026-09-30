# Defold WebTransport maintainer notes

This subtree is the independently versioned WebTransport extension.
`README.md` is user-facing installation and API documentation. Keep packaging,
artifact staging, generation, and release instructions here.

## Release boundary

- `VERSION` controls the extension version independently of the npm package.
- `pnpm package:defold-webtransport` creates
  `build/releases/defold-webtransport-<version>.zip`.
- The ZIP is an ordinary Defold library with a root `game.project` and the
  `defold_webtransport/` directory. It must not require déherm.
- `pnpm stage:defold-webtransport` creates the same ZIP and materializes its
  normalized member map at `build/defold-webtransport-dogfood/`.
- Release packaging fails closed unless the HTML5 backend and every native
  library declared by `ext.manifest` have been staged.

## Generated public surfaces

Do not hand-edit generated API files. Change
`scripts/generate-defold-webtransport-community-api.mjs` and its declared
inputs, then regenerate. It owns the Lua editor API, `client.h`, `native_v1.h`,
and the dynamic and Static Hermes TypeScript facades.

Keep the public high-level surface WebTransport-shaped. Handles, polling
frames, provider registration, and artifact selection are implementation
details. Browser and native behavior should remain aligned without pretending
an unavailable browser WebTransport implementation is another transport.

## Native artifacts

Native archives are independently published under the content-addressed tag
reported by:

```sh
node scripts/manage-defold-webtransport-artifacts.mjs release-metadata
```

Each target ZIP embeds its input fingerprint plus the digest and byte count of
every library. The standalone release downloads and verifies every target
archive before strict packaging.

Repository-local target staging:

```sh
node scripts/manage-defold-webtransport-artifacts.mjs stage \
  --target arm64-osx \
  --archive build/native-assets/defold-webtransport-native-arm64-osx.zip \
  --output build/defold-webtransport-native-overlay

DEHERM_WEBTRANSPORT_ARTIFACT_ROOT=build/defold-webtransport-native-overlay \
  deherm generate --project examples/war-battles-online/defold
```

`DEHERM_WEBTRANSPORT_ARTIFACT_ROOT` resolves from the working directory;
`[defold_webtransport] artifacts = ...` resolves from the Defold project.
Consumers do not need this staging command. The CLI uses
`webtransport/native-artifacts.json` to select, download, verify, and cache the
host artifact. `DEHERM_CACHE_HOME` is the explicit cache override.

## Verification

Exercise the community API generator check, extension syntax check, packaging
tests, and minimal example for changes to their owned contracts. Generated
files must change only through their generator.
