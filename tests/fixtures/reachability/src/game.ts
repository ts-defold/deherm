// A fixture "game": a handful of real Defold routes, reached the way game code
// reaches them — directly, through an alias, and through a nested Lua module.
import { go, gui, msg, vmath } from "@ts-defold/deherm";

const position = vmath;

export function init(): void {
  const node = gui.getNode("root");
  gui.setColor(node, vmath.vector4(1, 0, 0, 1));
  go.setPosition(position.vector3(1, 2, 3));
  msg.post("#collectionproxy", "load");
}

export function update(): void {
  const current = go.getPosition();
  go.setPosition(vmath.vector3(current.x + 1, current.y, current.z));
}
