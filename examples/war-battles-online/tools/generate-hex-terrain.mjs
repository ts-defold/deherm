#!/usr/bin/env node
// Authored source textures provide detail; this tool owns the hex topology,
// landform grammar, palette, edge treatment and exact repeat period. The
// simulation remains continuous: terrain is presentation, not a hex movement
// grid. The 1152px macro gives 144 distinct hexes before it repeats.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEX_DIRT_SPUR,
  HEX_SERVICE_ROUTE,
  HEX_MACRO_CELLS,
  HEX_MACRO_EDGE,
  hexCellAt,
  hexReliefTier,
  hexTerrainRole,
} from "../core/hex-landscape.ts";
import { buildWorldPlan, worldPlanElevationAt, worldPlanSurfaceRoleAt } from "../core/world-plan.ts";
import { MAP_HEIGHT, MAP_WIDTH, TILE_PIXELS } from "../core/constants.ts";
import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";
import { HEX_TILE_SELECTION_PATH, loadHexFamilySources, readHexSourceSelection } from "./hex-source-selection.mjs";

export {
  HEX_DIRT_SPUR,
  HEX_MACRO_CELLS,
  HEX_MACRO_EDGE,
  hexCellAt,
  hexReliefTier,
  hexTerrainRole,
} from "../core/hex-landscape.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestPath = "art/source/sprite-fusion/requests/frontier-hex-meadow-v1.json";
const sourceManifestPath = "art/source/imagegen/hex-frontier-manifest.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;
const sourceManifest = JSON.parse(readFileSync(resolve(root, sourceManifestPath), "utf8"));
if (sourceManifest.schemaVersion !== 1) throw new Error("unsupported hex source manifest");
const TEXTURE_SOURCES = sourceManifest.textures;
const TEXTURES = Object.fromEntries(
  Object.entries(TEXTURE_SOURCES).map(([role, record]) => {
    const bytes = readFileSync(resolve(root, record.path));
    if (hash(bytes) !== record.sha256) throw new Error(`hex ${role} texture source checksum mismatch`);
    return [role, decodeRgbaPng(bytes)];
  }),
);
const { selection: tileSelection, sha256: tileSelectionSha256 } = readHexSourceSelection(root);
const TILE_SOURCES = Object.fromEntries(
  Object.keys(tileSelection.families).map((role) => {
    const variants = loadHexFamilySources(root, tileSelection, role, decodeRgbaPng).map((source) => {
      const bounds = alphaBounds(source.image);
      if (!bounds) throw new Error(`Sprite Fusion hex source is empty: ${source.path}`);
      return { ...source, bounds };
    });
    return [role, variants];
  }),
);

