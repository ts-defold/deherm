# Snake

A small playable Defold game written entirely in TypeScript. A game-object
script runs the rules and creates head, body, and food sprites with Defold
factories. It sends score and game status to a separate GUI HUD through
`msg.post`. This exercises both script and GUI proxies, generated Defold APIs,
typed hash literals, input, policy materialization, and release bundling.

Open this directory (the one with `game.project` and `package.json`) in VS Code.
From the repository workspace:

```sh
pnpm install
cd examples/snake
pnpm generate
pnpm check
pnpm dev
```

Snake plays itself in attract mode until you press an arrow key or WASD. Your
first direction starts a fresh match. Use those keys to steer, Space to pause,
and R to restart. Eat the red food sprite; touching
a wall or your body ends the run. The board and three pixel sprites are
reproducible from `node scripts/generate-art.mjs`.

For the independent npm-tarball release proof, the candidate test copies this
example outside the monorepo, installs the candidate `.tgz` in place of the
workspace dependency, and runs the installed CLI. A workspace-only success is
not evidence that the published package can compile this game.

## Inspect the VS Code tools

Open this project folder, not its parent or `main/`, in VS Code. Install the
déherm VS Code extension and keep `pnpm dev` running. The Defold resource
features come from déherm's language server; ordinary TypeScript features
(type errors, rename, references, and TS API hover) remain with VS Code's
TypeScript service.

| Feature                             | Try this in Snake                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defold resource completion          | In `main/snake.script.ts`, start a string argument to `factory.create` with `"#`; `head_factory`, `body_factory`, and `food_factory` are project-aware choices.                                                                                                                                                                          |
| Resource hover and Go to Definition | Hover or F12 on `"#head_factory"`; it resolves to the factory declaration in `main/controller.go`. In `main/hud.gui.ts`, `gui.getNode("score")` resolves to the node in `main/snake.gui`.                                                                                                                                                |
| Project message IDs                 | Hover the `"snake_state"` argument of `msg.post` in `main/snake.script.ts`; completion uses the messages found in this project.                                                                                                                                                                                                          |
| Editor-property default             | The `tickSeconds: property.number(0.13)` declaration in `main/snake.script.ts` shows `= 0.13` inline. This is the source default, not the editor override.                                                                                                                                                                               |
| Live component values               | `main/main.collection` overrides `tickSeconds` to `0.2` for the controller instance. With the game running, the CodeLens at the top of `main/snake.script.ts` should show `tickSeconds=0.2`; hover the inline default hint for the live value and instance identity. These disappear if the engine disconnects or the snapshot ages out. |
| Debugging                           | Set a breakpoint in `update` or `onInput`, then run **déherm: Attach to running game**. Arrow keys or WASD reach `onInput`. The Variables pane shows authored arguments, active locals, module bindings, `this`, and globals when available; hover and Watch evaluate the paused Hermes frame.                                           |
| Profiling                           | Use the Command Palette actions **déherm: Capture Hermes CPU Profile** and **déherm: Capture Hermes Heap Snapshot** while the dev game is running.                                                                                                                                                                                       |

The live lens is at the top of the source file, not beside every statement.
It requires a current runtime snapshot; static type information alone cannot
show an instance's editor-overridden value. If the authored file changes before
the running bundle catches up, breakpoints become unverified and the Debug
Console explains why source-derived local scopes are temporarily unavailable.
