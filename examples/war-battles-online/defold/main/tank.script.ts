import { defineComponent, go, msg, property, vmath, type DefoldHash } from "@deherm/project";

import { arenaMatch, projectedX, projectedY } from "../src/arena-match";
import {
  INFANTRY_FIRE_COOLDOWN_TICKS,
  PLAYER_MODE_DEAD,
  PLAYER_MODE_INFANTRY,
  PLAYER_MODE_TANK,
  VELOCITY_SCALE,
  driverByPlayerId,
  isometricSortZ,
  isometricDirectionX,
  isometricDirectionY,
  isometricDirectionIndexHysteretic,
  hexReliefLiftAtSimulation,
  type PlayerTransform,
} from "../src/generated-war-battles/index";
import {
  tankHullAnimation,
  tankHullIdleAnimation,
  tankTurretAnimation,
  tankWreckAnimation,
} from "../src/generated-tank-art";
import { heroAnimation, heroDeathAnimation, heroFireAnimation, heroHitAnimation } from "../src/generated-hero-art";
import { nextHeroHitSeconds } from "../src/hero-presentation";
import { REMOTE_CUE_NONE, remoteLifecycleCue } from "../src/generated-war-battles/remote-lifecycle";

/**
 * One remote tank game object owns both hull and turret sprites. Both layers
 * receive the same sampled pose and cannot split across Defold update order.
 * The local player's authored object uses the same arrangement.
 */

interface TankSelf {
  /** Editor property: the simulation slot this part belongs to. */
  slot: number;
  colour: number;
  mode: number;
  generation: number;
  chassis: number;
  direction: number;
  turretDirection: number;
  moving: boolean;
  heroDirection: number;
  heroMoving: boolean;
  heroFiring: boolean;
  heroHitActive: boolean;
  heroHitSeconds: number;
  heroPreviousHealth: number;
  heroDead: boolean;
  z: number;
  transform: PlayerTransform;
}

/**
 * Colour is decided by team when there are teams and by slot otherwise, so a
 * free-for-all still hands four visibly different tanks to the eye. The local
 * slot always takes colour zero.
 */
export function tankColour(slot: number, team: number, localSlot: number): number {
  if (slot === localSlot) return 0;
  if (team !== 0) return team === 1 ? 1 : 2;
  return 1 + (slot % 3);
}

function play(animation: DefoldHash): void {
  msg.post("#sprite", "play_animation", { id: animation });
}

function showHero(show: boolean): void {
  msg.post("#hero", show ? "enable" : "disable");
  msg.post("#sprite", show ? "disable" : "enable");
  msg.post("#turret", show ? "disable" : "enable");
}

