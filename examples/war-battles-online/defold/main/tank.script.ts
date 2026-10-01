import { defineComponent, go, hashLiteral, msg, property, vmath, type DefoldHash } from "@deherm/project";

import { arenaMatch, projectedDirectionRadians, projectedX, projectedY } from "../src/arena-match";
import {
  PLAYER_MODE_DEAD,
  PLAYER_MODE_INFANTRY,
  PLAYER_MODE_TANK,
  VELOCITY_SCALE,
  isometricDepth,
  isometricDirectionX,
  isometricDirectionY,
  isometricDirectionIndex,
  type PlayerTransform,
} from "../src/generated-war-battles/index";
import {
  tankHullAnimation,
  tankHullIdleAnimation,
  tankTurretAnimation,
  tankWreckAnimation,
} from "../src/generated-tank-art";

/**
 * One visible part of one tank: a hull or a turret.
 *
 * Both parts are the same component because both do the same thing - read the
 * authoritative slot they were spawned for and move themselves to it. Nothing
 * here writes any other game object's transform, which matters: only the
 * current-instance `go.set_position` / `go.set_rotation` shapes are implemented
 * by the generated value bindings, so every entity in the arena has to be the
 * one that moves itself.
 *
 * The local player's hull is the authored `player` game object instead; its
 * turret is an instance of this component like any other.
 */

const PART_TURRET = 1;
const HERO_ANIMATION = hashLiteral("#player-down");

interface TankSelf {
  /** Editor property: the simulation slot this part belongs to. */
  slot: number;
  /** Editor property: 0 for the hull, 1 for the turret. */
  part: number;
  colour: number;
  turret: boolean;
  mode: number;
  chassis: number;
  direction: number;
  moving: boolean;
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
  if (show) msg.post("#hero", "play_animation", { id: HERO_ANIMATION });
}

export default defineComponent({
  properties: {
    slot: property.number(0),
    part: property.number(0),
  },

  init(self: TankSelf): void {
    self.turret = Math.trunc(self.part) === PART_TURRET;
    self.mode = -1;
    // The first authoritative update selects the real chassis. Keeping an
    // invalid sentinel here also makes a respawn and a chassis change follow
    // the same deterministic selection path.
    self.chassis = 0;
    self.direction = -1;
    self.moving = false;
    self.z = go.getPosition().z;
    self.transform = { x: 0, y: 0, hullX: 0, hullY: 0, turretX: 0, turretY: 0 };
    const match = arenaMatch();
    const world = match?.world;
    const team = world === undefined ? 0 : world.playerTeam[Math.trunc(self.slot)]!;
    self.colour = tankColour(Math.trunc(self.slot), team, match === undefined ? -1 : match.localSlot);
    msg.post("#hero", "disable");
    play(self.turret ? tankTurretAnimation(self.colour, 1, 4) : tankHullIdleAnimation(self.colour, 1, 4));
  },

  update(self: TankSelf, _dt: number): void {
    const match = arenaMatch();
    const world = match?.world;
    if (world === undefined) return;
    const slot = Math.trunc(self.slot);
    if (world.playerActive[slot] === 0) {
      go.delete();
      return;
    }
    const colour = tankColour(slot, world.playerTeam[slot]!, match === undefined ? -1 : match.localSlot);
    const colourChanged = colour !== self.colour;
    self.colour = colour;
    const chassis = world.playerChassis[slot]!;
    const chassisChanged = chassis !== self.chassis;
    self.chassis = chassis;
    const mode = world.playerMode[slot]!;
    const modeChanged = mode !== self.mode;
    if (modeChanged) {
      self.mode = mode;
      if (self.turret) {
        // A pilot or wreck has no turret to draw. Keep the component alive for
        // the replacement tank, but park it outside the arena meanwhile.
        if (mode !== PLAYER_MODE_TANK) go.setPosition(vmath.vector3(-10_000, -10_000, self.z));
        else self.direction = -1;
      } else {
        showHero(mode === PLAYER_MODE_INFANTRY);
        if (mode === PLAYER_MODE_DEAD) play(tankWreckAnimation(self.colour));
        else if (mode === PLAYER_MODE_TANK) self.direction = -1;
      }
    } else if (!self.turret && mode === PLAYER_MODE_DEAD && colourChanged) {
      play(tankWreckAnimation(self.colour));
    }
    if (mode !== PLAYER_MODE_TANK && self.turret) return;

    const sampled = match?.samplePlayerTransform(slot, self.transform) ?? false;
    if (!sampled) return;
    const drawZ = 0.2 + isometricDepth(self.transform.x, self.transform.y) * 0.05 + (self.turret ? 0.001 : 0);
    go.setPosition(
      vmath.vector3(
        projectedX(self.transform.x, self.transform.y),
        projectedY(self.transform.x, self.transform.y),
        drawZ,
      ),
    );
    if (mode === PLAYER_MODE_DEAD) return;
    const directionX = self.turret ? self.transform.turretX : self.transform.hullX;
    const directionY = self.turret ? self.transform.turretY : self.transform.hullY;
    if (mode === PLAYER_MODE_TANK) {
      const moving =
        Math.abs(world.playerVelocityX[slot]!) >= VELOCITY_SCALE ||
        Math.abs(world.playerVelocityY[slot]!) >= VELOCITY_SCALE;
      const movementChanged = !self.turret && moving !== self.moving;
      const direction = isometricDirectionIndex(
        isometricDirectionX(directionX, directionY),
        isometricDirectionY(directionX, directionY),
      );
      if (direction !== self.direction || colourChanged || chassisChanged || modeChanged || movementChanged) {
        self.direction = direction;
        self.moving = moving;
        play(
          self.turret
            ? tankTurretAnimation(self.colour, chassis, direction)
            : moving
              ? tankHullAnimation(self.colour, chassis, direction)
              : tankHullIdleAnimation(self.colour, chassis, direction),
        );
      }
      go.setRotation(vmath.quatRotationZ(0));
    } else {
      go.setRotation(vmath.quatRotationZ(projectedDirectionRadians(directionX, directionY) + Math.PI / 2));
    }
  },
});
