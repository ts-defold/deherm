# Capability-gated Defold project skeleton

This directory is a structurally valid Defold project with an authored
`src/controller.script.ts` component and its generated `.script` proxy. The
TypeScript component consumes the deterministic `BattleWorld`, fixed-tick input
schema, and transport-selection state machine.

It intentionally fails closed. The checked capability snapshot consumes two
independent gates:

- this example's generated manifest:
  `proxyRuntimeCapability.state = native-provider-executable` and
  `runtimeConformant = true`;
- `.agents/docs/data/war-battles-runtime-gate.json`:
  generated routes are `ready`, but `gameplayExecutionObserved = false`.

The executable proxy-provider contract is necessary but does not supersede the
negative packaged-engine gameplay evidence. The project therefore is not
described as playable or packageable yet. Regenerate the proxy rather than
editing it:

```sh
node scripts/generate-component-proxies.mjs \
  --project examples/war-battles-online/defold
node examples/war-battles-online/integration/generate-capability-snapshot.mjs
```

Local compiler/TUI diagnostic commands from the repository root are:

```sh
node examples/war-battles-online/integration/sync-defold-sources.mjs
node bin/deherm.mjs generate --project examples/war-battles-online/defold
node bin/deherm.mjs typecheck --project examples/war-battles-online/defold
node bin/deherm.mjs dev \
  --project examples/war-battles-online/defold \
  --entry examples/war-battles-online/defold/src/controller.script.ts \
  --watch examples/war-battles-online/defold/src \
  --once --headless --no-ttsc
```

The second command proves only the local compile/control plane unless a real
Defold target is also supplied and acknowledges the generated resource.

Observed on 2026-09-18: `generate` succeeds and the following Deherm
`typecheck` reports all four generated TypeScript contexts—shared, game-object,
GUI, and render—as passing. This is compiler evidence only. The `dev` command is
listed for the later engine-attached phase and is not claimed as an executed
gameplay run.