const PALETTES = Object.freeze({
  G: [
    [48, 79, 43],
    [70, 106, 53],
    [78, 117, 58],
    [89, 129, 64],
    [108, 143, 74],
  ],
  D: [
    [87, 72, 54],
    [119, 99, 65],
    [151, 126, 79],
    [180, 155, 101],
    [207, 184, 126],
  ],
  B: [
    [26, 30, 35],
    [41, 44, 49],
    [57, 59, 62],
    [77, 77, 75],
    [101, 99, 88],
  ],
  A: [
    [29, 29, 33],
    [45, 40, 39],
    [67, 51, 43],
    [93, 63, 43],
    [124, 79, 44],
  ],
  M: [
    [33, 39, 43],
    [55, 63, 64],
    [81, 87, 82],
    [109, 112, 98],
    [143, 139, 110],
  ],
});
const TEXTURE_SEAM_BLEND = 80;
const lumaAt = (texture, x, y) => {
  const i = (y * texture.width + x) * 4;
  return (texture.pixels[i] * 3 + texture.pixels[i + 1] * 5 + texture.pixels[i + 2] * 2) / 10;
};
function seamWeight(pixel, size) {
  const edge = Math.min(pixel, size - 1 - pixel);
  if (edge >= TEXTURE_SEAM_BLEND) return 1;
  const fraction = edge / TEXTURE_SEAM_BLEND;
  const smooth = fraction * fraction * (3 - 2 * fraction);
  return 0.5 + smooth * 0.5;
}
function periodicTextureLuma(texture, x, y) {
  const weightX = seamWeight(x, texture.width);
  const weightY = seamWeight(y, texture.height);
  const main = lumaAt(texture, x, y);
  if (weightX === 1 && weightY === 1) return main;
  const mirrorX = texture.width - 1 - x;
  const mirrorY = texture.height - 1 - y;
  const acrossX = weightX === 1 ? main : lumaAt(texture, mirrorX, y);
  const top = main * weightX + acrossX * (1 - weightX);
  if (weightY === 1) return top;
  const acrossY = lumaAt(texture, x, mirrorY);
  const corner = weightX === 1 ? acrossY : lumaAt(texture, mirrorX, mirrorY);
  const bottom = acrossY * weightX + corner * (1 - weightX);
  return top * weightY + bottom * (1 - weightY);
}
const hash32 = (a, b, seed = 0) => {
  let value = Math.imul(a ^ seed, 0x9e3779b1) ^ Math.imul(b ^ (seed >>> 3), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  return (value ^ (value >>> 15)) >>> 0;
};

const DIRT_NODE_MASK = new Uint8Array(HEX_MACRO_CELLS * HEX_MACRO_CELLS);
for (let r = 0; r < HEX_MACRO_CELLS; r++) {
  for (let q = 0; q < HEX_MACRO_CELLS; q++) {
    if (hexTerrainRole(q, r) === "D") DIRT_NODE_MASK[r * HEX_MACRO_CELLS + q] = 1;
  }
}
for (const [q, r] of HEX_DIRT_SPUR) DIRT_NODE_MASK[r * HEX_MACRO_CELLS + q] = 1;
const dirtNode = (q, r) => DIRT_NODE_MASK[mod(r, HEX_MACRO_CELLS) * HEX_MACRO_CELLS + mod(q, HEX_MACRO_CELLS)] === 1;
// Source D cells are hints, not permission to draw a free-standing road tile.
// Retain only cells connected to another road/spur hex in the six-neighbor
// topology; isolated source D cells otherwise become conspicuous tan islands.
for (let r = 0; r < HEX_MACRO_CELLS; r++) {
  for (let q = 0; q < HEX_MACRO_CELLS; q++) {
    if (hexTerrainRole(q, r) !== "D") continue;
    const diagonalR = r + (q & 1 ? 1 : -1);
    const connected =
      dirtNode(q, r - 1) ||
      dirtNode(q, r + 1) ||
      dirtNode(q - 1, r) ||
      dirtNode(q + 1, r) ||
      dirtNode(q - 1, diagonalR) ||
      dirtNode(q + 1, diagonalR);
    if (!connected) DIRT_NODE_MASK[r * HEX_MACRO_CELLS + q] = 0;
  }
}
const NEAR_DIRT_MASK = new Uint8Array(HEX_MACRO_CELLS * HEX_MACRO_CELLS);
for (let r = 0; r < HEX_MACRO_CELLS; r++) {
  for (let q = 0; q < HEX_MACRO_CELLS; q++) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dq = -1; dq <= 1; dq++) {
        if (dirtNode(q + dq, r + dr)) NEAR_DIRT_MASK[r * HEX_MACRO_CELLS + q] = 1;
      }
    }
  }
}
function hexPointSegmentDistanceSq(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  const x = px - ax - t * vx;
  const y = py - ay - t * vy;
  return x * x + y * y;
}

/** Distance to the joined centers of nearby authored dirt cells, in hex-space pixels. */
export function hexDirtDistanceSq(q, r, dx, dy) {
  let closest = Number.POSITIVE_INFINITY;
  const parity = q & 1;
  for (let stepQ = -1; stepQ <= 1; stepQ++) {
    const roadQ = q + stepQ;
    for (let stepR = -1; stepR <= 1; stepR++) {
      const roadR = r + stepR;
      if (!dirtNode(roadQ, roadR)) continue;
      const x = stepQ * 96;
      const y = stepR * 96 + ((roadQ & 1) - parity) * 48;
      const point = (dx - x) ** 2 + (dy - y) ** 2;
      if (point < closest) closest = point;
      for (const [nextQ, nextR] of [
        [roadQ, roadR + 1],
        [roadQ + 1, roadR],
        [roadQ + 1, roadR + (roadQ & 1 ? 1 : -1)],
      ]) {
        if (!dirtNode(nextQ, nextR)) continue;
        const nextX = (nextQ - q) * 96;
        const nextY = (nextR - r) * 96 + ((nextQ & 1) - parity) * 48;
        const segment = hexPointSegmentDistanceSq(dx, dy, x, y, nextX, nextY);
        if (segment < closest) closest = segment;
      }
    }
  }
  return closest;
}

