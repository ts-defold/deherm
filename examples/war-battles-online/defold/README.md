# War Battles Online — Defold project

A top-down arena deathmatch built entirely out of déherm TypeScript components.
Every gameplay entity is an ordinary Defold game object with sprite, factory and
collision-object components; the HUD is a GUI scene. No Lua is authored here.

| Resource | Contents |
| --- | --- |
| `main/main.collection` | level, player, camera, GUI, the arena director, and four tutorial tanks |
| `main/level.go` | `/main/arena.tilemap` over the generated `/main/arena-tiles.tilesource` |
| `main/arena.go` | `/main/arena.script` plus the five factories the arena creates objects through |
| `main/player.go` | tank sprite, rocket factory, `/main/player.script` |
| `main/arena-tank.go` | tank sprite, `/main/tank.script` — one hull or one turret |
| `main/arena-shot.go` | projectile sprite, `/main/rocket.script` bound to a simulation slot |
| `main/arena-pickup.go` | pickup sprite, `/main/pickup.script` |
| `main/arena-boom.go`, `main/arena-spark.go` | explosion sprites; no script, the director retires them |
| `main/camera.go` | orthographic `camera` component plus `/main/camera.script` |
| `main/rocket.go` | `/main/rocket.script`, sprite, kinematic collision, group `rockets`, mask `tanks` |
| `main/tank.go` | sprite, kinematic collision, group `tanks`, mask `rockets` |
| `main/ui.gui` | score, status, leaderboard and hint text driven by `/main/ui.gui_script` |
| `input/game.input_binding` | arrows/WASD, space, shift, `1`-`6` weapons, `7`-`0` chassis |

The authored sources are `main/arena.script.ts`, `main/player.script.ts`,
`main/tank.script.ts`, `main/rocket.script.ts`, `main/pickup.script.ts`,
`main/camera.script.ts` and `main/ui.gui.ts`, plus the shared
`src/arena-match.ts` and the synced simulation under
`src/generated-war-battles/`. The public `deherm generate` command owns the
sibling `.script` and `.gui_script` proxies; do not edit them.

Controls:

| Keys | Action |
| --- | --- |
| Arrows / WASD | Thrust. The tank has mass: it accelerates, drifts and coasts |
| Space | Fire |
| Shift | Boost — a limited, recharging burst of speed |
| `1`–`6` | Cannon, autocannon, railgun, scatter, mortar, ricochet |
| `7`–`0` | Purchase/select scout, assault, bulwark, artillery chassis |

The turret is a separate object from the hull and slews at its own rate. With a
keyboard there is no second stick, so the turret tracks the closest enemy the
tank can actually see, inside the current weapon's reach, led by the projectile's
flight time; with nothing in view it points where you are driving. A client with
a pointing device calls `setAim` instead and the assist steps aside. A mouse
binding is not wired up because the input-action shape Defold uses for pointer
motion has not been executed through the generated binding, and this port does
not guess at unproven route shapes.

## Who moves what

Only the **current-instance** shapes of `go.set_position`, `go.set_rotation` and
`go.get_position` are implemented by the generated value bindings, so no
component can write another game object's transform. The whole scene is built
around that: the arena director creates objects and never moves them, and every
hull, turret, projectile and pickup reads the authoritative slot it was spawned
for and moves *itself*. That is also why a tank is two game objects - the hull
and the turret rotate independently, and each has to be the thing that rotates.

## World, camera, and scale

### Scale policy

The reference display stays **1280x720 with `high_dpi = 1`**, and the world is
drawn through a **camera component with an authored orthographic zoom of 2**
(`orthographic_projection: 1`, `orthographic_mode: ORTHO_MODE_AUTO_FIT`). The
auto-fit mode preserves the 1280x720 reference view as the HTML5 canvas is
resized to its containing element; the camera script reads the effective auto
zoom before deriving its map clamp rectangle. At the reference size the
visible world rectangle is **640x360 world units**: one world pixel is two
logical pixels. Every step of that reference chain is an integer, and the
browser's responsive scaling cannot put a spawn outside the actual viewport.

This is a deliberate choice among three that Defold makes available:

* the tutorial's stretch projection at 1280x720 shows 80x45 tiles of 16 px art,
  which is exactly what made the art read as very small;
* dropping `display.width`/`display.height` to 640x360 would present the art at
  the same size but open a 640x360 *window*, because in Defold the display size
  is both the window size and the reference projection;
* `use_fixed_fit_projection` picks `min(window/reference)` as its zoom, which is
  a non-integer factor for any window that is not an exact multiple.

