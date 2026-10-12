/**
 * Cold-path, seed-derived geography and sparse built-surface plan.
 * Natural ground and manufactured surfaces are different fields even when an
 * offline compositor flattens them into one presentation texture.
 */
import {
  MAP_CELLS,
  MAP_HEIGHT,
  MAP_WIDTH,
  TILE_PIXELS,
  TILE_UNITS,
  UNITS_PER_PIXEL,
  WORLD_MIN_X,
  WORLD_MIN_Y,
} from "./constants.ts";
import { mix32 } from "./fixed.ts";
import { hexCellAt, hexCentreAtSimulation, type HexCell } from "./hex-landscape.ts";
import { isometricScreenX, isometricScreenY } from "./isometric-projection.ts";
import {
  worldPropOverlapsDepotSprite,
  worldPropSpritesOverlap,
  worldRockSpritesCrowd,
} from "./world-visual-footprints.ts";

export const WORLD_PLAN_RULES_VERSION = 7;
export const WORLD_HEX_Q_MIN = -17;
export const WORLD_HEX_Q_MAX = 22;
export const WORLD_HEX_R_MIN = -2;
export const WORLD_HEX_R_MAX = 37;
export const WORLD_HEX_COLUMNS = WORLD_HEX_Q_MAX - WORLD_HEX_Q_MIN + 1;
export const WORLD_HEX_ROWS = WORLD_HEX_R_MAX - WORLD_HEX_R_MIN + 1;
export const WORLD_HEX_COUNT = WORLD_HEX_COLUMNS * WORLD_HEX_ROWS;
export const WORLD_PLAN_SPAWN_COUNT = 16;
export const WORLD_PLAN_START_COUNT = 32;
export const WORLD_PLAN_MAX_PROPS = 40;
/** Four compass depots retain a clear visible building behind their gameplay aprons. */
export const WORLD_PLAN_VISIBLE_DEPOT_SLOTS = [0, 4, 8, 12] as const;
export const WORLD_PROP_TREE = 1;
export const WORLD_PROP_ROCK = 2;
export const WORLD_PROP_BUILDING = 3;
export const WORLD_PROP_DEPOT = 4;

export const WORLD_BIOME_WATER = 0;
export const WORLD_BIOME_MEADOW = 1;
export const WORLD_BIOME_EARTH = 2;
export const WORLD_BIOME_BASALT = 3;
export const WORLD_BIOME_ASH = 4;
export const WORLD_BUILT_NONE = 0;
export const WORLD_BUILT_ROUTE = 1;
export const WORLD_BUILT_PAD = 2;

const WORLD_WIDTH_PIXELS = (MAP_WIDTH * TILE_UNITS) / UNITS_PER_PIXEL;
const WORLD_HEIGHT_PIXELS = (MAP_HEIGHT * TILE_UNITS) / UNITS_PER_PIXEL;
const BIOME_SITE_KINDS = [
  WORLD_BIOME_MEADOW,
  WORLD_BIOME_MEADOW,
  WORLD_BIOME_MEADOW,
  WORLD_BIOME_MEADOW,
  WORLD_BIOME_MEADOW,
  WORLD_BIOME_EARTH,
  WORLD_BIOME_EARTH,
  WORLD_BIOME_BASALT,
  WORLD_BIOME_ASH,
] as const;

export interface WorldPlan {
  readonly seed: number;
  readonly rulesVersion: number;
  /** 1 means playable land; 0 means ocean/outside the bounded island. */
  readonly land: Uint8Array;
  /** Zero is water; positive entries are the WORLD_BIOME_* identifiers. */
  readonly biome: Uint8Array;
  /** Shallow presentation tiers: low=0, standard=1, high=2. */
  readonly elevation: Uint8Array;
  /** Bit i is set when the land hex's i-th neighbor is water. */
  readonly coastEdges: Uint8Array;
  /** Sparse manufactured surface: zero means the natural biome remains visible. */
  readonly builtSurface: Uint8Array;
  /** Simulation-cell projection of the hex land mask. Not a separate terrain rule. */
  readonly cellLand: Uint8Array;
  readonly cellBiome: Uint8Array;
  readonly cellElevation: Uint8Array;
  /** Cells protected for spawn/depot aprons before any prop is placed. */
  readonly reserved: Uint8Array;
  /** Sixteen tank-capable spawn centres, as indices into cellLand. */
  readonly spawnCells: Int32Array;
  /** Grounded, collidable facade cell for each visible depot; -1 for apron-only slots. */
  readonly depotFacadeCells: Int32Array;
  /** Thirty-two separated player starts; tank depots remain a separate table. */
  readonly playerStartCells: Int32Array;
  /** Cold-path, fixed-capacity scenery table; only [0, propCount) is active. */
  readonly propCells: Int32Array;
  readonly propKinds: Uint8Array;
  readonly propVisualRadius: Uint8Array;
  /** Exact 16-pixel collision-cell projection of the blocking scenery. */
  readonly propSolid: Uint8Array;
  readonly propCount: number;
  readonly landCount: number;
}