function periodicNoise(worldX, worldY) {
  const step = 24;
  const period = HEX_MACRO_EDGE / step;
  const sampleX = mod(worldX, HEX_MACRO_EDGE) / step;
  const sampleY = mod(worldY, HEX_MACRO_EDGE) / step;
  const x = Math.floor(sampleX);
  const y = Math.floor(sampleY);
  const fx = sampleX - x;
  const fy = sampleY - y;
  const smoothX = fx * fx * (3 - 2 * fx);
  const smoothY = fy * fy * (3 - 2 * fy);
  const sample = (offsetX, offsetY) =>
    (hash32(mod(x + offsetX, period), mod(y + offsetY, period), 0x524f_4144) & 65535) / 65535;
  const top = sample(0, 0) * (1 - smoothX) + sample(1, 0) * smoothX;
  const bottom = sample(0, 1) * (1 - smoothX) + sample(1, 1) * smoothX;
  return top * (1 - smoothY) + bottom * smoothY;
}

/** The role at one floor pixel: dirt traces a route, not a union of full hex plates. */
export function hexDirtPaintRole(q, r, dx, dy, worldX, worldY, baseRole = hexTerrainRole(q, r)) {
  if (baseRole !== "D" && baseRole !== "G") return baseRole;
  if (baseRole === "G" && NEAR_DIRT_MASK[mod(r, HEX_MACRO_CELLS) * HEX_MACRO_CELLS + mod(q, HEX_MACRO_CELLS)] === 0)
    return baseRole;
  const distance = Math.sqrt(hexDirtDistanceSq(q, r, dx, dy));
  // A wide union of all connected road edges turned junctions into tan ponds.
  // Keep a driveable earthen path while letting meadow break up its shoulder.
  const halfWidth = 26 + (periodicNoise(worldX, worldY) - 0.5) * 12;
  const coverage = Math.max(0, Math.min(1, (halfWidth + 7 - distance) / 14));
  const grain = hash32(
    Math.floor(mod(worldX, HEX_MACRO_EDGE) / 2),
    Math.floor(mod(worldY, HEX_MACRO_EDGE) / 2),
    0x4544_4745,
  );
  return (grain & 255) / 255 < coverage ? "D" : "G";
}

/** One crater-scale scar replaces the B/A source cluster's repeated hex plaques. */
export function hexRockPaintRole(q, r, _dx, _dy, worldX, worldY, baseRole = hexTerrainRole(q, r)) {
  if (baseRole !== "G" && baseRole !== "B" && baseRole !== "A") return baseRole;
  // The source cluster straddles the macro's north/south seam. Wrapped
  // world-space coordinates make this one continuous irregular impact mark,
  // not eight independent dark discs stamped at individual cell centers.
  const offsetX = mod(worldX - 194 + HEX_MACRO_EDGE / 2, HEX_MACRO_EDGE) - HEX_MACRO_EDGE / 2;
  const offsetY = mod(worldY - 16 + HEX_MACRO_EDGE / 2, HEX_MACRO_EDGE) - HEX_MACRO_EDGE / 2;
  const distance = Math.hypot(offsetX / 63, offsetY / 43);
  const irregularity = (periodicNoise(worldX, worldY) - 0.5) * 0.3;
  const radius = distance + irregularity;
  const fleck = hash32(
    Math.floor(mod(worldX, HEX_MACRO_EDGE) / 2),
    Math.floor(mod(worldY, HEX_MACRO_EDGE) / 2),
    0x524f_434b,
  );
  const edge = (fleck & 255) / 255;
  if (radius < 0.58 + (edge - 0.5) * 0.08) return radius < 0.18 && (fleck & 7) === 0 ? "A" : "B";
  if (radius < 1.17 + (edge - 0.5) * 0.16) return "D";
  return "G";
}

