# Reference scene (not built)

`battle.gui` and `battle.gui.ts` are the "ultimate edition" presentation mockup
that used to be the whole example. Every gameplay entity in it is a GUI box node
in screen space. It is retained unchanged as the visual target for a later
presentation phase and is deliberately not referenced by `/main/main.collection`,
so Bob does not compile it into the bundle archive.

The authored TypeScript is still generated and type-checked, so the component
proxy `battle.gui_script` stays in sync with the compiler.
