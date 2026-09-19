// Integer-only math for the simulation.
//
// Every routine here is exact: the simulation never calls `Math.sin`, `Math.cos`
// or `Math.sqrt`, because those are not required to be bit-identical between
// two JavaScript engines and this world is stepped independently by a server and
// by every predicting client. Directions are Q8 unit vectors (`DIRECTION_SCALE`)
// rather than angles, so slewing a turret is a normalised lerp rather than a
// trigonometric rotation, and nothing needs a sine table at all.
//
// `Math.trunc`, `Math.imul`, `Math.abs`, `Math.max` and `Math.min` on integer
// inputs are exact, so they are the only `Math` members used below.

import { DIRECTION_SCALE } from "./constants.ts";

/**
 * Exact integer square root: the largest `r` with `r * r <= value`.
 *
 * Newton's iteration for a square root converges monotonically downward only
 * from an over-estimate, so the seed is the first power of two strictly above
 * the root. Seeding from below terminates immediately on the first step and
 * returns the seed, which is why this is written out rather than assumed.
 * Every intermediate is an exact integer, and `Math.floor` rather than `>>`
 * keeps it exact for values past 2^31.
 */
export function isqrt(value: number): number {
  if (!(value > 0)) return 0;
  if (value < 4) return 1;
  let guess = 2;
  while (guess * guess <= value) guess *= 2;
  let next = Math.floor((guess + Math.floor(value / guess)) / 2);
  while (next < guess) {
    guess = next;
    next = Math.floor((guess + Math.floor(value / guess)) / 2);
  }
  return guess;
}

/** Exact integer length of a vector whose components fit in Int32. */
export function length(x: number, y: number): number {
  return isqrt(x * x + y * y);
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/**
 * A caller-owned direction. The simulation reuses a handful of these instead of
 * returning tuples, which keeps `step()` free of object construction.
 */
export interface Direction {
  x: number;
  y: number;
}

export function createDirection(x = DIRECTION_SCALE, y = 0): Direction {
  return { x, y };
}

/**
 * Normalises `(x, y)` onto the Q8 unit circle and writes it into `output`.
 * A zero vector leaves `output` untouched and returns false, so callers keep
 * their previous facing rather than snapping to +x.
 */
export function normalizeInto(x: number, y: number, output: Direction): boolean {
  if (x === 0 && y === 0) return false;
  const magnitude = length(x, y);
  if (magnitude === 0) return false;
  output.x = Math.trunc((x * DIRECTION_SCALE) / magnitude);
  output.y = Math.trunc((y * DIRECTION_SCALE) / magnitude);
  return true;
}

/**
 * Turns `(currentX, currentY)` toward `(targetX, targetY)` by at most `rate`
 * 1/256ths and writes the normalised result into `output`.
 *
 * The degenerate case is a target exactly opposite the current facing: a plain
 * lerp collapses to the zero vector there. That case turns through the left
 * perpendicular instead, which is an arbitrary but deterministic choice and the
 * only place the turn direction is not decided by the geometry.
 */
export function slewInto(
  currentX: number,
  currentY: number,
  targetX: number,
  targetY: number,
  rate: number,
  output: Direction,
): void {
  if (targetX === 0 && targetY === 0) {
    output.x = currentX;
    output.y = currentY;
    return;
  }
  const cross = currentX * targetY - currentY * targetX;
  const dot = currentX * targetX + currentY * targetY;
  if (cross === 0 && dot < 0) {
    if (!normalizeInto(currentX - currentY * rate / DIRECTION_SCALE, currentY + currentX * rate / DIRECTION_SCALE, output)) {
      output.x = currentX;
      output.y = currentY;
    }
    return;
  }
  const blendedX = currentX + Math.trunc(((targetX - currentX) * rate) / DIRECTION_SCALE);
  const blendedY = currentY + Math.trunc(((targetY - currentY) * rate) / DIRECTION_SCALE);
  if (!normalizeInto(blendedX, blendedY, output)) {
    output.x = targetX;
    output.y = targetY;
    normalizeInto(output.x, output.y, output);
  }
}

/**
 * Rotates a Q8 unit direction by `turns` sixteenths of a full circle using only
 * the exact eight-way basis plus a normalised blend, so a spread pattern is
 * reproducible without trigonometry. `spread` is in 1/256ths of a right angle.
 */
export function spreadInto(x: number, y: number, spread: number, output: Direction): void {
  // Rotating by a small angle t is approximately (x - y*t, y + x*t) followed by
  // renormalisation, which is exact enough for a shotgun cone and is a pure
  // integer operation.
  const rotatedX = x * DIRECTION_SCALE - y * spread;
  const rotatedY = y * DIRECTION_SCALE + x * spread;
  if (!normalizeInto(rotatedX, rotatedY, output)) {
    output.x = x;
    output.y = y;
  }
}

/**
 * Deterministic 32-bit hash, used wherever the simulation needs a reproducible
 * pseudo-random decision keyed by tick and entity rather than by a mutable
 * generator, so that a rollback re-derives exactly the same value.
 */
export function mix32(a: number, b: number): number {
  let hash = (a ^ Math.imul(b, 0x9e37_79b9)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85eb_ca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2_ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** `mix32` reduced into `[0, bound)`. */
export function mixRange(a: number, b: number, bound: number): number {
  if (bound <= 1) return 0;
  return mix32(a, b) % bound;
}

/** `mix32` reduced into `[-span, span]`. */
export function mixSigned(a: number, b: number, span: number): number {
  if (span <= 0) return 0;
  return (mix32(a, b) % (span * 2 + 1)) - span;
}
