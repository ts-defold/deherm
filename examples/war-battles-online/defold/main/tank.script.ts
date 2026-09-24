import { defineComponent, go, hashLiteral, msg, property, vmath, type DefoldHash } from "@deherm/project";

import { arenaMatch, directionRadians, pixelX, pixelY } from "../src/arena-match";
import {
  PLAYER_MODE_DEAD,
  PLAYER_MODE_INFANTRY,
  PLAYER_MODE_TANK,
  chassisById,
  type PlayerTransform,
} from "../src/generated-war-battles/index";

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

/** Team colours, in the order `arena-sprites.atlas` declares them. */
const HULL_ANIMATIONS: readonly DefoldHash[] = [
  hashLiteral("#tank-blue-hull"),
  hashLiteral("#tank-red-hull"),
  hashLiteral("#tank-green-hull"),
  hashLiteral("#tank-sand-hull"),
];
const TURRET_ANIMATIONS: readonly DefoldHash[] = [
  hashLiteral("#tank-blue-turret"),
  hashLiteral("#tank-red-turret"),
  hashLiteral("#tank-green-turret"),
  hashLiteral("#tank-sand-turret"),
];
const WRECK_ANIMATIONS: readonly DefoldHash[] = [
  hashLiteral("#tank-blue-wreck"),
  hashLiteral("#tank-red-wreck"),
  hashLiteral("#tank-green-wreck"),
  hashLiteral("#tank-sand-wreck"),
];
const CHASSIS_ANIMATIONS: readonly (readonly DefoldHash[])[] = [
  [
    hashLiteral("#chassis-blue-scout"),
    hashLiteral("#chassis-blue-assault"),
    hashLiteral("#chassis-blue-bulwark"),
    hashLiteral("#chassis-blue-artillery"),
  ],
  [
    hashLiteral("#chassis-red-scout"),
    hashLiteral("#chassis-red-assault"),
    hashLiteral("#chassis-red-bulwark"),
    hashLiteral("#chassis-red-artillery"),
  ],
  [
    hashLiteral("#chassis-green-scout"),
    hashLiteral("#chassis-green-assault"),
    hashLiteral("#chassis-green-bulwark"),
    hashLiteral("#chassis-green-artillery"),
  ],
  [
    hashLiteral("#chassis-sand-scout"),
    hashLiteral("#chassis-sand-assault"),
    hashLiteral("#chassis-sand-bulwark"),
    hashLiteral("#chassis-sand-artillery"),
  ],
];

interface TankSelf {
  /** Editor property: the simulation slot this part belongs to. */
  slot: number;
  /** Editor property: 0 for the hull, 1 for the turret. */
  part: number;
  colour: number;
  turret: boolean;
  mode: number;
  chassis: number;
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

function chassisAnimation(colour: number, chassis: number): DefoldHash {
  const definition = chassisById(chassis);
  return CHASSIS_ANIMATIONS[colour]![definition.id - 1]!;
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
    self.z = go.getPosition().z;
    self.transform = { x: 0, y: 0, hullX: 0, hullY: 0, turretX: 0, turretY: 0 };
    const match = arenaMatch();
    const world = match?.world;
    const team = world === undefined ? 0 : world.playerTeam[Math.trunc(self.slot)]!;
    self.colour = tankColour(Math.trunc(self.slot), team, match === undefined ? -1 : match.localSlot);
    msg.post("#hero", "disable");
    play(self.turret ? TURRET_ANIMATIONS[self.colour]! : HULL_ANIMATIONS[self.colour]!);
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
      } else {
        showHero(mode === PLAYER_MODE_INFANTRY);
        if (mode !== PLAYER_MODE_INFANTRY) {
          play(mode === PLAYER_MODE_DEAD ? WRECK_ANIMATIONS[self.colour]! : chassisAnimation(self.colour, chassis));
        }
      }
    } else if (self.turret) {
      if (mode === PLAYER_MODE_TANK && colourChanged) play(TURRET_ANIMATIONS[self.colour]!);
    } else if (colourChanged || (mode === PLAYER_MODE_TANK && chassisChanged)) {
      if (mode !== PLAYER_MODE_INFANTRY) {
        play(mode === PLAYER_MODE_DEAD ? WRECK_ANIMATIONS[self.colour]! : chassisAnimation(self.colour, chassis));
      }
    }
    if (mode !== PLAYER_MODE_TANK && self.turret) return;

    const sampled = match?.samplePlayerTransform(slot, self.transform) ?? false;
    if (!sampled) return;
    go.setPosition(vmath.vector3(pixelX(self.transform.x), pixelY(self.transform.y), self.z));
    if (mode === PLAYER_MODE_DEAD) return;
    const directionX = self.turret ? self.transform.turretX : self.transform.hullX;
    const directionY = self.turret ? self.transform.turretY : self.transform.hullY;
    go.setRotation(
      vmath.quatRotationZ(directionRadians(directionX, directionY) + (mode === PLAYER_MODE_INFANTRY ? Math.PI / 2 : 0)),
    );
  },
});
