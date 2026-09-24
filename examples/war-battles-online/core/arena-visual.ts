// Deterministic presentation roles for an authoritative ArenaMap.
//
// This module deliberately knows nothing about Defold tile ids. The art
// generator maps these compact semantic roles to each visual theme, while the
// checked .tilemap generator and the live Defold component both call this one
// projector. A seed therefore cannot change collision without changing the
// picture of the same cells.

import {
  ArenaMap,
  CELL_CRATE,
  CELL_FLOOR,
  CELL_SANDBAG,
  CELL_WALL,
  SPAWN_POINT_COUNT,
  cellOfX,
  cellOfY,
} from "./arena.ts";
import { MAP_HEIGHT, MAP_WIDTH, MAX_HAZARDS, MAX_PICKUPS } from "./constants.ts";

export const ARENA_VISUAL_CELL_COUNT = MAP_WIDTH * MAP_HEIGHT;
export const ARENA_GROUND_VARIANT_COUNT = 4;
export const ARENA_GROUND_ROLE_WALL_BASE = 16;

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
export const ARENA_DECOR_ROLE_COUNT = 7;

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

export function arenaGroundVariant(seed: number, cellX: number, cellY: number): number {
  let hash = ((seed >>> 0) ^ Math.imul(cellX, 0x9e37_79b1) ^ Math.imul(cellY, 0x85eb_ca6b)) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545_f491) >>> 0;
  return (hash >>> 3) % ARENA_GROUND_VARIANT_COUNT;
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

function markRole(marks: Uint8Array, cellX: number, cellY: number, role: number): void {
  if (cellX < 0 || cellY < 0 || cellX >= MAP_WIDTH || cellY >= MAP_HEIGHT) return;
  const index = cellY * MAP_WIDTH + cellX;
  if (marks[index] === ARENA_MARK_ROLE_NONE) marks[index] = role;
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
  ground: Uint8Array,
  decor: Uint8Array,
  marks: Uint8Array,
): void {
  requireRoleBuffer("ground", ground);
  requireRoleBuffer("decor", decor);
  requireRoleBuffer("marks", marks);
  if (seed >>> 0 !== map.seed) throw new Error("visual seed does not match the authoritative ArenaMap seed");

  decor.fill(ARENA_DECOR_ROLE_NONE);
  marks.fill(ARENA_MARK_ROLE_NONE);
  for (let cellY = 0; cellY < MAP_HEIGHT; cellY += 1) {
    for (let cellX = 0; cellX < MAP_WIDTH; cellX += 1) {
      const index = cellY * MAP_WIDTH + cellX;
      const cell = map.cellAt(cellX, cellY);
      ground[index] =
        cell === CELL_WALL
          ? ARENA_GROUND_ROLE_WALL_BASE + arenaWallMask(map, cellX, cellY)
          : arenaGroundVariant(seed, cellX, cellY);
      if (cell === CELL_CRATE) marks[index] = ARENA_MARK_ROLE_CRATE;
      else if (cell === CELL_SANDBAG) marks[index] = ARENA_MARK_ROLE_SANDBAG;
    }
  }

  for (let index = 0; index < SPAWN_POINT_COUNT; index += 1) {
    markRole(marks, cellOfX(map.spawnX[index]!), cellOfY(map.spawnY[index]!), ARENA_MARK_ROLE_SPAWN);
  }
  for (let index = 0; index < MAX_PICKUPS; index += 1) {
    markRole(marks, cellOfX(map.pickupX[index]!), cellOfY(map.pickupY[index]!), ARENA_MARK_ROLE_PICKUP);
  }
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
}
