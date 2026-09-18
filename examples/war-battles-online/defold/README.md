# War Battles — Defold project

This is a port of the Defold **War Battles** tutorial to déherm TypeScript
components. Gameplay entities are ordinary Defold game objects with sprite,
factory, and collision-object components; the only GUI is a single score node.

| Resource | Contents |
| --- | --- |
| `main/main.collection` | level, player, GUI, and four tanks |
| `main/level.go` | `/main/tutorial-map.tilemap` over `/assets/map.png` |
| `main/player.go` | sprite, rocket factory, `/main/player.script` |
| `main/rocket.go` | `/main/rocket.script`, sprite, kinematic collision, group `rockets`, mask `tanks` |
| `main/tank.go` | sprite, kinematic collision, group `tanks`, mask `rockets` |
| `main/ui.gui` | one `score` text node driven by `/main/ui.gui_script` |
| `input/game.input_binding` | arrow keys plus space mapped to `up`, `down`, `left`, `right`, `fire` |

The authored sources are `main/player.script.ts`, `main/rocket.script.ts`, and
`main/ui.gui.ts`. The public `deherm generate` command owns the sibling
`.script` and `.gui_script` proxies; do not edit them.

Controls:

| Keys | Action |
| --- | --- |
| Arrow keys | Move |
| Space | Fire a rocket in the last movement direction |

## Art substitutions

The tutorial's own sprite sheet is not vendored here. `main/tutorial-sprites.atlas`
maps the tutorial's four animations onto the closest art in `assets/`:

| Animation | Source | Note |
| --- | --- | --- |
| `player-down` | `assets/units/infantry/down` | 22x22 walk cycle, art faces screen-down |
| `rocket` | `assets/buildings/turret-rocket` | horizontally flipped so frame zero points along +x |
| `explosion` | `assets/fx/explosion` | nine frames, `PLAYBACK_ONCE_FORWARD`, 122x71 — much larger than the tutorial's |
| `tank-down` | `assets/units/tank/down` | 48x48 idle |

Because the infantry art faces down rather than along +x, `player.script.ts`
adds a quarter turn to the tutorial's single `go.set_rotation` call rather than
introducing per-direction flipbooks.

## Scripted demonstration shot

`main/main.collection` sets the player's `demo` script property to `1.0`. One
second after `init` the player moves right for one second and fires one rocket,
so a launch exercises the whole factory/physics/message chain without a human at
the keyboard. Set the property to `0` to disable it; player input is unaffected
once the shot has been taken.

## Building

```sh
pnpm package:defold
node bin/deherm.mjs generate --project examples/war-battles-online/defold
node bin/deherm.mjs dev \
  --project examples/war-battles-online/defold \
  --entry examples/war-battles-online/defold/main/player.script.ts \
  --watch examples/war-battles-online/defold \
  --once --headless --no-launch
/opt/homebrew/opt/openjdk@25/bin/java -jar build/tooling/bob.jar \
  --root examples/war-battles-online/defold \
  --output build/default \
  --platform arm64-macos --architectures arm64-macos \
  --variant debug --archive \
  --build-server http://localhost:9010 \
  resolve build
```

The project exposes the repository extension through its example-local
`defold_hermes` dependency link, so a full native build requires the pinned
local Extender (`pnpm extender:status`). Never use a remote build server.

Run the built game with `pnpm play` from the example package.

See [PLAYABLE-BLOCKERS.md](./PLAYABLE-BLOCKERS.md) for the exact observed
boundary and the remaining blockers, and [reference/README.md](./reference/README.md)
for the retained presentation mockup.