An authored integer zoom on a camera component keeps the window large and the
art legible. `main/camera.script.ts` reads both `orthographic_zoom` and
`orthographic_auto_zoom` back off the active camera, multiplies them, and
divides the reference display size by that effective zoom, so the clamp
arithmetic tracks the projection at every browser size; it rounds the view
origin to whole world pixels every frame.

The GUI is untouched by all of this: the built-in render script draws the world
predicate through the camera component and the `gui` predicate through its own
screen-space projection, so the score node stays fixed while the world scrolls.

### World

`main/arena.tilemap` is **120x90 tiles, 1920x1440 px** — three screens wide and
four tall. It is not decoration: it is the *picture* of the collision grid in
`core/arena.ts`, emitted from the same seed by
`../tools/generate-arena-tilemap.mjs`, which reads the tile identities out of the
art manifest so renumbering the tile sheet cannot silently repaint the map. If
the two ever disagree you are shooting at a wall the server does not have, which
is why there is one generator and a `--check` mode rather than two hand-kept
files.

`main/level.go` is placed at `(-312, -352)`, so the playable rectangle is
`x ∈ [-312, 1608]`, `y ∈ [-352, 1088]` exactly as before, and the simulation's
own origin sits at `(648, 368)` in Defold pixels. `main/main.collection` gives
the player an inset copy of that rectangle and the camera the rectangle itself.

The arena is **point-symmetric and not destructible**. Symmetric because neither
half of a deathmatch may be the bad half. Not destructible because the grid is
derived from a four-byte `mapSeed` rather than stored: a joining client rebuilds
it exactly, and the authoritative snapshot stays a fixed 17,752 bytes with no
terrain delta codec. Breakable cover would put 10,800 mutable cells on the wire
or force an encoder this slice does not have — and Quake's arenas are not
destructible either; cover you learned stays where you learned it.

### Camera

`main/camera.go` carries the camera component and `main/camera.script.ts`. The
script smooths the view toward the follow target with an exponential rate,
adds look-ahead along the target's own velocity — capped at `lookAhead` pixels
and scaled by `speed / lookAheadSpeed`, so it is bounded and eases back to zero
when the target stops — and clamps the result inside the world rectangle
shrunk by the half view. An axis whose world extent is smaller than the view
collapses to its centre instead of clamping.

The follow target reports itself. `go.get_position(id)` and its siblings declare
`String`, `Hash` and `Url` call shapes but the generated value bindings
implement only the current-instance shape, so a component still cannot read
another game object's transform. The player posts
`msg.post("/camera#follow", "player_at", { x, y })` instead, which is an
implemented `msg.post(String, String, Table)` shape.

Every camera property is an editor property on the script, so the follow feel is
tunable without a rebuild: `lookAhead`, `lookAheadSpeed`, `lookAheadRate`,
`followRate`, the four `world*` bounds, `zoom` (a fallback only), and
`traceInterval`, which controls the `war-battles:camera:` trace lines on stdout
and is disabled by setting it to 0.

## Art

The arena art is **generated**, by `../tools/generate-art.mjs`, into
`assets/derived/arena/` with a manifest at `assets/derived/arena/arena-art.json`
and a `--check` mode like every other generated artifact here. It is drawn from
a palette histogrammed out of the pinned tutorial PNGs — the generator refuses to
use a colour that is not in that histogram — at the same 16 px tile size, the
same chunky silhouettes and the same 1 px `#2c2839` outline the tutorial sprites
carry. Four team colours, tank hulls with a two-frame tread animation, separate
turrets and wrecks, six projectiles, explosion and spark sequences, nine pickup
icons, and the 17-cell arena tile sheet including a nine-tile blob wall set.

The tutorial's own sprite sheet is not vendored here. `main/tutorial-sprites.atlas`
maps the tutorial's four animations onto the closest art in `assets/`, and is
still used by the scripted demonstration rocket:

| Animation | Source | Note |
| --- | --- | --- |
| `player-down` | `assets/units/infantry/down` | 22x22 walk cycle, art faces screen-down |
| `rocket` | `assets/buildings/turret-rocket` | horizontally flipped so frame zero points along +x |
| `explosion` | `assets/fx/explosion` | nine frames, `PLAYBACK_ONCE_FORWARD`, 122x71 — much larger than the tutorial's |
| `tank-down` | `assets/units/tank/down` | 48x48 idle |

The generated tank hull points along +x at rotation zero, which is what
`quat_rotation_z` treats as its own zero, so the port no longer needs the
quarter turn the screen-down infantry art required.

