/**
 * RFC-1982-style ordering for the uint32 simulation/admission clock.
 *
 * Comparisons are defined only inside one half of the serial-number space.
 * Every duration accepted here is therefore strictly less than 2^31 ticks.
 */
export const MAX_TICK_SPAN = 0x7fff_ffff;

/** True when `left` is later than `right` in uint32 serial-number order. */
export function tickAfter(left: number, right: number): boolean {
  requireTick(left, "left tick");
  requireTick(right, "right tick");
  const distance = (left - right) >>> 0;
  return distance !== 0 && distance <= MAX_TICK_SPAN;
}

/** True when `tick` has not passed an inclusive deadline. */
export function tickAtOrBefore(tick: number, deadline: number): boolean {
  return !tickAfter(tick, deadline);
}

/**
 * Adds a bounded duration while preserving zero as the ledger's active-owner
 * sentinel. The single colliding deadline is extended to tick 1, which is a
 * conservative one-tick grace extension rather than an early revocation.
 */
export function tickDeadline(start: number, duration: number): number {
  requireTick(start, "start tick");
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_TICK_SPAN) {
    throw new RangeError(`duration must be in [1, ${MAX_TICK_SPAN}]`);
  }
  const deadline = (start + duration) >>> 0;
  return deadline === 0 ? 1 : deadline;
}

function requireTick(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${field} must fit uint32`);
  }
}
