---
okf_version: "0.2"
title: "Active implementation handoff"
type: reference
status: "active"
tags: [handoff, api, compiler, hmr, telemetry, war-battles]
---

# Active implementation handoff

Use this prompt verbatim to continue the current task:

> Continue the active déherm implementation in `/Users/mini/Documents/defold-hermes` on `main`. Read `/Users/mini/Documents/defold-hermes/AGENTS.md`, then this handoff and the canonical `.agents/docs` index. Do not discard, reset, or overwrite the dirty tree: nearly all changes are intentional agent work, while the deletion of the two old Scandinavian logo PNGs is an intentional user edit. The active goal is still to finish the deterministic generator/compiler and prove the whole Defold script API plus dmSDK across Dynamic Hermes, Static Hermes, Lua, and browser/Wasm, then use it in the playable War Battles port. Generated files must only change through their generators.
>
> First inspect the two active subagents with `collaboration.list_agents`: `/root/defold_public_namespace` is replacing the leaked public `builtins` name with generator-owned `defold`; `/root/war_tutorial_assets` is wiring the real Defold tutorial art, animation atlases, anchors, metadata, and tint/material effects under the required pixel-art-atlas workflow. Wait for and integrate their results; do not duplicate or conflict with their files.
>
> The just-finished contextual hash work is in `packages/compiler/ttsc/hash-literal/hash_literal.go` and `packages/sdk/src/address.ts`. Authored `const FIRE: DefoldHash = "#fire"`, DefoldHash-typed arguments, optional values, object fields, arrays, tuples, assignments, and returns now lower to exact unsigned bigint constants. Ambiguous `string | DefoldHash` contexts and address strings remain strings. `pnpm test:hash-literal` passes 6/6, including pinned native Defold ASCII/Unicode vectors, real ttsc emit, War bundling, Hermes bytecode, and strict Static Hermes. Preserve this fail-closed contextual behavior.
>
> The TUI/dev loop was corrected in `packages/cli/src/dev/{session,tui,defold-builder}.mjs`: `q` really tears down engine/watcher/compiler/server and is now labeled `quit`; `p` relaunches an already-ready build without rerunning Bob; logs use arrows for lines, Ctrl-U/Ctrl-D for pages, `f` to follow, with PageUp/PageDown/Home/End as aliases; every event is mirrored to `.deherm/dev/session.log`; Extender exceptions such as `r8Cmd` are surfaced. The Rezi/dev-session tests pass 16/16 and the installed-loop expectations were updated, but rerun `node --test tests/installed-dev-loop.test.mjs` after namespace integration.
>
> Runtime HMR acknowledgement and telemetry are implemented but still need a fresh packaged-engine observation. Native runtime now emits `DEHERM_EVENT bundle-activated` only after atomic commit and emits 1 Hz telemetry for engine dt, Hermes heap/peak/size, callback roots, component instances, Lua handles/capacity, and arena high-water. CLI parsing/model/TUI display exist; native runtime libraries compile. Do not claim live HMR or telemetry until a fresh War Battles process shows matching fingerprint activation plus non-placeholder metrics.
>
> The last Bob failure was not TypeScript: `examples/war-battles-online/defold/build/arm64-osx/log.txt` reports the running local Extender could not find `PlatformConfig.r8Cmd`. The pinned Extender source at `2a17252f657056c7705c584617c601a97c3c6a20` does contain `r8Cmd`, so the likely cause is a stale `upstream/extender/server/app/extender.jar`/service. Rebuild and restart with `pnpm extender:prepare`, `pnpm extender:stop`, `pnpm extender:start`, and `pnpm extender:status`; then run a fresh TUI process so Node also sees the now-exported `@ts-defold/deherm/ttsc` subpath. Verify the extension build, launch, fingerprint activation, telemetry, source-edit HMR, external-close then `p` direct relaunch, and clean `q` shutdown. Preserve the full transcript in repository-confined evidence.
>
> The dmSDK clean-room cycle was fixed by splitting the pure `dmsdk-universal-materializer-core.mjs` from the generated-catalog wrapper. `pnpm check:dmsdk-clean-room` currently passes all 100 owned artifacts, and `pnpm check:extension-syntax` passes 58 native/55 HTML5 translation units. Re-run the complete generator checks after subagents finish; do not run broad regeneration while their generator edits are in flight.
>
> Next integration order: (1) collect both subagents; (2) regenerate only through canonical scripts; (3) run `pnpm check`, focused native/Static/browser tests, package smoke, and clean-room gates; (4) rebuild/restart matching local Extender; (5) run War Battles and prove bundle activation + telemetry + HMR + relaunch; (6) inspect all real tutorial sprite animations/tints in engine; (7) run the Claude adversarial-review skill once on the substantial integrated wave, independently reproduce every claim before acting; (8) make atomic commits and push to the `ts-defold` remote. Update this handoff and `.agents/docs/log.md` with honest evidence boundaries.

## Last verified commands

```text
pnpm test:hash-literal                                      # 6/6
node --test tests/dev-tui.test.mjs tests/dev-session.test.mjs # 16/16
pnpm check:dmsdk-clean-room                                # 100 byte-identical artifacts
pnpm check:extension-syntax                                # 58 native, 55 HTML5
cmake --build build/native --target defold-hermes-runtime defold-hermes-component-runtime --parallel
```

No live packaged War Battles telemetry/HMR claim has yet been made for this final wave.