const SERVICE_SEGMENTS = Array.from({ length: HEX_MACRO_CELLS * HEX_MACRO_CELLS }, () => null);
let serviceDistance = 0;
for (let index = 0; index < HEX_SERVICE_ROUTE.length; index++) {
  const [q, r] = HEX_SERVICE_ROUTE[index];
  const previous = HEX_SERVICE_ROUTE[index - 1];
  const next = HEX_SERVICE_ROUTE[index + 1];
  if (previous) {
    serviceDistance += Math.hypot((q - previous[0]) * 96, (r - previous[1]) * 96 + ((q & 1) - (previous[0] & 1)) * 48);
  }
  const vector = (neighbor) =>
    neighbor ? [(neighbor[0] - q) * 96, (neighbor[1] - r) * 96 + ((neighbor[0] & 1) - (q & 1)) * 48] : null;
  SERVICE_SEGMENTS[r * HEX_MACRO_CELLS + q] = {
    previous: vector(previous),
    next: vector(next),
    distance: serviceDistance,
  };
}

/** Pixel role 0=unmarked, 1=dark centerline bed, 2=amber lane dash. */
function hexServiceRouteSample(q, r, dx, dy) {
  const segment = SERVICE_SEGMENTS[mod(r, HEX_MACRO_CELLS) * HEX_MACRO_CELLS + mod(q, HEX_MACRO_CELLS)];
  if (!segment) return { distance: Number.POSITIVE_INFINITY, along: 0 };
  let nearest = Number.POSITIVE_INFINITY;
  let along = 0;
  for (let branch = 0; branch < 2; branch++) {
    const vector = branch === 0 ? segment.previous : segment.next;
    if (!vector) continue;
    const length = Math.hypot(vector[0], vector[1]);
    const projected = (dx * vector[0] + dy * vector[1]) / length;
    if (projected < 0 || projected > length * 0.5) continue;
    const offset = Math.abs(dx * vector[1] - dy * vector[0]) / length;
    if (offset < nearest) {
      nearest = offset;
      along = segment.distance + (branch === 0 ? -projected : projected);
    }
  }
  return { distance: nearest, along };
}

/** Paint only a narrow lane in M source cells; unoccupied shoulder is meadow. */
export function hexServicePaintRole(q, r, dx, dy, worldX, worldY, baseRole = hexTerrainRole(q, r)) {
  if (baseRole !== "M") return baseRole;
  const { distance } = hexServiceRouteSample(q, r, dx, dy);
  const halfWidth = 22 + (periodicNoise(worldX, worldY) - 0.5) * 5;
  return distance < halfWidth ? "M" : "G";
}

/** Compose source materials into the actual painted floor role. */
export function hexGroundRole(q, r, dx, dy, worldX, worldY, baseRole = hexTerrainRole(q, r)) {
  if (baseRole === "M") return hexServicePaintRole(q, r, dx, dy, worldX, worldY, baseRole);
  if (hexDirtPaintRole(q, r, dx, dy, worldX, worldY, baseRole) === "D") return "D";
  return hexRockPaintRole(q, r, dx, dy, worldX, worldY, baseRole === "D" ? "G" : baseRole);
}

/** Pixel role 0=unmarked, 1=dark centerline bed, 2=amber lane dash. */
export function hexServiceRoutePixel(q, r, dx, dy) {
  const { distance, along } = hexServiceRouteSample(q, r, dx, dy);
  if (distance > 4.5) return 0;
  return distance < 2.4 && mod(Math.floor(along), 38) < 22 ? 2 : 1;
}

/**
 * Map a walkable hex sample into the inset TOP face of an isometric source.
 * Sprite Fusion's source bounds include the vertical side walls. Treating
 * their whole upper half as a flat texture stamped those side-wall pixels as
 * dark rectangular plaques on the ground. The top diamond occupies roughly
 * the upper 56% of each selected source's opaque bounds; sampling only its
 * central 60% keeps even hex corners away from the diamond's side edges.
 */
export function hexTopFaceSample(bounds, dx, dy) {
  const [left, top, right, bottom] = bounds;
  const centreX = (left + right) / 2;
  const faceHeight = (bottom - top + 1) * 0.56;
  const sourceX = Math.round(centreX + (dx / 64) * ((right - left + 1) / 2) * 0.6);
  const sourceY = Math.round(top + faceHeight * (0.5 + (dy / 48) * 0.3));
  return [Math.max(left, Math.min(right, sourceX)), Math.max(top, Math.min(bottom, sourceY))];
}

