/** One authored hex material map shared by offline art and live landmarks. */
import { UNITS_PER_PIXEL, WORLD_MIN_X, WORLD_MIN_Y } from "./constants.ts";

export const HEX_MACRO_CELLS = 12;
export const HEX_MACRO_EDGE = HEX_MACRO_CELLS * 96;

// G=meadow, D=earth, B=basalt, A=ash/fissure, M=service-route source cell.
export const HEX_LANDSCAPE = Object.freeze([
  "GGGGGGGGGGGG",
  "GABBGGGGGGGG",
  "DABBDGGGGGGG",
  "GBBGGGGMMMGG",
  "GGGGGGDDMMGG",
  "GGGGGDDGMMGG",
  "GGGGDDGGMMGG",
  "GGGDDGGGGGGG",
  "GGDDGGGGGGGG",
  "GGDDGGGGGGGG",
  "GGGGGGGGGGGG",
  "GGGGGGGGGGGG",
]);

// 0=low, 1=standard, 2=high. Broad contiguous patches keep the battlefield
// driveable; every edge row/column returns to standard so the 1152px macro
// repeats without a height discontinuity.
export const HEX_RELIEF = Object.freeze([
  "111111111111",
  "122221111111",
  "122221111111",
  "122221111111",
  "112211111111",
  "111111111111",
  "111111100011",
  "111111000011",
  "111110000011",
  "111111000011",
  "111111100011",
  "111111111111",
]);

/** Short hand-authored centreline through the depot's narrow service route. */
export const HEX_SERVICE_ROUTE = Object.freeze([
  [7, 3],
  [8, 3],
  [9, 3],
  [9, 4],
  [9, 5],
  [9, 6],
] as const);
/** Meadow cells carrying the opening dirt-road spur without changing biome. */
export const HEX_DIRT_SPUR = Object.freeze([
  [0, 3],
  [0, 4],
  [1, 4],
  [2, 4],
  [3, 4],
  [3, 5],
  [4, 5],
] as const);
if (HEX_LANDSCAPE.length !== HEX_MACRO_CELLS || HEX_LANDSCAPE.some((row) => row.length !== HEX_MACRO_CELLS)) {
  throw new Error("hex landscape layout does not fill the macro period");
}
if (HEX_RELIEF.length !== HEX_MACRO_CELLS || HEX_RELIEF.some((row) => row.length !== HEX_MACRO_CELLS)) {
  throw new Error("hex relief layout does not fill the macro period");
}

const mod = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

export function hexTerrainRole(q: number, r: number): string {
  return HEX_LANDSCAPE[mod(r, HEX_MACRO_CELLS)]![mod(q, HEX_MACRO_CELLS)]!;
}

/** The same authored terrace tiers used by the offline floor compositor. */
export function hexReliefTier(q: number, r: number): number {
  return Number(HEX_RELIEF[mod(r, HEX_MACRO_CELLS)]![mod(q, HEX_MACRO_CELLS)]!);
}

/** The exact simulation-space centre of an authored floor hex. */
export function hexCentreAtSimulation(q: number, r: number): { x: number; y: number } {
  const u = q * 96;
  const v = r * 96 + (q & 1) * 48;
  return {
    x: WORLD_MIN_X + ((u + v) / 2) * UNITS_PER_PIXEL,
    y: WORLD_MIN_Y + ((v - u) / 2) * UNITS_PER_PIXEL,
  };
}

function reliefAtLattice(q: number, r: number): number {
  return hexReliefTier(q, r + Math.floor(q / 2));
}

/**
 * Small, continuous presentation-only lift in Defold screen-world pixels.
 * Barycentric interpolation across the triangular lattice of hex centers
 * keeps hull, turret and pilot aligned without temporal state or allocations.
 */
export function hexReliefLiftAtSimulation(worldX: number, worldY: number): number {
  const localX = (worldX - WORLD_MIN_X) / UNITS_PER_PIXEL;
  const localY = (worldY - WORLD_MIN_Y) / UNITS_PER_PIXEL;
  const qFloat = (localX - localY) / 96;
  const rFloat = (localX + localY - qFloat * 48) / 96;
  const q = Math.floor(qFloat);
  const r = Math.floor(rFloat);
  const x = qFloat - q;
  const y = rFloat - r;
  let tier: number;
  if (x + y <= 1) {
    tier = (1 - x - y) * reliefAtLattice(q, r) + x * reliefAtLattice(q + 1, r) + y * reliefAtLattice(q, r + 1);
  } else {
    tier =
      (x + y - 1) * reliefAtLattice(q + 1, r + 1) +
      (1 - y) * reliefAtLattice(q + 1, r) +
      (1 - x) * reliefAtLattice(q, r + 1);
  }
  return tier * 2.5;
}

function inHex(dx: number, dy: number): boolean {
  return Math.abs(dy) <= 48 && Math.abs(dx) <= 64 - (Math.abs(dy) * 2) / 3;
}

export interface HexCell {
  q: number;
  r: number;
  dx: number;
  dy: number;
}

export function hexCellAt(worldX: number, worldY: number, output: HexCell = { q: 0, r: 0, dx: 0, dy: 0 }): HexCell {
  // Defold's scene is S(1,.5)R(45deg). The uncompressed u/v axes cancel its
  // rotation. One cell reads as ~90x34 screen-world pixels before camera zoom.
  const u = worldX - worldY;
  const v = worldX + worldY;
  for (let q = Math.floor(u / 96) - 1; q <= Math.floor(u / 96) + 1; q++) {
    const shift = mod(q, 2) * 48;
    for (let r = Math.floor((v - shift) / 96) - 1; r <= Math.floor((v - shift) / 96) + 1; r++) {
      const dx = u - q * 96;
      const dy = v - r * 96 - shift;
      if (inHex(dx, dy)) {
        output.q = q;
        output.r = r;
        output.dx = dx;
        output.dy = dy;
        return output;
      }
    }
  }
  throw new Error(`hex gap at ${worldX},${worldY}`);
}

/** Convert authoritative simulation units to the landscape tilemap's local pixels. */
export function hexTerrainRoleAtSimulation(worldX: number, worldY: number, scratch?: HexCell): string {
  const localX = (worldX - WORLD_MIN_X) / UNITS_PER_PIXEL;
  const localY = (worldY - WORLD_MIN_Y) / UNITS_PER_PIXEL;
  const { q, r } = hexCellAt(localX, localY, scratch);
  return hexTerrainRole(q, r);
}
