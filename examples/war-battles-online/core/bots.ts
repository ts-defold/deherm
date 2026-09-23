// Bots.
//
// A bot is a client, not a special case inside the simulation: it reads the
// world and produces exactly the same 32-byte `InputCommand` a human's keyboard
// produces. That is what lets the server host them, lets a client host them
// offline, and keeps `BattleWorld` free of any notion of "AI".
//
// Behaviour, in priority order: stay alive (break for health when hurt), arm
// yourself (contest a weapon or armour pad when what you are holding is weak),
// then fight - close to the range your current weapon actually wants, strafe
// across the target rather than walking into it, and lead the shot by the time
// the projectile will take to arrive. Every one of those is scaled by a
// difficulty row, so the same code plays a punching bag or a problem.

import {
  DIRECTION_SCALE,
  INPUT_BUTTON_BOOST,
  INPUT_BUTTON_FIRE,
  MAX_PICKUPS,
  MAX_PLAYERS,
  TILE_UNITS,
  VELOCITY_SCALE,
} from "./constants.ts";
import {
  PICKUP_ARMOR,
  PICKUP_HEALTH,
  PICKUP_OVERDRIVE,
  SPAWN_WEAPON,
  CHASSIS_COUNT,
  canUseWeapon,
  chassisById,
  WEAPON_COUNT,
  pickupByKind,
  weaponById,
} from "./content.ts";
import { clamp, length, mixSigned, normalizeInto, createDirection, type Direction } from "./fixed.ts";
import type { InputCommand } from "./protocol.ts";
import type { BattleWorld } from "./world.ts";

export interface BotDifficulty {
  readonly id: number;
  readonly name: string;
  /** Ticks between goal re-evaluations. Lower reacts faster. */
  readonly reactionTicks: number;
  /** Aim jitter, in 1/256ths of a right angle. */
  readonly aimError: number;
  /** Percentage of the correct target lead that is actually applied. */
  readonly leadAccuracy: number;
  /** Health-plus-armour percentage below which the bot disengages for a pad. */
  readonly retreatHealth: number;
  /** Chance in 256 of pulling the trigger on an eligible tick. */
  readonly trigger: number;
  /** How far off the turret may be, in 1/256ths of a dot product, and still fire. */
  readonly fireCone: number;
  /** Strength of the sideways component while fighting, 0-256. */
  readonly strafe: number;
  /** Chance in 256 of contesting a pad that is not strictly needed. */
  readonly greed: number;
}

const difficulty = (row: BotDifficulty): BotDifficulty => Object.freeze(row);

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = Object.freeze([
  difficulty({ id: 0, name: "recruit", reactionTicks: 24, aimError: 46, leadAccuracy: 10, retreatHealth: 25, trigger: 90, fireCone: 200, strafe: 60, greed: 20 }),
  difficulty({ id: 1, name: "regular", reactionTicks: 16, aimError: 26, leadAccuracy: 45, retreatHealth: 35, trigger: 150, fireCone: 228, strafe: 130, greed: 60 }),
  difficulty({ id: 2, name: "veteran", reactionTicks: 10, aimError: 13, leadAccuracy: 80, retreatHealth: 45, trigger: 210, fireCone: 244, strafe: 190, greed: 110 }),
  difficulty({ id: 3, name: "nightmare", reactionTicks: 5, aimError: 5, leadAccuracy: 100, retreatHealth: 55, trigger: 250, fireCone: 250, strafe: 240, greed: 170 }),
]);

export function botDifficulty(id: number): BotDifficulty {
  return BOT_DIFFICULTIES[clamp(Math.trunc(id), 0, BOT_DIFFICULTIES.length - 1)]!;
}

const GOAL_FIGHT = 0;
const GOAL_PICKUP = 1;
const GOAL_HUNT = 2;

