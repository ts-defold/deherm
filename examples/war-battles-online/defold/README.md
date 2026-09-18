# War Battles Online Ultimate — Defold project

This is the visible Defold frontend for the deterministic 32-player simulation.
The authored entry point is `main/battle.gui.ts`; the public `deherm generate`
command owns `main/battle.gui_script`. Do not edit that proxy.

The scene uses fixed, editor-authored pools rather than runtime node creation:

- 32 tank bodies and 32 independently aimed turrets;
- 160 projectile nodes, with deterministic culling when the authoritative pool
  contains more visible projectiles;
- a player-following camera projection over the bounded arena;
- a HUD with health, score, credits, team counts, round, tick, and projectile
  count; and
- a deterministic restart loop after local defeat, plus manual restart.

Controls:

| Keys | Action |
| --- | --- |
| W/A/S/D | Move and aim |
| Space | Fire |
| Z/X/C | Buy damage/mobility/armor upgrades |
| R | Restart the match |

From the repository root, dogfood the public CLI entry point with:

```sh
node examples/war-battles-online/integration/sync-defold-sources.mjs
node bin/deherm.mjs generate --project examples/war-battles-online/defold
node bin/deherm.mjs typecheck --project examples/war-battles-online/defold
node bin/deherm.mjs verify-generated --project examples/war-battles-online/defold
node bin/deherm.mjs dev \
  --project examples/war-battles-online/defold \
  --entry examples/war-battles-online/defold/main/battle.gui.ts \
  --watch examples/war-battles-online/defold \
  --once --headless --no-ttsc
```

The project exposes the repository extension through its example-local
`defold_hermes` dependency link. Consequently a full native build requires the
pinned local Extender:

```sh
/opt/homebrew/opt/openjdk@25/bin/java -jar build/tooling/bob.jar \
  --root examples/war-battles-online/defold \
  --output build/default \
  --platform arm64-macos --architectures arm64-macos \
  --variant debug --archive \
  --build-server http://localhost:9010 \
  resolve build
```

Bob's debug upload inspection proves that this layout contributes the extension
manifest, sources, headers, and arm64 Hermes archive. The earlier resource-only
build proves that the collection, game object, GUI, font, input, and generated
Lua proxy compile, but used a vanilla engine because the dependency was absent.
The current custom engine has now executed the generated GUI proxy, loaded the
bundle in Dynamic Hermes, completed the TypeScript `init`, first render, and
first update/render, and remained free of rejected diagnostics for a bounded
1.5-second window. Re-run
and record that artifact-bound proof from the example package with:

```sh
pnpm runtime:packaged
pnpm runtime:packaged:record
pnpm runtime:packaged:check
```

The narrower generated component capability report still records
`runtimeConformant: false`; this example observation does not promote every
component context, lifecycle, runtime target, or API. See
[PLAYABLE-BLOCKERS.md](./PLAYABLE-BLOCKERS.md) for the exact proven boundary and
remaining blockers.
