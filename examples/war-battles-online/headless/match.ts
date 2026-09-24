import { MAX_PLAYERS, SNAPSHOT_BYTES, createPlayerView, type PlayerView } from "../core/index.ts";
import { initializeFixtureWorld } from "./fixture.ts";
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
  const world = initializeFixtureWorld(header.matchId, header.players, header.seed);
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

function submitTick(
  world: ReturnType<typeof initializeFixtureWorld>,
  replay: Uint8Array,
  header: ReturnType<typeof readReplayHeader>,
  command: ReturnType<typeof emptyCommand>,
  tick: number,
): void {
  for (let playerId = 1; playerId <= header.players; playerId += 1) {
    readReplayCommand(replay, header, tick, playerId, command);
    // A dead tank sends nothing this bot could act on, so a refused command is
    // expected; only a command for a tick outside the window is a fault.
    world.submitInput(command);
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
  )
    throw new RangeError("rollback plan must satisfy 1 <= restoreTick < triggerTick <= ticks");
}

function emptyPlayerView(): PlayerView {
  return createPlayerView();
}

export const HEADLESS_MAX_PLAYERS = MAX_PLAYERS;
