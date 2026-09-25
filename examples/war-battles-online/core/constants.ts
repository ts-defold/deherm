// Fixed-point world constants shared by the simulation, the wire protocol and
// every renderer.
//
// UNITS. The simulation is integer-only. One Defold pixel is `UNITS_PER_PIXEL`
// simulation units, so a whole simulation coordinate is 1/16 of a pixel and the
// arena still fits comfortably inside Int32. Nothing in `BattleWorld` ever sees
// a float, which is what makes a server and a predicting client agree.
//
// The arena rectangle is pinned to the authored Defold tilemap: 120x90 tiles of
// 16 px placed at (-312, -352) in the built collection. `worldToPixelX/Y` below
// is the exact transform between the two, and the packaged runtime gates assert
// coordinates on the Defold side of it.

export const TICK_RATE = 60;
export const TICK_MILLISECONDS = 1000 / TICK_RATE;

export const MAX_PLAYERS = 32;
export const MAX_PROJECTILES = 512;
export const MAX_PICKUPS = 32;
/** Fixed environmental hazard vents; their positions are derived from mapSeed. */
export const MAX_HAZARDS = 4;
/** Fixed mutable cover panels; the remainder of the derived map stays static. */
export const MAX_COVER_PANELS = 64;
export const COVER_MAX_HEALTH = 100;
export const INPUT_HISTORY_TICKS = 256;
/** Fixed protocol width of the authenticated session-resume credential. */
export const SESSION_TOKEN_BYTES = 40;
/** Axes stay held this long without a fresh input before they are released. */
export const INPUT_HOLD_TICKS = 6;

/** Simulation units per Defold pixel. */
export const UNITS_PER_PIXEL = 16;
/** Map cell edge, in pixels and in units. A cell is one authored 16 px tile. */
export const TILE_PIXELS = 16;
export const TILE_UNITS = TILE_PIXELS * UNITS_PER_PIXEL;

/** Arena extent in tiles. 120x90 tiles is 1920x1440 px. */
export const MAP_WIDTH = 120;
export const MAP_HEIGHT = 90;
export const MAP_CELLS = MAP_WIDTH * MAP_HEIGHT;

/** Arena rectangle in simulation units, centred on the origin. */
export const WORLD_MIN_X = -(MAP_WIDTH * TILE_UNITS) / 2;
export const WORLD_MAX_X = (MAP_WIDTH * TILE_UNITS) / 2;
export const WORLD_MIN_Y = -(MAP_HEIGHT * TILE_UNITS) / 2;
export const WORLD_MAX_Y = (MAP_HEIGHT * TILE_UNITS) / 2;

/**
 * Where the arena's origin lands in the built Defold collection, in pixels.
 * The authored tilemap sits at (-312, -352) and is 1920x1440 px, so its centre
 * - the simulation origin - is at (648, 368).
 */
export const WORLD_PIXEL_ORIGIN_X = 648;
export const WORLD_PIXEL_ORIGIN_Y = 368;

export function worldToPixelX(x: number): number {
  return x / UNITS_PER_PIXEL + WORLD_PIXEL_ORIGIN_X;
}

export function worldToPixelY(y: number): number {
  return y / UNITS_PER_PIXEL + WORLD_PIXEL_ORIGIN_Y;
}

export function pixelToWorldX(x: number): number {
  return Math.round((x - WORLD_PIXEL_ORIGIN_X) * UNITS_PER_PIXEL);
}

export function pixelToWorldY(y: number): number {
  return Math.round((y - WORLD_PIXEL_ORIGIN_Y) * UNITS_PER_PIXEL);
}

/** Tank body radius: 14 px. Projectile base radius: 4 px. */
export const PLAYER_RADIUS = 14 * UNITS_PER_PIXEL;
/** On-foot pilots are deliberately small, fast, and extremely fragile. */
export const INFANTRY_RADIUS = 7 * UNITS_PER_PIXEL;
export const PROJECTILE_RADIUS = 4 * UNITS_PER_PIXEL;
/** Muzzle stand-off from the hull centre, 22 px, so a shot clears the tank. */
export const MUZZLE_OFFSET = 22 * UNITS_PER_PIXEL;

// --- tank mobility ----------------------------------------------------------

/** Velocity is carried at this sub-unit scale so drag stays smooth. */
export const VELOCITY_SCALE = 256;
/** Base top speed, in units per tick: 5.5 px/tick, 330 px/s. */
export const TANK_MAX_SPEED = 88 * VELOCITY_SCALE;
/** Extra top speed per mobility upgrade level. */
export const TANK_SPEED_PER_MOBILITY = 8 * VELOCITY_SCALE;
/**
 * Hard ceiling on total speed. The drive speed above is enforced by refusing to
 * add thrust that would exceed it, NOT by clamping the velocity vector: an
 * explosion has to be able to throw a tank faster than it can drive, or splash
 * knockback and rocket jumps are cancelled out on the very next tick.
 */
export const TANK_MAX_IMPULSE_SPEED = 3 * TANK_MAX_SPEED;
/** Thrust applied per tick while a direction is held. */
export const TANK_ACCELERATION = 5 * VELOCITY_SCALE;
/** Boost multiplier numerator/denominator applied to thrust and top speed. */
export const TANK_BOOST_NUMERATOR = 5;
export const TANK_BOOST_DENOMINATOR = 3;
/** Ticks of boost available, and ticks to refill one tick of boost. */
export const TANK_BOOST_CAPACITY = 90;
export const TANK_BOOST_REFILL_TICKS = 3;
/**
 * Per-tick drag, as a right shift of the current velocity. A shift of 5 keeps
 * roughly 97% of speed per tick, so a tank coasts for about half a second.
 */