function terrainRoleAt(plan, q, r) {
  return plan === undefined ? hexTerrainRole(q, r) : worldPlanSurfaceRoleAt(plan, q, r);
}

function terrainTierAt(plan, q, r) {
  return plan === undefined ? hexReliefTier(q, r) : worldPlanElevationAt(plan, q, r);
}

export function hexVisualRole(q, r, plan) {
  const base = terrainRoleAt(plan, q, r);
  const diagonalRows = q & 1 ? [r, r + 1] : [r - 1, r];
  const neighbors = [
    terrainRoleAt(plan, q, r - 1),
    terrainRoleAt(plan, q, r + 1),
    ...[-1, 1].flatMap((side) => diagonalRows.map((row) => terrainRoleAt(plan, q + side, row))),
  ];
  if (base === "G") {
    if (neighbors.some((role) => role === "B" || role === "A")) return "GB";
    if (neighbors.includes("M")) return "GM";
    if (neighbors.includes("D")) return "GD";
  }
  if (base === "D") {
    if (neighbors.includes("A")) return "DA";
    if (neighbors.includes("B")) return "DB";
    if (neighbors.includes("M")) return "DM";
  }
  if (base === "B" && neighbors.includes("A")) return "BA";
  return base;
}

/** The neighbor across the nearest forward-facing edge of this flat-top hex. */
export function hexForwardNeighbor(q, r, dx, dy) {
  const flatDistance = 48 - Math.abs(dy);
  const diagonalDistance = 64 - (Math.abs(dy) * 2) / 3 - Math.abs(dx);
  if (flatDistance <= diagonalDistance) return { q, r: r + 1 };
  return { q: q + (dx < 0 ? -1 : 1), r: r + (q & 1 ? 1 : 0) };
}

function hexRearNeighbor(q, r, dx, dy) {
  const flatDistance = 48 - Math.abs(dy);
  const diagonalDistance = 64 - (Math.abs(dy) * 2) / 3 - Math.abs(dx);
  if (flatDistance <= diagonalDistance) return { q, r: r - 1 };
  return { q: q + (dx < 0 ? -1 : 1), r: r + (q & 1 ? 0 : -1) };
}