export function worldHexIndex(q: number, r: number): number {
  if (q < WORLD_HEX_Q_MIN || q > WORLD_HEX_Q_MAX || r < WORLD_HEX_R_MIN || r > WORLD_HEX_R_MAX) return -1;
  return (r - WORLD_HEX_R_MIN) * WORLD_HEX_COLUMNS + q - WORLD_HEX_Q_MIN;
}

export function worldHexQ(index: number): number {
  return WORLD_HEX_Q_MIN + (index % WORLD_HEX_COLUMNS);
}

export function worldHexR(index: number): number {
  return WORLD_HEX_R_MIN + Math.floor(index / WORLD_HEX_COLUMNS);
}

/** The selected source-art grammar for one planned hex; W is ocean. */
export function worldPlanRoleAt(plan: WorldPlan, q: number, r: number): string {
  const index = worldHexIndex(q, r);
  if (index < 0 || plan.land[index] === 0) return "W";
  const biome = plan.biome[index];
  if (biome === WORLD_BIOME_MEADOW) return "G";
  if (biome === WORLD_BIOME_EARTH) return "D";
  if (biome === WORLD_BIOME_BASALT) return "B";
  if (biome === WORLD_BIOME_ASH) return "A";
  throw new Error(`unknown world biome ${biome}`);
}

/** Flattened art role. The plan still keeps built surfaces separate. */
export function worldPlanSurfaceRoleAt(plan: WorldPlan, q: number, r: number): string {
  const index = worldHexIndex(q, r);
  if (index >= 0 && plan.builtSurface[index] === WORLD_BUILT_PAD) return "M";
  if (index >= 0 && plan.builtSurface[index] === WORLD_BUILT_ROUTE) return "D";
  return worldPlanRoleAt(plan, q, r);
}

/** The same role the floor compositor paints under an authoritative world point. */
export function worldPlanSurfaceRoleAtSimulation(
  plan: WorldPlan,
  worldX: number,
  worldY: number,
  scratch?: HexCell,
): string {
  const localX = (worldX - WORLD_MIN_X) / UNITS_PER_PIXEL;
  const localY = (worldY - WORLD_MIN_Y) / UNITS_PER_PIXEL;
  const hex = hexCellAt(localX, localY, scratch);
  return worldPlanSurfaceRoleAt(plan, hex.q, hex.r);
}

export function worldPlanElevationAt(plan: WorldPlan, q: number, r: number): number {
  const index = worldHexIndex(q, r);
  return index < 0 || plan.land[index] === 0 ? 0 : plan.elevation[index]!;
}

/** Odd-column staggered hex neighbors in the same q/r convention as hexCellAt(). */
export function worldHexNeighbor(q: number, r: number, direction: number): number {
  if (direction < 0 || direction >= 6) throw new RangeError("hex direction must be 0..5");
  if (direction === 0) return worldHexIndex(q, r - 1);
  if (direction === 1) return worldHexIndex(q, r + 1);
  const diagonalR = r + ((q & 1) !== 0 ? 1 : -1);
  if (direction === 2) return worldHexIndex(q + 1, r);
  if (direction === 3) return worldHexIndex(q + 1, diagonalR);
  if (direction === 4) return worldHexIndex(q - 1, r);
  return worldHexIndex(q - 1, diagonalR);
}

function valueNoise(q: number, r: number, span: number, seed: number): number {
  const x = q / span;
  const y = r / span;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sample = (dx: number, dy: number): number =>
    (mix32(seed ^ Math.imul(ix + dx, 0x45d9_f3b), Math.imul(iy + dy, 0x27d4_eb2d)) & 0xffff) / 32767.5 - 1;
  const south = sample(0, 0) * (1 - sx) + sample(1, 0) * sx;
  const north = sample(0, 1) * (1 - sx) + sample(1, 1) * sx;
  return south * (1 - sy) + north * sy;
}

