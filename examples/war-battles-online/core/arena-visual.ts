// Deterministic presentation roles for an authoritative ArenaMap.
//
// This module deliberately knows nothing about Defold tile ids. The art
// generator maps these compact semantic roles to each visual theme, while the
// checked .tilemap generator and the live Defold component both call this one
// projector. A seed therefore cannot change collision without changing the
// picture of the same cells.

import {
  ArenaMap,
  ARENA_BORDER_CELLS,
  CELL_FLOOR,
  CELL_WALL,
  cellCentreX,
  cellCentreY,
  cellOfX,
  cellOfY,
} from "./arena.ts";
import { MAP_HEIGHT, MAP_WIDTH, MAX_HAZARDS, MAX_PLAYERS, PLAYER_MODE_INFANTRY } from "./constants.ts";
import { mix32 } from "./fixed.ts";
import { type HexCell } from "./hex-landscape.ts";
import type { BattleWorld } from "./world.ts";
import { worldPlanSurfaceRoleAtSimulation } from "./world-plan.ts";

export const ARENA_VISUAL_CELL_COUNT = MAP_WIDTH * MAP_HEIGHT;

/** Only an exposed driver needs a replacement-tank pad highlighted. */
export function visibleTankDepotMarkerSite(world: BattleWorld, localSlot: number): number {
  if (
    localSlot < 0 ||
    localSlot >= MAX_PLAYERS ||
    world.playerActive[localSlot] === 0 ||
    world.playerHealth[localSlot]! <= 0 ||
    world.playerMode[localSlot] !== PLAYER_MODE_INFANTRY
  ) {
    return -1;
  }
  return world.nearestTankDepot(localSlot + 1);
}

export const ARENA_MEADOW_VARIANT_COUNT = 144;
export const ARENA_LANDSCAPE_MATERIAL_COUNT = 4;
export const ARENA_LANDSCAPE_MASK_COUNT = 16;
export const ARENA_LANDSCAPE_VARIANTS_PER_MASK = 4;
export const ARENA_GROUND_VARIANT_COUNT =
  ARENA_MEADOW_VARIANT_COUNT +
  (ARENA_LANDSCAPE_MATERIAL_COUNT - 1) * ARENA_LANDSCAPE_MASK_COUNT * ARENA_LANDSCAPE_VARIANTS_PER_MASK;
export const ARENA_GROUND_ROLE_WALL_BASE = ARENA_GROUND_VARIANT_COUNT;
export const ARENA_GROUND_ROLE_BORDER_BASE = ARENA_GROUND_ROLE_WALL_BASE + 16;
export const ARENA_GROUND_ROLE_COUNT = ARENA_GROUND_ROLE_BORDER_BASE + 16;

export const ARENA_MARK_ROLE_NONE = 0;
export const ARENA_MARK_ROLE_CRATE = 1;
export const ARENA_MARK_ROLE_SANDBAG = 2;
export const ARENA_MARK_ROLE_SPAWN = 3;
export const ARENA_MARK_ROLE_PICKUP = 4;
export const ARENA_MARK_ROLE_COUNT = 5;

export const ARENA_DECOR_ROLE_NONE = 0;
export const ARENA_DECOR_ROLE_FLOOR_VENT = 1;
export const ARENA_DECOR_ROLE_LAVA_FISSURE = 2;
export const ARENA_DECOR_ROLE_PICKUP_PEDESTAL = 3;
export const ARENA_DECOR_ROLE_PIPE_JUNCTION = 4;
export const ARENA_DECOR_ROLE_PIPE_RUN = 5;
export const ARENA_DECOR_ROLE_THERMAL_VENT = 6;
export const ARENA_DECOR_ROLE_GRASS = 7;
export const ARENA_DECOR_ROLE_STONES = 8;
export const ARENA_DECOR_ROLE_TRACKS = 9;
export const ARENA_DECOR_ROLE_SCORCH = 10;
export const ARENA_DECOR_ROLE_STAGING_PAD_BASE = 11;
export const ARENA_DECOR_ROLE_CRATER_BASE = ARENA_DECOR_ROLE_STAGING_PAD_BASE + 4;
export const ARENA_DECOR_ROLE_OIL_SPILL = ARENA_DECOR_ROLE_CRATER_BASE + 4;
export const ARENA_DECOR_ROLE_SHELL_CASES = ARENA_DECOR_ROLE_OIL_SPILL + 1;
export const ARENA_DECOR_ROLE_FIELD_FLOWERS = ARENA_DECOR_ROLE_SHELL_CASES + 1;
export const ARENA_DECOR_ROLE_CAUTION_PAINT = ARENA_DECOR_ROLE_FIELD_FLOWERS + 1;
export const ARENA_DECOR_ROLE_COUNT = ARENA_DECOR_ROLE_CAUTION_PAINT + 1;

