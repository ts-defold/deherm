export const TICK_RATE = 60;
export const MAX_PLAYERS = 32;
export const MAX_PROJECTILES = 512;
export const INPUT_HISTORY_TICKS = 256;
export const INPUT_HOLD_TICKS = 6;

export const PLAYER_RADIUS = 256;
export const PROJECTILE_RADIUS = 64;
export const MUZZLE_OFFSET = 384;
export const WORLD_MIN = -16_384;
export const WORLD_MAX = 16_384;

export const INPUT_BUTTON_FIRE = 1 << 0;
export const INPUT_BUTTON_ALT_FIRE = 1 << 1;
export const INPUT_BUTTON_MASK = INPUT_BUTTON_FIRE | INPUT_BUTTON_ALT_FIRE;

// Direction components use Q8 fixed point. 181 approximates 256 / sqrt(2).
export const DIRECTION_SCALE = 256;
export const DIRECTION_DIAGONAL = 181;

export const PLAYER_SNAPSHOT_BYTES = 44;
export const PROJECTILE_SNAPSHOT_BYTES = 24;
export const SNAPSHOT_HEADER_BYTES = 20;
export const SNAPSHOT_BYTES =
  SNAPSHOT_HEADER_BYTES +
  MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES +
  MAX_PROJECTILES * PROJECTILE_SNAPSHOT_BYTES;
