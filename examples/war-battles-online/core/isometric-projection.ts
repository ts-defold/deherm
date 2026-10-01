// Pure presentation projection for the isometric War Battles renderer.
//
// The authoritative simulation, collision, rollback and network snapshots all
// remain in their integer Cartesian world. Only the renderer crosses this
// seam. Keeping the transform here gives tanks, projectiles, effects, input
// remapping and the tilemap one canonical piece of math to share.

import {
  UNITS_PER_PIXEL,
  WORLD_MAX_X,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  WORLD_MIN_Y,
  WORLD_PIXEL_ORIGIN_X,
  WORLD_PIXEL_ORIGIN_Y,
} from "./constants.ts";

/** 2:1 dimetric projection: one world axis rises right, the other rises left. */
export const ISOMETRIC_X_SCALE = Math.SQRT1_2;
export const ISOMETRIC_Y_SCALE = Math.SQRT1_2 * 0.5;

export function isometricScreenX(worldX: number, worldY: number): number {
  return WORLD_PIXEL_ORIGIN_X + ((worldX - worldY) / UNITS_PER_PIXEL) * ISOMETRIC_X_SCALE;
}

export function isometricScreenY(worldX: number, worldY: number): number {
  return WORLD_PIXEL_ORIGIN_Y + ((worldX + worldY) / UNITS_PER_PIXEL) * ISOMETRIC_Y_SCALE;
}

/** Project a direction without applying position origin or world-unit scale. */
export function isometricDirectionX(worldX: number, worldY: number): number {
  return (worldX - worldY) * ISOMETRIC_X_SCALE;
}

export function isometricDirectionY(worldX: number, worldY: number): number {
  return (worldX + worldY) * ISOMETRIC_Y_SCALE;
}

/**
 * Convert screen-relative digital controls back into simulation axes.
 * Signs are sufficient because the fixed simulation normalizes input.
 */
export function isometricControlWorldX(screenX: number, screenY: number): number {
  return screenX + screenY;
}

export function isometricControlWorldY(screenX: number, screenY: number): number {
  return screenY - screenX;
}

/** Stable painter-order coordinate, normalized across the authoritative map. */
export function isometricDepth(worldX: number, worldY: number): number {
  const minimum = WORLD_MIN_X + WORLD_MIN_Y;
  const span = WORLD_MAX_X + WORLD_MAX_Y - minimum;
  return (worldX + worldY - minimum) / span;
}

/** Presentation-only ballistic lift over an authoritative flat trajectory. */
export function isometricArcHeight(remainingTicks: number, totalTicks: number, apexPixels: number): number {
  if (totalTicks <= 0 || apexPixels <= 0) return 0;
  const progress = Math.max(0, Math.min(1, 1 - remainingTicks / totalTicks));
  return Math.sin(progress * Math.PI) * apexPixels;
}

const cornerX = [WORLD_MIN_X, WORLD_MAX_X] as const;
const cornerY = [WORLD_MIN_Y, WORLD_MAX_Y] as const;

export const ISOMETRIC_SCREEN_MIN_X = Math.min(...cornerX.flatMap((x) => cornerY.map((y) => isometricScreenX(x, y))));
export const ISOMETRIC_SCREEN_MAX_X = Math.max(...cornerX.flatMap((x) => cornerY.map((y) => isometricScreenX(x, y))));
export const ISOMETRIC_SCREEN_MIN_Y = Math.min(...cornerX.flatMap((x) => cornerY.map((y) => isometricScreenY(x, y))));
export const ISOMETRIC_SCREEN_MAX_Y = Math.max(...cornerX.flatMap((x) => cornerY.map((y) => isometricScreenY(x, y))));