/** A set bit means the orthogonal neighbour is another concrete wall. */
export const ARENA_WALL_MASK_BITS = { north: 1, south: 2, east: 4, west: 8 } as const;

/**
 * Explicit 4-neighbour mask grammar. Roles name the exposed bevels, not the
 * connected neighbours: mask 10 (south + west connected) exposes north-east.
 */
export const ARENA_WALL_MASK_TO_FRAME = [
  "centre",
  "centre",
  "centre",
  "centre",
  "centre",
  "sw",
  "nw",
  "w",
  "centre",
  "se",
  "ne",
  "e",
  "centre",
  "s",
  "n",
  "centre",
] as const;

export function arenaThemeIndex(seed: number, defaultSeed: number, themeCount: number): number {
  if (!Number.isInteger(themeCount) || themeCount < 1) throw new RangeError("themeCount must be a positive integer");
  return ((((seed >>> 0) ^ (defaultSeed >>> 0)) >>> 0) % themeCount) >>> 0;
}

/**
 * Broad deterministic landscape patches. Material zero is the shared meadow
 * substrate; 1..3 are earth, basalt, and scorch. The ellipses are intentionally
 * much larger than a tile so the battlefield reads as a world, not cell noise.
 */
export function arenaGroundMaterial(seed: number, cellX: number, cellY: number): number {
  let material = 0;
  let bestScore = 1_000_001;
  for (let patch = 0; patch < 6; patch += 1) {
    const key = mix32(seed ^ 0x4c41_4e44, patch + 1);
    const sourceX = 12 + (key % (MAP_WIDTH - 24));
    const sourceY = 10 + ((key >>> 8) % (MAP_HEIGHT - 20));
    const radiusX = 6 + ((key >>> 16) % 7);
    const radiusY = 5 + ((key >>> 24) % 5);
    for (let mirror = 0; mirror < 2; mirror += 1) {
      const centreX = mirror === 0 ? sourceX : MAP_WIDTH - 1 - sourceX;
      const centreY = mirror === 0 ? sourceY : MAP_HEIGHT - 1 - sourceY;
      const scaledX = Math.trunc(((cellX - centreX) * 1024) / radiusX);
      const scaledY = Math.trunc(((cellY - centreY) * 1024) / radiusY);
      const score = Math.trunc((scaledX * scaledX + scaledY * scaledY) / 1024);
      if (score <= 1024 && score < bestScore) {
        bestScore = score;
        material = 1 + (patch % (ARENA_LANDSCAPE_MATERIAL_COUNT - 1));
      }
    }
  }
  return material;
}

export function arenaGroundMaterialMask(seed: number, cellX: number, cellY: number, material: number): number {
  let mask = 0;
  if (arenaGroundMaterial(seed, cellX, cellY + 1) === material) mask |= ARENA_WALL_MASK_BITS.north;
  if (arenaGroundMaterial(seed, cellX, cellY - 1) === material) mask |= ARENA_WALL_MASK_BITS.south;
  if (arenaGroundMaterial(seed, cellX + 1, cellY) === material) mask |= ARENA_WALL_MASK_BITS.east;
  if (arenaGroundMaterial(seed, cellX - 1, cellY) === material) mask |= ARENA_WALL_MASK_BITS.west;
  return mask;
}