function insideWorld(q: number, r: number): boolean {
  const centre = hexCentreAtSimulation(q, r);
  const x = (centre.x - WORLD_MIN_X) / UNITS_PER_PIXEL;
  const y = (centre.y - WORLD_MIN_Y) / UNITS_PER_PIXEL;
  return x >= 0 && y >= 0 && x < WORLD_WIDTH_PIXELS && y < WORLD_HEIGHT_PIXELS;
}

function islandDistance(q: number, r: number): number {
  const centre = hexCentreAtSimulation(q, r);
  const x = (centre.x - WORLD_MIN_X) / UNITS_PER_PIXEL;
  const y = (centre.y - WORLD_MIN_Y) / UNITS_PER_PIXEL;
  // The bounded support has six sides before low-frequency perturbation:
  // horizontal top/bottom, and two diagonal facets on each end. It cannot
  // degrade into the former rectangular tilemap crop.
  const nx = (x - WORLD_WIDTH_PIXELS / 2) / (WORLD_WIDTH_PIXELS / 2 - 96);
  const ny = (y - WORLD_HEIGHT_PIXELS / 2) / (WORLD_HEIGHT_PIXELS / 2 - 96);
  return Math.max(Math.abs(ny), Math.abs(nx) + Math.abs(ny) * 0.5);
}

function seedBiomeSites(seed: number): { x: Float64Array; y: Float64Array; kinds: Uint8Array } {
  const x = new Float64Array(BIOME_SITE_KINDS.length);
  const y = new Float64Array(BIOME_SITE_KINDS.length);
  const kinds = Uint8Array.from(BIOME_SITE_KINDS);
  // The sites are spatially stratified, but their biome roles must not be
  // fixed to compass bearings: that made every seed the same colored wedges.
  for (let index = kinds.length - 1; index > 0; index -= 1) {
    const other = mix32(seed ^ 0x75ab_2351, index) % (index + 1);
    const kind = kinds[index]!;
    kinds[index] = kinds[other]!;
    kinds[other] = kind;
  }
  let volcanicCount = 0;
  for (const kind of kinds) {
    if (kind === WORLD_BIOME_BASALT || kind === WORLD_BIOME_ASH) volcanicCount += 1;
  }
  const naturalCount = kinds.length - volcanicCount;
  const rotation = ((mix32(seed ^ 0x117a_486d, 0) >>> 0) / 0x1_0000_0000) * Math.PI * 2;
  let volcanicSpoke = 0;
  let naturalSpoke = 0;
  for (let index = 0; index < BIOME_SITE_KINDS.length; index += 1) {
    const volcanic = kinds[index] === WORLD_BIOME_BASALT || kinds[index] === WORLD_BIOME_ASH;
    // Distinct volcanic spokes sit in the permitted interior core while the
    // natural spokes surround them. One shuffled outer ring allowed adjacent
    // dark sites to erase one another, producing zero ash on the shipped seed.
    const spoke = volcanic ? volcanicSpoke++ : naturalSpoke++;
    const angle = rotation + (spoke * Math.PI * 2) / (volcanic ? volcanicCount : naturalCount);
    const radial = volcanic
      ? 0.2 + ((mix32(seed ^ 0x81f2_4ea7, index) & 255) / 255) * 0.1
      : 0.42 + ((mix32(seed ^ 0x81f2_4ea7, index) & 255) / 255) * 0.17;
    const jitter = ((mix32(seed ^ 0xacc5_310d, index) & 255) / 255 - 0.5) * 0.32;
    x[index] = Math.cos(angle + jitter) * radial;
    y[index] = Math.sin(angle + jitter) * radial;
  }
  return { x, y, kinds };
}

function connectedLand(land: Uint8Array): number {
  const centre = worldHexIndex(2, 17);
  if (centre < 0 || land[centre] === 0) throw new Error("world plan lost its central land core");
  const visited = new Uint8Array(WORLD_HEX_COUNT);
  const queue = new Int16Array(WORLD_HEX_COUNT);
  let head = 0;
  let tail = 1;
  queue[0] = centre;
  visited[centre] = 1;
  while (head < tail) {
    const index = queue[head++]!;
    const q = worldHexQ(index);
    const r = worldHexR(index);
    for (let direction = 0; direction < 6; direction += 1) {
      const neighbor = worldHexNeighbor(q, r, direction);
      if (neighbor < 0 || land[neighbor] === 0 || visited[neighbor] !== 0) continue;
      visited[neighbor] = 1;
      queue[tail++] = neighbor;
    }
  }
  for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
    if (land[index] !== 0 && visited[index] === 0) land[index] = 0;
  }
  return tail;
}