## Scripted demonstration, and how the match starts

`main/main.collection` sets the player's `demo` script property to `1.0` and its
`tour` property to `10.0`. One second after `init` the player fires one rocket
at the nearest tutorial tank, so a launch exercises the whole
factory/physics/message chain without a human at the keyboard; it then drives
east for five seconds and north for five more, which scrolls the world on both
axes and drives the player and the camera into their clamps. **That sequence is
unchanged, and it is what both packaged runtime gates observe.**

When it ends, the player posts `engage` to the arena director and the match
starts: the roster is created, turrets and pickup pads appear, and the tank
starts being driven by the simulation instead of by the script. **Any input does
the same thing immediately**, so a human who presses a key is playing within a
frame and never waits out the demonstration. Set `demo` to `0` for a scene that
is waiting for you from the first frame, or set the director's
`autoEngageSeconds` to start without either.

The four tutorial `tank.go` instances stay in the collection. They are the
collision targets the demonstration rocket is observed hitting, which is the
`war-battles:rocket-hit` marker in the gates; they are inert once the arena is
running.

## The arena director

`main/arena.script.ts` owns the match and the five factories. Its editor
properties are `players` (2–32, default 8), `botSkill` (0 recruit to 3
nightmare), `mapSeed` (0 keeps the built-in arena) and `autoEngageSeconds`.

It is the only component that advances the simulation; everything else reads the
world it stepped. Defold does not guarantee update order inside a collection, so
a tank may draw the previous frame's state — invisible at 60 Hz, and much simpler
than a frame barrier.

Object lifetime is deliberately creation-and-deletion rather than enable/disable:
those two routes are the ones this port has actually executed inside a packaged
engine. A projectile game object is created when its simulation slot goes live
and deletes itself when the slot goes quiet or its generation is recycled; a
pickup pad does the same; explosions are created by the director and retired by
it on a tick count. Visible projectiles are capped at 64.

## Online play

`arena.script.ts` connects to a server when `game.project` declares one:

```ini
[war_battles]
server = https://localhost:4433/war-battles
server_certificate_sha256 = <64 hex characters for a local self-signed certificate>
```

Production certificates use the browser trust store and do not need the hash.
For a no-rebuild development session, the browser host may install an explicit
`globalThis.__warBattlesConfigV1` object with `server` and
`serverCertificateSha256` before the engine starts. The packaged online gate
uses that seam; game code exposes its current fixed-shape counters as
`globalThis.__warBattlesTelemetryV1` and mutates the same object in place.

On HTML5 the arena prefers browser WebTransport/HTTP3 and falls back explicitly
to WebSocket/TCP. A native Defold engine has neither adapter yet, so native
builds play offline against bots. See [`../server/README.md`](../server/README.md)
for both server lanes, the certificate, and the packaged browser proofs.

## Building

```sh
pnpm package:defold
node bin/deherm.mjs generate --project examples/war-battles-online/defold
node bin/deherm.mjs dev \
  --project examples/war-battles-online/defold \
  --entry examples/war-battles-online/defold/main/player.script.ts \
  --watch examples/war-battles-online/defold \
  --once --headless --no-launch
node scripts/assemble-typed-native-extension.mjs \
  --project examples/war-battles-online/defold
/opt/homebrew/opt/openjdk@25/bin/java -jar build/tooling/bob.jar \
  --root examples/war-battles-online/defold \
  --output build/default \
  --platform arm64-macos --architectures arm64-macos \
  --variant debug --archive \
  --build-server http://localhost:9010 \
  resolve build
```

## The typed-native transport

The assemble step above materialises `defold_hermes_typed_native/`, a
project-local extension carrying one `shermes -typed -strict -O -emit-c` unit.
Bob uploads it, Extender compiles and links it, and `defold_hermes` evaluates it
into the same Hermes runtime as the bytecode bundle. The unit installs itself
over the script bridge, so the routes it claims cross into the engine through
`extern_c` and every other route keeps crossing over JSI in the same binary.

The shipped default is telemetry **off**. Add `--profile` to the assemble step
to build with transport telemetry on: the running game then prints a
`DEHERM_EVENT transport-span` census every two seconds and one final census
after teardown, naming the transport, route, call count and mean nanoseconds of
every binding crossing. `pnpm check:profile-shipped-default` refuses a commit
whose `generated_build_config.h` is the instrumented header a `--profile` run
leaves behind, so re-assemble without `--profile` when you are done.

Record a census with

