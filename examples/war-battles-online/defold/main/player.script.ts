import {
  defold,
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

import { arenaMatch, directionRadians, pixelX, pixelY } from "../src/arena-match";
import {
  PLAYER_MODE_DEAD,
  PLAYER_MODE_INFANTRY,
  PLAYER_MODE_TANK,
  chassisById,
} from "../src/generated-war-battles/index";

const UP = hashLiteral("#up");
const DOWN = hashLiteral("#down");
const LEFT = hashLiteral("#left");
const RIGHT = hashLiteral("#right");
const FIRE = hashLiteral("#fire");
const BOOST = hashLiteral("#boost");
const WEAPON_1 = hashLiteral("#weapon1");
const WEAPON_2 = hashLiteral("#weapon2");
const WEAPON_3 = hashLiteral("#weapon3");
const WEAPON_4 = hashLiteral("#weapon4");
const WEAPON_5 = hashLiteral("#weapon5");
const WEAPON_6 = hashLiteral("#weapon6");
const CHASSIS_1 = hashLiteral("#chassis1");
const CHASSIS_2 = hashLiteral("#chassis2");
const CHASSIS_3 = hashLiteral("#chassis3");
const CHASSIS_4 = hashLiteral("#chassis4");
const UPGRADE_1 = hashLiteral("#upgrade1");
const UPGRADE_2 = hashLiteral("#upgrade2");
const RESTART = hashLiteral("#restart");
const DEPLOY = hashLiteral("#deploy");
const UI = "/gui#ui";

/**
 * The camera follows a reported position rather than sampling this object.
 * `go.get_position(id)` is declared but not implemented for the addressed call
 * shapes, so the world-space hand-off is a message the camera consumes.
 */
const CAMERA = "/camera#follow";
/** The arena director, which owns the match and every factory in the scene. */
const ARENA = "/arena#arena";

/**
 * The tank hull sprite points +x at rotation zero, which is what
 * `quat_rotation_z` treats as its own zero, so no authored facing offset is
 * needed. (The tutorial's infantry art faced screen-down and did need one.)
 */
const ART_FACING_OFFSET = 0;
const CHASSIS_ANIMATIONS: readonly DefoldHash[] = [
  hashLiteral("#chassis-blue-scout"),
  hashLiteral("#chassis-blue-assault"),
  hashLiteral("#chassis-blue-bulwark"),
  hashLiteral("#chassis-blue-artillery"),
];
const WRECK_ANIMATION = hashLiteral("#tank-blue-wreck");
const HERO_ANIMATION = hashLiteral("#player-down");
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

  /** True once the arena has taken over from the scripted demonstration. */
  engaged: boolean;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  firing: boolean;
  boosting: boolean;
  weapon: number;
  z: number;
  chassis: number;
  mode: number;
}

function isMappedPlayerAction(actionId: DefoldHash): boolean {
  return (
    actionId === UP ||
    actionId === DOWN ||
    actionId === LEFT ||
    actionId === RIGHT ||
    actionId === FIRE ||
    actionId === BOOST ||
    actionId === DEPLOY ||
    actionId === RESTART ||
    actionId === WEAPON_1 ||
    actionId === WEAPON_2 ||
    actionId === WEAPON_3 ||
    actionId === WEAPON_4 ||
    actionId === WEAPON_5 ||
    actionId === WEAPON_6 ||
    actionId === CHASSIS_1 ||
    actionId === CHASSIS_2 ||
    actionId === CHASSIS_3 ||
    actionId === CHASSIS_4 ||
    actionId === UPGRADE_1 ||
    actionId === UPGRADE_2
  );
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
  go.setPosition(
    vmath.vector3(
      clamp(position.x + direction.x * self.speed * dt, self.worldMinX, self.worldMaxX),
      clamp(position.y + direction.y * self.speed * dt, self.worldMinY, self.worldMaxY),
      position.z,
    ),
  );
  go.setRotation(vmath.quatRotationZ(Math.atan2(direction.y, direction.x) + ART_FACING_OFFSET));
}