export function arenaGroundVariant(seed: number, cellX: number, cellY: number): number {
  const material = arenaGroundMaterial(seed, cellX, cellY);
  if (material === 0) {
    const phaseX = ((cellX % 12) + 12) % 12;
    const phaseY = ((cellY % 12) + 12) % 12;
    return phaseY * 12 + phaseX;
  }
  const mask = arenaGroundMaterialMask(seed, cellX, cellY, material);
  const phaseX = (cellX + (seed & 1)) & 1;
  const phaseY = (cellY + ((seed >>> 1) & 1)) & 1;
  const variation = phaseY * 2 + phaseX;
  return (
    ARENA_MEADOW_VARIANT_COUNT +
    (material - 1) * ARENA_LANDSCAPE_MASK_COUNT * ARENA_LANDSCAPE_VARIANTS_PER_MASK +
    mask * ARENA_LANDSCAPE_VARIANTS_PER_MASK +
    variation
  );
}

export function arenaWallMask(map: ArenaMap, cellX: number, cellY: number): number {
  let mask = 0;
  if (map.cellAt(cellX, cellY + 1) === CELL_WALL) mask |= ARENA_WALL_MASK_BITS.north;
  if (map.cellAt(cellX, cellY - 1) === CELL_WALL) mask |= ARENA_WALL_MASK_BITS.south;
  if (map.cellAt(cellX + 1, cellY) === CELL_WALL) mask |= ARENA_WALL_MASK_BITS.east;
  if (map.cellAt(cellX - 1, cellY) === CELL_WALL) mask |= ARENA_WALL_MASK_BITS.west;
  return mask;
}

function requireRoleBuffer(name: string, values: Uint8Array): void {
  if (!(values instanceof Uint8Array) || values.length !== ARENA_VISUAL_CELL_COUNT) {
    throw new RangeError(`${name} must be a Uint8Array(${ARENA_VISUAL_CELL_COUNT})`);
  }
}

function decorateRole(map: ArenaMap, decor: Uint8Array, cellX: number, cellY: number, role: number): void {
  if (cellX < 0 || cellY < 0 || cellX >= MAP_WIDTH || cellY >= MAP_HEIGHT) return;
  const index = cellY * MAP_WIDTH + cellX;
  if (map.cellAt(cellX, cellY) === CELL_FLOOR && decor[index] === ARENA_DECOR_ROLE_NONE) decor[index] = role;
}