```sh
node integration/check-typed-native-transport.mjs --run with-typed-native --record-evidence
```

A recorded run is in
[`../evidence/packaged-typed-native-transport-arm64-macos.json`](../evidence/packaged-typed-native-transport-arm64-macos.json):
14 routes on `typed-native`, and `gui.get_node`/`gui.set_text` - the two routes
whose value type is a retained `node` handle - on `jsi`.

The directory is generated. Delete it, rebuild, and record with `--run control`
and the game still runs with every route back on JSI; that control is in the
same evidence file, and it is what makes the split the assembly rather than the
instrument.

It is also **runtime-scoped**. A `shermes` unit executes only where a Hermes
runtime exists, so the assemble step takes `--target` and refuses a
browser-runtime target with `typed-native-requires-hermes-runtime`, and every
build reconciles the project's `.defignore` so Bob cannot upload this extension
for `wasm-web`. `scripts/bob.sh` does that automatically; a hand-run `bob.jar`
should be preceded by

```sh
node scripts/assemble-typed-native-extension.mjs \
  --project examples/war-battles-online/defold --target <platform> --reconcile
```

## The three projections

This port runs in three projections of the same IR, and each carries its own
evidence because each is a first-class artifact rather than a variant of
another. The set is declared in
[`../integration/projections.mjs`](../integration/projections.mjs) and checked
by `pnpm check:war-battles-projections`, which fails by name when a declared
projection has no evidence.

| Projection | Runtime | Transport | Profile | Gate |
|---|---|---|---|---|
| `native-arm64-macos` | `hermes` | `jsi` + `typed-native` | engine-detected | `pnpm --filter @deherm/example-war-battles-online runtime:packaged` |
| `browser-wasm-web` | `browser` | `direct-memory` | browser | `pnpm test:html5:war-battles` |
| `native-arm64-macos-typed-native-transport` | `hermes` | `typed-native` + `jsi` | `DEHERM_PROFILE` | `node integration/check-typed-native-transport.mjs --run <slot>` |

None of them claims visual correctness: every one reads markers, engine state,
or a transport census, and nothing here can inspect a window or a canvas.

## Graceful shutdown and component teardown

SIGTERM and SIGINT tear `dmengine` down without running a single component
`final()`, so the only way to exercise teardown is the engine service:
`POST /post/@system/exit`. The native runtime gate terminates that way and
requires `war-battles:player-final`, which `player.script.ts` emits after a
`msg.post` from `final()` returns.

A port is not an engine. Defold sets `SO_REUSEADDR`/`SO_REUSEPORT` on its
listening sockets, so two engines on the default service port both bind it and
an exit post can be absorbed by the wrong one. The gate starts the engine with
`DM_SERVICE_PORT=dynamic`, reads the port back out of that engine's own
transcript, and refuses to post until the listeners on it are exactly that
process. Stop any stray `dmengine` before running it; the gate will say so by
pid rather than post into one of them.

The project exposes the repository extension through its example-local
`defold_hermes` dependency link, so a full native build requires the pinned
local Extender (`pnpm extender:status`). Never use a remote build server.

Run the built game with `pnpm play` from the example package.

For the browser, bundle the same project for `wasm-web` and run the HTML5
runtime gate:

```sh
/opt/homebrew/opt/openjdk@25/bin/java -jar build/tooling/bob.jar \
  --root examples/war-battles-online/defold \
  --output build/bob --bundle-output build/bundle \
  --platform wasm-web --architectures wasm-web \
  --variant debug --archive \
  --build-server http://localhost:9010 \
  resolve build bundle

pnpm runtime:browser
```

`scripts/bob.sh` builds this project directly when `DEFOLD_HERMES_PROJECT`
names it, so `DEFOLD_HERMES_PROJECT=examples/war-battles-online/defold pnpm
bob:web:bundle` is the wrapped equivalent.

The same bundle is what `deherm dev` launches as its HTML5 target - press `w`
in the console, or pass `--web` for a non-interactive run. The session serves
it on a scoped loopback port, drives a dedicated headless Chrome profile, and
pushes each rebuilt bundle into the page, which acknowledges the exact
fingerprint it activated. `pnpm test:html5:war-battles-hot-reload` proves that
edit loop end to end. A TypeScript edit does not change the Wasm engine, so it
needs no rebundle; changing the extension or `game.project` does.

See [PLAYABLE-BLOCKERS.md](./PLAYABLE-BLOCKERS.md) for the exact observed
boundary and the remaining blockers, and [reference/README.md](./reference/README.md)
for the retained presentation mockup.
