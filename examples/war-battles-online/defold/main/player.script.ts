import {
  defold,
  defineComponent,
  factory,
  go,
  hashLiteral,
  msg,
  property,
  sys,
  vmath,
  window,
  type DefoldHash,
  type OnInputAction,
  type Vector3,
} from "@deherm/project";

import { arenaMatch, projectedX, projectedY } from "../src/arena-match";
import {
  INFANTRY_FIRE_COOLDOWN_TICKS,
  PLAYER_MODE_DEAD,
  PLAYER_MODE_INFANTRY,
  PLAYER_MODE_TANK,
  REJECT_FULL,
  VELOCITY_SCALE,
  driverByPlayerId,
  hexReliefLiftAtSimulation,
  isometricControlWorldX,
  isometricControlWorldY,
  isometricSortZ,
  isometricDirectionX,
  isometricDirectionY,
  isometricDirectionIndex,
  isometricDirectionIndexHysteretic,
  createVirtualControls,
  updateVirtualControls,
  type PlayerTransform,
  type VirtualControls,
} from "../src/generated-war-battles/index";
import {
  tankHullAnimation,
  tankHullIdleAnimation,
  tankTurretAnimation,
  tankWreckAnimation,
} from "../src/generated-tank-art";
import {
  HERO_FAMILY_COUNT,
  heroAnimation,
  heroDeathAnimation,
  heroFireAnimation,
  heroHitAnimation,
} from "../src/generated-hero-art";
import { nextHeroHitSeconds } from "../src/hero-presentation";

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
const TOUCH = hashLiteral("#touch_multi");
const UI = "/gui#ui";

/**
 * The camera follows a reported position rather than sampling this object.
 * `go.get_position(id)` is declared but not implemented for the addressed call
 * shapes, so the world-space hand-off is a message the camera consumes.
 */
const CAMERA = "/camera#follow";
/** The arena director, which owns the match and every factory in the scene. */
const ARENA = "/arena#arena";

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
  directionIndex: number;
  turretDirectionIndex: number;
  moving: boolean;
  heroDirectionIndex: number;
  heroMoving: boolean;
  heroFiring: boolean;
  heroHitActive: boolean;
  heroHitSeconds: number;
  heroPreviousHealth: number;
  heroDead: boolean;
  mode: number;
  generation: number;
  /** Snap the camera on the next authoritative transform sample. */
  cameraSnapPending: boolean;
  transform: PlayerTransform;
  touch: VirtualControls;
  touchSeen: boolean;
}

interface WarBattlesPlayerGlobals {
  __warBattlesConfigV1?: { demo?: boolean; artGallery?: boolean; artGalleryHeroVariant?: number };
}

function heroVariantForSlot(slot: number): number {
  const ordinary = driverByPlayerId(slot + 1).variant;
  const config = (globalThis as unknown as WarBattlesPlayerGlobals).__warBattlesConfigV1;
  if (config?.artGallery !== true || config.artGalleryHeroVariant === undefined) return ordinary;
  const variant = config.artGalleryHeroVariant;
  if (!Number.isInteger(variant) || variant < 0 || variant >= HERO_FAMILY_COUNT) {
    throw new RangeError("art gallery hero variant is not a selected family");
  }
  return variant;
}

function scriptedDemoEnabled(): boolean {
  const browserConfigured = (globalThis as unknown as WarBattlesPlayerGlobals).__warBattlesConfigV1?.demo === true;
  // Defold's documented command-line override form uses numeric 0/1 values.
  // Read the project setting through the matching integer accessor so
  // `--config=war_battles.demo=1` cannot be mistaken for the literal boolean
  // spelling expected by `sys.get_config_boolean`.
  return browserConfigured || sys.getConfigInt("war_battles.demo", 0) === 1;
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
    actionId === UPGRADE_2 ||
    actionId === TOUCH
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
  const directionIndex = isometricDirectionIndex(direction.x, direction.y);
  if (directionIndex !== self.directionIndex || !self.moving) {
    self.directionIndex = directionIndex;
    self.moving = true;
    msg.post("#sprite", "play_animation", { id: tankHullAnimation(0, 1, directionIndex) });
  }
  go.setRotation(vmath.quatRotationZ(0));
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
  self.cameraSnapPending = true;
  self.demoMove = 0;
  self.demoTurn = 0;
  self.direction = vmath.vector3(0, 0, 0);
  msg.post(ARENA, "engage");
}