export function hexGroundPixel(source, worldX, worldY, plan) {
  const { q, r, dx, dy } = hexCellAt(worldX, worldY);
  const baseRole = terrainRoleAt(plan, q, r);
  if (baseRole === "W") return [0, 0, 0, 0];
  const baseVisualRole = hexVisualRole(q, r, plan);
  const role = plan === undefined ? hexGroundRole(q, r, dx, dy, worldX, worldY, baseRole) : baseRole;
  const visualRole = role === baseRole ? baseVisualRole : role;
  const palette = PALETTES[role];
  const seed = hash32(
    plan === undefined ? mod(q, HEX_MACRO_CELLS) : q,
    plan === undefined ? mod(r, HEX_MACRO_CELLS) : r,
    0x4a17 ^ (plan?.seed ?? 0),
  );
  const variants = TILE_SOURCES[visualRole];
  const selected =
    variants[
      hash32(
        plan === undefined ? mod(q, HEX_MACRO_CELLS) : q,
        plan === undefined ? mod(r, HEX_MACRO_CELLS) : r,
        0x5f12 ^ (plan?.seed ?? 0),
      ) % variants.length
    ];
  const texture = TEXTURES[role];
  // Projected tanks and muzzle flashes need a calmer field than a strategy
  // map shown at rest. Sample larger authored clusters, then let the landform
  // palette carry the dominant value rather than every source micro-pixel.
  // Meadow is one continuous walkable field. Sampling its material with a
  // different random texture origin for every hex produced an unmistakable
  // honeycomb border even when same-surface edge ink was disabled. Sample in
  // world space instead; authored material/relief changes still show cells.
  const continuousMaterial = role === "G" || role === "D" || role === "B" || role === "A";
  const sx = continuousMaterial
    ? Math.floor((mod(worldX, HEX_MACRO_EDGE) / HEX_MACRO_EDGE) * texture.width)
    : 40 + (seed % 700) + Math.floor((dx + 64) * 1.7);
  const sy = continuousMaterial
    ? Math.floor((mod(worldY, HEX_MACRO_EDGE) / HEX_MACRO_EDGE) * texture.height)
    : 40 + ((seed >>> 11) % 700) + Math.floor((dy + 48) * 1.7);
  const i = (sy * texture.width + sx) * 4;
  const l = continuousMaterial ? periodicTextureLuma(texture, sx, sy) : lumaAt(texture, sx, sy);
  const grainX = mod(Math.floor(dx / 2) + (seed & 31) + 64, source.width);
  const grainY = mod(Math.floor(dy / 2) + ((seed >>> 8) & 31) + 64, source.height);
  const grainI = (grainY * source.width + grainX) * 4;
  const grain = (source.pixels[grainI] + source.pixels[grainI + 1] + source.pixels[grainI + 2]) / 3;
  const fleck = hash32(Math.floor(mod(worldX, HEX_MACRO_EDGE) / 2), Math.floor(mod(worldY, HEX_MACRO_EDGE) / 2), seed);
  let shade = l < 70 ? 1 : l < 115 ? 2 : l < 165 ? 3 : 4;
  if (role === "G") shade = l < 75 ? 1 : l < 130 ? 2 : l < 190 ? 3 : 4;
  if ((fleck & 127) === 0) shade = role === "G" || role === "D" ? 4 : 1;
  const distance = Math.min(48 - Math.abs(dy), 64 - (Math.abs(dy) * 2) / 3 - Math.abs(dx));
  const topLit = dy < 0 || (dy === 0 && dx < 0);
  // Preserve a quiet bevel between equal-height meadow cells: at gameplay
  // scale the full-strength outlines disappeared, but removing every edge
  // made the authored hex field read as one square terrain texture.
  let meadowEdgeLight = 0;
  if (distance < 6) {
    const neighbor = dy >= 0 ? hexForwardNeighbor(q, r, dx, dy) : hexRearNeighbor(q, r, dx, dy);
    const sameSurface =
      terrainRoleAt(plan, neighbor.q, neighbor.r) === baseRole &&
      terrainTierAt(plan, neighbor.q, neighbor.r) === terrainTierAt(plan, q, r);
    if (!sameSurface) {
      if (distance < 1.25) shade = 0;
      else if (distance < 3.5) shade = topLit ? 4 : 1;
      else if (!topLit) shade = Math.min(shade, 2);
    } else if (baseRole === "G" && distance < 5) {
      meadowEdgeLight = topLit ? 8 : -10;
    }
  }
  // A step is a relationship between two cells, not a ring around a single
  // one. Paint only the visible forward edge of the higher hex. Both cells
  // still meet at the exact shared outline, with no transparent floor pixels.
  if (dy > 0 && distance < 22) {
    const neighbor = hexForwardNeighbor(q, r, dx, dy);
    const drop = terrainTierAt(plan, q, r) - terrainTierAt(plan, neighbor.q, neighbor.r);
    if (drop > 0) {
      const faceDepth = drop === 2 ? 12 : 7;
      if (distance >= 1.25 && distance < faceDepth) {
        const rock = role === "D" ? [105, 72, 49] : role === "G" ? [76, 73, 55] : [52, 52, 51];
        const striation = hash32(Math.floor((dx + 64) / 5), Math.floor((dy + 48) / 4), seed) & 7;
        const light = distance > faceDepth - 2 ? 21 : striation === 0 ? 11 : striation === 1 ? -13 : 0;
        const [left, top, right, bottom] = selected.bounds;
        const sideTop = top + Math.floor((bottom - top + 1) * 0.52);
        const sourceX = Math.max(
          left,
          Math.min(right, Math.floor((left + right) / 2 + (dx * (right - left + 1)) / 128)),
        );
        const sourceY = Math.max(
          sideTop,
          Math.min(bottom, Math.floor(sideTop + ((faceDepth - distance) * (bottom - sideTop)) / faceDepth)),
        );
        const side = (sourceY * selected.image.width + sourceX) * 4;
        return rock
          .map((channel, index) =>
            Math.max(
              0,
              Math.min(
                255,
                Math.round(
                  channel * (selected.image.pixels[side + 3] >= 128 ? 0.55 : 1) +
                    selected.image.pixels[side + index] * (selected.image.pixels[side + 3] >= 128 ? 0.45 : 0) +
                    light,
                ),
              ),
            ),
          )
          .concat(255);
      }
      if (distance >= faceDepth && distance < faceDepth + 2.5) shade = 4;
    }
  } else if (dy < 0 && distance < 14) {
    const neighbor = hexRearNeighbor(q, r, dx, dy);
    const rise = terrainTierAt(plan, neighbor.q, neighbor.r) - terrainTierAt(plan, q, r);
    if (rise > 0) shade = Math.min(shade, distance < 7 ? 0 : distance < 11 ? 1 : 2);
  }

  // Material-specific clustered details. All marks are inside their cell;
  // neighboring materials can meet on any of the six edges without seams.
  const cellX = Math.floor(dx + 64);
  const cellY = Math.floor(dy + 48);
  if (distance > 7) {
    if (role === "G") {
      const tuft = hash32(Math.floor(cellX / 11), Math.floor(cellY / 9), seed);
      const localX = mod(cellX, 11),
        localY = mod(cellY, 9);
      if ((tuft & 7) < 3 && ((localX === 5 && localY >= 3 && localY <= 6) || (localX === 6 && localY === 5)))
        shade = localX === 5 ? 4 : 1;
      if ((tuft & 63) === 12 && localX === 4 && localY === 4) return [225, 195, 117, 255];
    } else if (role === "D") {
      if ((fleck & 63) === 7) shade = 4;
    } else if (role === "B" || role === "A") {
      const vein = Math.abs(mod(Math.floor(dx * 0.65 - dy * 0.33 + (seed & 15)), 27) - 13);
      if (vein === 0 && (fleck & 3) !== 0) shade = 0;
      if (role === "A" && vein <= 1 && (fleck & 7) < 4) return [207, 91 + (fleck & 31), 30, 255];
    } else if (role === "M") {
      // Repeated full-cell plate seams made the service yard resemble a field
      // of separate hex tokens. Keep only sparse scuffs and tiny fasteners;
      // the authored lane, building, and raised landforms carry the industrial
      // identity instead of a grid on every floor pixel.
      const scuff = hash32(Math.floor(cellX / 17), Math.floor(cellY / 13), seed);
      if ((scuff & 31) === 3 && mod(cellX, 17) < 5 && mod(cellY, 13) === 6) shade = 1;
      if ((scuff & 63) === 12 && mod(cellX, 17) === 7 && mod(cellY, 13) === 5) shade = 4;
    }
  }
  if (role === "M" && plan === undefined && distance > 4) {
    const routeMark = hexServiceRoutePixel(q, r, dx, dy);
    if (routeMark === 2) return [210, 161, 59, 255];
    if (routeMark === 1) return [43, 43, 42, 255];
  }
  if (distance >= 6) {
    // The sampled region is different for every hex; a light palette grade
    // preserves its authored rocks, tufts, scratches and grates while keeping
    // combat silhouettes above the terrain in contrast.
    const materialWeight =
      role === "G" ? 0.18 : role === "D" ? 0.22 : role === "M" ? 0.4 : role === "B" || role === "A" ? 0.35 : 0.42;
    const grainOffset = grain > 145 ? 2 : grain < 75 ? -2 : 0;
    const base = palette[shade]
      .map((channel, index) =>
        Math.max(
          0,
          Math.min(
            255,
            Math.round(channel * (1 - materialWeight) + texture.pixels[i + index] * materialWeight + grainOffset),
          ),
        ),
      )
      .concat(255);
    // Sprite Fusion's selected *top faces* contribute the dominant local
    // pixel clusters. The source side faces are intentionally not projected
    // into walkable ground; actual elevation needs collision-aligned cliffs.
    const [sourceX, sourceY] = hexTopFaceSample(selected.bounds, dx, dy);
    const sourceOffset = (sourceY * selected.image.width + sourceX) * 4;
    if (selected.image.pixels[sourceOffset + 3] >= 128) {
      for (let channel = 0; channel < 3; channel++) {
        // The dirt source is a complete isolated hex top. Projecting most of
        // it into every road cell repeated its pale six-sided border across
        // what should read as one continuous worn path. Keep a trace of its
        // soil detail; the broad continuous material owns the road value.
        const sourceWeight = role === "G" ? 0.08 : role === "D" ? 0.12 : role === "B" || role === "A" ? 0.1 : 0.4;
        base[channel] = Math.round(
          base[channel] * (1 - sourceWeight) + selected.image.pixels[sourceOffset + channel] * sourceWeight,
        );
      }
    }
    return base;
  }
  return [...palette[shade].map((channel) => Math.max(0, Math.min(255, channel + meadowEdgeLight))), 255];
}

