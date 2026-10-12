import assert from "node:assert/strict";
import { test } from "node:test";

import { HERO_HIT_REACTION_SECONDS, nextHeroHitSeconds } from "../defold/src/hero-presentation.ts";
import { REMOTE_CUE_EJECT, REMOTE_CUE_NONE, REMOTE_CUE_REARM, remoteLifecycleCue } from "../core/remote-lifecycle.ts";
import { PLAYER_MODE_DEAD, PLAYER_MODE_INFANTRY, PLAYER_MODE_TANK } from "../core/index.ts";

test("infantry damage starts a bounded visual reaction without changing health", () => {
  const previous = 24;
  const current = 19;
  const remaining = nextHeroHitSeconds(previous, current, 0, 1 / 60, false);
  assert.equal(remaining, HERO_HIT_REACTION_SECONDS);
  assert.equal(current, 19);
  assert.ok(nextHeroHitSeconds(current, current, remaining, 1 / 60, false) < remaining);
});

test("ejection and healing never fake a hit, and dead players use death instead", () => {
  assert.equal(nextHeroHitSeconds(100, 24, 0, 1 / 60, true), 0);
  assert.equal(nextHeroHitSeconds(12, 18, 0, 1 / 60, false), 0);
  assert.equal(nextHeroHitSeconds(12, 0, 0, 1 / 60, false), 0);
  assert.equal(nextHeroHitSeconds(12, 12, 0.05, 1, false), 0);
});

test("snapshot-derived remote lifecycle cues explain tank/driver changes without a first-sighting flash", () => {
  assert.equal(remoteLifecycleCue(-1, -1, PLAYER_MODE_TANK, 1), REMOTE_CUE_NONE);
  assert.equal(remoteLifecycleCue(PLAYER_MODE_TANK, 1, PLAYER_MODE_TANK, 1), REMOTE_CUE_NONE);
  assert.equal(remoteLifecycleCue(PLAYER_MODE_TANK, 1, PLAYER_MODE_INFANTRY, 1), REMOTE_CUE_EJECT);
  assert.equal(remoteLifecycleCue(PLAYER_MODE_TANK, 1, PLAYER_MODE_DEAD, 1), REMOTE_CUE_EJECT);
  assert.equal(remoteLifecycleCue(PLAYER_MODE_INFANTRY, 1, PLAYER_MODE_TANK, 2), REMOTE_CUE_REARM);
  assert.equal(remoteLifecycleCue(PLAYER_MODE_DEAD, 1, PLAYER_MODE_TANK, 2), REMOTE_CUE_REARM);
  assert.equal(remoteLifecycleCue(PLAYER_MODE_TANK, 1, PLAYER_MODE_TANK, 2), REMOTE_CUE_REARM);
  assert.equal(remoteLifecycleCue(PLAYER_MODE_INFANTRY, 1, PLAYER_MODE_DEAD, 1), REMOTE_CUE_NONE);
});
