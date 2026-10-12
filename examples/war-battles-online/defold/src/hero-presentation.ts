/** A bounded visual reaction only; authoritative damage stays in BattleWorld. */
export const HERO_HIT_REACTION_SECONDS = 0.2;

/**
 * Observe a health sample without allocating or changing simulation state.
 * A newly ejected driver begins with a smaller health pool, which is not a hit.
 */
export function nextHeroHitSeconds(
  previousHealth: number,
  health: number,
  remaining: number,
  dt: number,
  newlyEjected: boolean,
): number {
  if (newlyEjected) return 0;
  if (health > 0 && health < previousHealth) return HERO_HIT_REACTION_SECONDS;
  return Math.max(0, remaining - Math.max(0, dt));
}
