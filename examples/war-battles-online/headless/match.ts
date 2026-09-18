import {
  MAX_PLAYERS,
  SNAPSHOT_BYTES,
  UPGRADE_ARMOR,
  UPGRADE_DAMAGE,
  UPGRADE_MOBILITY,
  BattleWorld,
  type PlayerView,
} from "../core/index.ts";
import { emptyCommand, readReplayCommand, readReplayHeader } from "./replay.ts";

export interface RollbackPlan {
  readonly restoreTick: number;
  readonly triggerTick: number;
}

export interface MatchSummary {
  readonly matchId: number;
  readonly players: number;
  readonly ticks: number;
  readonly stateHash: number;
  readonly alivePlayers: number;
  readonly totalKills: number;
  readonly rollbackCount: number;
  readonly replayBodyHash: number;
}

export function runReplay(replay: Uint8Array, rollback?: Readonly<RollbackPlan>): MatchSummary {
  const header = readReplayHeader(replay);
  validateRollback(rollback, header.ticks);
  const world = new BattleWorld(header.matchId);
  initializeWorld(world, header.players);
  const command = emptyCommand();
  const snapshot = rollback === undefined ? undefined : new Uint8Array(SNAPSHOT_BYTES);
  let rollbackCount = 0;

  for (let tick = 1; tick <= header.ticks; tick += 1) {
    submitTick(world, replay, header, command, tick);
    world.step();
    if (rollback !== undefined && tick === rollback.restoreTick) world.writeSnapshot(snapshot!);
    if (rollback !== undefined && tick === rollback.triggerTick) {
      world.restoreSnapshot(snapshot!);
      for (let replayTick = rollback.restoreTick + 1; replayTick <= rollback.triggerTick; replayTick += 1) {
        submitTick(world, replay, header, command, replayTick);
        world.step();
      }
      rollbackCount += 1;
    }
  }

  const view = emptyPlayerView();
  let alivePlayers = 0;
  let totalKills = 0;
  for (let playerId = 1; playerId <= header.players; playerId += 1) {
    world.readPlayer(playerId, view);
    if (view.health > 0) alivePlayers += 1;
    totalKills += view.score;
  }
  return Object.freeze({
    matchId: header.matchId,
    players: header.players,
    ticks: header.ticks,
    stateHash: world.stateHash(),
    alivePlayers,
    totalKills,
    rollbackCount,
    replayBodyHash: header.bodyHash,
  });
}

function initializeWorld(world: BattleWorld, players: number): void {
  const firstTeamSize = Math.ceil(players / 2);
  for (let playerId = 1; playerId <= players; playerId += 1) {
    const firstTeam = playerId <= firstTeamSize;
    const teamIndex = firstTeam ? playerId - 1 : playerId - firstTeamSize - 1;
    world.addPlayer(playerId, firstTeam ? 1 : 2, firstTeam ? -5_000 : 5_000, -7_500 + teamIndex * 1_000);
    world.setWeapon(playerId, ((playerId - 1) % 3) + 1);
    world.grantCredits(playerId, 2_500);
    const levels = 1 + (playerId % 3);
    for (let level = 0; level < levels; level += 1) {
      world.applyUpgrade(playerId, UPGRADE_DAMAGE);
      world.applyUpgrade(playerId, UPGRADE_MOBILITY);
      world.applyUpgrade(playerId, UPGRADE_ARMOR);
    }
  }
}

function submitTick(
  world: BattleWorld,
  replay: Uint8Array,
  header: ReturnType<typeof readReplayHeader>,
  command: ReturnType<typeof emptyCommand>,
  tick: number,
): void {
  for (let playerId = 1; playerId <= header.players; playerId += 1) {
    readReplayCommand(replay, header, tick, playerId, command);
    if (!world.submitInput(command)) throw new Error(`input rejected at tick ${tick}, player ${playerId}`);
  }
}

function validateRollback(rollback: Readonly<RollbackPlan> | undefined, ticks: number): void {
  if (rollback === undefined) return;
  if (
    !Number.isInteger(rollback.restoreTick) ||
    !Number.isInteger(rollback.triggerTick) ||
    rollback.restoreTick < 1 ||
    rollback.triggerTick <= rollback.restoreTick ||
    rollback.triggerTick > ticks
  ) throw new RangeError("rollback plan must satisfy 1 <= restoreTick < triggerTick <= ticks");
}

function emptyPlayerView(): PlayerView {
  return {
    active: false,
    entityId: 0,
    playerId: 0,
    team: 0,
    x: 0,
    y: 0,
    aimX: 0,
    aimY: 0,
    health: 0,
    score: 0,
    credits: 0,
    weaponId: 0,
    damageLevel: 0,
    mobilityLevel: 0,
    armorLevel: 0,
  };
}

export const HEADLESS_MAX_PLAYERS = MAX_PLAYERS;
