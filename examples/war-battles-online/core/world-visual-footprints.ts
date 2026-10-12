/** Cold-path projected footprints shared by world generation and presentation. */
import { MAP_WIDTH, TILE_UNITS, WORLD_MIN_X, WORLD_MIN_Y } from "./constants.ts";
import { mix32 } from "./fixed.ts";
import { isometricScreenX, isometricScreenY } from "./isometric-projection.ts";

export const HEX_LANDMARK_SPRITE_OFFSET_Y = 56;

// Selected opaque envelopes relative to each plan-owned ground foot. The art
// test checks these against the generated manifest; a new selected sprite
// cannot silently outgrow placement. Indices are WORLD_PROP_* kinds.
export const WORLD_PROP_PROJECTED_BOUNDS = [
  null,
  [
    { left: -27, right: 26, bottom: 0, top: 90 },
    { left: -33, right: 31, bottom: 0, top: 71 },
    { left: -32, right: 31, bottom: 0, top: 81 },
  ], // tree: tall, broad, leaning
  [
    { left: -36, right: 35, bottom: 1, top: 50 },
    { left: -37, right: 35, bottom: 1, top: 37 },
    { left: -36, right: 34, bottom: 1, top: 41 },
  ], // rock: outcrop, stone, rubble
  [
    { left: -43, right: 41, bottom: 1, top: 57 },
    { left: -36, right: 35, bottom: 1, top: 41 },
    { left: -38, right: 36, bottom: 1, top: 36 },
  ], // building: bunker, supply, gun nest
  [{ left: -32, right: 31, bottom: -33, top: 34 }], // depot
] as const;

/** The same deterministic variant is used by placement and the renderer. */
export function worldPropVariant(seed: number, cell: number, kind: number): number {
  const variants = WORLD_PROP_PROJECTED_BOUNDS[kind];
  if (variants === undefined || variants === null) throw new RangeError("unknown world prop sprite kind");
  return variants.length === 1 ? 0 : mix32(seed ^ 0x5650_524f, cell) % variants.length;
}

function cellWorldX(cell: number): number {
  return WORLD_MIN_X + ((cell % MAP_WIDTH) + 0.5) * TILE_UNITS;
}

function cellWorldY(cell: number): number {
  return WORLD_MIN_Y + (Math.floor(cell / MAP_WIDTH) + 0.5) * TILE_UNITS;
}

/** Reject projected opaque-envelope overlap even when cell circles do not touch. */
export function worldPropSpritesOverlap(
  seed: number,
  firstCell: number,
  firstKind: number,
  secondCell: number,
  secondKind: number,
): boolean {
  const first = WORLD_PROP_PROJECTED_BOUNDS[firstKind]?.[worldPropVariant(seed, firstCell, firstKind)];
  const second = WORLD_PROP_PROJECTED_BOUNDS[secondKind]?.[worldPropVariant(seed, secondCell, secondKind)];
  if (first === undefined || first === null || second === undefined || second === null) {
    throw new RangeError("unknown world prop sprite kind");
  }
  const firstX = isometricScreenX(cellWorldX(firstCell), cellWorldY(firstCell));
  const secondX = isometricScreenX(cellWorldX(secondCell), cellWorldY(secondCell));
  if (firstX + first.right <= secondX + second.left || secondX + second.right <= firstX + first.left) return false;
  const firstY = isometricScreenY(cellWorldX(firstCell), cellWorldY(firstCell));
  const secondY = isometricScreenY(cellWorldX(secondCell), cellWorldY(secondCell));
  return firstY + first.bottom < secondY + second.top && secondY + second.bottom < firstY + first.top;
}

/** Keep large rock silhouettes from reading as one repeated screen-space pile. */
export function worldRockSpritesCrowd(firstCell: number, secondCell: number): boolean {
  const dx = Math.abs(
    isometricScreenX(cellWorldX(firstCell), cellWorldY(firstCell)) -
      isometricScreenX(cellWorldX(secondCell), cellWorldY(secondCell)),
  );
  const dy = Math.abs(
    isometricScreenY(cellWorldX(firstCell), cellWorldY(firstCell)) -
      isometricScreenY(cellWorldX(secondCell), cellWorldY(secondCell)),
  );
  return dx < 112 && dy < 64;
}

/** Conservative visible alpha rectangles around the plan-owned facade foot. */
export function worldPropOverlapsDepotSprite(propCell: number, depotFacadeCell: number): boolean {
  const dx = Math.abs(
    isometricScreenX(cellWorldX(propCell), cellWorldY(propCell)) -
      isometricScreenX(cellWorldX(depotFacadeCell), cellWorldY(depotFacadeCell)),
  );
  const dy = Math.abs(
    isometricScreenY(cellWorldX(propCell), cellWorldY(propCell)) +
      HEX_LANDMARK_SPRITE_OFFSET_Y -
      isometricScreenY(cellWorldX(depotFacadeCell), cellWorldY(depotFacadeCell)),
  );
  return dx < 62 + 56 && dy < 45 + 48;
}