/** Fill caller-owned arrays; the projection allocates nothing after entry. */
export function projectArenaVisualRoles(
  map: ArenaMap,
  seed: number,
  ground: Uint16Array,
  decor: Uint8Array,
  marks: Uint8Array,
): void {
  if (!(ground instanceof Uint16Array) || ground.length !== ARENA_VISUAL_CELL_COUNT) {
    throw new RangeError(`ground must be a Uint16Array(${ARENA_VISUAL_CELL_COUNT})`);
  }
  requireRoleBuffer("decor", decor);
  requireRoleBuffer("marks", marks);
  if (seed >>> 0 !== map.seed) throw new Error("visual seed does not match the authoritative ArenaMap seed");

  decor.fill(ARENA_DECOR_ROLE_NONE);
  marks.fill(ARENA_MARK_ROLE_NONE);
  for (let cellY = 0; cellY < MAP_HEIGHT; cellY += 1) {
    for (let cellX = 0; cellX < MAP_WIDTH; cellX += 1) {
      const index = cellY * MAP_WIDTH + cellX;
      const cell = map.cellAt(cellX, cellY);
      const border =
        cellX < ARENA_BORDER_CELLS ||
        cellY < ARENA_BORDER_CELLS ||
        cellX >= MAP_WIDTH - ARENA_BORDER_CELLS ||
        cellY >= MAP_HEIGHT - ARENA_BORDER_CELLS;
      ground[index] =
        cell === CELL_WALL
          ? (border ? ARENA_GROUND_ROLE_BORDER_BASE : ARENA_GROUND_ROLE_WALL_BASE) + arenaWallMask(map, cellX, cellY)
          : arenaGroundVariant(seed, cellX, cellY);
      // Raised cover is rendered by foot-sorted world sprites. Tile marks here
      // would leave square decals underneath those sprites after destruction.
    }
  }

  // Spawn and pickup footprints are world-space isometric sprites. Their old
  // 16px tile marks no longer match the projection of the hex terrain.
  for (let index = 0; index < MAX_HAZARDS; index += 1) {
    const cellX = cellOfX(map.hazardX[index]!);
    const cellY = cellOfY(map.hazardY[index]!);
    decorateRole(map, decor, cellX, cellY, ARENA_DECOR_ROLE_FLOOR_VENT);
    decorateRole(map, decor, cellX - 1, cellY, ARENA_DECOR_ROLE_LAVA_FISSURE);
    decorateRole(map, decor, cellX + 1, cellY, ARENA_DECOR_ROLE_LAVA_FISSURE);
    decorateRole(map, decor, cellX, cellY + 1, ARENA_DECOR_ROLE_THERMAL_VENT);
    decorateRole(map, decor, cellX, cellY - 1, ARENA_DECOR_ROLE_PIPE_JUNCTION);
    decorateRole(map, decor, cellX + (index % 2 === 0 ? 2 : -2), cellY - 1, ARENA_DECOR_ROLE_PIPE_RUN);
  }

  // The continuous hex floor already carries driveable texture, terrain
  // scars, and service-deck detail. Square 2x2 staging/crater decals floated
  // over that projection and read as unrelated tiles, so they are not placed.

  // Quiet, seed-stable details follow the *visible* hex material instead of
  // placing flowers on steel or caution paint in a meadow. The map seed picks
  // positions; the shared landscape decides the local art grammar. Existing
  // hazard art and gameplay marks always win. One scratch cell is reused for
  // all lookups so the projection has no per-cell heap traffic.
  const hexScratch: HexCell = { q: 0, r: 0, dx: 0, dy: 0 };
  for (let index = 0; index < ARENA_VISUAL_CELL_COUNT; index += 1) {
    if (decor[index] !== ARENA_DECOR_ROLE_NONE || marks[index] !== ARENA_MARK_ROLE_NONE) continue;
    const cellX = index % MAP_WIDTH;
    const cellY = Math.floor(index / MAP_WIDTH);
    if (map.cellAt(cellX, cellY) !== CELL_FLOOR) continue;
    const mirroredIndex = Math.min(index, ARENA_VISUAL_CELL_COUNT - 1 - index);
    const detail = mix32(seed ^ 0x574f_524c, mirroredIndex);
    if (detail % 17 !== 0) continue;
    const biome = worldPlanSurfaceRoleAtSimulation(map.plan, cellCentreX(cellX), cellCentreY(cellY), hexScratch);
    const kind = (detail >>> 8) & 7;
    if (biome === "G") {
      decor[index] =
        kind < 3 ? ARENA_DECOR_ROLE_FIELD_FLOWERS : kind < 7 ? ARENA_DECOR_ROLE_GRASS : ARENA_DECOR_ROLE_STONES;
    } else if (biome === "D" && kind !== 7) {
      decor[index] = kind < 6 ? ARENA_DECOR_ROLE_STONES : ARENA_DECOR_ROLE_SHELL_CASES;
    } else if (biome === "B" && kind < 3) {
      decor[index] = kind === 0 ? ARENA_DECOR_ROLE_STONES : ARENA_DECOR_ROLE_SCORCH;
    } else if (biome === "A" && kind < 4) {
      decor[index] = kind === 0 ? ARENA_DECOR_ROLE_STONES : ARENA_DECOR_ROLE_SCORCH;
    } else if (biome === "M" && kind < 5) {
      decor[index] = kind === 2 ? ARENA_DECOR_ROLE_OIL_SPILL : ARENA_DECOR_ROLE_SHELL_CASES;
    }
  }
}
