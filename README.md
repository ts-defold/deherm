<p align="center">
  <img src="docs/assets/brand/deherm-wordmark-basalt-heart.png" alt="déherm" width="960">
</p>

<p align="center">
  <strong>TypeScript for Defold. Native where it matters.</strong>
</p>

<p align="center">
  <a href="https://ts-defold.dev/deherm/docs/">Docs</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-runs">How it runs</a> ·
  <a href="https://discord.gg/eukcq5m">Discord</a> ·
  <a href="https://ts-defold.dev/">ts-defold</a>
</p>

> [!IMPORTANT]
> déherm is a **0.1 preview**. The generated API, CLI, editor tools, native
> artifacts, and standalone WebTransport extension are being hardened for the
> first public release. Pre-1.0 source compatibility may change between
> documented releases.

déherm lets you build Defold games in TypeScript without treating Lua as the
only execution target. It generates a project SDK from the exact Defold engine
revision and native extensions your game uses, then selects the runtime that
fits the target:

- Dynamic Hermes for fast native development and hot reload.
- Static Hermes plus generated C ABI routes for optimized native builds.
- The browser's JavaScript engine for HTML5, calling the Defold Wasm engine
  without embedding Hermes in Wasm.
- A generated Lua compatibility bridge for Defold script APIs exposed through
  Lua.

The same `.script.ts`, `.gui_script.ts`, and `.render_script.ts` conventions
produce the Defold proxy resources you attach in the editor. Generated context
projects keep GUI-only and render-only APIs out of places where Defold does not
make them available.

## What you get

- A deterministic generator for the Defold Script API, dmSDK, and project
  native extensions.
- An idiomatic `@deherm/project` TypeScript surface with generated TSDoc.
- Typed component properties and Defold editor proxy generation.
- Literal Defold hashes such as `const fire: DefoldHash = "#fire"`, lowered at
  compile time when the call site requires a hash.
- A development TUI with watch mode, build and launch controls, hot-reload
  state, live logs, runtime telemetry, and profiles.
- A VS Code language server, source-mapped debugger, inline property lenses,
  `.cpuprofile` capture, and `.heapsnapshot` capture.
- Tree-shaken release projections: generation exposes the compatible surface;
  the final application retains only reachable code.
- Content-addressed host tools and native libraries downloaded once and reused
  from the platform-native user cache.

## Quick start

Create a new game:

```sh
pnpm dlx @ts-defold/deherm create my-game --name "My Game"
cd my-game
pnpm install
pnpm dev
```

Add déherm to a Defold project that already contains `game.project`:

```sh
pnpm add -D @ts-defold/deherm
pnpm exec deherm generate
pnpm exec deherm dev
```

Running `deherm` with no command opens the project/scaffold TUI. `deherm dev`
generates when inputs change, type-checks the context projects, bundles the
application, watches source and assets, and coordinates launch and hot reload.
The explicit `deherm generate` command is always available for CI and manual
workflows.