export const TANK_DRAG_SHIFT = 5;
/** Fraction of speed kept when a tank slams into a wall, in 1/256ths. */
export const TANK_WALL_BOUNCE = 96;
/** Hull heading slew toward the travel direction, in 1/256ths per tick. */
export const HULL_SLEW = 44;
/** Turret slew toward the aim direction, in 1/256ths per tick. */
export const TURRET_SLEW = 26;

// --- combat -----------------------------------------------------------------

export const BASE_HEALTH = 100;
export const MAX_HEALTH = 200;
export const MAX_ARMOR = 100;
export const PLAYER_MODE_TANK = 0;
export const PLAYER_MODE_INFANTRY = 1;
export const PLAYER_MODE_DEAD = 2;
export const INFANTRY_HEALTH = 24;
export const INFANTRY_MAX_SPEED = 72 * VELOCITY_SCALE;
export const INFANTRY_ACCELERATION = 9 * VELOCITY_SCALE;
export const INFANTRY_DRAG_SHIFT = 3;
export const INFANTRY_FIRE_DAMAGE = 8;
export const INFANTRY_FIRE_COOLDOWN_TICKS = 18;
/** Brief lockout prevents a tank destroyed on a depot from being reclaimed instantly. */
export const INFANTRY_EJECT_LOCK_TICKS = 45;
export const TANK_DEPOT_RADIUS = 24 * UNITS_PER_PIXEL;
/** Any hostile tank touching an on-foot pilot at speed finishes the job. */
export const INFANTRY_CRUSH_DAMAGE = 0x7fff;
/** Ticks a tank stays wrecked before it respawns. */
export const RESPAWN_TICKS = 96;
/** Ticks of spawn protection: damage taken is halved and kills award nothing. */
export const SPAWN_PROTECT_TICKS = 60;
/** Ticks an overdrive pickup doubles outgoing damage for. */
export const OVERDRIVE_TICKS = 600;
/**
 * Knockback applied to the victim, in velocity units per point of damage. A
 * 58-point mortar hit therefore moves a tank at about 40% of its own top speed,
 * and a point-blank splash roughly doubles that - enough to rocket-jump with.
 */
export const KNOCKBACK_PER_DAMAGE = 160;

// --- objective -------------------------------------------------------------

/** Central command beacon used by team matches. Progress is signed: + is team 1, - is team 2. */
export const OBJECTIVE_RADIUS = 96 * UNITS_PER_PIXEL;
export const OBJECTIVE_CAPTURE_TICKS = 180;
export const OBJECTIVE_SCORE_LIMIT = 3;

// Rotating hazard vents make the non-destructible arena reactive without adding
// mutable terrain to the fixed snapshot. The active vent and pulse schedule are
// pure functions of the authoritative tick and map seed.
export const HAZARD_RADIUS = 72 * UNITS_PER_PIXEL;
export const HAZARD_CYCLE_TICKS = 600;
export const HAZARD_ACTIVE_TICKS = 240;
export const HAZARD_PULSE_TICKS = 30;
export const HAZARD_DAMAGE = 8;

// --- input ------------------------------------------------------------------

export const INPUT_BUTTON_FIRE = 1 << 0;
export const INPUT_BUTTON_BOOST = 1 << 1;
export const INPUT_BUTTON_MASK = INPUT_BUTTON_FIRE | INPUT_BUTTON_BOOST;

// Direction components use Q8 fixed point. 181 approximates 256 / sqrt(2).
export const DIRECTION_SCALE = 256;
export const DIRECTION_DIAGONAL = 181;

// --- wire sizes -------------------------------------------------------------

// Four additive bytes carry a per-player weapon-upgrade unlock mask and packed
// branch selections; the record remains fixed-capacity and ammo stays aligned.
// Two additive bytes carry player mode plus the last-input-tick validity bit.
// The separate bit keeps every uint32 tick, including 0xffffffff, representable.
export const PLAYER_SNAPSHOT_BYTES = 96;
export const PROJECTILE_SNAPSHOT_BYTES = 28;
export const PICKUP_SNAPSHOT_BYTES = 12;
/** One byte of remaining health per destructible cover panel. */
export const COVER_SNAPSHOT_BYTES = MAX_COVER_PANELS;
// The header carries the authoritative central-objective state in addition to
// the map seed. Keeping it in the fixed header means every rollback/reconnect
// frame restores the mode without adding per-entity bytes.
export const SNAPSHOT_HEADER_BYTES = 32;
export const SNAPSHOT_BYTES =
  SNAPSHOT_HEADER_BYTES +
  MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES +
  MAX_PROJECTILES * PROJECTILE_SNAPSHOT_BYTES +
  MAX_PICKUPS * PICKUP_SNAPSHOT_BYTES +
  COVER_SNAPSHOT_BYTES;
/** 3.2 seconds of 20 Hz authoritative bases, shared by server and client. */
export const SNAPSHOT_BASE_HISTORY_FRAMES = 64;
