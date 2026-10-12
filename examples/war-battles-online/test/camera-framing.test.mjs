import assert from "node:assert/strict";
import test from "node:test";

import { LandwardCameraFramer } from "../core/camera-framing.ts";
import { hexCentreAtSimulation } from "../core/hex-landscape.ts";
import { isometricScreenX, isometricScreenY } from "../core/isometric-projection.ts";
import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import { WORLD_HEX_COUNT, buildWorldPlan, worldHexQ, worldHexR } from "../core/world-plan.ts";

function landAnchors(plan) {
  const anchors = [];
  for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
    if (plan.land[index] === 0) continue;
    const centre = hexCentreAtSimulation(worldHexQ(index), worldHexR(index));
    anchors.push({ x: isometricScreenX(centre.x, centre.y), y: isometricScreenY(centre.x, centre.y) });
  }
  return anchors;
}

test("the local camera frames the plan-owned island landward at both coasts", () => {
  const plan = buildWorldPlan(DEFAULT_ARENA_SEED);
  const framer = new LandwardCameraFramer(plan);
  const anchors = landAnchors(plan).sort((a, b) => a.y - b.y);
  const target = { x: 0, y: 0 };
  const north = anchors[0];
  const south = anchors.at(-1);
  framer.frame(north.x, north.y, 320, 180, target);
  assert.ok(target.y > north.y + 20, "northern coast must reveal more battlefield below the driver");
  assert.ok(target.y - north.y <= 45, "the driver must stay in the central half of the view");
  framer.frame(south.x, south.y, 320, 180, target);
  assert.ok(target.y < south.y - 20, "southern coast must reveal more battlefield above the driver");
  assert.ok(south.y - target.y <= 45);

  const middle = anchors[Math.floor(anchors.length / 2)];
  framer.frame(middle.x, middle.y, 320, 180, target);
  assert.ok(Math.hypot(target.x - middle.x, target.y - middle.y) < 10, "interior play stays close to centered");
});

test("shoreline framing is continuous under a small actor movement and reuses caller storage", () => {
  const plan = buildWorldPlan(DEFAULT_ARENA_SEED);
  const framer = new LandwardCameraFramer(plan);
  const north = landAnchors(plan).sort((a, b) => a.y - b.y)[0];
  const target = { x: 0, y: 0 };
  framer.frame(north.x, north.y, 320, 180, target);
  const previousX = target.x;
  const previousY = target.y;
  framer.frame(north.x + 8, north.y + 8, 320, 180, target);
  assert.ok(Math.hypot(target.x - previousX, target.y - previousY) < 16);
  assert.equal(framer.seed, DEFAULT_ARENA_SEED);
  assert.ok(Math.abs(target.x - (north.x + 8)) <= 80);
  assert.ok(Math.abs(target.y - (north.y + 8)) <= 45);
});
