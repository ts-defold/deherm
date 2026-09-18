import {
  DIRECTION_SCALE,
  INPUT_BUTTON_FIRE,
  MAX_PLAYERS,
  WORLD_MAX,
  WORLD_MIN,
} from "./constants.ts";
import {
  UPGRADE_ARMOR,
  UPGRADE_DAMAGE,
  UPGRADE_MOBILITY,
  WEAPON_AUTOCANNON,
  WEAPON_CANNON,
  WEAPON_RAILGUN,
} from "./content.ts";
import type { InputCommand } from "./protocol.ts";
import { BattleWorld } from "./world.ts";

export const PLAYABLE_MATCH_ID = 77;
export const LOCAL_PLAYER_ID = 1;
export const TEAM_SIZE = MAX_PLAYERS / 2;
export const AUTO_RESTART_TICKS = 180;

export interface PlayControls {
  moveX: number;
  moveY: number;
  fire: boolean;
}

/**
 * Deterministic orchestration used by both the Defold component and headless
 * tests. Commands are allocated once and rewritten in place every tick.
 */
export class PlayableBattle {
  world: BattleWorld;
  round = 1;
  restartCountdown = 0;

  private readonly commands: InputCommand[];
  private localMoveX = 0;
  private localMoveY = 0;
  private localAimX = DIRECTION_SCALE / 2;
  private localAimY = 0;
  private localFire = false;

  constructor() {
    this.world = new BattleWorld(PLAYABLE_MATCH_ID);
    this.commands = Array.from({ length: MAX_PLAYERS }, (_, slot) => emptyCommand(slot + 1));
    this.populateWorld();
  }

  setControls(controls: Readonly<PlayControls>): void {
    this.localMoveX = axis(controls.moveX);
    this.localMoveY = axis(controls.moveY);
    this.localFire = controls.fire;
    if (this.localMoveX !== 0 || this.localMoveY !== 0) {
      const direction = quantizeDirection(this.localMoveX, this.localMoveY);
      this.localAimX = direction.x;
      this.localAimY = direction.y;
    }
  }

  step(): void {
    const tick = this.world.tick + 1;
    this.stageLocalCommand(this.commands[0]!, tick);
    this.world.submitInput(this.commands[0]!);
    for (let playerId = 2; playerId <= MAX_PLAYERS; playerId += 1) {
      const command = this.commands[playerId - 1]!;
      this.stageBotCommand(command, playerId, tick);
      this.world.submitInput(command);
    }
    this.world.step();

    if (this.world.playerHealth[LOCAL_PLAYER_ID - 1]! <= 0) {
      this.restartCountdown += 1;
      if (this.restartCountdown >= AUTO_RESTART_TICKS) this.restart();
    } else {
      this.restartCountdown = 0;
    }
  }

  restart(): void {
    this.round += 1;
    this.restartCountdown = 0;
    this.world = new BattleWorld(PLAYABLE_MATCH_ID);
    this.populateWorld();
  }

  buyUpgrade(upgradeId: number): boolean {
    if (upgradeId !== UPGRADE_DAMAGE && upgradeId !== UPGRADE_MOBILITY && upgradeId !== UPGRADE_ARMOR) {
      return false;
    }
    return this.world.applyUpgrade(LOCAL_PLAYER_ID, upgradeId);
  }

  private populateWorld(): void {
    for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
      this.world.addPlayer(playerId, playerId <= TEAM_SIZE ? 1 : 2);
      this.world.setWeapon(playerId, botWeapon(playerId));
    }
    this.world.setWeapon(LOCAL_PLAYER_ID, WEAPON_CANNON);
    this.world.grantCredits(LOCAL_PLAYER_ID, 600);
  }

  private stageLocalCommand(command: InputCommand, tick: number): void {
    stageCommand(
      command,
      tick,
      this.localMoveX,
      this.localMoveY,
      this.localAimX,
      this.localAimY,
      this.localFire,
    );
  }

  private stageBotCommand(command: InputCommand, playerId: number, tick: number): void {
    const slot = playerId - 1;
    if (this.world.playerHealth[slot]! <= 0) {
      stageCommand(command, tick, 0, 0, 0, 0, false);
      return;
    }

    const target = nearestLivingEnemy(this.world, slot);
    if (target < 0) {
      stageCommand(command, tick, 0, 0, 0, 0, false);
      return;
    }
    const dx = this.world.playerX[target]! - this.world.playerX[slot]!;
    const dy = this.world.playerY[target]! - this.world.playerY[slot]!;
    const aim = quantizeDirection(dx, dy);
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    const orbit = ((Math.trunc(tick / 90) + playerId) & 1) === 0 ? 1 : -1;
    const moveX = distance > 4_000 ? axis(dx) : axis(-dy) * orbit;
    const moveY = distance > 4_000 ? axis(dy) : axis(dx) * orbit;
    stageCommand(command, tick, moveX, moveY, aim.x, aim.y, distance < 13_000);
  }
}

export interface ScreenPoint {
  x: number;
  y: number;
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

export function arenaSpan(): number {
  return WORLD_MAX - WORLD_MIN;
}

function nearestLivingEnemy(world: BattleWorld, slot: number): number {
  let best = -1;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (let target = 0; target < MAX_PLAYERS; target += 1) {
    if (target === slot || world.playerHealth[target]! <= 0 || world.playerTeam[target] === world.playerTeam[slot]) continue;
    const dx = world.playerX[target]! - world.playerX[slot]!;
    const dy = world.playerY[target]! - world.playerY[slot]!;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

function stageCommand(
  command: InputCommand,
  tick: number,
  moveX: number,
  moveY: number,
  aimX: number,
  aimY: number,
  fire: boolean,
): void {
  command.tick = tick;
  command.sequence = tick & 0xffff;
  command.moveX = axis(moveX);
  command.moveY = axis(moveY);
  command.aimX = clampDirection(aimX);
  command.aimY = clampDirection(aimY);
  command.buttons = fire ? INPUT_BUTTON_FIRE : 0;
  command.fireSubtick = fire ? 127 : 255;
  command.latestSnapshotTick = tick > 0 ? tick - 1 : 0;
  command.snapshotAckBits = 0xffff_ffff;
}

function emptyCommand(playerId: number): InputCommand {
  return {
    matchId: PLAYABLE_MATCH_ID,
    playerId,
    tick: 1,
    sequence: 1,
    moveX: 0,
    moveY: 0,
    aimX: 127,
    aimY: 0,
    buttons: 0,
    fireSubtick: 255,
    latestSnapshotTick: 0,
    snapshotAckBits: 0,
  };
}

function quantizeDirection(x: number, y: number): ScreenPoint {
  const magnitude = Math.max(Math.abs(x), Math.abs(y));
  if (magnitude === 0) return { x: 0, y: 0 };
  return {
    x: clampDirection(Math.trunc(x * 127 / magnitude)),
    y: clampDirection(Math.trunc(y * 127 / magnitude)),
  };
}

function clampDirection(value: number): number {
  const integer = Math.trunc(value);
  return integer < -127 ? -127 : integer > 127 ? 127 : integer;
}

function axis(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function botWeapon(playerId: number): number {
  const selection = playerId % 3;
  return selection === 0 ? WEAPON_RAILGUN : selection === 1 ? WEAPON_CANNON : WEAPON_AUTOCANNON;
}