function projectCells(
  land: Uint8Array,
  biome: Uint8Array,
  elevation: Uint8Array,
): { cellLand: Uint8Array; cellBiome: Uint8Array; cellElevation: Uint8Array } {
  const cellLand = new Uint8Array(MAP_CELLS);
  const cellBiome = new Uint8Array(MAP_CELLS);
  const cellElevation = new Uint8Array(MAP_CELLS);
  const hex = { q: 0, r: 0, dx: 0, dy: 0 };
  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      hexCellAt((x + 0.5) * TILE_PIXELS, (y + 0.5) * TILE_PIXELS, hex);
      const index = worldHexIndex(hex.q, hex.r);
      if (index < 0 || land[index] === 0) continue;
      const cell = y * MAP_WIDTH + x;
      cellLand[cell] = 1;
      cellBiome[cell] = biome[index]!;
      cellElevation[cell] = elevation[index]!;
    }
  }
  return { cellLand, cellBiome, cellElevation };
}

function placeSpawnReservations(cellLand: Uint8Array): {
  spawnCells: Int32Array;
  reserved: Uint8Array;
  clear: Uint8Array;
} {
  const clear = new Uint8Array(MAP_CELLS);
  for (let y = 2; y < MAP_HEIGHT - 2; y += 1) {
    for (let x = 2; x < MAP_WIDTH - 2; x += 1) {
      let open = true;
      for (let dy = -2; dy <= 2 && open; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (cellLand[(y + dy) * MAP_WIDTH + x + dx] === 0) {
            open = false;
            break;
          }
        }
      }
      if (open) clear[y * MAP_WIDTH + x] = 1;
    }
  }
  const spawnCells = new Int32Array(WORLD_PLAN_SPAWN_COUNT);
  const reserved = new Uint8Array(MAP_CELLS);
  for (let slot = 0; slot < WORLD_PLAN_SPAWN_COUNT; slot += 1) {
    const angle = (2 * Math.PI * slot) / WORLD_PLAN_SPAWN_COUNT;
    const targetX = MAP_WIDTH / 2 + Math.cos(angle) * (MAP_WIDTH * 0.31);
    const targetY = MAP_HEIGHT / 2 + Math.sin(angle) * (MAP_HEIGHT * 0.31);
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let cell = 0; cell < MAP_CELLS; cell += 1) {
      if (clear[cell] === 0 || reserved[cell] !== 0) continue;
      const x = cell % MAP_WIDTH;
      const y = Math.floor(cell / MAP_WIDTH);
      const score = (x - targetX) ** 2 + (y - targetY) ** 2;
      if (score < bestScore) {
        best = cell;
        bestScore = score;
      }
    }
    if (best < 0) throw new Error(`world plan has no tank-capable spawn for slot ${slot}`);
    spawnCells[slot] = best;
    const x = best % MAP_WIDTH;
    const y = Math.floor(best / MAP_WIDTH);
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < MAP_WIDTH && ny >= 0 && ny < MAP_HEIGHT && dx * dx + dy * dy <= 16) {
          reserved[ny * MAP_WIDTH + nx] = 1;
        }
      }
    }
  }
  return { spawnCells, reserved, clear };
}

function radicalInverse(index: number, base: number): number {
  let reversed = 0;
  let divisor = 1;
  while (index > 0) {
    divisor *= base;
    reversed = reversed * base + (index % base);
    index = Math.floor(index / base);
  }
  return reversed / divisor;
}

function placePlayerStarts(seed: number, clear: Uint8Array, reserved: Uint8Array): Int32Array {
  const candidates: number[] = [];
  for (let y = 4; y < MAP_HEIGHT - 4; y += 4) {
    for (let x = 4; x < MAP_WIDTH - 4; x += 4) {
      const cell = y * MAP_WIDTH + x;
      if (clear[cell] !== 0) candidates.push(cell);
    }
  }
  candidates.sort((left, right) => {
    const orderLeft = mix32(seed ^ 0x5354_4152, left);
    const orderRight = mix32(seed ^ 0x5354_4152, right);
    return orderLeft - orderRight || left - right;
  });
  const starts = new Int32Array(WORLD_PLAN_START_COUNT);
  let count = 0;
  for (const candidate of candidates) {
    if (count === WORLD_PLAN_START_COUNT) break;
    const x = candidate % MAP_WIDTH;
    const y = Math.floor(candidate / MAP_WIDTH);
    let separated = true;
    for (let prior = 0; prior < count; prior += 1) {
      const previous = starts[prior]!;
      const dx = x - (previous % MAP_WIDTH);
      const dy = y - Math.floor(previous / MAP_WIDTH);
      if (dx * dx + dy * dy < 64) {
        separated = false;
        break;
      }
    }
    if (!separated) continue;
    starts[count++] = candidate;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        if (dx * dx + dy * dy <= 4) reserved[(y + dy) * MAP_WIDTH + x + dx] = 1;
      }
    }
  }
  if (count !== WORLD_PLAN_START_COUNT) throw new Error(`world plan has only ${count} separated tank starts`);
  return starts;
}

