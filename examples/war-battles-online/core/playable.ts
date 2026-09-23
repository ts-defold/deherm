// Offline match orchestration.
//
// One `BattleWorld`, one local player, and a roster of bots that are staged
// through the same input path a network client would use. This is what the
// Defold arena runs when it is not connected to a server, what the headless
// runner drives, and what the retained presentation scene renders.

import {
  DIRECTION_SCALE,
  INPUT_BUTTON_BOOST,
  INPUT_BUTTON_FIRE,
  MAX_PLAYERS,
  TILE_UNITS,
  VELOCITY_SCALE,
  WORLD_MAX_X,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  WORLD_MIN_Y,
} from "./constants.ts";
import {
  UPGRADE_ARMOR,
  UPGRADE_DAMAGE,
  UPGRADE_MOBILITY,
  isWeaponId,
  weaponById,
} from "./content.ts";
import { BotController, botDifficulty, nearestEnemy } from "./bots.ts";
import { clamp, createDirection, length, normalizeInto, type Direction } from "./fixed.ts";
import { createInputCommand, type InputCommand } from "./protocol.ts";
import { BattleWorld } from "./world.ts";

export const PLAYABLE_MATCH_ID = 77;
export const LOCAL_PLAYER_ID = 1;
export const DEFAULT_ARENA_SEED = 0x57_41_52_42;
/** Frags that end a round. */
export const DEFAULT_FRAG_LIMIT = 25;
export const AUTO_RESTART_TICKS = 300;
/** Kept for the retained presentation scene, which splits the roster in half. */
export const TEAM_SIZE = MAX_PLAYERS / 2;

export interface PlayControls {
  moveX: number;
  moveY: number;
  fire: boolean;
  boost?: boolean;
  /** Weapon id the player wants, or 0 for no change. */
  weapon?: number;
}

export interface PlayableOptions {
  /** Total tanks in the match, local player included. */
  readonly players?: number;
  /** Difficulty row applied to every bot, 0-3. */
  readonly botSkill?: number;
  readonly mapSeed?: number;
  /** Two teams when true, free-for-all when false. */
  readonly teams?: boolean;
  readonly fragLimit?: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Deterministic orchestration used by both the Defold components and the
 * headless tests. Commands are allocated once and rewritten in place every tick.
 */
export class PlayableBattle {
  world: BattleWorld;
  round = 1;
  restartCountdown = 0;
  readonly playerCount: number;
  readonly botSkill: number;
  readonly teams: boolean;
  readonly fragLimit: number;
  readonly mapSeed: number;

  private readonly commands: InputCommand[];
  private readonly bots = new BotController();
  private readonly aim: Direction = createDirection();
  private localMoveX = 0;
  private localMoveY = 0;
  private localAimX = DIRECTION_SCALE;
  private localAimY = 0;
  private localFire = false;
  private localBoost = false;
  private localWeapon = 0;

  constructor(options: PlayableOptions = {}) {
    this.playerCount = clamp(Math.trunc(options.players ?? 8), 2, MAX_PLAYERS);
    this.botSkill = clamp(Math.trunc(options.botSkill ?? 2), 0, 3);
    this.teams = options.teams ?? false;
    this.fragLimit = Math.max(1, Math.trunc(options.fragLimit ?? DEFAULT_FRAG_LIMIT));
    this.mapSeed = (options.mapSeed ?? DEFAULT_ARENA_SEED) >>> 0;
    this.world = new BattleWorld(PLAYABLE_MATCH_ID, this.mapSeed);
    this.commands = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      this.commands.push(createInputCommand(PLAYABLE_MATCH_ID, slot + 1));
    }
    this.populateWorld();
  }

  setControls(controls: Readonly<PlayControls>): void {
    this.localMoveX = axis(controls.moveX);
    this.localMoveY = axis(controls.moveY);
    this.localFire = controls.fire;
    this.localBoost = controls.boost === true;
    if (controls.weapon !== undefined && isWeaponId(controls.weapon)) this.localWeapon = controls.weapon;
  }

  /** Aim the local turret explicitly, in world units relative to the tank. */
  setAim(x: number, y: number): void {
    if (normalizeInto(x, y, this.aim)) {
      this.localAimX = this.aim.x;
      this.localAimY = this.aim.y;
    }
  }

  step(): void {
    const tick = this.world.tick + 1;
    this.stageLocalCommand(this.commands[LOCAL_PLAYER_ID - 1]!, tick);
    this.world.submitInput(this.commands[LOCAL_PLAYER_ID - 1]!);
    for (let playerId = 2; playerId <= this.playerCount; playerId += 1) {
      const command = this.commands[playerId - 1]!;
      this.bots.stage(this.world, command, playerId, tick);
      this.world.submitInput(command);
    }
    this.world.step();

    if (this.leaderScore() >= this.fragLimit) {
      this.restartCountdown += 1;
      if (this.restartCountdown >= AUTO_RESTART_TICKS) this.restart();
    } else {
      this.restartCountdown = 0;
    }
  }

  restart(): void {
    this.round += 1;
    this.restartCountdown = 0;
    this.world = new BattleWorld(PLAYABLE_MATCH_ID, this.mapSeed);
    this.bots.reset();
    this.populateWorld();
  }

  buyUpgrade(upgradeId: number): boolean {
    if (upgradeId !== UPGRADE_DAMAGE && upgradeId !== UPGRADE_MOBILITY && upgradeId !== UPGRADE_ARMOR) {
      return false;
    }
    return this.world.applyUpgrade(LOCAL_PLAYER_ID, upgradeId);
  }

