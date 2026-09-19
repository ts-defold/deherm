// A fixed-capacity presentation event ring.
//
// These are NOT authoritative state and never enter a snapshot. They exist so a
// renderer can spawn a muzzle flash, an explosion or a pickup chime at the exact
// tick and position the simulation decided, instead of inferring it by diffing
// two snapshots. A client that restores an authoritative snapshot clears the ring
// first, so a rollback never replays effects that the player already saw.
//
// The ring drops the oldest record when it overflows. A dropped effect is a
// missing puff of smoke, never a missing hit.

export const EVENT_FIRE = 1;
export const EVENT_HIT = 2;
export const EVENT_KILL = 3;
export const EVENT_EXPLOSION = 4;
export const EVENT_BOUNCE = 5;
export const EVENT_PICKUP_TAKEN = 6;
export const EVENT_PICKUP_RESPAWN = 7;
export const EVENT_RESPAWN = 8;
export const EVENT_WEAPON_CHANGED = 9;

export const EVENT_CAPACITY = 256;

export interface BattleEvent {
  kind: number;
  /** Player id, projectile owner, or pickup index, depending on `kind`. */
  a: number;
  /** Victim player id, weapon id, or pickup kind, depending on `kind`. */
  b: number;
  x: number;
  y: number;
  tick: number;
}

/**
 * Writer and reader of the ring. `sequence` counts every record ever written, so
 * a reader can tell the difference between "nothing happened" and "I fell so far
 * behind that records were overwritten".
 */
export class EventRing {
  sequence = 0;
  private readonly kind = new Uint8Array(EVENT_CAPACITY);
  private readonly a = new Uint16Array(EVENT_CAPACITY);
  private readonly b = new Uint16Array(EVENT_CAPACITY);
  private readonly x = new Int32Array(EVENT_CAPACITY);
  private readonly y = new Int32Array(EVENT_CAPACITY);
  private readonly tick = new Uint32Array(EVENT_CAPACITY);

  push(kind: number, a: number, b: number, x: number, y: number, tick: number): void {
    const slot = this.sequence % EVENT_CAPACITY;
    this.kind[slot] = kind;
    this.a[slot] = a;
    this.b[slot] = b;
    this.x[slot] = x;
    this.y[slot] = y;
    this.tick[slot] = tick;
    this.sequence += 1;
  }

  clear(): void {
    this.sequence = 0;
  }

  /** The oldest sequence number still readable. */
  oldest(): number {
    return this.sequence > EVENT_CAPACITY ? this.sequence - EVENT_CAPACITY : 0;
  }

  /** Reads one record by absolute sequence number. Returns false once evicted. */
  read(sequence: number, output: BattleEvent): boolean {
    if (sequence < this.oldest() || sequence >= this.sequence) return false;
    const slot = sequence % EVENT_CAPACITY;
    output.kind = this.kind[slot]!;
    output.a = this.a[slot]!;
    output.b = this.b[slot]!;
    output.x = this.x[slot]!;
    output.y = this.y[slot]!;
    output.tick = this.tick[slot]!;
    return true;
  }
}

export function createBattleEvent(): BattleEvent {
  return { kind: 0, a: 0, b: 0, x: 0, y: 0, tick: 0 };
}
