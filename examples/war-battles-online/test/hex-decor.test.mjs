import assert from "node:assert/strict";
import { test } from "node:test";
import { ArenaMap, cellCentreX, cellCentreY } from "../core/arena.ts";
import {
  ARENA_DECOR_ROLE_CAUTION_PAINT,
  ARENA_DECOR_ROLE_FIELD_FLOWERS,
  ARENA_DECOR_ROLE_GRASS,
  ARENA_DECOR_ROLE_OIL_SPILL,
  ARENA_DECOR_ROLE_SCORCH,
  ARENA_DECOR_ROLE_SHELL_CASES,
  ARENA_DECOR_ROLE_STONES,
  ARENA_DECOR_ROLE_TRACKS,
  ARENA_VISUAL_CELL_COUNT,
  projectArenaVisualRoles,
} from "../core/arena-visual.ts";
import { MAP_WIDTH } from "../core/constants.ts";
import { worldPlanSurfaceRoleAtSimulation } from "../core/world-plan.ts";
import { DEFAULT_ARENA_SEED } from "../core/playable.ts";

const ambientByBiome = {
  G: new Set([ARENA_DECOR_ROLE_FIELD_FLOWERS, ARENA_DECOR_ROLE_GRASS, ARENA_DECOR_ROLE_STONES]),
  D: new Set([ARENA_DECOR_ROLE_TRACKS, ARENA_DECOR_ROLE_STONES, ARENA_DECOR_ROLE_SHELL_CASES]),
  B: new Set([ARENA_DECOR_ROLE_STONES, ARENA_DECOR_ROLE_SCORCH]),
  A: new Set([ARENA_DECOR_ROLE_STONES, ARENA_DECOR_ROLE_SCORCH]),
  M: new Set([ARENA_DECOR_ROLE_CAUTION_PAINT, ARENA_DECOR_ROLE_OIL_SPILL, ARENA_DECOR_ROLE_SHELL_CASES]),
};
const ambientRoles = new Set(Object.values(ambientByBiome).flatMap((roles) => [...roles]));

test("seeded ambient props follow the rendered hex biome without changing collision", () => {
  for (const seed of [DEFAULT_ARENA_SEED, 0, 0xffff_ffff]) {
    const map = new ArenaMap(seed);
    const originalCells = map.cells.slice();
    const ground = new Uint16Array(ARENA_VISUAL_CELL_COUNT);
    const decor = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
    const marks = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
    projectArenaVisualRoles(map, seed, ground, decor, marks);
    const repeated = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
    projectArenaVisualRoles(map, seed, ground, repeated, marks);
    assert.deepEqual(repeated, decor, "the same seed produces the same ambient roles");
    assert.deepEqual(map.cells, originalCells, "presentation never mutates authoritative collision");
    const counts = { G: 0, D: 0, B: 0, A: 0, M: 0 };
    for (let index = 0; index < decor.length; index++) {
      const role = decor[index];
      if (!ambientRoles.has(role)) continue;
      const cellX = index % MAP_WIDTH;
      const cellY = Math.floor(index / MAP_WIDTH);
      const biome = worldPlanSurfaceRoleAtSimulation(map.plan, cellCentreX(cellX), cellCentreY(cellY));
      assert.ok(ambientByBiome[biome]?.has(role), `role ${role} on ${biome} at ${cellX},${cellY}`);
      counts[biome]++;
    }
    assert.ok(counts.G > 0 && counts.D > 0, `the broad meadow and earth biomes have detail: ${JSON.stringify(counts)}`);
  }
});