function placeProps(
  seed: number,
  cellLand: Uint8Array,
  cellBiome: Uint8Array,
  reserved: Uint8Array,
  clear: Uint8Array,
  spawnCells: Int32Array,
): {
  propCells: Int32Array;
  propKinds: Uint8Array;
  propVisualRadius: Uint8Array;
  propSolid: Uint8Array;
  depotFacadeCells: Int32Array;
  propCount: number;
} {
  const propCells = new Int32Array(WORLD_PLAN_MAX_PROPS);
  const propKinds = new Uint8Array(WORLD_PLAN_MAX_PROPS);
  const propVisualRadius = new Uint8Array(WORLD_PLAN_MAX_PROPS);
  const propSolid = new Uint8Array(MAP_CELLS);
  const depotFacadeCells = new Int32Array(WORLD_PLAN_SPAWN_COUNT);
  depotFacadeCells.fill(-1);
  const offsetX = mix32(seed ^ 0x5350_4f52, 0) / 0x1_0000_0000;
  const offsetY = mix32(seed ^ 0x5350_4f52, 1) / 0x1_0000_0000;
  let propCount = 0;
  function accept(x: number, y: number, kind: number): boolean {
    const cell = y * MAP_WIDTH + x;
    if (clear[cell] === 0 || reserved[cell] !== 0) return false;
    // A tank-depot apron is smaller than its decorative sprite. Protect a
    // bounded compass set in screen space before accepting scenery, so the
    // runtime never has to hide every depot to avoid a tree/building overlap.
    for (const slot of WORLD_PLAN_VISIBLE_DEPOT_SLOTS) {
      if (worldPropOverlapsDepotSprite(cell, depotFacadeCells[slot]!)) return false;
    }
    const visualRadius = kind === WORLD_PROP_BUILDING ? 4 : kind === WORLD_PROP_TREE ? 3 : 2;
    const solidRadius = kind === WORLD_PROP_BUILDING ? 2 : 1;
    let valid = true;
    for (let dy = -visualRadius; dy <= visualRadius && valid; dy += 1) {
      for (let dx = -visualRadius; dx <= visualRadius; dx += 1) {
        if (dx * dx + dy * dy > visualRadius * visualRadius) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_WIDTH || ny >= MAP_HEIGHT) {
          valid = false;
          break;
        }
        const footprintCell = ny * MAP_WIDTH + nx;
        if (cellLand[footprintCell] === 0 || reserved[footprintCell] !== 0) {
          valid = false;
          break;
        }
      }
    }
    if (!valid) return false;
    for (let prior = 0; prior < propCount; prior += 1) {
      const priorCell = propCells[prior]!;
      if (worldPropSpritesOverlap(seed, cell, kind, priorCell, propKinds[prior]!)) {
        valid = false;
        break;
      }
      if (kind === WORLD_PROP_ROCK && propKinds[prior] === WORLD_PROP_ROCK && worldRockSpritesCrowd(cell, priorCell)) {
        valid = false;
        break;
      }
      const dx = x - (priorCell % MAP_WIDTH);
      const dy = y - Math.floor(priorCell / MAP_WIDTH);
      const separation = visualRadius + propVisualRadius[prior]! + 2;
      if (dx * dx + dy * dy < separation * separation) {
        valid = false;
        break;
      }
    }
    if (!valid) return false;
    propCells[propCount] = cell;
    propKinds[propCount] = kind;
    propVisualRadius[propCount] = visualRadius;
    propCount += 1;
    for (let dy = -solidRadius; dy <= solidRadius; dy += 1) {
      for (let dx = -solidRadius; dx <= solidRadius; dx += 1) {
        if (dx * dx + dy * dy <= solidRadius * solidRadius) propSolid[(y + dy) * MAP_WIDTH + x + dx] = 1;
      }
    }
    return true;
  }
  // A depot building is a real world object, not a sprite shifted away from
  // its gameplay apron. Select a land-grounded facade near each protected
  // spawn before scenery; the same cell owns both its sprite and collision.
  for (const slot of WORLD_PLAN_VISIBLE_DEPOT_SLOTS) {
    const spawn = spawnCells[slot]!;
    const spawnX = spawn % MAP_WIDTH;
    const spawnY = Math.floor(spawn / MAP_WIDTH);
    const spawnWorldX = WORLD_MIN_X + (spawnX + 0.5) * TILE_UNITS;
    const spawnWorldY = WORLD_MIN_Y + (spawnY + 0.5) * TILE_UNITS;
    let chosen = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let dy = -12; dy <= 12; dy += 1) {
      for (let dx = -12; dx <= 12; dx += 1) {
        const x = spawnX + dx;
        const y = spawnY + dy;
        if (x < 4 || y < 4 || x >= MAP_WIDTH - 4 || y >= MAP_HEIGHT - 4) continue;
        const worldX = WORLD_MIN_X + (x + 0.5) * TILE_UNITS;
        const worldY = WORLD_MIN_Y + (y + 0.5) * TILE_UNITS;
        const screenX = isometricScreenX(worldX, worldY) - isometricScreenX(spawnWorldX, spawnWorldY);
        const screenY = isometricScreenY(worldX, worldY) - isometricScreenY(spawnWorldX, spawnWorldY);
        if (screenY < 0 || screenY > 96 || Math.abs(screenX) > 180 || (Math.abs(screenX) < 48 && screenY < 50))
          continue;
        let valid = true;
        for (let oy = -4; oy <= 4 && valid; oy += 1) {
          for (let ox = -4; ox <= 4; ox += 1) {
            if (ox * ox + oy * oy > 16) continue;
            const footprint = (y + oy) * MAP_WIDTH + x + ox;
            if (cellLand[footprint] === 0 || (ox * ox + oy * oy <= 1 && reserved[footprint] !== 0)) {
              valid = false;
              break;
            }
          }
        }
        if (!valid) continue;
        for (const prior of WORLD_PLAN_VISIBLE_DEPOT_SLOTS) {
          const priorCell = depotFacadeCells[prior]!;
          if (priorCell < 0) continue;
          const priorX = WORLD_MIN_X + ((priorCell % MAP_WIDTH) + 0.5) * TILE_UNITS;
          const priorY = WORLD_MIN_Y + (Math.floor(priorCell / MAP_WIDTH) + 0.5) * TILE_UNITS;
          if (
            Math.abs(isometricScreenX(worldX, worldY) - isometricScreenX(priorX, priorY)) < 112 &&
            Math.abs(isometricScreenY(worldX, worldY) - isometricScreenY(priorX, priorY)) < 96
          )
            valid = false;
        }
        if (!valid) continue;
        const score = screenX * screenX + (screenY - 64) * (screenY - 64);
        if (score < bestScore) {
          bestScore = score;
          chosen = y * MAP_WIDTH + x;
        }
      }
    }
    if (chosen < 0) throw new Error(`world plan has no grounded depot facade for slot ${slot}`);
    depotFacadeCells[slot] = chosen;
    propCells[propCount] = chosen;
    propKinds[propCount] = WORLD_PROP_DEPOT;
    propVisualRadius[propCount] = 4;
    propCount += 1;
    const x = chosen % MAP_WIDTH;
    const y = Math.floor(chosen / MAP_WIDTH);
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        if (ox * ox + oy * oy <= 1) propSolid[(y + oy) * MAP_WIDTH + x + ox] = 1;
      }
    }
  }
  // Place the command post as an object, not as a biome. Prefer the broad
  // meadow for readable contrast, then accept any full land footprint.
  let hasBuilding = false;
  for (let candidate = 1; candidate <= 512 && !hasBuilding; candidate += 1) {
    const x = Math.floor(((radicalInverse(candidate, 2) + offsetX) % 1) * MAP_WIDTH);
    const y = Math.floor(((radicalInverse(candidate, 3) + offsetY) % 1) * MAP_HEIGHT);
    if (cellBiome[y * MAP_WIDTH + x] === WORLD_BIOME_MEADOW) hasBuilding = accept(x, y, WORLD_PROP_BUILDING);
  }
  for (let candidate = 1; candidate <= 512 && !hasBuilding; candidate += 1) {
    const x = Math.floor(((radicalInverse(candidate, 2) + offsetX) % 1) * MAP_WIDTH);
    const y = Math.floor(((radicalInverse(candidate, 3) + offsetY) % 1) * MAP_HEIGHT);
    hasBuilding = accept(x, y, WORLD_PROP_BUILDING);
  }
  if (!hasBuilding) throw new Error("world plan has no grounded building footprint");
  // A short seeded Halton sequence fills gaps predictably. Every accepted
  // candidate still passes the island, reservation and full-footprint rules.
  for (let candidate = 1; candidate <= 2048 && propCount < WORLD_PLAN_MAX_PROPS; candidate += 1) {
    const x = Math.floor(((radicalInverse(candidate, 2) + offsetX) % 1) * MAP_WIDTH);
    const y = Math.floor(((radicalInverse(candidate, 3) + offsetY) % 1) * MAP_HEIGHT);
    const cell = y * MAP_WIDTH + x;
    const roll = mix32(seed ^ 0x5052_4f50, candidate);
    const biome = cellBiome[cell];
    const kind =
      biome === WORLD_BIOME_MEADOW
        ? roll % 13 === 0
          ? WORLD_PROP_BUILDING
          : roll % 5 === 0
            ? WORLD_PROP_ROCK
            : WORLD_PROP_TREE
        : biome === WORLD_BIOME_EARTH && roll % 13 === 0
          ? WORLD_PROP_BUILDING
          : WORLD_PROP_ROCK;
    accept(x, y, kind);
  }
  return { propCells, propKinds, propVisualRadius, propSolid, depotFacadeCells, propCount };
}

