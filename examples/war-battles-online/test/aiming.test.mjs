import assert from "node:assert/strict";
import test from "node:test";

import { botAimErrorBudget, BOT_DIFFICULTIES } from "../core/bots.ts";
import { BattleClient } from "../core/client.ts";
import { DIRECTION_SCALE, TILE_UNITS } from "../core/constants.ts";
import { WEAPON_RICOCHET } from "../core/content.ts";
import { assistedAim } from "../core/playable.ts";
import { createInputCommand } from "../core/protocol.ts";
import { BattleWorld } from "../core/world.ts";

function aimingWorld() {
  const world = new BattleWorld(871);
  world.addPlayer(1);
  world.addPlayer(2);
  world.addPlayer(3);
  world.setWeapon(1, WEAPON_RICOCHET);
  world.playerX[0] = 0;
  world.playerY[0] = 0;
  world.playerX[1] = 4 * TILE_UNITS;
  world.playerY[1] = 2 * TILE_UNITS;
  world.playerX[2] = -TILE_UNITS;
  world.playerY[2] = 0;
  return world;
}

test("keyboard assist bends manual aim without locking onto a closer rear enemy", () => {
  const world = aimingWorld();
  const aim = { x: DIRECTION_SCALE, y: 0 };
  assert.equal(assistedAim(world, 0, aim), true);
  assert.ok(aim.x > 230, "the player still chooses the main aim direction");
  assert.ok(aim.y > 0 && aim.y < 70, "assist is a small pull, not an exact target lock");

  world.playerActive[1] = 0;
  aim.x = DIRECTION_SCALE;
  aim.y = 0;
  assert.equal(assistedAim(world, 0, aim), false, "a rear target never auto-spins the turret");
  assert.deepEqual(aim, { x: DIRECTION_SCALE, y: 0 });
});

test("online explicit pointing aim bypasses assist even when it is enabled", () => {
  const world = aimingWorld();
  const client = new BattleClient({ assistAim: true });
  client.playerId = 1;
  client.world = world;
  client.setAim(0, DIRECTION_SCALE);
  const command = createInputCommand(world.matchId, 1);
  client.stageCommand(command, 1);
  assert.equal(command.aimX, 0);
  assert.equal(command.aimY, 127);
});

test("every bot difficulty has a bounded error budget that grows with shot distance", () => {
  for (const skill of BOT_DIFFICULTIES) {
    const close = botAimErrorBudget(skill, 0);
    const distant = botAimErrorBudget(skill, 12 * TILE_UNITS);
    assert.equal(close, skill.aimError, skill.name);
    assert.ok(distant > close, `${skill.name} needs a long-range handicap`);
    assert.ok(distant <= 192, `${skill.name} must stay inside the declared bound`);
  }
  assert.equal(botAimErrorBudget(BOT_DIFFICULTIES[3], 1_000 * TILE_UNITS), 192);
});