export function buildHexGround(plan) {
  const request = JSON.parse(readFileSync(resolve(root, requestPath), "utf8"));
  const selected = request.outputs.find((output) => output.index === 0);
  const bytes = readFileSync(resolve(root, selected.path));
  if (hash(bytes) !== selected.sha256) throw new Error("hex terrain source checksum mismatch");
  const source = decodeRgbaPng(bytes);
  const width = plan === undefined ? HEX_MACRO_EDGE : MAP_WIDTH * TILE_PIXELS;
  const height = plan === undefined ? HEX_MACRO_EDGE : MAP_HEIGHT * TILE_PIXELS;
  const pixels = Buffer.alloc(width * height * 4);
  // PNG rows descend while Defold world coordinates ascend.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set(hexGroundPixel(source, x, height - 1 - y, plan), (y * width + x) * 4);
    }
  }
  return {
    width,
    height,
    pixels,
    source: {
      requestId: request.requestId,
      assetId: selected.assetId,
      index: selected.index,
      path: selected.path,
      sha256: selected.sha256,
    },
  };
}

function main() {
  const check = process.argv.includes("--check");
  const plan = buildWorldPlan(DEFAULT_ARENA_SEED);
  const ground = buildHexGround(plan);
  const outputs = new Map();
  outputs.set("defold/assets/derived/world/hex-meadow.png", encodeRgbaPng(ground.width, ground.height, ground.pixels));
  outputs.set(
    "defold/assets/derived/world/hex-meadow.json",
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 3,
          owner: "tools/generate-hex-terrain.mjs",
          worldPlan: {
            seed: plan.seed,
            rulesVersion: plan.rulesVersion,
            landHexes: plan.landCount,
            propCount: plan.propCount,
          },
          source: ground.source,
          textureSources: TEXTURE_SOURCES,
          spriteFusionTiles: {
            selection: HEX_TILE_SELECTION_PATH,
            sha256: tileSelectionSha256,
            families: Object.fromEntries(
              Object.entries(TILE_SOURCES).map(([role, variants]) => [
                role,
                variants.map(({ request, index, assetId, path, sha256 }) => ({
                  request,
                  index,
                  assetId,
                  path,
                  sha256,
                })),
              ]),
            ),
            use: "selected top-face samples for seamless floor projection, graded to the meadow palette; raised side faces emitted on collision-aligned wall stamps",
          },
          materialRoles: Object.keys(PALETTES),
          tileSize: [ground.width, ground.height],
          topology: {
            kind: "flat-top-hex",
            axes: ["u=x-y", "v=x+y"],
            columnStride: 96,
            rowStride: 96,
            oddColumnOffset: 48,
          },
          projection: "scene applies 45 degree rotation and 0.5 vertical scale",
          purpose: "one seed-pinned irregular island floor; water hexes are transparent over the coast resource",
        },
        null,
        2,
      ) + "\n",
    ),
  );
  outputs.set(
    "defold/main/hex-meadow.tilesource",
    Buffer.from(
      `image: "/assets/derived/world/hex-meadow.png"\ntile_width: ${ground.width}\ntile_height: ${ground.height}\nextrude_borders: 2\n`,
    ),
  );
  // The single full-world tile follows the exact map-plan land mask. Repeating
  // the old 12x12 macro here would reintroduce rectangular land outside it.
  outputs.set(
    "defold/main/hex-meadow.tilemap",
    Buffer.from(
      'tile_set: "/main/hex-meadow.tilesource"\nlayers {\n  id: "landscape"\n  z: -0.1\n  cell { x: 0 y: 0 tile: 0 }\n}\nmaterial: "/builtins/materials/tile_map.material"\n',
    ),
  );
  for (const [relative, bytes] of outputs) {
    const absolute = resolve(root, relative);
    if (check) {
      if (!readFileSync(absolute).equals(bytes)) throw new Error(`stale: ${relative}`);
    } else {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
    }
  }
  console.log(`hex-terrain:${check ? "fresh" : "generated"}:source=${ground.source.assetId}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
