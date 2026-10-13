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

Use arrow keys or WASD to steer, Space to pause, and R to restart. Eat the red
food sprite; touching a wall or your body ends the run. The three pixel sprites
are reproducible from `node scripts/generate-art.mjs`.

For the independent npm-tarball release proof, the candidate test copies this
example outside the monorepo, installs the candidate `.tgz` in place of the
workspace dependency, and runs the installed CLI. A workspace-only success is
not evidence that the published package can compile this game.
