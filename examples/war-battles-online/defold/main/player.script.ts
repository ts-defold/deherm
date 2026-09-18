import {
  defineComponent,
  factory,
  go,
  hashLiteral,
  msg,
  property,
  vmath,
  type DefoldHash,
  type OnInputAction,
  type Vector3,
} from "@deherm/project";

declare const __defoldHostV1: {
  log(level: "info", message: string): void;
};

const UP = hashLiteral("#up");
const DOWN = hashLiteral("#down");
const LEFT = hashLiteral("#left");
const RIGHT = hashLiteral("#right");
const FIRE = hashLiteral("#fire");

/**
 * The supplied infantry art faces screen-down, while `quat_rotation_z` treats
 * +x as zero. Rotating the authored facing onto the travel direction keeps the
 * tutorial's single `go.set_rotation` call and its exact API demand.
 */
const ART_FACING_OFFSET = Math.PI / 2;
const SPEED = 180;

interface PlayerSelf {
  /** Editor property: seconds before the scripted demonstration shot, 0 disables it. */
  demo: number;
  direction: Vector3;
  aim: Vector3;
  speed: number;
  elapsed: number;
  demoFired: boolean;
  demoMove: number;
}

function step(self: PlayerSelf, dt: number): void {
  const direction = vmath.normalize(self.direction);
  self.aim = direction;
  const position = go.getPosition();
  go.setPosition(vmath.vector3(
    position.x + direction.x * self.speed * dt,
    position.y + direction.y * self.speed * dt,
    position.z,
  ));
  go.setRotation(vmath.quatRotationZ(Math.atan2(direction.y, direction.x) + ART_FACING_OFFSET));
}

function fire(self: PlayerSelf): void {
  const position = go.getPosition();
  factory.create("#rocketfactory", position, undefined, new Map<string, unknown>([["dir", self.aim]]));
  __defoldHostV1.log(
    "info",
    `war-battles:player-fire:${position.x.toFixed(1)}:${position.y.toFixed(1)}:${self.aim.x.toFixed(2)}:${self.aim.y.toFixed(2)}`,
  );
}

export default defineComponent({
  properties: {
    demo: property.number(0),
  },

  init(self: PlayerSelf): void {
    self.direction = vmath.vector3(0, 0, 0);
    self.aim = vmath.vector3(1, 0, 0);
    self.speed = SPEED;
    self.elapsed = 0;
    self.demoFired = false;
    self.demoMove = 0;
    msg.post(".", "acquire_input_focus");
    const position = go.getPosition();
    __defoldHostV1.log("info", `war-battles:player-init:${position.x.toFixed(1)}:${position.y.toFixed(1)}`);
  },

  final(_self: PlayerSelf): void {
    msg.post(".", "release_input_focus");
  },

  update(self: PlayerSelf, dt: number): void {
    self.elapsed += dt;
    if (self.demo > 0 && !self.demoFired && self.elapsed >= self.demo) {
      self.demoFired = true;
      self.demoMove = 1;
      self.direction = vmath.vector3(1, 0, 0);
      self.aim = vmath.vector3(1, 0, 0);
      fire(self);
    }
    if (self.demoMove > 0) {
      self.demoMove -= dt;
      if (self.demoMove <= 0) {
        self.direction = vmath.vector3(0, 0, 0);
        const position = go.getPosition();
        __defoldHostV1.log("info", `war-battles:player-moved:${position.x.toFixed(1)}:${position.y.toFixed(1)}`);
      }
    }
    if (vmath.length(self.direction) === 0) return;
    step(self, dt);
  },

  onInput(self: PlayerSelf, actionId: DefoldHash, action: OnInputAction): boolean {
    if (actionId === FIRE) {
      if (action.pressed) fire(self);
      return true;
    }
    const amount = action.released ? 0 : action.pressed ? 1 : undefined;
    if (amount === undefined) return false;
    if (actionId === UP) self.direction = vmath.vector3(self.direction.x, amount, 0);
    else if (actionId === DOWN) self.direction = vmath.vector3(self.direction.x, -amount, 0);
    else if (actionId === LEFT) self.direction = vmath.vector3(-amount, self.direction.y, 0);
    else if (actionId === RIGHT) self.direction = vmath.vector3(amount, self.direction.y, 0);
    else return false;
    self.demoMove = 0;
    return true;
  },
});