function fire(self: PlayerSelf): void {
  const position = go.getPosition();
  factory.create("#rocketfactory", position, undefined, new Map<string, unknown>([["dir", self.aim]]));
  defold.log(
    "info",
    `war-battles:player-fire:${position.x.toFixed(1)}:${position.y.toFixed(1)}:${self.aim.x.toFixed(2)}:${self.aim.y.toFixed(2)}`,
  );
}

/** Hands control to the arena. Idempotent; the director ignores a repeat. */
function engage(self: PlayerSelf): void {
  if (self.engaged) return;
  self.engaged = true;
  self.demoMove = 0;
  self.demoTurn = 0;
  self.direction = vmath.vector3(0, 0, 0);
  msg.post(ARENA, "engage");
}

function pushControls(self: PlayerSelf): void {
  const match = arenaMatch();
  if (match === undefined) return;
  const moveX = (self.right ? 1 : 0) - (self.left ? 1 : 0);
  const moveY = (self.up ? 1 : 0) - (self.down ? 1 : 0);
  match.setControls(moveX, moveY, self.firing, self.boosting, self.weapon);
  self.weapon = 0;
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
    self.engaged = false;
    self.up = false;
    self.down = false;
    self.left = false;
    self.right = false;
    self.firing = false;
    self.boosting = false;
    self.weapon = 0;
    msg.post(".", "acquire_input_focus");
    const position = go.getPosition();
    self.z = position.z;
    self.chassis = 0;
    self.mode = -1;
    msg.post("#hero", "disable");
    defold.log("info", `war-battles:player-init:${position.x.toFixed(1)}:${position.y.toFixed(1)}`);
  },

  final(_self: PlayerSelf): void {
    // A structured call from `final` binds against the captured Lua script
    // instance, which the extension must still hold at collection teardown.
    // The marker is emitted after the call returns, so observing it is the
    // only positive evidence that component teardown ran: neither SIGTERM nor
    // SIGINT reaches `final`, so it takes a graceful `@system/exit` to get
    // here. See `integration/check-graceful-shutdown.mjs`.
    msg.post(".", "release_input_focus");
    defold.log("info", "war-battles:player-final");
  },

  update(self: PlayerSelf, dt: number): void {
    self.elapsed += dt;

    if (self.engaged) {
      pushControls(self);
      const match = arenaMatch();
      const world = match?.world;
      const slot = match === undefined ? -1 : match.localSlot;
      if (world === undefined || slot < 0) return;
      const chassis = world.playerChassis[slot]!;
      const chassisChanged = chassis !== self.chassis;
      if (chassisChanged) {
        self.chassis = chassis;
      }
      const mode = world.playerMode[slot]!;
      const modeChanged = mode !== self.mode;
      if (modeChanged) {
        self.mode = mode;
        if (mode === PLAYER_MODE_INFANTRY) {
          msg.post("#sprite", "disable");
          msg.post("#hero", "enable");
          msg.post("#hero", "play_animation", { id: HERO_ANIMATION });
        } else {
          msg.post("#hero", "disable");
          msg.post("#sprite", "enable");
          msg.post("#sprite", "play_animation", {
            id: mode === PLAYER_MODE_DEAD ? WRECK_ANIMATION : CHASSIS_ANIMATIONS[chassisById(chassis).id - 1]!,
          });
        }
      } else if (mode === PLAYER_MODE_TANK && chassisChanged) {
        msg.post("#sprite", "play_animation", { id: CHASSIS_ANIMATIONS[chassisById(chassis).id - 1]! });
      }
      const x = pixelX(world.playerX[slot]!);
      const y = pixelY(world.playerY[slot]!);
      go.setPosition(vmath.vector3(x, y, self.z));
      const facing = directionRadians(world.playerHullX[slot]!, world.playerHullY[slot]!);
      go.setRotation(vmath.quatRotationZ(facing + (mode === PLAYER_MODE_INFANTRY ? Math.PI / 2 : 0)));
      msg.post(CAMERA, "player_at", { x, y });
      return;
    }

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
        defold.log("info", `war-battles:player-moved:${position.x.toFixed(1)}:${position.y.toFixed(1)}`);
        // The demonstration is over; the match starts on its own so an idle
        // launch still ends up in a playable arena.
        engage(self);
        return;
      }
    }
    if (vmath.length(self.direction) === 0) return;
    step(self, dt);
  },

  onInput(self: PlayerSelf, actionId: DefoldHash, action: OnInputAction): boolean {
    // The scripted tutorial may already be running behind the title. Only a
    // real player press dismisses that title, so launch evidence and an idle
    // attract loop do not impersonate user intent.
    if (action.pressed && isMappedPlayerAction(actionId)) {
      defold.log("info", `war-battles:user-input:${defold.hashToHex(actionId)}`);
      msg.post(UI, "deploy");
    }
    if (actionId === DEPLOY) return action.pressed === true;
    if (actionId === RESTART) {
      if (action.pressed) {
        engage(self);
        msg.post(ARENA, "restart");
      }
      return true;
    }
    // Any input at all takes the match off the scripted demonstration.
    if (actionId === FIRE) {
      // Pressing fire during the demonstration starts the match rather than
      // firing one more scripted rocket; the same press then arms the tank, so
      // holding the key through the transition keeps shooting.
      engage(self);
      if (action.pressed) self.firing = true;
      else if (action.released) self.firing = false;
      return true;
    }
    if (actionId === BOOST) {
      if (action.pressed) self.boosting = true;
      else if (action.released) self.boosting = false;
      engage(self);
      return true;
    }
    const weapon =
      actionId === WEAPON_1
        ? 1
        : actionId === WEAPON_2
          ? 2
          : actionId === WEAPON_3
            ? 3
            : actionId === WEAPON_4
              ? 4
              : actionId === WEAPON_5
                ? 5
                : actionId === WEAPON_6
                  ? 6
                  : 0;
    if (weapon !== 0) {
      if (action.pressed) self.weapon = weapon;
      engage(self);
      return true;
    }
    const chassis =
      actionId === CHASSIS_1
        ? 1
        : actionId === CHASSIS_2
          ? 2
          : actionId === CHASSIS_3
            ? 3
            : actionId === CHASSIS_4
              ? 4
              : 0;
    if (chassis !== 0) {
      if (action.pressed) arenaMatch()?.selectChassis(chassis);
      engage(self);
      return true;
    }
    if (actionId === UPGRADE_1 || actionId === UPGRADE_2) {
      if (action.pressed) arenaMatch()?.selectCurrentWeaponBranch(actionId === UPGRADE_1 ? 1 : 2);
      engage(self);
      return true;
    }
    const held = action.released ? false : action.pressed ? true : undefined;
    if (held === undefined) return false;
    if (actionId === UP) self.up = held;
    else if (actionId === DOWN) self.down = held;
    else if (actionId === LEFT) self.left = held;
    else if (actionId === RIGHT) self.right = held;
    else return false;
    if (!self.engaged) {
      // Before the arena starts, the keys still drive the scripted mover, which
      // is what the tutorial did and what the evidence path exercises.
      const amount = held ? 1 : 0;
      if (actionId === UP) self.direction = vmath.vector3(self.direction.x, amount, 0);
      else if (actionId === DOWN) self.direction = vmath.vector3(self.direction.x, -amount, 0);
      else if (actionId === LEFT) self.direction = vmath.vector3(-amount, self.direction.y, 0);
      else if (actionId === RIGHT) self.direction = vmath.vector3(amount, self.direction.y, 0);
      engage(self);
    }
    return true;
  },
});