export default defineComponent({
  properties: {
    slot: property.number(0),
  },

  init(self: TankSelf): void {
    self.mode = -1;
    self.generation = -1;
    // The first authoritative update selects the real chassis. Keeping an
    // invalid sentinel here also makes a respawn and a chassis change follow
    // the same deterministic selection path.
    self.chassis = 0;
    self.direction = -1;
    self.turretDirection = -1;
    self.moving = false;
    self.heroDirection = -1;
    self.heroMoving = false;
    self.heroFiring = false;
    self.heroHitActive = false;
    self.heroHitSeconds = 0;
    self.heroPreviousHealth = 0;
    self.heroDead = false;
    self.z = go.getPosition().z;
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
    const match = arenaMatch();
    const world = match?.world;
    const team = world === undefined ? 0 : world.playerTeam[Math.trunc(self.slot)]!;
    self.colour = tankColour(Math.trunc(self.slot), team, match === undefined ? -1 : match.localSlot);
    msg.post("#hero", "disable");
    msg.post("#turret", "disable");
    play(tankHullIdleAnimation(self.colour, 1, 4));
  },

  update(self: TankSelf, dt: number): void {
    const match = arenaMatch();
    const world = match?.world;
    if (world === undefined) return;
    const slot = Math.trunc(self.slot);
    if (!(match?.samplePlayerTransform(slot, self.transform) ?? false)) return;
    if (self.transform.active === 0) {
      go.delete();
      return;
    }
    const colour = tankColour(slot, world.playerTeam[slot]!, match === undefined ? -1 : match.localSlot);
    const colourChanged = colour !== self.colour;
    self.colour = colour;
    const chassis = self.transform.chassis;
    const chassisChanged = chassis !== self.chassis;
    self.chassis = chassis;
    const mode = self.transform.mode;
    const modeChanged = mode !== self.mode;
    if (match?.mode === "online") {
      const cue = remoteLifecycleCue(self.mode, self.generation, mode, self.transform.generation);
      if (cue !== REMOTE_CUE_NONE) {
        msg.post("/arena#arena", "remote_lifecycle_cue", {
          x: self.transform.x,
          y: self.transform.y,
          cue,
        });
      }
    }
    self.generation = self.transform.generation;
    if (modeChanged) {
      const wasInfantry = self.mode === PLAYER_MODE_INFANTRY;
      self.mode = mode;
      self.heroDead = mode === PLAYER_MODE_DEAD && wasInfantry;
      showHero(mode === PLAYER_MODE_INFANTRY || self.heroDead);
      if (mode === PLAYER_MODE_INFANTRY) {
        self.heroDirection = -1;
        self.heroHitActive = false;
        self.heroHitSeconds = 0;
        self.heroPreviousHealth = world.playerHealth[slot]!;
      }
      if (mode !== PLAYER_MODE_TANK) msg.post("#turret", "disable");
      else {
        msg.post("#turret", "enable");
        self.direction = -1;
        self.turretDirection = -1;
      }
      if (self.heroDead) {
        const direction = self.heroDirection >= 0 ? self.heroDirection : 1;
        msg.post("#hero", "play_animation", {
          id: heroDeathAnimation(direction, driverByPlayerId(slot + 1).variant),
        });
      } else if (mode === PLAYER_MODE_DEAD) play(tankWreckAnimation(self.colour, chassis));
    } else if (mode === PLAYER_MODE_DEAD && colourChanged && !self.heroDead) {
      play(tankWreckAnimation(self.colour, chassis));
    }

    const drawZ = isometricSortZ(self.transform.x, self.transform.y);
    go.setPosition(
      vmath.vector3(
        projectedX(self.transform.x, self.transform.y),
        projectedY(self.transform.x, self.transform.y) + hexReliefLiftAtSimulation(self.transform.x, self.transform.y),
        drawZ,
      ),
    );
    if (mode === PLAYER_MODE_DEAD) return;
    if (mode === PLAYER_MODE_TANK) {
      const moving =
        Math.abs(self.transform.velocityX) >= VELOCITY_SCALE || Math.abs(self.transform.velocityY) >= VELOCITY_SCALE;
      const movementChanged = moving !== self.moving;
      const direction = isometricDirectionIndexHysteretic(
        isometricDirectionX(self.transform.hullX, self.transform.hullY),
        isometricDirectionY(self.transform.hullX, self.transform.hullY),
        self.direction,
      );
      if (direction !== self.direction || colourChanged || chassisChanged || modeChanged || movementChanged) {
        self.direction = direction;
        self.moving = moving;
        play(
          moving
            ? tankHullAnimation(self.colour, chassis, direction)
            : tankHullIdleAnimation(self.colour, chassis, direction),
        );
      }
      const turretDirection = isometricDirectionIndexHysteretic(
        isometricDirectionX(self.transform.turretX, self.transform.turretY),
        isometricDirectionY(self.transform.turretX, self.transform.turretY),
        self.turretDirection,
      );
      if (turretDirection !== self.turretDirection || colourChanged || chassisChanged || modeChanged) {
        self.turretDirection = turretDirection;
        msg.post("#turret", "play_animation", { id: tankTurretAnimation(self.colour, chassis, turretDirection) });
      }
      go.setRotation(vmath.quatRotationZ(0));
    } else {
      const health = world.playerHealth[slot]!;
      self.heroHitSeconds = nextHeroHitSeconds(self.heroPreviousHealth, health, self.heroHitSeconds, dt, modeChanged);
      self.heroPreviousHealth = health;
      const heroHit = self.heroHitSeconds > 0;
      const heroDirection = isometricDirectionIndexHysteretic(
        isometricDirectionX(self.transform.hullX, self.transform.hullY),
        isometricDirectionY(self.transform.hullX, self.transform.hullY),
        self.heroDirection,
      );
      const heroMoving =
        Math.abs(self.transform.velocityX) >= VELOCITY_SCALE || Math.abs(self.transform.velocityY) >= VELOCITY_SCALE;
      const heroFiring = world.playerCooldown[slot]! > INFANTRY_FIRE_COOLDOWN_TICKS - 10;
      if (
        heroDirection !== self.heroDirection ||
        heroMoving !== self.heroMoving ||
        heroFiring !== self.heroFiring ||
        heroHit !== self.heroHitActive ||
        modeChanged
      ) {
        self.heroDirection = heroDirection;
        self.heroMoving = heroMoving;
        self.heroFiring = heroFiring;
        self.heroHitActive = heroHit;
        msg.post("#hero", "play_animation", {
          id: heroHit
            ? heroHitAnimation(heroDirection, driverByPlayerId(slot + 1).variant)
            : heroFiring
              ? heroFireAnimation(heroDirection, driverByPlayerId(slot + 1).variant)
              : heroAnimation(heroDirection, heroMoving, driverByPlayerId(slot + 1).variant),
        });
      }
      go.setRotation(vmath.quatRotationZ(0));
    }
  },
});