The package is not yet published to npm. Until the first preview release, use
the [source checkout](#working-on-déherm) and the workspace examples below.

## Write a component

Save this as `src/player.script.ts`:

```ts
import { defold, defineComponent, go, property, vmath } from "@deherm/project";

interface Player {
  speed: number;
}

export default defineComponent({
  properties: {
    speed: property.number(180),
  },

  init(): void {
    defold.log("info", "TypeScript is running in Defold");
  },

  update(self: Player, dt: number): void {
    const position = go.getPosition();
    go.setPosition(vmath.vector3(position.x + self.speed * dt, position.y, position.z));
  },
});
```

Generation creates `/src/player.script`, which is the proxy attached to a game
object in Defold. The proxy binds the engine instance to the TypeScript
component and projects its declared properties into the editor.

## How it runs

| Target | Application code | Engine bridge | Why |
| --- | --- | --- | --- |
| Native development | Hermes bytecode | generated JSI/Lua adapters | fast iteration and reload without relinking |
| Native release | Static Hermes typed subset or dynamic profile | generated direct C ABI plus bounded fallbacks | native code where the reachable shape supports it |
| HTML5 | bundled browser JavaScript | generated Wasm memory/host adapters | use the browser VM; do not ship a second JS engine |

The policy for a Defold revision carries facts derived from that revision. The
npm package carries version-independent parsers, recipes, emitters, and runtime
code. `deherm generate` combines them locally with the extensions in the user's
project. A new Defold release therefore does not require a new npm release
unless it introduces a genuinely new language or ABI shape the installed
compiler cannot represent.

Generated files are owned by the generator. Configure their inputs and rerun
generation instead of editing the output by hand. Generation is keyed and
idempotent: unchanged inputs reuse the existing materialization; `deherm
verify-generated` performs the explicit integrity check.

## The generated API

The generator reads Defold's Script API declarations, Lua registration and
adapter source, public dmSDK headers and implementations, project configuration,
and each resolved extension's `.script_api` or public C header. It normalizes
those inputs into one typed IR and emits declarations, runtime routes, exact-call
twins, context projects, and verification fixtures from that same source.

The public surface is not reduced merely because a route lacks a heavyweight
live-engine observation. Every discoverable API remains visible. Generated
exact-call tests verify symbol names, signatures, argument order, result shape,
and fail-closed routing; deeper runtime observations are tracked separately so
generation evidence is never misrepresented as engine-behavior evidence.

Inspect a project with:

```sh
pnpm exec deherm doctor
pnpm exec deherm extensions
pnpm exec deherm typecheck
pnpm exec deherm verify-generated
```

Inspect a module before adopting it, or list modules with recorded target
evidence:

```sh
pnpm exec deherm module report ./path/to/module
pnpm exec deherm module report ./node_modules/some-native-module --target arm64-ios,wasm-web
pnpm exec deherm module report ./node_modules/some-native-module --directory
pnpm exec deherm module list
```

The report recognizes Defold extensions, déherm providers, Expo Modules,
TurboModule specs, Nitro specs, and plain JSI sources. It distinguishes a route
the generator can emit from an independently compile- or runtime-verified
target. Expo/Turbo/Nitro source shapes currently report `adapter-required`;
they are designed to feed the same Defold-owned provider IR rather than import
their original application runtime.

`--directory` refreshes React Native Directory metadata into the platform-native
déherm user cache. That community metadata nominates candidates; exact local
package sources outrank it, and it never becomes compile or runtime proof. The
docs site publishes a much smaller déherm module directory: non-UI native
capabilities with target-by-target generation, compile, or runtime evidence.

## Development tools

The CLI is the control plane:

```sh
pnpm exec deherm dev              # TUI, watcher, compiler, launcher, HMR
pnpm exec deherm dev --engine-config display.vsync=0  # repeat for Defold key=value overrides
pnpm exec deherm debug            # Debug Adapter Protocol server
pnpm exec deherm language-server  # Language Server Protocol server
pnpm exec deherm profile cpu      # standard Hermes .cpuprofile
pnpm exec deherm profile heap     # standard Hermes .heapsnapshot
```

The VS Code extension connects these protocols to breakpoints, evaluation,
resource-aware completion, live instances, property lenses, and standard
profile files that can also be opened in existing browser developer tools.

## Measured boundary cost

Current unprofiled Release microbenchmarks over stub providers measure the
generated transport itself, not Defold engine work:

| Boundary | Median/best | Relative to fastest direct ABI |
| --- | ---: | ---: |
| direct generated C ABI | 3.8 ns best | 1.0× |
| Static Hermes typed-native | 64.6 ns median | 17.0× |
| complete generated Lua crossing | 283.2 ns median | 74.5× |

The protected Lua call in that fixture costs 211.0 ns by itself; déherm owns a
70.9 ns median staging and transport layer around it. These are boundary
measurements, not frame-level game benchmarks. See the
[documentation site](https://ts-defold.dev/deherm/docs/#performance) for the
recorded build, host, ranges, and release package sizes.

## Examples

### War Battles Online

[`examples/war-battles-online`](examples/war-battles-online) is the full-stack
dogfood game: generated script and GUI components, native and HTML5 targets,
Static Hermes reachability, hot reload, bots, 32-player simulation, network
impairment tests, browser playability checks, and WebTransport/QUIC with a
WebSocket fallback.

From a source checkout:

```sh
pnpm install
pnpm --dir examples/war-battles-online play
```

Use `pnpm --dir examples/war-battles-online stack` to launch the local game,
server, and network-bot stack together.

### Defold WebTransport

[`extensions/defold-webtransport`](extensions/defold-webtransport) is a
standalone Defold extension for the wider Defold community. It exposes the same
WebTransport-shaped session, stream, and datagram API to Lua, C/C++, déherm,
native QUIC targets, and browsers. Its README contains installation, API, and
minimal-client documentation.

## Working on déherm

Requirements: Node.js, pnpm, a JDK compatible with Defold's Bob tool, CMake,
Ninja, and a host C/C++ toolchain.

```sh
git clone https://github.com/ts-defold/deherm.git
cd deherm
pnpm install
pnpm bootstrap
pnpm doctor
pnpm check
```

`pnpm bootstrap` materializes the revisions pinned in `upstream.lock` and the
checksum-pinned Bob JAR. Platform artifacts are content-addressed GitHub
Release downloads; contributors can reuse the published artifact for their
host or build it locally when changing the native toolchain.

Repository layout:

- `packages/` — internal source packages composed into `@ts-defold/deherm`.
- `examples/` — private consumers and integration fixtures.
- `extensions/` — independently packaged Defold extensions.
- `editors/vscode/` — VS Code client and language tooling.
- `defold/` — the native Defold/Hermes extension used by the product.
- `.agents/docs/` — architecture decisions, evidence, and maintainer knowledge.

## License and community

déherm is available under the [MIT License](LICENSE).

- [Documentation](https://ts-defold.dev/deherm/docs/)
- [ts-defold](https://ts-defold.dev/)
- [GitHub](https://github.com/ts-defold/deherm)
- [Discord](https://discord.gg/eukcq5m)
