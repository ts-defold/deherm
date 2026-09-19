import {
  BattleWorld,
  UPGRADE_ARMOR,
  UPGRADE_DAMAGE,
  UPGRADE_MOBILITY,
} from "../core/index.ts";

/**
 * The one definition of the soak fixture's starting world.
 *
 * Both the replay writer and the replay reader build their world through this,
 * because a replay is only a stream of inputs: it reproduces a match only if
 * the state those inputs are applied to is identical, down to which tank has
 * which upgrade. Two copies of this setup would be two matches that happen to
 * agree until they do not.
 */
export function initializeFixtureWorld(matchId: number, players: number, seed: number): BattleWorld {
  const world = new BattleWorld(matchId, seed >>> 0);
  const firstTeamSize = Math.ceil(players / 2);
  for (let playerId = 1; playerId <= players; playerId += 1) {
    world.addPlayer(playerId, playerId <= firstTeamSize ? 1 : 2);
    // A spread of skills, keyed by the seed, so the fixture is a real match and
    // not thirty-two identical opponents.
    world.setBotSkill(playerId, (seed + playerId * 7) % 4);
    world.grantCredits(playerId, 2_500);
    const levels = 1 + (playerId % 3);
    for (let level = 0; level < levels; level += 1) {
      world.applyUpgrade(playerId, UPGRADE_DAMAGE);
      world.applyUpgrade(playerId, UPGRADE_MOBILITY);
      world.applyUpgrade(playerId, UPGRADE_ARMOR);
    }
  }
  return world;
}
