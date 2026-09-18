import {
  builtins,
  factory,
  go,
  msg,
  vmath,
  type DefoldHash,
  type Vector3,
} from "@ts-defold/deherm";
import { defineComponent } from "@ts-defold/deherm/component";

interface InputAction {
  readonly pressed?: boolean;
  readonly released?: boolean;
}

interface PlayerSelf {
  direction: Vector3;
  speed: number;
}

const UP = builtins.hash("up");
const DOWN = builtins.hash("down");
const LEFT = builtins.hash("left");
const RIGHT = builtins.hash("right");
const FIRE = builtins.hash("fire");

function scaledAdd(position: Vector3, direction: Vector3, scale: number): Vector3 {
  return vmath.vector3(
    position.x + direction.x * scale,
    position.y + direction.y * scale,
    position.z + direction.z * scale,
  );
}

export default defineComponent({
  init(self: PlayerSelf): void {
    self.direction = vmath.vector3();
    self.speed = 200;
    msg.post(".", "acquire_input_focus");
  },

  final(_self: PlayerSelf): void {
    msg.post(".", "release_input_focus");
  },

  update(self: PlayerSelf, dt: number): void {
    if (vmath.length(self.direction) === 0) return;
    const direction = vmath.normalize(self.direction);
    go.setPosition(scaledAdd(go.getPosition(), direction, self.speed * dt));
    go.setRotation(vmath.quatRotationZ(Math.atan2(direction.y, direction.x)));
  },

  onInput(self: PlayerSelf, actionId: DefoldHash, action: InputAction): boolean {
    const amount = action.released ? 0 : action.pressed ? 1 : undefined;
    if (amount === undefined) return false;
    if (actionId === UP) self.direction = vmath.vector3(self.direction.x, amount, 0);
    else if (actionId === DOWN) self.direction = vmath.vector3(self.direction.x, -amount, 0);
    else if (actionId === LEFT) self.direction = vmath.vector3(-amount, self.direction.y, 0);
    else if (actionId === RIGHT) self.direction = vmath.vector3(amount, self.direction.y, 0);
    else if (actionId === FIRE && action.pressed) {
      const direction = vmath.normalize(self.direction);
      factory.create("#rocketfactory", go.getPosition(), undefined, new Map([["dir", direction]]));
    }
    return true;
  },
});