/**
 * Per-bot memory. Kept outside `BattleWorld` on purpose: it is not authoritative
 * state, it never enters a snapshot, and a server that rolls the world back does
 * not roll its bots' opinions back with it.
 */
export class BotController {
  private readonly goal = new Uint8Array(MAX_PLAYERS);
  private readonly goalTarget = new Int16Array(MAX_PLAYERS);
  private readonly goalX = new Int32Array(MAX_PLAYERS);
  private readonly goalY = new Int32Array(MAX_PLAYERS);
  private readonly decideAt = new Int32Array(MAX_PLAYERS);
  private readonly strafeSign = new Int8Array(MAX_PLAYERS);
  private readonly avoidSign = new Int8Array(MAX_PLAYERS);
  private readonly stuckTicks = new Uint16Array(MAX_PLAYERS);
  private readonly lastX = new Int32Array(MAX_PLAYERS);
  private readonly lastY = new Int32Array(MAX_PLAYERS);
  private readonly move: Direction = createDirection();
  private readonly aim: Direction = createDirection();

  constructor() {
    this.strafeSign.fill(1);
    this.avoidSign.fill(1);
    this.decideAt.fill(-1);
  }

  /** Forgets every opinion; used when a match restarts. */
  reset(): void {
    this.goal.fill(GOAL_FIGHT);
    this.goalTarget.fill(-1);
    this.decideAt.fill(-1);
    this.stuckTicks.fill(0);
  }

  /**
   * Writes this bot's input for `tick` into `command`. The command is caller
   * owned and rewritten in place, so a full roster of bots allocates nothing
   * per tick.
   */
  stage(world: BattleWorld, command: InputCommand, playerId: number, tick: number): void {
    const slot = playerId - 1;
    command.tick = tick;
    command.sequence = tick & 0xffff;
    command.latestSnapshotTick = tick > 0 ? tick - 1 : 0;
    command.snapshotAckBits = 0xffff_ffff;
    command.fireSubtick = 255;
    command.weaponRequest = 0;
    command.buttons = 0;
    command.moveX = 0;
    command.moveY = 0;

    if (world.playerActive[slot] === 0 || world.playerHealth[slot]! <= 0) {
      this.decideAt[slot] = -1;
      return;
    }
    const skill = botDifficulty(world.playerBotSkill[slot]!);
    this.detectStuck(world, slot);
    if (tick >= this.decideAt[slot]!) {
      this.decide(world, slot, skill, tick);
      this.decideAt[slot] = tick + skill.reactionTicks;
    }

    const enemy = this.goalTarget[slot]!;
    const selfX = world.playerX[slot]!;
    const selfY = world.playerY[slot]!;

    // --- aim ---------------------------------------------------------------
    let aimX = world.playerTurretX[slot]!;
    let aimY = world.playerTurretY[slot]!;
    let canFire = false;
    if (enemy >= 0 && world.playerActive[enemy] !== 0 && world.playerHealth[enemy]! > 0) {
      const weapon = weaponById(world.playerWeapon[slot]!);
      const rawX = world.playerX[enemy]! - selfX;
      const rawY = world.playerY[enemy]! - selfY;
      const distance = length(rawX, rawY);
      // Lead by the flight time, scaled by how good this bot is supposed to be.
      const flightTicks = weapon.projectileSpeed > 0 ? Math.trunc(distance / weapon.projectileSpeed) : 0;
      const leadScale = Math.trunc((flightTicks * skill.leadAccuracy) / 100);
      const leadX = rawX + Math.trunc((world.playerVelocityX[enemy]! * leadScale) / VELOCITY_SCALE);
      const leadY = rawY + Math.trunc((world.playerVelocityY[enemy]! * leadScale) / VELOCITY_SCALE);
      if (normalizeInto(leadX, leadY, this.aim)) {
        const error = mixSigned(tick, (slot + 1) * 0x9e37, skill.aimError);
        // Nudge the aim sideways by the error, then renormalise: an integer
        // approximation of a small rotation, with no trigonometry.
        if (!normalizeInto(
          this.aim.x * DIRECTION_SCALE - this.aim.y * error,
          this.aim.y * DIRECTION_SCALE + this.aim.x * error,
          this.aim,
        )) {
          this.aim.x = DIRECTION_SCALE;
          this.aim.y = 0;
        }
        aimX = this.aim.x;
        aimY = this.aim.y;
      }
      const inRange = distance < weapon.projectileSpeed * weapon.lifetimeTicks;
      const alignment = Math.trunc(
        (world.playerTurretX[slot]! * aimX + world.playerTurretY[slot]! * aimY) / DIRECTION_SCALE);
      const sighted = weapon.bounces > 0 || world.map.lineOfSight(selfX, selfY, world.playerX[enemy]!, world.playerY[enemy]!);
      // A mortar fired into a wall two metres away kills its owner, so splash
      // weapons hold fire at point-blank range.
      const tooClose = weapon.splashRadius > 0 && distance < weapon.splashRadius;
      canFire = inRange && sighted && !tooClose && alignment >= skill.fireCone;
    }
    command.aimX = quantize(aimX);
    command.aimY = quantize(aimY);

    // --- movement ----------------------------------------------------------
    this.steer(world, slot, skill, tick);
    command.moveX = quantizeAxis(this.move.x);
    command.moveY = quantizeAxis(this.move.y);

    // --- trigger and loadout ------------------------------------------------
    if (canFire && (hash(tick, slot) & 0xff) < skill.trigger) command.buttons |= INPUT_BUTTON_FIRE;
    if (this.goal[slot] !== GOAL_FIGHT && world.playerBoostCharge[slot]! > 30) command.buttons |= INPUT_BUTTON_BOOST;
    const best = this.bestWeapon(world, slot);
    if (best !== world.playerWeapon[slot]) command.weaponRequest = best;
  }

