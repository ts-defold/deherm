import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { createVirtualControls, updateVirtualControls } from "../core/virtual-controls.ts";

const touch = (id, screenX, screenY, pressed = false, released = false) => ({
  id,
  screenX,
  screenY,
  x: screenX,
  y: screenY,
  pressed,
  released,
});

test("touch falls back to Defold canvas x/y when screen coordinates are omitted", () => {
  const controls = createVirtualControls();
  updateVirtualControls(controls, [{ id: 1, pressed: true, released: false, x: 950, y: 210 }], 1205);
  assert.equal(controls.aimId, 1);
  assert.equal(controls.fire, true);
});

test("two thumbs independently drive, boost, aim, fire, and release", () => {
  const controls = createVirtualControls();
  updateVirtualControls(controls, [touch(4, 180, 220, true), touch(9, 1100, 220, true)], 1280);
  assert.equal(controls.fire, true);
  assert.equal(controls.moveX, 0);
  assert.equal(controls.hasAim, false);

  updateVirtualControls(controls, [touch(4, 225, 235), touch(9, 1030, 280)], 1280);
  assert.deepEqual([controls.moveX, controls.moveY, controls.boost], [1, 1, false]);
  assert.deepEqual([controls.aimX, controls.aimY, controls.hasAim, controls.fire], [-70, 60, true, true]);

  updateVirtualControls(controls, [touch(4, 300, 220)], 1280);
  assert.equal(controls.boost, true);
  updateVirtualControls(controls, [touch(4, 300, 220, false, true)], 1280);
  assert.deepEqual([controls.moveId, controls.moveX, controls.moveY, controls.boost], [-1, 0, 0, false]);
  assert.equal(controls.fire, true, "lifting the steering thumb does not release the gun");
  updateVirtualControls(controls, [touch(9, 1030, 280, false, true)], 1280);
  assert.deepEqual([controls.aimId, controls.hasAim, controls.fire], [-1, false, false]);
});

test("the Defold project binds multi-touch separately from mouse deploy", () => {
  const binding = readFileSync(resolve(import.meta.dirname, "../defold/input/game.input_binding"), "utf8");
  assert.match(binding, /touch_trigger\s*\{\s*input: TOUCH_MULTI\s*action: "touch_multi"\s*\}/u);
  assert.match(binding, /mouse_trigger\s*\{\s*input: MOUSE_BUTTON_1\s*action: "deploy"\s*\}/u);
});