function routeBuiltSurface(
  land: Uint8Array,
  propCells: Int32Array,
  propKinds: Uint8Array,
  propCount: number,
  spawnCells: Int32Array,
): Uint8Array {
  const builtSurface = new Uint8Array(WORLD_HEX_COUNT);
  let buildingCell = -1;
  for (let prop = 0; prop < propCount; prop += 1) {
    if (propKinds[prop] === WORLD_PROP_BUILDING) {
      buildingCell = propCells[prop]!;
      break;
    }
  }
  if (buildingCell < 0) throw new Error("world plan lost its command post");
  const hex = { q: 0, r: 0, dx: 0, dy: 0 };
  const hexAtCell = (cell: number): number => {
    hexCellAt(((cell % MAP_WIDTH) + 0.5) * TILE_PIXELS, (Math.floor(cell / MAP_WIDTH) + 0.5) * TILE_PIXELS, hex);
    return worldHexIndex(hex.q, hex.r);
  };
  const start = hexAtCell(buildingCell);
  const core = worldHexIndex(2, 17);
  if (start < 0 || land[start] === 0) throw new Error("world plan command post is outside the island");
  let nearestDepot = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const cell of spawnCells) {
    const depot = hexAtCell(cell);
    if (depot < 0 || land[depot] === 0) continue;
    const distance = Math.abs(worldHexQ(depot) - worldHexQ(start)) + Math.abs(worldHexR(depot) - worldHexR(start));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestDepot = depot;
    }
  }
  const frontier = new Int16Array(WORLD_HEX_COUNT);
  const parent = new Int16Array(WORLD_HEX_COUNT);
  for (const goal of [core, nearestDepot]) {
    if (goal < 0 || goal === start) continue;
    parent.fill(-1);
    let head = 0;
    let tail = 1;
    frontier[0] = start;
    parent[start] = start;
    while (head < tail && parent[goal]! < 0) {
      const index = frontier[head++]!;
      const q = worldHexQ(index);
      const r = worldHexR(index);
      for (let direction = 0; direction < 6; direction += 1) {
        const neighbor = worldHexNeighbor(q, r, direction);
        if (neighbor < 0 || land[neighbor] === 0 || parent[neighbor]! >= 0) continue;
        parent[neighbor] = index;
        frontier[tail++] = neighbor;
      }
    }
    if (parent[goal]! < 0) throw new Error("world plan infrastructure crossed water");
    for (let index = goal; index !== start; index = parent[index]!) builtSurface[index] = WORLD_BUILT_ROUTE;
  }
  builtSurface[start] = WORLD_BUILT_PAD;
  return builtSurface;
}