  private detectStuck(world: BattleWorld, slot: number): void {
    const moved = Math.abs(world.playerX[slot]! - this.lastX[slot]!) + Math.abs(world.playerY[slot]! - this.lastY[slot]!);
    this.lastX[slot] = world.playerX[slot]!;
    this.lastY[slot] = world.playerY[slot]!;
    if (moved < TILE_UNITS / 8) {
      this.stuckTicks[slot] = this.stuckTicks[slot]! + 1;
      if (this.stuckTicks[slot]! > 20) {
        // Committed to the wrong side of an obstacle: commit to the other one.
        this.avoidSign[slot] = this.avoidSign[slot]! > 0 ? -1 : 1;
        this.strafeSign[slot] = this.strafeSign[slot]! > 0 ? -1 : 1;
        this.stuckTicks[slot] = 0;
        this.decideAt[slot] = -1;
      }
    } else if (this.stuckTicks[slot]! > 0) {
      this.stuckTicks[slot] = this.stuckTicks[slot]! - 1;
    }
  }

  private decide(world: BattleWorld, slot: number, skill: BotDifficulty, tick: number): void {
    // Chassis purchases use the same authoritative credit path as a human
    // control message. The hash keeps the upgrade cadence deterministic while
    // the fixed roster assignment still gives a match four roles immediately.
    const nextChassis = (world.playerChassis[slot]! % CHASSIS_COUNT) + 1;
    if (world.playerCredits[slot]! >= chassisById(nextChassis).unlockCost && (hash(tick, slot * 17 + 9) & 0xff) < 4) {
      world.selectChassis(slot + 1, nextChassis);
    }
    const enemy = nearestEnemy(world, slot);
    this.goalTarget[slot] = enemy;
    const vitality = world.playerHealth[slot]! + world.playerArmor[slot]!;
    const hurt = vitality * 100 < skill.retreatHealth * 200;
    const weakWeapon = world.playerWeapon[slot] === SPAWN_WEAPON;
    const greedy = (hash(tick, slot * 7 + 3) & 0xff) < skill.greed;

    const pad = this.choosePickup(world, slot, hurt, weakWeapon || greedy);
    if (pad >= 0 && (hurt || weakWeapon || greedy)) {
      this.goal[slot] = GOAL_PICKUP;
      this.goalX[slot] = world.pickupX[pad]!;
      this.goalY[slot] = world.pickupY[pad]!;
      return;
    }
    if (enemy < 0) {
      this.goal[slot] = GOAL_PICKUP;
      this.goalX[slot] = world.pickupX[(slot * 3) % MAX_PICKUPS]!;
      this.goalY[slot] = world.pickupY[(slot * 3) % MAX_PICKUPS]!;
      return;
    }
    const sighted = world.map.lineOfSight(world.playerX[slot]!, world.playerY[slot]!, world.playerX[enemy]!, world.playerY[enemy]!);
    this.goal[slot] = sighted ? GOAL_FIGHT : GOAL_HUNT;
    this.goalX[slot] = world.playerX[enemy]!;
    this.goalY[slot] = world.playerY[enemy]!;
    if ((hash(tick, slot * 11 + 5) & 0x3f) === 0) this.strafeSign[slot] = this.strafeSign[slot]! > 0 ? -1 : 1;
  }