function pushControls(self: PlayerSelf): void {
  const match = arenaMatch();
  if (match === undefined) return;
  const screenX = (self.right ? 1 : 0) - (self.left ? 1 : 0) + self.touch.moveX;
  const screenY = (self.up ? 1 : 0) - (self.down ? 1 : 0) + self.touch.moveY;
  match.setControls(
    isometricControlWorldX(screenX, screenY),
    isometricControlWorldY(screenX, screenY),
    self.firing || self.touch.fire,
    self.boosting || self.touch.boost,
    self.weapon,
  );
  if (self.touch.hasAim) {
    match.setAim(
      isometricControlWorldX(self.touch.aimX, self.touch.aimY),
      isometricControlWorldY(self.touch.aimX, self.touch.aimY),
    );
  } else {
    match.clearAim();
  }
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
    // The tutorial tour is an explicit evidence/demo mode, never normal
    // gameplay. This keeps deterministic runtime gates without making a real
    // player's tank drive itself on launch.
    if (scriptedDemoEnabled()) {
      self.demo = 1;
      self.tour = 10;
    }
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
    self.touch = createVirtualControls();
    self.touchSeen = false;
    msg.post(".", "acquire_input_focus");
    // Input reaches the most recently focused component first. The GUI owns
    // the scoreboard ribbon hit area; all other actions pass through to this
    // player script when its onInput returns false.
    msg.post(UI, "acquire_input_focus");
    const position = go.getPosition();
    self.z = position.z;
    self.chassis = 0;
    self.directionIndex = -1;
    self.turretDirectionIndex = -1;
    self.moving = false;
    self.heroDirectionIndex = -1;
    self.heroMoving = false;
    self.heroFiring = false;
    self.heroHitActive = false;
    self.heroHitSeconds = 0;
    self.heroPreviousHealth = 0;
    self.heroDead = false;
    self.mode = -1;
    self.generation = -1;
    self.cameraSnapPending = false;
    self.transform = {
      x: 0,
      y: 0,
      hullX: 0,
      hullY: 0,
      turretX: 0,
      turretY: 0,
      active: 0,
      generation: 0,
      mode: PLAYER_MODE_DEAD,
      chassis: 0,
      velocityX: 0,
      velocityY: 0,
    };
    msg.post("#hero", "disable");
    msg.post("#turret", "disable");
    msg.post("#sprite", "play_animation", { id: tankHullIdleAnimation(0, 1, 4) });
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
    const match = arenaMatch();
    // Online admission engages the arena before this component sees player
    // input. Follow that authoritative transition instead of continuing the
    // old scripted tour over the live networked tank.
    if (!self.engaged && match?.engaged) {
      engage(self);
      // Online welcome has no keyboard press to send the normal deploy
      // message. Hide the title on that same authoritative transition so the
      // connected player actually sees and controls the match.
      msg.post(UI, "deploy");
    }

    if (self.engaged) {
      pushControls(self);
      const world = match?.world;
      const slot = match === undefined ? -1 : match.localSlot;
      if (world === undefined || slot < 0) return;
      if (!(match?.samplePlayerTransform(slot, self.transform) ?? false)) return;
      const chassis = self.transform.chassis;
      const chassisChanged = chassis !== self.chassis;
      if (chassisChanged) {
        self.chassis = chassis;
      }
      const mode = self.transform.mode;
      const modeChanged = mode !== self.mode;
      if (modeChanged) {
        const wasInfantry = self.mode === PLAYER_MODE_INFANTRY;
        self.mode = mode;
        self.heroDead = mode === PLAYER_MODE_DEAD && wasInfantry;
        if (mode === PLAYER_MODE_INFANTRY) {
          msg.post("#sprite", "disable");
          msg.post("#turret", "disable");
          msg.post("#hero", "enable");
          self.heroDirectionIndex = -1;
          self.heroFiring = false;
          self.heroHitActive = false;
          self.heroHitSeconds = 0;
          self.heroPreviousHealth = world.playerHealth[slot]!;
        } else if (self.heroDead) {
          msg.post("#sprite", "disable");
          msg.post("#turret", "disable");
          msg.post("#hero", "enable");
          const direction = self.heroDirectionIndex >= 0 ? self.heroDirectionIndex : 1;
          msg.post("#hero", "play_animation", { id: heroDeathAnimation(direction, heroVariantForSlot(slot)) });
          if ((globalThis as unknown as WarBattlesPlayerGlobals).__warBattlesConfigV1?.artGallery === true) {
            defold.log("info", `war-battles:hero-pose:direction=${direction}:death=1`);
          }
        } else {
          msg.post("#hero", "disable");
          msg.post("#sprite", "enable");
          msg.post("#turret", mode === PLAYER_MODE_TANK ? "enable" : "disable");
          if (mode === PLAYER_MODE_DEAD) msg.post("#sprite", "play_animation", { id: tankWreckAnimation(0, chassis) });
          else {
            self.directionIndex = -1;
            self.turretDirectionIndex = -1;
          }
        }
      }
      const generation = self.transform.generation;
      if (generation !== self.generation) {
        self.generation = generation;
        self.cameraSnapPending = true;
      }
      const x = projectedX(self.transform.x, self.transform.y);
      const y = projectedY(self.transform.x, self.transform.y);
      const z = isometricSortZ(self.transform.x, self.transform.y);
      go.setPosition(vmath.vector3(x, y + hexReliefLiftAtSimulation(self.transform.x, self.transform.y), z));
      if (mode === PLAYER_MODE_TANK) {
        const moving =
          Math.abs(self.transform.velocityX) >= VELOCITY_SCALE || Math.abs(self.transform.velocityY) >= VELOCITY_SCALE;
        const directionIndex = isometricDirectionIndexHysteretic(
          isometricDirectionX(self.transform.hullX, self.transform.hullY),
          isometricDirectionY(self.transform.hullX, self.transform.hullY),
          self.directionIndex,
        );
        if (directionIndex !== self.directionIndex || chassisChanged || modeChanged || moving !== self.moving) {
          self.directionIndex = directionIndex;
          self.moving = moving;
          msg.post("#sprite", "play_animation", {
            id: moving
              ? tankHullAnimation(0, chassis, directionIndex)
              : tankHullIdleAnimation(0, chassis, directionIndex),
          });
        }
        const turretDirectionIndex = isometricDirectionIndexHysteretic(
          isometricDirectionX(self.transform.turretX, self.transform.turretY),
          isometricDirectionY(self.transform.turretX, self.transform.turretY),
          self.turretDirectionIndex,
        );
        if (turretDirectionIndex !== self.turretDirectionIndex || chassisChanged || modeChanged) {
          self.turretDirectionIndex = turretDirectionIndex;
          msg.post("#turret", "play_animation", { id: tankTurretAnimation(0, chassis, turretDirectionIndex) });
        }
        go.setRotation(vmath.quatRotationZ(0));
      } else if (mode === PLAYER_MODE_INFANTRY) {
        const health = world.playerHealth[slot]!;
        self.heroHitSeconds = nextHeroHitSeconds(self.heroPreviousHealth, health, self.heroHitSeconds, dt, modeChanged);
        self.heroPreviousHealth = health;
        const heroHit = self.heroHitSeconds > 0;
        const heroDirection = isometricDirectionIndexHysteretic(
          isometricDirectionX(self.transform.hullX, self.transform.hullY),
          isometricDirectionY(self.transform.hullX, self.transform.hullY),
          self.heroDirectionIndex,
        );
        const heroMoving =
          Math.abs(self.transform.velocityX) >= VELOCITY_SCALE || Math.abs(self.transform.velocityY) >= VELOCITY_SCALE;
        // The first ten ticks of the authoritative infantry cooldown are a
        // visible recoil window. Holding the button alone cannot fake a shot.
        const heroFiring = world.playerCooldown[slot]! > INFANTRY_FIRE_COOLDOWN_TICKS - 10;
        if (
          heroDirection !== self.heroDirectionIndex ||
          heroMoving !== self.heroMoving ||
          heroFiring !== self.heroFiring ||
          heroHit !== self.heroHitActive ||
          modeChanged
        ) {
          self.heroDirectionIndex = heroDirection;
          self.heroMoving = heroMoving;
          self.heroFiring = heroFiring;
          self.heroHitActive = heroHit;
          msg.post("#hero", "play_animation", {
            id: heroHit
              ? heroHitAnimation(heroDirection, heroVariantForSlot(slot))
              : heroFiring
                ? heroFireAnimation(heroDirection, heroVariantForSlot(slot))
                : heroAnimation(heroDirection, heroMoving, heroVariantForSlot(slot)),
          });
          if ((globalThis as unknown as WarBattlesPlayerGlobals).__warBattlesConfigV1?.artGallery === true) {
            defold.log(
              "info",
              `war-battles:hero-pose:direction=${heroDirection}:cooldown=${world.playerCooldown[slot]}:fire=${heroFiring ? 1 : 0}:hit=${heroHit ? 1 : 0}`,
            );
          }
        }
        go.setRotation(vmath.quatRotationZ(0));
      }
      msg.post(CAMERA, "player_at", { x, y, snap: self.cameraSnapPending });
      self.cameraSnapPending = false;
      return;
    }

    const start = go.getPosition();
    msg.post(CAMERA, "player_at", { x: start.x, y: start.y });
    if (self.demo > 0 && !self.demoFired && self.elapsed >= self.demo) {
      self.demoFired = true;
      // The tutorial target is evidence-only. It is created for the one
      // scripted shot and deleted by the rocket collision; normal gameplay
      // contains no decorative tutorial tanks baked into the collection.
      factory.create("#demotankfactory", vmath.vector3(860, 360, 0));
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
        self.moving = false;
        msg.post("#sprite", "play_animation", { id: tankHullIdleAnimation(0, 1, self.directionIndex) });
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
    // The opt-in packaged-runtime tour is an evidence fixture, not a playable
    // attract mode. A key held when Defold focuses its new window must not
    // cancel its deterministic shot and movement markers. Normal launches
    // leave `demo` at zero and retain the regular input behavior below.
    if (self.demo > 0 && !self.engaged) return true;
    const client = arenaMatch()?.client;
    if (client?.state === "rejected" && client.lastReject?.code === REJECT_FULL) {
      if (action.pressed || action.touch?.some((touch) => touch.pressed) === true) {
        msg.post(ARENA, "retry_online");
      }
      return true;
    }
    if (actionId === TOUCH && action.touch !== undefined) {
      const [screenWidth] = window.getSize();
      updateVirtualControls(self.touch, action.touch, screenWidth);
      if (!self.touchSeen) {
        self.touchSeen = true;
        msg.post(UI, "touch_enabled");
      }
      if (action.touch.some((touch) => touch.pressed)) {
        msg.post(UI, "deploy");
        engage(self);
      }
      // The GUI may also own a touch on the leader ribbon. Its own hit test
      // decides whether to consume it; normal drive/aim touches pass through.
      return false;
    }
    // The scripted tutorial may already be running behind the title. Only a
    // real player press dismisses that title, so launch evidence and an idle
    // attract loop do not impersonate user intent.
    if (action.pressed && isMappedPlayerAction(actionId)) {
      defold.log("info", `war-battles:user-input:${defold.hashToHex(actionId)}`);
      msg.post(UI, "deploy");
    }
    // A click still deploys through the message above, but it must continue to
    // the GUI so the persistent leader ribbon can open the scoreboard.
    if (actionId === DEPLOY) return false;
    if (actionId === RESTART) {
      if (action.pressed) {
        engage(self);
        self.cameraSnapPending = true;
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
