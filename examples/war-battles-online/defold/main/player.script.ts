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
 * The camera follows a reported position rather than sampling this object.
 * `go.get_position(id)` is declared but not implemented for the addressed call
 * shapes, so the world-space hand-off is a message the camera consumes.
 */
const CAMERA = "/camera#follow";

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
  /** Editor property: extra seconds of scripted travel after the shot, 0 disables it. */
  tour: number;
  /** Editor properties: the world rectangle the player is held inside, in pixels. */
  worldMinX: number;
  worldMinY: number;
  worldMaxX: number;
  worldMaxY: number;
  direction: Vector3;
  aim: Vector3;
  speed: number;
  elapsed: number;
  demoFired: boolean;
  demoMove: number;
  demoTurn: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) return value;
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function step(self: PlayerSelf, dt: number): void {
  const direction = vmath.normalize(self.direction);
  self.aim = direction;
  const position = go.getPosition();
  // The world is larger than one screen, so travel is bounded by the same
  // rectangle the camera clamps against rather than by the screen edge.
  go.setPosition(vmath.vector3(
    clamp(position.x + direction.x * self.speed * dt, self.worldMinX, self.worldMaxX),
    clamp(position.y + direction.y * self.speed * dt, self.worldMinY, self.worldMaxY),
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
    tour: property.number(0),
    worldMinX: property.number(0),
    worldMinY: property.number(0),
    worldMaxX: property.number(0),
    worldMaxY: property.number(0),
  },

  init(self: PlayerSelf): void {
    self.direction = vmath.vector3(0, 0, 0);
    self.aim = vmath.vector3(1, 0, 0);
    self.speed = SPEED;
    self.elapsed = 0;
    self.demoFired = false;
    self.demoMove = 0;
    self.demoTurn = 0;
    msg.post(".", "acquire_input_focus");
    const position = go.getPosition();
    __defoldHostV1.log("info", `war-battles:player-init:${position.x.toFixed(1)}:${position.y.toFixed(1)}`);
  },

  final(_self: PlayerSelf): void {
    // A structured call from `final` binds against the captured Lua script
    // instance, which the extension must still hold at collection teardown.
    // The marker is emitted after the call returns, so observing it is the
    // only positive evidence that component teardown ran: neither SIGTERM nor
    // SIGINT reaches `final`, so it takes a graceful `@system/exit` to get
    // here. See `integration/check-graceful-shutdown.mjs`.
    msg.post(".", "release_input_focus");
    __defoldHostV1.log("info", "war-battles:player-final");
  },

  update(self: PlayerSelf, dt: number): void {
    self.elapsed += dt;
    const start = go.getPosition();
    msg.post(CAMERA, "player_at", { x: start.x, y: start.y });
    if (self.demo > 0 && !self.demoFired && self.elapsed >= self.demo) {
      self.demoFired = true;
      // One second reproduces the original demonstration shot; the tour keeps
      // walking afterwards so the enlarged world visibly scrolls on launch.
      self.demoMove = 1 + self.tour;
      // The tour turns north half way through so a launch scrolls the world on
      // both axes and reaches two different world edges.
      self.demoTurn = 1 + self.tour * 0.5;
      self.direction = vmath.vector3(1, 0, 0);
      self.aim = vmath.vector3(1, 0, 0);
      fire(self);
    }
    if (self.demoTurn > 0) {
      self.demoTurn -= dt;
      if (self.demoTurn <= 0) self.direction = vmath.vector3(0, 1, 0);
    }
    if (self.demoMove > 0) {
      self.demoMove -= dt;
      if (self.demoMove <= 0) {
        self.direction = vmath.vector3(0, 0, 0);
        self.demoTurn = 0;
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
    self.demoTurn = 0;
    return true;
  },
});