  /** The nearest live pad worth walking to, or -1. */
  private choosePickup(world: BattleWorld, slot: number, hurt: boolean, wantWeapon: boolean): number {
    let best = -1;
    let bestCost = Number.MAX_SAFE_INTEGER;
    const currentPreference = weaponById(world.playerWeapon[slot]!).botPreference;
    for (let index = 0; index < MAX_PICKUPS; index += 1) {
      if (world.pickupActive[index] === 0) continue;
      const kind = world.pickupKind[index]!;
      const definition = pickupByKind(kind);
      let weight = 0;
      if (definition.weapon !== 0) {
        if (!canUseWeapon(world.playerChassis[slot]!, definition.weapon)) continue;
        const candidate = weaponById(definition.weapon);
        if (!wantWeapon) continue;
        if (candidate.botPreference <= currentPreference && world.ammo(slot + 1, definition.weapon) > 0) continue;
        weight = 256 - candidate.botPreference;
      } else if (kind === PICKUP_HEALTH) {
        if (!hurt) continue;
        weight = 0;
      } else if (kind === PICKUP_ARMOR) {
        if (world.playerArmor[slot]! > 40) continue;
        weight = hurt ? 32 : 128;
      } else if (kind === PICKUP_OVERDRIVE) {
        weight = 64;
      }
      const dx = (world.pickupX[index]! - world.playerX[slot]!) / TILE_UNITS;
      const dy = (world.pickupY[index]! - world.playerY[slot]!) / TILE_UNITS;
      const cost = dx * dx + dy * dy + weight * weight;
      if (cost < bestCost) {
        bestCost = cost;
        best = index;
      }
    }
    return best;
  }

