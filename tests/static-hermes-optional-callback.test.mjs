import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { staticExactArgumentShapes } from "../packages/compiler/src/script-static-exact-verification.mjs";

const root = path.resolve(import.meta.dirname, "..");
const plan = JSON.parse(await readFile(
  path.join(root, "packages/bindings/generated/defold-binding-lowering-plan.json"), "utf8"));
const projection = JSON.parse(await readFile(
  path.join(root, "packages/bindings/generated/defold-script-projection-ir.json"), "utf8"));
const recording = JSON.parse(await readFile(
  path.join(root, "packages/bindings/generated/defold-script-recording-engine.json"), "utf8"));
const typedNative = await readFile(
  path.join(root, "packages/static-hermes/src/generated/script-typed-native-bridge.ts"), "utf8");

test("sound.play Static Hermes route is exact at omitted callback arity", () => {
  const unit = plan.units.find(({ identity }) => identity.id === "script:sound.play");
  assert.equal(unit.backends.staticHermesCAbi.selection, "emit");
  assert.deepEqual(unit.backends.staticHermesCAbi.blockerSet, 0);

  const route = recording.routes.find(({ id }) => id === "script:sound.play");
  assert.equal(route.arity.minimum, 1);
  assert.equal(route.arity.maximum, 3);
  assert.deepEqual(staticExactArgumentShapes(recording, route), [route.argumentShapes[0]]);

  const source = projection.rows.find(({ id }) => id === "script:sound.play").signature;
  assert.equal(source.parameters[2].optional, true);
});

test("present callbacks decline before Static dispatch and fail closed without JSI", () => {
  const decline = typedNative.indexOf(
    "if (__dehermTypedNativeDeclined) return __dehermDeclineToJsi(stableId, args);");
  const dispatch = typedNative.indexOf(
    "const results: Array<DehermStaticValue> = dispatchScriptUniversalValue(stableId, values);");
  assert.ok(decline >= 0 && decline < dispatch,
    "a function argument must decline before any Static frame dispatch");
  assert.match(typedNative, /typeof __dehermJsiBridge\.call !== "function"/u);
  assert.match(typedNative, /JSI bridge unavailable/u);
});