export function buildWorldPlan(seed: number): WorldPlan {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("world seed must be an unsigned 32-bit integer");
  }
  const land = new Uint8Array(WORLD_HEX_COUNT);
  const biome = new Uint8Array(WORLD_HEX_COUNT);
  const elevation = new Uint8Array(WORLD_HEX_COUNT);
  const coastEdges = new Uint8Array(WORLD_HEX_COUNT);
  const sites = seedBiomeSites(seed);
  for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
    const q = worldHexQ(index);
    const r = worldHexR(index);
    if (!insideWorld(q, r)) continue;
    const distance = islandDistance(q, r);
    // Perturb the six-sided support at the coast, not every interior hex. A
    // narrower amplitude produced near-identical silhouettes across seeds.
    const coastVariation = valueNoise(q, r, 5, seed ^ 0x1f90_e17a) * 0.15;
    if (distance > 0.91 + coastVariation) continue;
    land[index] = 1;
  }
  const landCount = connectedLand(land);
  for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
    if (land[index] === 0) continue;
    const q = worldHexQ(index);
    const r = worldHexR(index);
    const centre = hexCentreAtSimulation(q, r);
    const x = (centre.x - WORLD_MIN_X) / UNITS_PER_PIXEL / (WORLD_WIDTH_PIXELS / 2) - 1;
    const y = (centre.y - WORLD_MIN_Y) / UNITS_PER_PIXEL / (WORLD_HEIGHT_PIXELS / 2) - 1;
    // Perturb Voronoi edges without letting a distant outer natural site erase
    // a whole volcanic interior site on unlucky seeds.
    const borderNoise = valueNoise(q, r, 7, seed ^ 0x172d_650b) * 0.008;
    let bestSite = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let site = 0; site < BIOME_SITE_KINDS.length; site += 1) {
      const dx = x - sites.x[site]!;
      const dy = y - sites.y[site]!;
      const kind = sites.kinds[site]!;
      const naturalGroundBias = kind === WORLD_BIOME_EARTH ? 0.08 : 0;
      const distance = dx * dx + dy * dy + borderNoise * (site & 1 ? -1 : 1) + naturalGroundBias;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSite = site;
      }
    }
    const chosen = sites.kinds[bestSite]!;
    // Volcanic material is a restrained interior accent, not a dark coast
    // wedge. Outside the core the same cell resolves to legible natural earth.
    biome[index] =
      islandDistance(q, r) > 0.45 && (chosen === WORLD_BIOME_BASALT || chosen === WORLD_BIOME_ASH)
        ? WORLD_BIOME_EARTH
        : chosen;
    const relief = valueNoise(q, r, 6, seed ^ 0xe0a4_1217) * 0.64 + valueNoise(q, r, 11, seed ^ 0x2d83_1b09) * 0.36;
    elevation[index] = relief > 0.26 ? 2 : relief < -0.26 ? 0 : 1;
  }
  // A high-to-low step makes a cosmetic cliff look drivable while the physics
  // stays flat. Insert a standard tier at every such adjacency.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
      if (land[index] === 0 || elevation[index] !== 2) continue;
      const q = worldHexQ(index);
      const r = worldHexR(index);
      for (let direction = 0; direction < 6; direction += 1) {
        const neighbor = worldHexNeighbor(q, r, direction);
        if (neighbor >= 0 && land[neighbor] !== 0 && elevation[neighbor] === 0) {
          elevation[index] = 1;
          break;
        }
      }
    }
  }
  for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
    if (land[index] === 0) continue;
    const q = worldHexQ(index);
    const r = worldHexR(index);
    let mask = 0;
    for (let direction = 0; direction < 6; direction += 1) {
      const neighbor = worldHexNeighbor(q, r, direction);
      if (neighbor < 0 || land[neighbor] === 0) mask |= 1 << direction;
    }
    coastEdges[index] = mask;
  }
  const { cellLand, cellBiome, cellElevation } = projectCells(land, biome, elevation);
  const { spawnCells, reserved, clear } = placeSpawnReservations(cellLand);
  const playerStartCells = placePlayerStarts(seed, clear, reserved);
  const props = placeProps(seed, cellLand, cellBiome, reserved, clear, spawnCells);
  const builtSurface = routeBuiltSurface(land, props.propCells, props.propKinds, props.propCount, spawnCells);
  return {
    seed,
    rulesVersion: WORLD_PLAN_RULES_VERSION,
    land,
    biome,
    elevation,
    coastEdges,
    builtSurface,
    cellLand,
    cellBiome,
    cellElevation,
    reserved,
    spawnCells,
    playerStartCells,
    ...props,
    landCount,
  };
}