  private steer(world: BattleWorld, slot: number, skill: BotDifficulty, tick: number): void {
    const selfX = world.playerX[slot]!;
    const selfY = world.playerY[slot]!;
    let desiredX = this.goalX[slot]! - selfX;
    let desiredY = this.goalY[slot]! - selfY;

    if (this.goal[slot] === GOAL_FIGHT) {
      const weapon = weaponById(world.playerWeapon[slot]!);
      // Every weapon wants a different distance: the scatter gun wants to be in
      // your face and the railgun wants to be across the map.
      const preferred = Math.trunc((weapon.projectileSpeed * weapon.lifetimeTicks * 45) / 100);
      const distance = length(desiredX, desiredY);
      if (distance > 0) {
        const approach = distance > preferred ? 256 : distance < Math.trunc(preferred / 2) ? -256 : 0;
        const alongX = Math.trunc((desiredX * approach) / distance);
        const alongY = Math.trunc((desiredY * approach) / distance);
        const sideways = this.strafeSign[slot]! * skill.strafe;
        const acrossX = Math.trunc((-desiredY * sideways) / distance);
        const acrossY = Math.trunc((desiredX * sideways) / distance);
        desiredX = alongX + acrossX;
        desiredY = alongY + acrossY;
      }
    }

    if (!normalizeInto(desiredX, desiredY, this.move)) {
      this.move.x = 0;
      this.move.y = 0;
      return;
    }

    // Obstacle avoidance: probe ahead, and if the way is blocked commit to one
    // side. The side is remembered so the bot does not dither in a doorway.
    const probe = TILE_UNITS * 3;
    const aheadX = selfX + Math.trunc((this.move.x * probe) / DIRECTION_SCALE);
    const aheadY = selfY + Math.trunc((this.move.y * probe) / DIRECTION_SCALE);
    if (!world.map.lineOfSight(selfX, selfY, aheadX, aheadY)) {
      const sign = this.avoidSign[slot]!;
      const turnedX = this.move.x - sign * this.move.y;
      const turnedY = this.move.y + sign * this.move.x;
      const sideX = selfX + Math.trunc((turnedX * probe) / (DIRECTION_SCALE * 2));
      const sideY = selfY + Math.trunc((turnedY * probe) / (DIRECTION_SCALE * 2));
      if (!world.map.lineOfSight(selfX, selfY, sideX, sideY)) {
        this.avoidSign[slot] = sign > 0 ? -1 : 1;
      }
      const chosen = this.avoidSign[slot]!;
      if (!normalizeInto(this.move.x - chosen * this.move.y, this.move.y + chosen * this.move.x, this.move)) {
        this.move.x = 0;
        this.move.y = 0;
      }
    } else if ((hash(tick, slot * 13 + 7) & 0x7f) === 0) {
      // Occasionally re-open the avoidance choice so a bot that committed to a
      // bad side in open ground is not stuck with it forever.
      this.avoidSign[slot] = this.avoidSign[slot]! > 0 ? -1 : 1;
    }
  }

  private bestWeapon(world: BattleWorld, slot: number): number {
    let best = SPAWN_WEAPON;
    let bestPreference = weaponById(SPAWN_WEAPON).botPreference;
    for (let weaponId = 1; weaponId <= WEAPON_COUNT; weaponId += 1) {
      const definition = weaponById(weaponId);
      if (!canUseWeapon(world.playerChassis[slot]!, weaponId)) continue;
      if (definition.maximumAmmo > 0 && world.playerAmmo[slot * WEAPON_COUNT + weaponId - 1] === 0) continue;
      if (definition.botPreference <= bestPreference) continue;
      best = weaponId;
      bestPreference = definition.botPreference;
    }
    return best;
  }
}

export function nearestEnemy(world: BattleWorld, slot: number): number {
  let best = -1;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  const team = world.playerTeam[slot]!;
  for (let target = 0; target < MAX_PLAYERS; target += 1) {
    if (target === slot || world.playerActive[target] === 0 || world.playerHealth[target]! <= 0) continue;
    if (team !== 0 && world.playerTeam[target] === team) continue;
    const dx = (world.playerX[target]! - world.playerX[slot]!) / TILE_UNITS;
    const dy = (world.playerY[target]! - world.playerY[slot]!) / TILE_UNITS;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

function quantize(value: number): number {
  return clamp(Math.trunc((value * 127) / DIRECTION_SCALE), -127, 127);
}

function quantizeAxis(value: number): number {
  // The world renormalises the move vector, so a bot only has to say which way.
  return value > 90 ? 1 : value < -90 ? -1 : 0;
}

function hash(a: number, b: number): number {
  let value = (a * 0x9e37_79b1 + b * 0x85eb_ca6b) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x2545_f491) >>> 0;
  return (value ^ (value >>> 13)) >>> 0;
}