  selectChassis(chassisId: number): boolean {
    return this.world.selectChassis(LOCAL_PLAYER_ID, chassisId);
  }

  /** Highest frag count in the match. */
  leaderScore(): number {
    let best = 0;
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      if (this.world.playerActive[slot] === 0) continue;
      if (this.world.playerScore[slot]! > best) best = this.world.playerScore[slot]!;
    }
    return best;
  }

  private populateWorld(): void {
    for (let playerId = 1; playerId <= this.playerCount; playerId += 1) {
      const team = this.teams ? (playerId <= this.playerCount / 2 ? 1 : 2) : 0;
      this.world.addPlayer(playerId, team);
      if (playerId !== LOCAL_PLAYER_ID) {
        // Spread the roster one row either side of the chosen difficulty so a
        // match has a shape rather than 31 identical opponents.
        const spread = ((playerId * 7) % 3) - 1;
        this.world.setBotSkill(playerId, clamp(this.botSkill + spread, 0, 3));
      }
    }
  }

  private stageLocalCommand(command: InputCommand, tick: number): void {
    const slot = LOCAL_PLAYER_ID - 1;
    // Keyboard-only aiming: the turret tracks the best target the tank can
    // actually see, and otherwise points where the tank is driving. `setAim`
    // overrides this for a client that has a real pointing device.
    if (assistedAim(this.world, slot, this.aim)) {
      this.localAimX = this.aim.x;
      this.localAimY = this.aim.y;
    } else if (this.localMoveX !== 0 || this.localMoveY !== 0) {
      if (normalizeInto(this.localMoveX, this.localMoveY, this.aim)) {
        this.localAimX = this.aim.x;
        this.localAimY = this.aim.y;
      }
    }
    command.tick = tick;
    command.sequence = tick & 0xffff;
    command.moveX = axis(this.localMoveX);
    command.moveY = axis(this.localMoveY);
    command.aimX = quantize(this.localAimX);
    command.aimY = quantize(this.localAimY);
    command.buttons = (this.localFire ? INPUT_BUTTON_FIRE : 0) | (this.localBoost ? INPUT_BUTTON_BOOST : 0);
    command.weaponRequest = this.localWeapon;
    command.fireSubtick = this.localFire ? 127 : 255;
    command.latestSnapshotTick = tick > 0 ? tick - 1 : 0;
    command.snapshotAckBits = 0xffff_ffff;
    this.localWeapon = 0;
  }
}

/**
 * Turret assist. Picks the closest enemy this tank can see inside its current
 * weapon's reach and leads it by the projectile's flight time. Returns false
 * when there is nothing worth tracking, which leaves the caller's own aim alone.
 */
export function assistedAim(world: BattleWorld, slot: number, output: Direction): boolean {
  if (world.playerActive[slot] === 0 || world.playerHealth[slot]! <= 0) return false;
  const enemy = nearestEnemy(world, slot);
  if (enemy < 0) return false;
  const selfX = world.playerX[slot]!;
  const selfY = world.playerY[slot]!;
  const targetX = world.playerX[enemy]!;
  const targetY = world.playerY[enemy]!;
  const weapon = weaponById(world.playerWeapon[slot]!);
  const distance = length(targetX - selfX, targetY - selfY);
  if (distance > weapon.projectileSpeed * weapon.lifetimeTicks) return false;
  if (weapon.bounces === 0 && !world.map.lineOfSight(selfX, selfY, targetX, targetY)) return false;
  const flightTicks = weapon.projectileSpeed > 0 ? Math.trunc(distance / weapon.projectileSpeed) : 0;
  return normalizeInto(
    targetX - selfX + Math.trunc((world.playerVelocityX[enemy]! * flightTicks) / VELOCITY_SCALE),
    targetY - selfY + Math.trunc((world.playerVelocityY[enemy]! * flightTicks) / VELOCITY_SCALE),
    output,
  );
}

export function projectWorldToScreen(
  worldX: number,
  worldY: number,
  cameraX: number,
  cameraY: number,
  width: number,
  height: number,
  scale: number,
  output: ScreenPoint,
): ScreenPoint {
  output.x = width * 0.5 + (worldX - cameraX) * scale;
  output.y = height * 0.5 + (worldY - cameraY) * scale;
  return output;
}

export function visibleAt(point: Readonly<ScreenPoint>, width: number, height: number, margin = 48): boolean {
  return point.x >= -margin && point.x <= width + margin && point.y >= -margin && point.y <= height + margin;
}

export function aimDegrees(x: number, y: number): number {
  return Math.atan2(y, x) * 180 / Math.PI;
}

/** The arena's long edge, in simulation units. */
export function arenaSpan(): number {
  const spanX = WORLD_MAX_X - WORLD_MIN_X;
  const spanY = WORLD_MAX_Y - WORLD_MIN_Y;
  return spanX > spanY ? spanX : spanY;
}

/** One tile, in simulation units; renderers use it to size the camera. */
export function arenaTileSpan(): number {
  return TILE_UNITS;
}

/** Difficulty name for a skill row, for HUDs and command lines. */
export function botSkillName(skill: number): string {
  return botDifficulty(skill).name;
}

function quantize(value: number): number {
  return clamp(Math.trunc((value * 127) / DIRECTION_SCALE), -127, 127);
}

function axis(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}
