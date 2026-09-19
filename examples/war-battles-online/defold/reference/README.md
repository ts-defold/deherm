# Reference scene (not built)

`battle.gui` and `battle.gui.ts` are the presentation mockup that used to be the
whole example: every gameplay entity is a GUI box node in screen space, all 32
tanks, their turrets, a 160-node projectile pool, the HUD and the upgrade keys.

It is retained unchanged in shape, and deliberately not referenced by
`/main/main.collection`, so Bob does not compile it into the bundle archive. The
built scene now renders the same simulation as real Defold game objects, so this
is no longer the visual target; what it still is, is the one place in this
project that exercises the wider GUI route set - `gui.set_size`, `gui.set_color`,
`gui.set_euler`, `gui.set_texture`, `gui.play_flipbook`, `gui.set_enabled` -
against the compiler. The built scene deliberately restricts itself to
`gui.get_node` and `gui.set_text`, the two GUI routes with a packaged-engine
observation behind them.

The authored TypeScript is still generated and type-checked, so the component
proxy `battle.gui_script` stays in sync with the compiler, and it is the entry
point `headless/measure-bundles.mjs` measures as the diagnostic Defold bundle.

Two things were updated when the simulation grew: it now asks `PlayableBattle`
for a full 32-tank, two-team roster explicitly rather than relying on a default
that is now eight, and it reads each tank's hull direction rather than its aim
direction, because those became two different things when the turret did.
