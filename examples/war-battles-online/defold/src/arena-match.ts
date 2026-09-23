// The match every Defold component in the arena reads from.
//
// One module-level instance, created lazily. `arena.script.ts` is the only
// component that advances it; hulls, turrets and projectiles only read. Defold
// does not guarantee update order inside a collection, so a tank may render the
// state of the previous frame - which is invisible at 60 Hz and much simpler
// than a frame barrier.
//
// Offline it drives a `PlayableBattle`. Online it drives a `BattleClient` over
// the same transport boundary the headless tests use; both expose a
// `BattleWorld`, so nothing downstream knows or cares which one is running.

import {
  BattleClient,
  BattleWorld,
  DIRECTION_SCALE,
  PlayableBattle,
  TICK_MILLISECONDS,
  UNITS_PER_PIXEL,
  WORLD_PIXEL_ORIGIN_X,
  WORLD_PIXEL_ORIGIN_Y,
  type PlayControls,
} from "./generated-war-battles/index";
import { hmrPersistentState } from "@deherm/project";

export const MAX_VISIBLE_PROJECTILES = 64;
export const DEFAULT_ROSTER = 8;

export type MatchMode = "offline" | "online";

export interface ArenaOptions {
  players: number;
  botSkill: number;
  /** Zero or omitted keeps the built-in arena layout. */
  mapSeed?: number;
}

/**
 * Wraps whichever of the two drivers is running. `world` is undefined only
 * before an online client has been welcomed.
 */
export class ArenaMatch {
  mode: MatchMode = "offline";
  battle: PlayableBattle;
  client?: BattleClient;
  /** False until the player has taken control or the opening demo has ended. */
  engaged = false;
  ticksStepped = 0;

  private accumulator = 0;
  private readonly controls: PlayControls = { moveX: 0, moveY: 0, fire: false, boost: false, weapon: 0 };

  constructor(options: ArenaOptions) {
    this.battle = options.mapSeed === undefined || options.mapSeed === 0
      ? new PlayableBattle({ players: options.players, botSkill: options.botSkill })
      : new PlayableBattle({ players: options.players, botSkill: options.botSkill, mapSeed: options.mapSeed });
  }

  get world(): BattleWorld | undefined {
    return this.mode === "online" ? this.client?.world : this.battle.world;
  }

  /** The slot this screen is following, or -1 while an online client waits. */
  get localSlot(): number {
    if (this.mode === "online") return this.client === undefined ? -1 : this.client.playerId - 1;
    return 0;
  }

  setControls(moveX: number, moveY: number, fire: boolean, boost: boolean, weapon: number): void {
    this.controls.moveX = moveX;
    this.controls.moveY = moveY;
    this.controls.fire = fire;
    this.controls.boost = boost;
    this.controls.weapon = weapon;
    if (this.mode === "online") this.client?.setControls(this.controls);
    else this.battle.setControls(this.controls);
  }

  /** Starts a fresh offline round. The authoritative server owns online restarts. */
  restart(): boolean {
    if (this.mode !== "offline") return false;
    this.controls.moveX = 0;
    this.controls.moveY = 0;
    this.controls.fire = false;
    this.controls.boost = false;
    this.controls.weapon = 0;
    this.accumulator = 0;
    this.battle.restart();
    return true;
  }

  /** Advances by `dt` seconds of wall clock, in whole 60 Hz ticks. */
  advance(dt: number, maximumSteps = 5): number {
    if (!this.engaged) return 0;
    if (this.mode === "online") {
      const client = this.client;
      if (client === undefined) return 0;
      const stepped = client.update(dt * 1000, maximumSteps);
      this.ticksStepped += stepped;
      return stepped;
    }
    this.accumulator += dt * 1000;
    let steps = 0;
    while (this.accumulator >= TICK_MILLISECONDS && steps < maximumSteps) {
      this.accumulator -= TICK_MILLISECONDS;
      this.battle.step();
      steps += 1;
    }
    if (steps === maximumSteps) this.accumulator = 0;
    this.ticksStepped += steps;
    return steps;
  }
}

const persistent = hmrPersistentState("war-battles/arena-match", () => ({ current: undefined as ArenaMatch | undefined }));

export function arenaMatch(): ArenaMatch | undefined {
  return persistent.value.current;
}

export function startArena(options: ArenaOptions): ArenaMatch {
  persistent.value.current = new ArenaMatch(options);
  return persistent.value.current;
}

/** Simulation units to Defold world pixels, and back. */
export function pixelX(x: number): number {
  return x / UNITS_PER_PIXEL + WORLD_PIXEL_ORIGIN_X;
}

export function pixelY(y: number): number {
  return y / UNITS_PER_PIXEL + WORLD_PIXEL_ORIGIN_Y;
}

/** A Q8 direction as radians, for `vmath.quatRotationZ`. */
export function directionRadians(x: number, y: number): number {
  if (x === 0 && y === 0) return 0;
  return Math.atan2(y / DIRECTION_SCALE, x / DIRECTION_SCALE);
}
