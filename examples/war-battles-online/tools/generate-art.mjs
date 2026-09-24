#!/usr/bin/env node
// Deterministic arena art generator for the War Battles online showcase.
//
// The showcase needs an arena tile sheet, four tank teams, projectiles, FX,
// pickups and HUD chips that sit next to the pinned tutorial art without
// looking foreign. Rather than authoring those by hand in a paint package,
// this tool *samples the tutorial art's own palette* out of the pinned PNGs
// and draws every new pixel from that sampled palette, so the derived art is
// guaranteed to share the tutorial's colour identity.
//
//   node examples/war-battles-online/tools/generate-art.mjs
//   node examples/war-battles-online/tools/generate-art.mjs --check
//
// `--check` re-derives every byte in memory and exits non-zero when anything
// on disk differs, matching `integration/build-war-battles-art.py`. The output
// is byte-reproducible: no timestamps, a fixed zlib level, and a seeded
// mulberry32 in place of Math.random (same generator as
// `tools/generate-world-tilemap.mjs`).
//
// There are no third-party dependencies: the PNG decoder (used for palette
// sampling and for self-verification) and the PNG encoder are both in this
// file and lean only on `node:zlib`.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

import {
  ARENA_DECOR_ROLE_COUNT,
  ARENA_DECOR_ROLE_FLOOR_VENT,
  ARENA_DECOR_ROLE_LAVA_FISSURE,
  ARENA_DECOR_ROLE_PICKUP_PEDESTAL,
  ARENA_DECOR_ROLE_PIPE_JUNCTION,
  ARENA_DECOR_ROLE_PIPE_RUN,
  ARENA_DECOR_ROLE_THERMAL_VENT,
  ARENA_GROUND_ROLE_WALL_BASE,
  ARENA_GROUND_VARIANT_COUNT,
  ARENA_MARK_ROLE_COUNT,
  ARENA_MARK_ROLE_CRATE,
  ARENA_MARK_ROLE_PICKUP,
  ARENA_MARK_ROLE_SANDBAG,
  ARENA_MARK_ROLE_SPAWN,
  ARENA_WALL_MASK_BITS,
  ARENA_WALL_MASK_TO_FRAME,
} from "../core/arena-visual.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, "..");
const projectRoot = resolve(exampleRoot, "defold");
const assetsRoot = resolve(projectRoot, "assets");
const outputRoot = resolve(assetsRoot, "derived", "arena");
const worldArtRoot = resolve(assetsRoot, "derived", "world");
const mainRoot = resolve(projectRoot, "main");
const sourceRoot = resolve(projectRoot, "src");

/** Fixed seed keeps every noise field and scatter byte-reproducible. */
const SEED = 0x41524e41; // "ARNA"
/** zlib level is pinned so the encoded PNG bytes never drift. */
const ZLIB_LEVEL = 9;

// ---------------------------------------------------------------------------
// PNG codec (8-bit RGBA, non-interlaced)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; ++i) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG buffer to `{ width, height, data }` with 8-bit RGBA `data`. */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let header = null;
  let plte = null;
  let trns = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "PLTE") plte = Buffer.from(body);
    else if (type === "tRNS") trns = Buffer.from(body);
    else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");
  if (header.interlace !== 0) throw new Error("interlaced PNG is not supported");
  const { width, height, bitDepth, colorType } = header;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const bytesPerRow = Math.ceil((bitsPerPixel * width) / 8);
  const lines = Buffer.alloc(bytesPerRow * height);

  let cursor = 0;
  for (let y = 0; y < height; ++y) {
    const filter = raw[cursor++];
    const row = y * bytesPerRow;
    const prior = row - bytesPerRow;
    for (let x = 0; x < bytesPerRow; ++x) {
      const value = raw[cursor++];
      const a = x >= bytesPerPixel ? lines[row + x - bytesPerPixel] : 0;
      const b = y > 0 ? lines[prior + x] : 0;
      const c = y > 0 && x >= bytesPerPixel ? lines[prior + x - bytesPerPixel] : 0;
      let out;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + a;
          break;
        case 2:
          out = value + b;
          break;
        case 3:
          out = value + ((a + b) >> 1);
          break;
        case 4:
          out = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      lines[row + x] = out & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  const maxValue = (1 << bitDepth) - 1;
  const scale = bitDepth === 16 ? 1 : 255 / maxValue;
  const sample = (row, index) => {
    if (bitDepth === 8) return lines[row + index];
    if (bitDepth === 16) return lines[row + index * 2];
    const bit = index * bitDepth;
    return (lines[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & maxValue;
  };

  for (let y = 0; y < height; ++y) {
    const row = y * bytesPerRow;
    for (let x = 0; x < width; ++x) {
      const target = (y * width + x) * 4;
      if (colorType === 3) {
        const index = sample(row, x);
        data[target] = plte[index * 3];
        data[target + 1] = plte[index * 3 + 1];
        data[target + 2] = plte[index * 3 + 2];
        data[target + 3] = trns && index < trns.length ? trns[index] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const gray = Math.round(sample(row, x * channels) * scale);
        data[target] = gray;
        data[target + 1] = gray;
        data[target + 2] = gray;
        data[target + 3] = colorType === 4 ? Math.round(sample(row, x * channels + 1) * scale) : 255;
      } else {
        data[target] = Math.round(sample(row, x * channels) * scale);
        data[target + 1] = Math.round(sample(row, x * channels + 1) * scale);
        data[target + 2] = Math.round(sample(row, x * channels + 2) * scale);
        data[target + 3] = colorType === 6 ? Math.round(sample(row, x * channels + 3) * scale) : 255;
      }
    }
  }
  return { width, height, data };
}

function pngChunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** Encode 8-bit RGBA bytes into a deterministic non-interlaced PNG. */
function encodePng(width, height, data) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; ++y) {
    raw[y * (stride + 1)] = 0; // filter type 0 everywhere: stable and cheap
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: ZLIB_LEVEL })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Value noise that wraps exactly over `size` pixels, so any tile drawn from it
 * is seamless against itself and against its neighbours.
 */
function tileNoise(x, y, size, cells, seed) {
  const gx = (x * cells) / size;
  const gy = (y * cells) / size;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const u = smooth(gx - x0);
  const v = smooth(gy - y0);
  const at = (a, b) => hash2(((a % cells) + cells) % cells, ((b % cells) + cells) % cells, seed);
  return lerp(lerp(at(x0, y0), at(x0 + 1, y0), u), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), u), v);
}

function octaveNoise(x, y, size, seed) {
  // Weighted toward the higher octaves: the tutorial ground is a scatter of
  // 3-6 px patches, not a few large lobes.
  return (
    0.3 * tileNoise(x, y, size, 2, seed) +
    0.42 * tileNoise(x, y, size, 4, seed + 101) +
    0.28 * tileNoise(x, y, size, 8, seed + 211)
  );
}

/** Drop specks left behind by erosion, which would otherwise gain an outline. */
function dropSmallIslands(canvas, minimumSize) {
  const seen = new Uint8Array(canvas.width * canvas.height);
  for (let y = 0; y < canvas.height; ++y) {
    for (let x = 0; x < canvas.width; ++x) {
      const start = y * canvas.width + x;
      if (seen[start] || canvas.alpha(x, y) === 0) continue;
      const stack = [[x, y]];
      const island = [];
      seen[start] = 1;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        island.push([cx, cy]);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!canvas.inside(nx, ny) || canvas.alpha(nx, ny) === 0) continue;
          const key = ny * canvas.width + nx;
          if (seen[key]) continue;
          seen[key] = 1;
          stack.push([nx, ny]);
        }
      }
      if (island.length < minimumSize) for (const [ix, iy] of island) canvas.set(ix, iy, [0, 0, 0, 0]);
    }
  }
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Hard write (no blending): pixel art keeps hard edges. */
  set(x, y, color) {
    if (!color || !this.inside(x, y)) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = color[0];
    this.data[i + 1] = color[1];
    this.data[i + 2] = color[2];
    this.data[i + 3] = color.length > 3 ? color[3] : 255;
  }

  get(x, y) {
    if (!this.inside(x, y)) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  alpha(x, y) {
    if (!this.inside(x, y)) return 0;
    return this.data[(y * this.width + x) * 4 + 3];
  }

  rect(x, y, w, h, color) {
    for (let j = 0; j < h; ++j) for (let i = 0; i < w; ++i) this.set(x + i, y + j, color);
  }

  hline(x0, x1, y, color) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); ++x) this.set(x, y, color);
  }

  vline(x, y0, y1, color) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); ++y) this.set(x, y, color);
  }

  /** Filled disc with a hard edge; `cx`/`cy` may be half-pixel centres. */
  disc(cx, cy, r, color) {
    const rr = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); ++y) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); ++x) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= rr) this.set(x, y, color);
      }
    }
  }

  blit(source, dx, dy) {
    for (let y = 0; y < source.height; ++y) {
      for (let x = 0; x < source.width; ++x) {
        if (source.alpha(x, y) === 0) continue;
        this.set(dx + x, dy + y, source.get(x, y));
      }
    }
  }

  /** Copy the top half over the bottom half, making the sprite exactly centred. */
  mirrorTopToBottom() {
    for (let y = 0; y < this.height >> 1; ++y) {
      for (let x = 0; x < this.width; ++x) {
        this.set(x, this.height - 1 - y, this.get(x, y));
      }
    }
  }

  opaqueBbox() {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < this.height; ++y) {
      for (let x = 0; x < this.width; ++x) {
        if (this.alpha(x, y) === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < x0 ? null : [x0, y0, x1, y1];
  }

  clone() {
    const copy = new Canvas(this.width, this.height);
    copy.data.set(this.data);
    return copy;
  }
}

/**
 * Add the tutorial art's signature 1px dark border: every transparent pixel
 * that touches an opaque pixel (8-connected, exactly as the tutorial sprites
 * read) becomes the outline colour.
 */
function outline(canvas, color) {
  const before = canvas.clone();
  for (let y = 0; y < canvas.height; ++y) {
    for (let x = 0; x < canvas.width; ++x) {
      if (before.alpha(x, y) !== 0) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; ++dy) {
        for (let dx = -1; dx <= 1; ++dx) {
          if (dx === 0 && dy === 0) continue;
          if (before.alpha(x + dx, y + dy) !== 0) {
            touches = true;
            break;
          }
        }
      }
      if (touches) canvas.set(x, y, color);
    }
  }
}

/** Stamp an ASCII template; `.` is transparent, every other glyph is a ramp key. */
function stamp(canvas, template, x, y, ramp) {
  const width = template[0].length;
  for (const row of template) {
    if (row.length !== width) throw new Error(`ragged template row: ${JSON.stringify(row)}`);
  }
  template.forEach((row, j) => {
    for (let i = 0; i < row.length; ++i) {
      const glyph = row[i];
      if (glyph === ".") continue;
      const color = ramp[glyph];
      if (!color) throw new Error(`template glyph '${glyph}' is not in the ramp`);
      canvas.set(x + i, y + j, color);
    }
  });
}

// ---------------------------------------------------------------------------
// Palette sampling
// ---------------------------------------------------------------------------

/** Pinned tutorial art the palette is sampled from, in a fixed order. */
const PALETTE_SOURCES = [
  "map.png",
  "units/tank/down/1.png",
  "units/tank/down/2.png",
  "units/infantry/down/1.png",
  "fx/explosion/1.png",
  "fx/explosion/2.png",
  "fx/explosion/3.png",
  "fx/explosion/4.png",
  "fx/explosion/5.png",
  "buildings/command-center/1.png",
  "buildings/turret/1.png",
];

/** Colours below this alpha are treated as feathering, not as palette entries. */
const OPAQUE_THRESHOLD = 250;
/** Near-duplicates inside this RGB radius collapse into the more frequent one. */
const QUANTISE_RADIUS = 3;
/** Colours rarer than this across all sources are discarded as stray pixels. */
const MIN_PIXEL_COUNT = 4;
/** Hard cap on the quantised palette. */
const MAX_PALETTE_ENTRIES = 72;

const hex = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function samplePalette() {
  const seen = new Map(); // "#rrggbb" -> { r,g,b, count, sources: Map<file,count> }
  for (const relPath of PALETTE_SOURCES) {
    const image = decodePng(readFileSync(resolve(assetsRoot, relPath)));
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] < OPAQUE_THRESHOLD) continue;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const key = hex(r, g, b);
      let entry = seen.get(key);
      if (!entry) {
        entry = { hex: key, r, g, b, count: 0, sources: new Map() };
        seen.set(key, entry);
      }
      entry.count += 1;
      entry.sources.set(relPath, (entry.sources.get(relPath) ?? 0) + 1);
    }
  }

  // Quantise: fold near-duplicates into their more frequent neighbour.
  const ordered = [...seen.values()].sort((a, b) => b.count - a.count || (a.hex < b.hex ? -1 : 1));
  const kept = [];
  for (const entry of ordered) {
    const host = kept.find((candidate) => {
      const dr = candidate.r - entry.r;
      const dg = candidate.g - entry.g;
      const db = candidate.b - entry.b;
      return Math.sqrt(dr * dr + dg * dg + db * db) <= QUANTISE_RADIUS;
    });
    if (host) {
      host.count += entry.count;
      host.merged.push(entry.hex);
      for (const [file, count] of entry.sources) {
        host.sources.set(file, (host.sources.get(file) ?? 0) + count);
      }
      continue;
    }
    kept.push({ ...entry, sources: new Map(entry.sources), merged: [] });
  }

  const palette = kept
    .filter((entry) => entry.count >= MIN_PIXEL_COUNT)
    .sort((a, b) => b.count - a.count || (a.hex < b.hex ? -1 : 1))
    .slice(0, MAX_PALETTE_ENTRIES);

  const index = new Map(palette.map((entry) => [entry.hex, entry]));
  return { palette, index };
}

const { palette: SAMPLED_PALETTE, index: SAMPLED_INDEX } = samplePalette();

/** Look up a colour and prove it came out of the tutorial art's own histogram. */
function sampled(hexValue) {
  const entry = SAMPLED_INDEX.get(hexValue);
  if (!entry) throw new Error(`${hexValue} is not in the sampled tutorial palette`);
  entry.used = true;
  return [entry.r, entry.g, entry.b, 255];
}

/** Same colour at a reduced alpha, for the handful of glow layers. */
const fade = (color, alpha) => [color[0], color[1], color[2], alpha];

// --- hue rotation, used only where a team hue is genuinely absent -----------

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => Math.round((v + m) * 255));
}

const DERIVATIONS = [];

/**
 * Rotate a *sampled* colour to a new hue while preserving its saturation and
 * lightness. This keeps a derived team ramp on exactly the tutorial tank's
 * value structure, so all four teams shade identically.
 */
function hueRotated(sourceHex, targetHue, role) {
  const entry = SAMPLED_INDEX.get(sourceHex);
  if (!entry) throw new Error(`${sourceHex} is not in the sampled tutorial palette`);
  entry.used = true;
  const hsl = rgbToHsl(entry.r, entry.g, entry.b);
  const [r, g, b] = hslToRgb(targetHue, hsl.s, hsl.l);
  DERIVATIONS.push({
    role,
    hex: hex(r, g, b),
    derivedFrom: sourceHex,
    derivedFromSources: [...entry.sources.keys()],
    rule: "sRGB -> HSL, replace H, keep S and L, HSL -> sRGB",
    sourceHue: Number(hsl.h.toFixed(2)),
    targetHue,
    hueDelta: Number((((targetHue - hsl.h + 540) % 360) - 180).toFixed(2)),
    saturation: Number(hsl.s.toFixed(4)),
    lightness: Number(hsl.l.toFixed(4)),
  });
  return [r, g, b, 255];
}

// ---------------------------------------------------------------------------
// Named roles - every one of these resolves inside the sampled histogram
// ---------------------------------------------------------------------------

const C = {
  outline: sampled("#2c2839"), // the tutorial sprite border colour
  shadowDeep: sampled("#453a4e"),
  metalDark: sampled("#515454"),
  metalMid: sampled("#738485"),
  metalLight: sampled("#9ca6a6"),
  metalHi: sampled("#bccccc"),

  // Track rubber. The tutorial tank's own tread brown (#743f27) is also the
  // sand team's shadow shade, so the treads would vanish into a sand hull;
  // these are map.png's dark rock shades instead, still from the same palette.
  treadDark: sampled("#3e2c39"),
  treadBase: sampled("#503b41"),
  treadSheen: sampled("#764d53"),

  woodDark: sampled("#644543"),
  woodBase: sampled("#85604e"),
  woodLight: sampled("#a37860"),
  woodHi: sampled("#bf9b68"),

  groundDeep: sampled("#284020"),
  groundDark: sampled("#607e41"),
  groundBase: sampled("#708646"),
  groundLight: sampled("#7a914b"),

  dustMid: sampled("#997a61"),
  dustLight: sampled("#bf9b68"),

  goldDark: sampled("#8a7549"),
  goldBase: sampled("#ccaa39"),
  goldLight: sampled("#ebd07a"),

  hot: sampled("#fce8c0"),
  flame: sampled("#fcbb66"),
  ember: sampled("#c95e2b"),
  emberDeep: sampled("#8a1a27"),
  smokeLight: sampled("#8a797e"),
  smokeDark: sampled("#423438"),

  red: sampled("#fc3500"),
  skyBlue: sampled("#76c5e0"),
  seaBlue: sampled("#4f8c9c"),
  deepBlue: sampled("#436682"),
};

/**
 * Team ramps. `blue` and `sand` are 100% sampled; `sand` *is* the tutorial
 * tank. `red` keeps the sampled ember shadow and rotates the tank's three
 * upper shades to hue 0; `green` is fully rotated because every sampled green
 * is the olive of the ground itself, which would camouflage a tank.
 */
const TEAM_HUES = { red: 0, green: 148 };
const TEAMS = {
  blue: {
    shadow: sampled("#436682"),
    base: sampled("#4f8c9c"),
    light: sampled("#76c5e0"),
    highlight: sampled("#bccccc"),
  },
  red: {
    shadow: sampled("#8a1a27"),
    base: hueRotated("#a17132", TEAM_HUES.red, "red.base"),
    light: hueRotated("#d1b561", TEAM_HUES.red, "red.light"),
    highlight: hueRotated("#fadea7", TEAM_HUES.red, "red.highlight"),
  },
  green: {
    shadow: hueRotated("#743f27", TEAM_HUES.green, "green.shadow"),
    base: hueRotated("#a17132", TEAM_HUES.green, "green.base"),
    light: hueRotated("#d1b561", TEAM_HUES.green, "green.light"),
    highlight: hueRotated("#fadea7", TEAM_HUES.green, "green.highlight"),
  },
  sand: {
    shadow: sampled("#743f27"),
    base: sampled("#a17132"),
    light: sampled("#d1b561"),
    highlight: sampled("#fadea7"),
  },
};
const TEAM_ORDER = ["blue", "red", "green", "sand"];

// ---------------------------------------------------------------------------
// Tile sheet
// ---------------------------------------------------------------------------

const TILE = 16;
const SHEET_COLUMNS = 8;

const ARENA_THEMES = Object.freeze([
  Object.freeze({ id: "frontier", name: "Frontier", replacements: [] }),
  Object.freeze({
    id: "refinery",
    name: "Slate Refinery",
    replacements: [
      [C.groundDeep, C.shadowDeep],
      [C.groundDark, C.metalDark],
      [C.groundBase, C.metalMid],
      [C.groundLight, C.metalLight],
      [C.dustMid, C.smokeDark],
      [C.dustLight, C.smokeLight],
      [C.woodDark, C.emberDeep],
      [C.woodBase, C.ember],
      [C.woodLight, C.flame],
      [C.woodHi, C.goldLight],
    ],
  }),
  Object.freeze({
    id: "canyon",
    name: "Ember Canyon",
    replacements: [
      [C.groundDeep, C.woodDark],
      [C.groundDark, C.dustMid],
      [C.groundBase, C.woodLight],
      [C.groundLight, C.dustLight],
      [C.shadowDeep, C.woodDark],
      [C.metalDark, C.woodBase],
      [C.metalMid, C.woodLight],
      [C.metalLight, C.dustLight],
      [C.metalHi, C.hot],
    ],
  }),
]);

const colorKey = (color) => `${color[0]},${color[1]},${color[2]},${color[3] ?? 255}`;

function applyTheme(canvas, theme) {
  const themed = canvas.clone();
  if (theme.replacements.length === 0) return themed;
  const replacements = new Map(theme.replacements.map(([from, to]) => [colorKey(from), to]));
  for (let y = 0; y < themed.height; y += 1) {
    for (let x = 0; x < themed.width; x += 1) {
      const pixel = themed.get(x, y);
      const replacement = replacements.get(colorKey(pixel));
      if (replacement) themed.set(x, y, replacement);
    }
  }
  return themed;
}

/**
 * Import the checked Sprite Fusion selections through our local world-art
 * projection. Defold still owns the final tile sheet and map: the external
 * service contributes pixels, never map structure, collision, or tile IDs.
 */
function loadWorldTiles() {
  const metadataPath = resolve(worldArtRoot, "refinery-props.json");
  const atlasPath = resolve(worldArtRoot, "refinery-props.png");
  let metadata;
  let atlasBytes;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    atlasBytes = readFileSync(atlasPath);
  } catch (error) {
    throw new Error(
      `derived world art is missing or unreadable: ${error.message}\n` + "Run: node tools/generate-world-art.mjs",
    );
  }
  if (metadata?.owner !== "tools/generate-world-art.mjs" || metadata?.schemaVersion !== 1) {
    throw new Error("derived world-art metadata has an unsupported owner or schema");
  }
  if (metadata.atlas?.sha256 !== sha256(atlasBytes)) {
    throw new Error("derived world-art atlas hash disagrees with its metadata");
  }
  const atlas = decodePng(atlasBytes);
  if (atlas.width !== metadata.atlas.width || atlas.height !== metadata.atlas.height) {
    throw new Error("derived world-art atlas dimensions disagree with its metadata");
  }
  return metadata.roles.map((entry) => {
    const [sourceX, sourceY, width, height] = entry.cell ?? [];
    if (width !== TILE || height !== TILE || sourceX < 0 || sourceY < 0) {
      throw new Error(`world-art role ${entry.role} is not a valid ${TILE}px cell`);
    }
    const canvas = new Canvas(TILE, TILE);
    for (let y = 0; y < TILE; y += 1) {
      for (let x = 0; x < TILE; x += 1) {
        const offset = ((sourceY + y) * atlas.width + sourceX + x) * 4;
        canvas.set(x, y, atlas.data.subarray(offset, offset + 4));
      }
    }
    return {
      role: `world.${entry.role}`,
      layer: "decor",
      canvas,
      sourceSha256: entry.outputSha256,
    };
  });
}

/** Ground: soft two-tone olive blobs, exactly the tutorial's ground language. */
function groundTile(variant) {
  const canvas = new Canvas(TILE, TILE);
  const seed = SEED + variant * 7919;
  for (let y = 0; y < TILE; ++y) {
    for (let x = 0; x < TILE; ++x) {
      const n = octaveNoise(x, y, TILE, seed);
      let color = C.groundBase;
      if (n < 0.47) color = C.groundDark;
      else if (n > 0.63) color = C.groundLight;
      canvas.set(x, y, color);
    }
  }
  if (variant === 2) {
    // A dust patch: the tutorial ground drifts into sand at the map's edges.
    for (let y = 0; y < TILE; ++y) {
      for (let x = 0; x < TILE; ++x) {
        const n = octaveNoise(x + 3, y + 5, TILE, seed + 33);
        if (n > 0.74) canvas.set(x, y, n > 0.82 ? C.dustLight : C.dustMid);
      }
    }
  }
  if (variant === 3) {
    // Scrub tufts: single dark pixels, the same trick tile 28 uses.
    for (let y = 0; y < TILE; ++y) {
      for (let x = 0; x < TILE; ++x) {
        if (hash2(x, y, seed + 71) > 0.955) canvas.set(x, y, C.groundDeep);
      }
    }
  }
  return canvas;
}

/** Shared, seamlessly wrapping concrete field under every wall tile. */
function concreteField() {
  const field = new Canvas(TILE, TILE);
  for (let y = 0; y < TILE; ++y) {
    for (let x = 0; x < TILE; ++x) {
      const n = octaveNoise(x, y, TILE, SEED + 4242);
      let color = C.metalMid;
      if (n > 0.66) color = C.metalLight;
      else if (n < 0.3) color = C.shadowDeep;
      else if (n < 0.42) color = C.metalDark;
      field.set(x, y, color);
    }
  }
  return field;
}

const CONCRETE = concreteField();

/** Bevel bands by depth from the lit (N/W) and shadowed (S/E) block edges. */
const BEVEL = {
  N: [C.outline, C.metalHi, C.metalLight],
  W: [C.outline, C.metalHi, C.metalLight],
  S: [C.outline, C.shadowDeep, C.metalDark],
  E: [C.outline, C.shadowDeep, C.metalDark],
};
/** Tie-break order gives the corners a clean 45 degree miter. */
const BEVEL_PRIORITY = ["N", "W", "S", "E"];

function wallTile(edges) {
  const canvas = CONCRETE.clone();
  if (edges.length === 0) return canvas;
  for (let y = 0; y < TILE; ++y) {
    for (let x = 0; x < TILE; ++x) {
      const distance = { N: y, S: TILE - 1 - y, W: x, E: TILE - 1 - x };
      let best = null;
      for (const edge of BEVEL_PRIORITY) {
        if (!edges.includes(edge)) continue;
        if (best === null || distance[edge] < distance[best]) best = edge;
      }
      const depth = distance[best];
      if (depth < BEVEL[best].length) canvas.set(x, y, BEVEL[best][depth]);
    }
  }
  return canvas;
}

const CRATE = [
  "EAAAAAAAAAAAAE",
  "AADCCCCCCCCDAA",
  "ADCCBBBBBBCCDA",
  "ACCBDCCCCDBCCA",
  "ACBCDBBBBDCBCA",
  "ACBCBDBBDBCBCA",
  "ACBBBBDDBBBBCA",
  "ACBBBBDDBBBBCA",
  "ACBCBDBBDBCBCA",
  "ACBCDBBBBDCBCA",
  "ACCBDCCCCDBCCA",
  "ADCCBBBBBBCCDA",
  "AADCCCCCCCCDAA",
  "EAAAAAAAAAAAAE",
];

function crateTile() {
  const canvas = new Canvas(TILE, TILE);
  stamp(canvas, CRATE, 1, 1, {
    A: C.woodDark,
    B: C.woodBase,
    C: C.woodLight,
    D: C.woodHi,
    E: C.metalMid,
  });
  outline(canvas, C.outline);
  return canvas;
}

/**
 * Sandbags. The bag grid wraps in both axes so a run of sandbag tiles reads as
 * one continuous barrier; each bag carries its own dark seam instead of the
 * shared silhouette outline, which would otherwise cut the barrier at a seam.
 */
function sandbagTile() {
  const canvas = new Canvas(TILE, TILE);
  const bagWidth = 8;
  const bagHeight = 4;
  for (let row = 0; row < TILE / bagHeight; ++row) {
    const offset = row % 2 === 0 ? 0 : bagWidth / 2;
    for (let x = 0; x < TILE; ++x) {
      const local = (((x - offset) % bagWidth) + bagWidth) % bagWidth;
      for (let j = 0; j < bagHeight; ++j) {
        const y = row * bagHeight + j;
        let color;
        if (j === bagHeight - 1 || local === bagWidth - 1) color = C.woodDark;
        else if (j === 0) {
          if (local === 0) color = C.woodDark; // rounded bag corner
          else if (local === 1 || local >= bagWidth - 2) color = C.dustMid;
          else color = C.dustLight;
        } else if (j === 1) color = local === 0 ? C.woodBase : C.dustLight;
        else color = local === 0 ? C.woodBase : C.dustMid;
        canvas.set(x, y, color);
      }
    }
  }
  return canvas;
}

/**
 * Spawn pad: two painted chevrons pointing +X. Floor paint gets a darker gold
 * leading edge rather than the sprite silhouette outline, so it reads as paint
 * on the ground instead of an object standing on it.
 */
function spawnPadTile() {
  const canvas = new Canvas(TILE, TILE);
  for (const originX of [2, 7]) {
    for (let step = 0; step <= 5; ++step) {
      canvas.set(originX + step - 1, 2 + step, C.goldDark);
      canvas.set(originX + step, 2 + step, C.goldLight);
      canvas.set(originX + step + 1, 2 + step, C.goldBase);
      canvas.set(originX + step - 1, 13 - step, C.goldDark);
      canvas.set(originX + step, 13 - step, C.goldBase);
      canvas.set(originX + step + 1, 13 - step, C.goldBase);
    }
  }
  for (const [cx, cy, sx, sy] of [
    [0, 0, 1, 1],
    [15, 0, -1, 1],
    [0, 15, 1, -1],
    [15, 15, -1, -1],
  ]) {
    for (let i = 0; i < 3; ++i) {
      canvas.set(cx + i * sx, cy, C.goldDark);
      canvas.set(cx, cy + i * sy, C.goldDark);
    }
  }
  return canvas;
}

/** Pickup pad: a cool blue painted ring, deliberately unlike the gold spawn. */
function pickupPadTile() {
  const canvas = new Canvas(TILE, TILE);
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < TILE; ++y) {
    for (let x = 0; x < TILE; ++x) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= 6.4 && d >= 5.0) canvas.set(x, y, C.skyBlue);
      else if (d <= 5.0 && d >= 4.2) canvas.set(x, y, C.seaBlue);
    }
  }
  for (const [x, y] of [
    [7, 0],
    [8, 0],
    [7, 15],
    [8, 15],
    [0, 7],
    [0, 8],
    [15, 7],
    [15, 8],
  ]) {
    canvas.set(x, y, C.seaBlue);
  }
  outline(canvas, C.deepBlue);
  return canvas;
}

/**
 * Sheet order is Defold tile order: left to right, top row first, 1-based.
 * `layer` says whether a tile replaces the ground or overlays it.
 */
function buildTileSheet() {
  const baseTiles = [
    { role: "ground.0", layer: "ground", canvas: groundTile(0) },
    { role: "ground.1", layer: "ground", canvas: groundTile(1) },
    { role: "ground.2", layer: "ground", canvas: groundTile(2) },
    { role: "ground.3", layer: "ground", canvas: groundTile(3) },
    { role: "wall.centre", layer: "ground", canvas: wallTile([]) },
    { role: "wall.n", layer: "ground", canvas: wallTile(["N"]) },
    { role: "wall.s", layer: "ground", canvas: wallTile(["S"]) },
    { role: "wall.e", layer: "ground", canvas: wallTile(["E"]) },
    { role: "wall.w", layer: "ground", canvas: wallTile(["W"]) },
    { role: "wall.ne", layer: "ground", canvas: wallTile(["N", "E"]) },
    { role: "wall.nw", layer: "ground", canvas: wallTile(["N", "W"]) },
    { role: "wall.se", layer: "ground", canvas: wallTile(["S", "E"]) },
    { role: "wall.sw", layer: "ground", canvas: wallTile(["S", "W"]) },
    { role: "crate", layer: "overlay", canvas: crateTile() },
    { role: "sandbag", layer: "overlay", canvas: sandbagTile() },
    { role: "spawnPad", layer: "overlay", canvas: spawnPadTile() },
    { role: "pickupPad", layer: "overlay", canvas: pickupPadTile() },
    ...loadWorldTiles(),
  ];
  const tiles = ARENA_THEMES.flatMap((theme) =>
    baseTiles.map((tile) => ({
      ...tile,
      role: `theme.${theme.id}.${tile.role}`,
      semanticRole: tile.role,
      theme: theme.id,
      canvas: applyTheme(tile.canvas, theme),
    })),
  );
  const rows = Math.ceil(tiles.length / SHEET_COLUMNS);
  const sheet = new Canvas(SHEET_COLUMNS * TILE, rows * TILE);
  tiles.forEach((tile, index) => {
    const column = index % SHEET_COLUMNS;
    const row = Math.floor(index / SHEET_COLUMNS);
    sheet.blit(tile.canvas, column * TILE, row * TILE);
    tile.id = index + 1;
    tile.cell = [column, row];
  });
  return { sheet, tiles, rows, cells: rows * SHEET_COLUMNS };
}

// ---------------------------------------------------------------------------
// Tanks
// ---------------------------------------------------------------------------

const TANK = 32;
/**
 * Everything below is authored for the top half only and mirrored, which both
 * halves the amount of hand-placed detail and guarantees the opaque bounding
 * box is exactly centred on the rotation pivot.
 *
 * Layout, +X forward:  rows 6-9 tread, rows 10-21 hull body, rows 22-25 tread.
 * The turret sprite covers x 8-23 / rows 12-19, so the hull's team colour lives
 * in the rear deck, the nose and the fender strips that frame the turret.
 */
const TREAD_X0 = 2;
const TREAD_X1 = 26;
/** Hull body spans, top half only: [row, x0, x1]. */
const HULL_ROWS = [
  [10, 3, 26],
  [11, 3, 27],
  [12, 3, 28],
  [13, 3, 29],
  [14, 3, 29],
  [15, 3, 29],
];
/** Turret spans, top half only: [row, x0, x1]. */
const TURRET_ROWS = [
  [12, 10, 21],
  [13, 9, 22],
  [14, 8, 23],
  [15, 8, 23],
];

/** Un-outlined hull, shared by the live tank and by the wreck. */
function tankHullBody(team, frame) {
  const ramp = TEAMS[team];
  const canvas = new Canvas(TANK, TANK);

  // --- track: 4 rows, mirrored to rows 22-25 -------------------------------
  canvas.hline(TREAD_X0, TREAD_X1, 6, C.treadBase);
  canvas.hline(TREAD_X0, TREAD_X1, 7, C.treadSheen);
  canvas.hline(TREAD_X0, TREAD_X1, 8, C.treadBase);
  canvas.hline(TREAD_X0, TREAD_X1, 9, C.treadDark);
  const phase = frame === 0 ? 0 : 2;
  for (let x = TREAD_X0; x <= TREAD_X1; ++x) {
    if ((x - TREAD_X0 + phase) % 4 !== 0) continue;
    canvas.vline(x, 6, 8, C.treadDark); // track link, rolling between frames
  }
  canvas.rect(TREAD_X0, 7, 2, 2, C.treadSheen); // rear drive sprocket
  canvas.rect(TREAD_X1 - 1, 7, 2, 2, C.treadSheen); // front idler

  // --- hull body -----------------------------------------------------------
  for (const [y, x0, x1] of HULL_ROWS) {
    canvas.hline(x0, x1, y, ramp.base);
    canvas.hline(Math.max(22, x0), x1, y, ramp.light); // sloped glacis
    canvas.hline(x1 - 2, x1, y, ramp.highlight); // lit nose edge
    canvas.hline(x0, x0 + 1, y, ramp.shadow); // rear plate
  }
  canvas.hline(3, 26, 10, ramp.shadow); // fender shadow line
  canvas.vline(21, 10, 15, ramp.shadow); // deck / glacis seam
  canvas.rect(5, 11, 5, 1, C.metalDark); // engine louvres
  canvas.rect(5, 13, 5, 1, C.metalDark);
  canvas.rect(1, 12, 2, 2, C.metalDark); // exhaust stubs
  canvas.rect(1, 12, 2, 1, C.metalMid);

  // --- turret well: a shallow ring the turret sprite seats into ------------
  for (let y = 11; y <= 15; ++y) {
    for (let x = 11; x <= 21; ++x) {
      const d = Math.hypot(x - 16, y - 15.5);
      if (d <= 4.2 && d >= 3.2) canvas.set(x, y, ramp.shadow);
      else if (d < 3.2) canvas.set(x, y, C.metalDark);
    }
  }

  return canvas;
}

function tankHull(team, frame) {
  const canvas = tankHullBody(team, frame);
  canvas.mirrorTopToBottom();
  outline(canvas, C.outline);
  return canvas;
}

/**
 * Chassis silhouettes reuse the generated team hull and add a small role marker
 * in the same sampled metal palette. Keeping the team as an input is
 * important: a chassis swap must not erase the team colour of the tank.
 */
function chassisHull(team, kind, frame) {
  const canvas = tankHull(team, frame);
  if (kind === "scout") {
    canvas.rect(25, 11, 4, 2, C.skyBlue);
    canvas.rect(25, 19, 4, 2, C.seaBlue);
  } else if (kind === "assault") {
    canvas.rect(4, 10, 4, 2, C.metalHi);
    canvas.rect(4, 20, 4, 2, C.metalHi);
  } else if (kind === "bulwark") {
    canvas.rect(27, 11, 3, 10, C.metalLight);
    canvas.rect(26, 13, 2, 6, C.metalHi);
  } else {
    canvas.rect(6, 11, 2, 10, C.deepBlue);
    canvas.rect(23, 11, 2, 10, C.deepBlue);
  }
  return canvas;
}

function tankTurret(team) {
  const ramp = TEAMS[team];
  const canvas = new Canvas(TANK, TANK);

  for (const [y, x0, x1] of TURRET_ROWS) {
    canvas.hline(x0, x1, y, ramp.base);
    canvas.hline(x0, x0 + 1, y, ramp.shadow); // rear of the turret
    canvas.hline(17, x1, y, ramp.light); // lit front cheeks
  }
  canvas.hline(10, 21, 12, ramp.shadow); // turret rim
  canvas.hline(17, 22, 15, ramp.highlight);
  // Commander cupola, sitting at the rear of the ring.
  for (let y = 12; y <= 15; ++y) {
    for (let x = 9; x <= 17; ++x) {
      const d = Math.hypot(x - 13, y - 15.5);
      if (d <= 3.0 && d >= 2.1) canvas.set(x, y, ramp.shadow);
      else if (d < 2.1) canvas.set(x, y, ramp.light);
    }
  }
  canvas.rect(20, 13, 4, 3, C.metalDark); // mantlet
  canvas.rect(20, 15, 4, 1, C.metalMid);

  // --- barrel: a flat 4px tube opening into a 6px muzzle brake -------------
  canvas.hline(23, 30, 14, C.metalMid);
  canvas.hline(23, 30, 15, C.metalLight);
  canvas.hline(28, 30, 13, C.metalDark);
  canvas.hline(28, 30, 14, C.metalLight);
  canvas.hline(28, 30, 15, C.metalHi);

  canvas.mirrorTopToBottom();
  outline(canvas, C.outline);
  return canvas;
}

/**
 * A wreck keeps the hull's exact silhouette - it is the same geometry run
 * through a charring map - so a destroyed tank does not jump on screen. Paint
 * burns off to bare steel, the team ramp collapses into charcoal, and the
 * turret well is blown open with embers still in it.
 */
const CHAR_RAMP = (team) => {
  const ramp = TEAMS[team];
  const key = (c) => `${c[0]},${c[1]},${c[2]}`;
  return new Map([
    [key(ramp.highlight), C.metalLight], // bare metal where the paint burned
    [key(ramp.light), C.metalDark],
    [key(ramp.base), C.shadowDeep],
    [key(ramp.shadow), C.smokeDark],
    [key(C.treadSheen), C.metalDark],
    [key(C.treadBase), C.shadowDeep],
    [key(C.treadDark), C.smokeDark],
    [key(C.metalLight), C.metalLight],
    [key(C.metalMid), C.metalDark],
    [key(C.metalDark), C.smokeDark],
  ]);
};

function tankWreck(team) {
  const hull = tankHullBody(team, 0);
  const char = CHAR_RAMP(team);
  const canvas = new Canvas(TANK, TANK);
  for (let y = 0; y < TANK; ++y) {
    for (let x = 0; x < TANK; ++x) {
      if (hull.alpha(x, y) === 0) continue;
      const source = hull.get(x, y);
      canvas.set(x, y, char.get(`${source[0]},${source[1]},${source[2]}`) ?? source);
    }
  }

  // Damage is authored on the top half only, so mirroring keeps the wreck
  // centred on the same pivot as the tank it replaces.
  const random = mulberry32(SEED + 991);
  for (let i = 0; i < 16; ++i) {
    const x = 5 + Math.floor(random() * 22);
    const y = 11 + Math.floor(random() * 5);
    canvas.set(x, y, random() > 0.8 ? C.emberDeep : C.outline);
  }
  canvas.rect(13, 12, 6, 4, C.outline); // blown turret well
  canvas.set(14, 13, C.emberDeep);
  canvas.set(16, 14, C.ember);
  canvas.set(17, 12, C.emberDeep);
  canvas.set(15, 15, C.ember);
  canvas.rect(24, 6, 3, 2, [0, 0, 0, 0]); // track shot off the front idler
  canvas.set(23, 8, C.smokeDark);
  canvas.rect(5, 10, 3, 1, [0, 0, 0, 0]); // torn rear fender
  canvas.set(9, 13, C.woodDark); // rust streaks
  canvas.set(22, 15, C.woodDark);

  canvas.mirrorTopToBottom();
  outline(canvas, C.outline);
  return canvas;
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

function projCannon() {
  const canvas = new Canvas(10, 10);
  const rows = [
    [1, 2, 5],
    [2, 2, 6],
    [3, 1, 7],
    [4, 1, 8],
  ];
  for (const [y, x0, x1] of rows) {
    for (let x = x0; x <= x1; ++x) {
      let color = C.goldBase;
      if (x <= 2) color = C.goldDark;
      if (x >= 6) color = C.metalMid;
      if (x >= 8) color = C.metalHi;
      if (y === 4 && x >= 3 && x <= 5) color = C.goldLight;
      canvas.set(x, y, color);
    }
  }
  canvas.mirrorTopToBottom();
  outline(canvas, C.outline);
  return canvas;
}

function projMachinegun() {
  const canvas = new Canvas(8, 4);
  canvas.hline(1, 5, 0, C.flame);
  canvas.hline(0, 7, 1, C.hot);
  canvas.set(0, 1, C.ember);
  canvas.set(1, 1, C.flame);
  canvas.set(0, 0, C.ember);
  canvas.mirrorTopToBottom();
  return canvas; // a tracer is self-luminous: no dark border, like explosion 1
}

function projRailgun() {
  const canvas = new Canvas(20, 4);
  canvas.hline(2, 17, 0, C.deepBlue);
  canvas.hline(0, 19, 1, C.skyBlue);
  canvas.hline(3, 16, 1, C.metalHi);
  canvas.hline(16, 19, 1, C.hot);
  canvas.set(0, 1, C.deepBlue);
  canvas.set(1, 1, C.seaBlue);
  canvas.hline(14, 17, 0, C.skyBlue);
  canvas.mirrorTopToBottom();
  return canvas;
}

function projScatter() {
  const canvas = new Canvas(6, 6);
  canvas.hline(2, 3, 1, C.metalLight);
  canvas.hline(1, 4, 2, C.metalLight);
  canvas.set(2, 2, C.metalHi);
  canvas.mirrorTopToBottom();
  outline(canvas, C.outline);
  return canvas;
}

function projMortar() {
  const canvas = new Canvas(12, 12);
  const rows = [
    [1, 1, 3],
    [2, 1, 4],
    [3, 1, 8],
    [4, 1, 9],
    [5, 1, 10],
  ];
  for (const [y, x0, x1] of rows) {
    for (let x = x0; x <= x1; ++x) {
      let color = C.metalMid;
      if (y <= 2) color = C.metalDark;
      else if (y === 5) color = C.metalLight;
      if (y >= 3 && x >= 5 && x <= 6) color = C.emberDeep;
      if (y >= 3 && x <= 2) color = C.metalDark;
      canvas.set(x, y, color);
    }
  }
  canvas.set(10, 5, C.metalHi);
  canvas.mirrorTopToBottom();
  outline(canvas, C.outline);
  return canvas;
}

function projRicochet(frame) {
  const canvas = new Canvas(10, 10);
  const cx = 4.5;
  const cy = 4.5;
  if (frame === 0) {
    canvas.disc(cx, cy, 3.2, C.deepBlue);
    canvas.disc(cx, cy, 2.4, C.skyBlue);
    canvas.disc(cx, cy, 1.3, C.metalHi);
  } else {
    canvas.disc(cx, cy, 4.3, C.deepBlue);
    canvas.disc(cx, cy, 3.4, C.seaBlue);
    canvas.disc(cx, cy, 2.2, C.skyBlue);
    canvas.disc(cx, cy, 1.0, C.hot);
    for (const [dx, dy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      canvas.set(Math.round(cx + dx * 4), Math.round(cy + dy * 4), C.skyBlue);
    }
  }
  canvas.mirrorTopToBottom();
  return canvas;
}

// ---------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------

/** Per-explosion angular wobble, shared across the frames so it grows coherently. */
function wobbleField(seed) {
  const random = mulberry32(seed);
  const p1 = random() * Math.PI * 2;
  const p2 = random() * Math.PI * 2;
  const p3 = random() * Math.PI * 2;
  return (angle) =>
    1 + 0.2 * Math.sin(angle * 3 + p1) + 0.12 * Math.sin(angle * 5 + p2) + 0.07 * Math.sin(angle * 7 + p3);
}

function fillBlob(canvas, cx, cy, radius, wobble, bands) {
  // Two pixels of clearance so the fireball and its dark edge both stay inside.
  const cap = Math.min(cx, cy, canvas.width - 1 - cx, canvas.height - 1 - cy) - 2;
  for (let y = 0; y < canvas.height; ++y) {
    for (let x = 0; x < canvas.width; ++x) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      const edge = Math.min(radius * wobble(Math.atan2(dy, dx)), cap);
      if (d > edge) continue;
      const t = edge === 0 ? 0 : d / edge;
      for (const [stop, color] of bands) {
        if (t <= stop) {
          canvas.set(x, y, color);
          break;
        }
      }
    }
  }
}

/**
 * A ball of smoke: overlapping puffs flattened into one silhouette, then shaded
 * by depth so the mass keeps a light rim over a dark interior - the same read
 * as the tutorial's own late explosion frames. Shading per puff instead would
 * leave a dark dot in every lobe and the cloud would look like a bunch of
 * bubbles.
 */
function smokeMass(size, cx, cy, radius, count, puffRadius, seed, rim, core, erosion) {
  const canvas = new Canvas(size, size);
  const random = mulberry32(seed);
  // Keep two pixels of clearance so the cloud and its dark edge both fit.
  const extent = Math.min(cx, cy, size - 1 - cx, size - 1 - cy) - 2;
  for (let i = 0; i < count; ++i) {
    const angle = (i / count) * Math.PI * 2 + random() * 0.5;
    let distance = radius * (0.42 + random() * 0.3);
    let puff = puffRadius * (0.72 + random() * 0.55);
    if (distance + puff > extent) {
      const scale = extent / (distance + puff);
      distance *= scale;
      puff *= scale;
    }
    canvas.disc(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, puff, rim);
  }
  if (erosion > 0) erodeSmoke(canvas, seed + 55, erosion);
  dropSmallIslands(canvas, 5);
  const silhouette = canvas.clone();
  const depth = 2;
  for (let y = 0; y < size; ++y) {
    for (let x = 0; x < size; ++x) {
      if (silhouette.alpha(x, y) === 0) continue;
      let interior = true;
      for (let dy = -depth; dy <= depth && interior; ++dy) {
        for (let dx = -depth; dx <= depth; ++dx) {
          if (silhouette.alpha(x + dx, y + dy) === 0) {
            interior = false;
            break;
          }
        }
      }
      if (interior) canvas.set(x, y, core);
    }
  }
  return canvas;
}

/** Punch holes so dissipating smoke breaks up instead of fading as a disc. */
function erodeSmoke(canvas, seed, strength) {
  for (let y = 0; y < canvas.height; ++y) {
    for (let x = 0; x < canvas.width; ++x) {
      if (canvas.alpha(x, y) === 0) continue;
      if (octaveNoise(x * 1.4, y * 1.4, canvas.width, seed) < strength) canvas.set(x, y, [0, 0, 0, 0]);
    }
  }
}

function sparkRing(canvas, cx, cy, seed, count, distance, colors) {
  const random = mulberry32(seed);
  // Debris never travels past the canvas: a spark clipped by the sprite edge
  // reads as a rendering bug rather than as ejecta.
  const limit = Math.min(cx, cy, canvas.width - 1 - cx, canvas.height - 1 - cy) - 1.5;
  for (let i = 0; i < count; ++i) {
    const angle = (i / count) * Math.PI * 2 + random() * 0.8;
    const reach = Math.min(distance * (0.72 + random() * 0.55), limit);
    const x = Math.round(cx + Math.cos(angle) * reach);
    const y = Math.round(cy + Math.sin(angle) * reach);
    canvas.set(x, y, colors[i % colors.length]);
  }
}

/**
 * A six/eight frame bloom-then-smoke arc: white-hot core, flame shell, ember
 * shell, then the fire is replaced by expanding, breaking-up smoke puffs.
 */
function explosionFrames(size, frameCount, seed) {
  const centre = size / 2 - 0.5;
  const maxR = size * 0.41; // leaves room for the ejected debris ring
  const wobble = wobbleField(seed);
  const frames = [];
  for (let index = 0; index < frameCount; ++index) {
    const t = index / (frameCount - 1);
    const canvas = new Canvas(size, size);
    const radius = maxR * (0.26 + 0.74 * Math.pow(t, 0.48));

    if (t < 0.22) {
      fillBlob(canvas, centre, centre, radius, wobble, [
        [0.46, C.hot],
        [0.8, C.flame],
        [1.0, C.ember],
      ]);
    } else if (t < 0.52) {
      fillBlob(canvas, centre, centre, radius, wobble, [
        [0.3, C.hot],
        [0.6, C.flame],
        [0.84, C.ember],
        [1.0, C.emberDeep],
      ]);
    } else if (t < 0.74) {
      fillBlob(canvas, centre, centre, radius, wobble, [
        [0.22, C.flame],
        [0.48, C.ember],
        [0.72, C.emberDeep],
        [1.0, C.smokeLight],
      ]);
      canvas.blit(
        smokeMass(size, centre, centre, radius, 6, radius * 0.34, seed + 17, C.smokeLight, C.smokeDark, 0),
        0,
        0,
      );
      fillBlob(canvas, centre, centre, radius * 0.34, wobble, [
        [0.5, C.flame],
        [1.0, C.ember],
      ]);
    } else if (t < 0.92) {
      canvas.blit(
        smokeMass(size, centre, centre, radius, 7, radius * 0.38, seed + 17, C.smokeLight, C.smokeDark, 0.3),
        0,
        0,
      );
      fillBlob(canvas, centre, centre, radius * 0.26, wobble, [
        [0.55, C.ember],
        [1.0, C.emberDeep],
      ]);
    } else {
      // The last wisp: lighter and thinner, not a darker version of frame 5.
      canvas.blit(
        smokeMass(size, centre, centre, radius, 7, radius * 0.38, seed + 17, C.smokeLight, C.smokeDark, 0.36),
        0,
        0,
      );
    }

    if (size >= 64 && index >= 1 && index <= 2) {
      // A shockwave rim the small explosion does not get.
      const ringRadius = radius * 1.1;
      for (let y = 0; y < size; ++y) {
        for (let x = 0; x < size; ++x) {
          const dx = x - centre;
          const dy = y - centre;
          const d = Math.hypot(dx, dy);
          const edge = ringRadius * wobble(Math.atan2(dy, dx));
          if (Math.abs(d - edge) <= 0.6) canvas.set(x, y, index === 1 ? C.hot : C.flame);
        }
      }
    }

    dropSmallIslands(canvas, 5);
    // The tutorial's own explosion frames carry a dark smoke edge rather than
    // the sprite outline; the first flash and the final wisp carry none at all.
    if (index > 0 && index < frameCount - 1) outline(canvas, C.smokeDark);
    // Ejected debris is drawn last: a spark is a single bright pixel and must
    // not pick up the smoke border, which would turn it into a 3x3 dark box.
    if (index >= 1 && index <= frameCount - 2) {
      const heat = t < 0.5 ? [C.hot, C.flame] : t < 0.8 ? [C.flame, C.ember] : [C.ember, C.emberDeep];
      sparkRing(canvas, centre, centre, seed + index, 9, radius * 1.1, heat);
    }
    frames.push(canvas);
  }
  return frames;
}

/** Muzzle flash: a cone opening toward +X from the barrel tip at the left. */
function muzzleFrames() {
  const size = 16;
  const profiles = [
    [0, 1, 2, 3, 3, 2, 2, 1],
    [1, 3, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1],
    [0, 1, 2, 2, 1, 1, 1],
  ];
  return profiles.map((profile, index) => {
    const canvas = new Canvas(size, size);
    profile.forEach((half, x) => {
      for (let k = 0; k <= half; ++k) {
        const y = 7 - k;
        let color = C.flame;
        if (k <= half - 2) color = C.hot;
        if (index === 2) color = k <= 0 ? C.flame : C.ember;
        canvas.set(x + 1, y, color);
      }
    });
    if (index === 1) {
      canvas.hline(1, 6, 7, C.hot);
      // Two angled flare spikes, drawn as continuous strokes so they read as
      // flame rather than as stray pixels.
      for (let i = 0; i < 4; ++i) {
        canvas.set(3 + i, 4 - i, C.flame);
        canvas.set(3 + i, 11 + i, C.flame);
      }
      for (let i = 0; i < 3; ++i) {
        canvas.set(9 + i, 5 - i, C.flame);
        canvas.set(9 + i, 10 + i, C.flame);
      }
    }
    if (index === 2) {
      for (let i = 0; i < 4; ++i) canvas.set(7 + i, 6 - (i >> 1), C.smokeLight);
    }
    canvas.mirrorTopToBottom();
    return canvas;
  });
}

/** Impact puff: a bright blob that throws spokes out and decays into smoke. */
function sparkFrames() {
  const size = 16;
  const centre = 7.5;
  const random = mulberry32(SEED + 6161);
  const angles = Array.from({ length: 6 }, (_, i) => (i / 6) * Math.PI * 2 + random() * 0.5);
  const recipes = [
    { core: 2.6, coreColor: C.hot, rim: C.flame, inner: 0, outer: 0, spoke: [C.hot, C.flame] },
    { core: 1.9, coreColor: C.hot, rim: C.flame, inner: 1.6, outer: 4.6, spoke: [C.hot, C.flame] },
    { core: 1.1, coreColor: C.flame, rim: C.ember, inner: 2.6, outer: 6.2, spoke: [C.flame, C.ember] },
    { core: 0, coreColor: null, rim: null, inner: 4.2, outer: 7.0, spoke: [C.ember, C.smokeLight] },
  ];
  return recipes.map((recipe, index) => {
    const canvas = new Canvas(size, size);
    if (recipe.core > 0) {
      canvas.disc(centre, centre, recipe.core + 0.9, recipe.rim);
      canvas.disc(centre, centre, recipe.core, recipe.coreColor);
    }
    for (const angle of angles) {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      for (let d = recipe.inner; d <= recipe.outer; d += 0.34) {
        const tip = d > recipe.outer - 1.4;
        const color = tip ? recipe.spoke[1] : recipe.spoke[0];
        canvas.set(Math.round(centre + dx * d), Math.round(centre + dy * d), color);
        if (d < recipe.inner + 1.6) {
          // Thicken the base of each spoke so it reads as a jet, not a dotted line.
          canvas.set(Math.round(centre + dx * d - dy), Math.round(centre + dy * d + dx), color);
        }
      }
    }
    if (index === 3) {
      for (const [x, y] of [
        [4, 4],
        [11, 5],
        [6, 11],
      ])
        canvas.set(x, y, C.smokeLight);
    }
    dropSmallIslands(canvas, 2);
    return canvas;
  });
}

// ---------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------

const PICKUP_ICONS = {
  "pickup-machinegun": {
    ramp: () => ({ A: C.metalDark, B: C.metalMid, C: C.metalLight, D: C.metalHi, E: C.goldBase }),
    art: [
      "............",
      "............",
      "...AAAAAAAA.",
      "...BCCCCCCB.",
      ".AAAAAB.....",
      ".ABCCCB.....",
      ".ABBBBB.....",
      ".AAABAAA....",
      "...EEE......",
      "...EDE......",
      "...EEE......",
      "............",
    ],
  },
  "pickup-cannon": {
    ramp: () => ({ A: C.goldDark, B: C.goldBase, C: C.goldLight, D: C.metalMid, E: C.metalLight }),
    art: [
      "............",
      ".....DD.....",
      "....DDDD....",
      "....DEED....",
      "....DDDD....",
      "...AAAAAA...",
      "...ABBBBA...",
      "...ABCCBA...",
      "...ABBBBA...",
      "...ABBBBA...",
      "...AAAAAA...",
      "............",
    ],
  },
  "pickup-railgun": {
    ramp: () => ({ A: C.deepBlue, B: C.seaBlue, C: C.skyBlue, D: C.metalHi, E: C.hot }),
    art: [
      "............",
      "............",
      "............",
      ".AAAAAAAAAA.",
      ".ABBBBBBBBA.",
      ".ACDCDCDCEA.",
      ".ABBBBBBBBA.",
      ".AAAAAAAAAA.",
      "....A..A....",
      "....A..A....",
      "............",
      "............",
    ],
  },
  "pickup-scatter": {
    ramp: () => ({ A: C.metalDark, B: C.metalMid, C: C.metalLight, D: C.metalHi }),
    art: [
      "............",
      "....AAA.....",
      "...ACCCA....",
      "...ACDCA....",
      "....AAA.....",
      ".AAA....AAA.",
      "ACCCA..ACCCA",
      "ACDCA..ACDCA",
      ".AAA....AAA.",
      "............",
      "............",
      "............",
    ],
  },
  "pickup-mortar": {
    ramp: () => ({ A: C.metalDark, B: C.metalMid, C: C.metalLight, D: C.emberDeep, E: C.metalHi }),
    art: [
      "............",
      ".....CC.....",
      "....BCCB....",
      "....BCEB....",
      "....BCCB....",
      "....DDDD....",
      "....BCCB....",
      "...ABCCBA...",
      "..AAB..BAA..",
      ".AA..AA..AA.",
      "............",
      "............",
    ],
  },
  "pickup-ricochet": {
    ramp: () => ({ A: C.deepBlue, B: C.seaBlue, C: C.skyBlue, D: C.metalHi, E: C.metalDark }),
    art: [
      "............",
      ".CC......CD.",
      ".CCC....CCD.",
      "..BCC..CCB..",
      "...BCCCCB...",
      "....BCCB....",
      ".....BB.....",
      "............",
      ".EEEEEEEEEE.",
      ".EEEEEEEEEE.",
      "............",
      "............",
    ],
  },
  "pickup-health": {
    ramp: () => ({ A: C.emberDeep, B: C.red, C: C.hot }),
    art: [
      "............",
      "..AAAAAAAA..",
      ".ABBBBBBBBA.",
      ".ABBBCCBBBA.",
      ".ABBBCCBBBA.",
      ".ABCCCCCCBA.",
      ".ABCCCCCCBA.",
      ".ABBBCCBBBA.",
      ".ABBBCCBBBA.",
      ".ABBBBBBBBA.",
      "..AAAAAAAA..",
      "............",
    ],
  },
  "pickup-armor": {
    ramp: () => ({ A: C.metalDark, B: C.metalMid, C: C.metalLight, D: C.metalHi, E: C.deepBlue }),
    art: [
      "............",
      "..AAAAAAAA..",
      ".ACCCCCCCCA.",
      ".ACDDEEDDCA.",
      ".ABCDEEDCBA.",
      ".ABCDEEDCBA.",
      "..ABCEECBA..",
      "..ABCEECBA..",
      "...ABCCBA...",
      "....ABBA....",
      ".....AA.....",
      "............",
    ],
  },
  "pickup-overdrive": {
    ramp: () => ({ A: C.goldDark, B: C.goldBase, C: C.goldLight, D: C.hot }),
    art: [
      "............",
      "......ABBD..",
      ".....ABBD...",
      "....ABBD....",
      "...ABBD.....",
      "..ABBBBBD...",
      "...ABBBBD...",
      "....ABBD....",
      "...ABBD.....",
      "..ABBD......",
      ".ABD........",
      "............",
    ],
  },
};

function pickupSprite(name, frame) {
  const spec = PICKUP_ICONS[name];
  const canvas = new Canvas(TILE, TILE);
  stamp(canvas, spec.art, 2, frame === 0 ? 2 : 1, spec.ramp());
  outline(canvas, C.outline);
  return canvas;
}

/**
 * The glow ring under a live pickup: a ring that pulses outward, brightest on
 * the ring itself and soft on both sides. Three alpha steps, no soft gradient.
 */
function pickupPadSprite(frame) {
  const canvas = new Canvas(TILE, TILE);
  const cx = 7.5;
  const cy = 7.5;
  const ring = frame === 0 ? 4.8 : 5.9;
  const alphas = frame === 0 ? [255, 170, 90] : [190, 120, 60];
  for (let y = 0; y < TILE; ++y) {
    for (let x = 0; x < TILE; ++x) {
      const offset = Math.abs(Math.hypot(x - cx, y - cy) - ring);
      if (offset <= 0.9) canvas.set(x, y, fade(C.skyBlue, alphas[0]));
      else if (offset <= 1.9) canvas.set(x, y, fade(C.seaBlue, alphas[1]));
      else if (offset <= 2.9) canvas.set(x, y, fade(C.deepBlue, alphas[2]));
    }
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// HUD chips
// ---------------------------------------------------------------------------

function hudBarBack() {
  const canvas = new Canvas(4, 4);
  canvas.rect(0, 0, 4, 4, C.outline);
  return canvas;
}

function hudBarFill() {
  const canvas = new Canvas(4, 4);
  canvas.rect(0, 0, 4, 4, C.metalHi); // uniform, so a GUI tint reproduces exactly
  return canvas;
}

function hudPanel() {
  const canvas = new Canvas(8, 8);
  canvas.rect(0, 0, 8, 8, C.outline);
  canvas.rect(1, 1, 6, 6, C.metalDark);
  canvas.rect(2, 2, 4, 4, C.shadowDeep);
  return canvas;
}

function hudTick() {
  const canvas = new Canvas(4, 4);
  canvas.rect(0, 0, 4, 4, C.hot);
  return canvas;
}

// ---------------------------------------------------------------------------
// Sprite inventory
// ---------------------------------------------------------------------------

/** `anchored` sprites rotate about their centre, so they must be y-centred. */
function buildSprites() {
  const sprites = [];
  const add = (name, canvas, options = {}) => {
    sprites.push({
      name,
      canvas,
      outlineColor: options.outlineColor ?? "#2c2839",
      anchored: !!options.anchored,
      role: options.role,
    });
  };

  for (const team of TEAM_ORDER) {
    add(`tank-${team}-hull-1`, tankHull(team, 0), { anchored: true, role: `tank.${team}.hull` });
    add(`tank-${team}-hull-2`, tankHull(team, 1), { anchored: true, role: `tank.${team}.hull` });
    add(`tank-${team}-turret`, tankTurret(team), { anchored: true, role: `tank.${team}.turret` });
    add(`tank-${team}-wreck`, tankWreck(team), { anchored: true, role: `tank.${team}.wreck` });
  }
  for (const team of TEAM_ORDER) {
    for (const kind of ["scout", "assault", "bulwark", "artillery"]) {
      add(`chassis-${team}-${kind}-1`, chassisHull(team, kind, 0), { anchored: true, role: `chassis.${team}.${kind}` });
      add(`chassis-${team}-${kind}-2`, chassisHull(team, kind, 1), { anchored: true, role: `chassis.${team}.${kind}` });
    }
  }

  add("proj-cannon", projCannon(), { anchored: true, role: "projectile" });
  add("proj-machinegun", projMachinegun(), { anchored: true, role: "projectile", outlineColor: null });
  add("proj-railgun", projRailgun(), { anchored: true, role: "projectile", outlineColor: null });
  add("proj-scatter", projScatter(), { anchored: true, role: "projectile" });
  add("proj-mortar", projMortar(), { anchored: true, role: "projectile" });
  add("proj-ricochet-1", projRicochet(0), { anchored: true, role: "projectile", outlineColor: null });
  add("proj-ricochet-2", projRicochet(1), { anchored: true, role: "projectile", outlineColor: null });

  explosionFrames(32, 6, SEED + 313).forEach((canvas, index) => {
    add(`explosion-small-${index + 1}`, canvas, { role: "fx", outlineColor: index === 0 ? null : "#423438" });
  });
  explosionFrames(64, 8, SEED + 727).forEach((canvas, index) => {
    add(`explosion-big-${index + 1}`, canvas, { role: "fx", outlineColor: index === 0 ? null : "#423438" });
  });
  muzzleFrames().forEach((canvas, index) => {
    add(`muzzle-${index + 1}`, canvas, { anchored: true, role: "fx", outlineColor: null });
  });
  sparkFrames().forEach((canvas, index) => {
    add(`spark-${index + 1}`, canvas, { role: "fx", outlineColor: null });
  });

  for (const name of Object.keys(PICKUP_ICONS)) {
    add(`${name}-1`, pickupSprite(name, 0), { role: "pickup" });
    add(`${name}-2`, pickupSprite(name, 1), { role: "pickup" });
  }
  add("pickup-pad-1", pickupPadSprite(0), { role: "pickup", outlineColor: null });
  add("pickup-pad-2", pickupPadSprite(1), { role: "pickup", outlineColor: null });

  add("hud-bar-back", hudBarBack(), { role: "ui", outlineColor: null });
  add("hud-bar-fill", hudBarFill(), { role: "ui", outlineColor: null });
  add("hud-panel", hudPanel(), { role: "ui", outlineColor: null });
  add("hud-tick", hudTick(), { role: "ui", outlineColor: null });

  return sprites;
}

// ---------------------------------------------------------------------------
// Atlas + tilesource emission
// ---------------------------------------------------------------------------

const ATLAS_IMAGE_ROOT = "/assets/derived/arena";

function buildAnimations() {
  const animations = [];
  const loop = (id, frames, fps) => animations.push({ id, frames, playback: "PLAYBACK_LOOP_FORWARD", fps });
  const once = (id, frames, fps) => animations.push({ id, frames, playback: "PLAYBACK_ONCE_FORWARD", fps });
  const still = (id, frame) => animations.push({ id, frames: [frame], playback: "PLAYBACK_NONE" });

  for (const team of TEAM_ORDER) {
    loop(`tank-${team}-hull`, [`tank-${team}-hull-1`, `tank-${team}-hull-2`], 12);
  }
  for (const team of TEAM_ORDER) still(`tank-${team}-turret`, `tank-${team}-turret`);
  for (const team of TEAM_ORDER) still(`tank-${team}-wreck`, `tank-${team}-wreck`);
  for (const team of TEAM_ORDER) {
    for (const kind of ["scout", "assault", "bulwark", "artillery"]) {
      loop(`chassis-${team}-${kind}`, [`chassis-${team}-${kind}-1`, `chassis-${team}-${kind}-2`], 10);
    }
  }

  for (const id of ["proj-cannon", "proj-machinegun", "proj-railgun", "proj-scatter", "proj-mortar"]) {
    still(id, id);
  }
  loop("proj-ricochet", ["proj-ricochet-1", "proj-ricochet-2"], 16);

  once(
    "explosion-small",
    Array.from({ length: 6 }, (_, i) => `explosion-small-${i + 1}`),
    18,
  );
  once(
    "explosion-big",
    Array.from({ length: 8 }, (_, i) => `explosion-big-${i + 1}`),
    16,
  );
  once(
    "muzzle",
    Array.from({ length: 3 }, (_, i) => `muzzle-${i + 1}`),
    30,
  );
  once(
    "spark",
    Array.from({ length: 4 }, (_, i) => `spark-${i + 1}`),
    24,
  );

  for (const name of Object.keys(PICKUP_ICONS)) loop(name, [`${name}-1`, `${name}-2`], 4);
  loop("pickup-pad", ["pickup-pad-1", "pickup-pad-2"], 4);

  for (const id of ["hud-bar-back", "hud-bar-fill", "hud-panel", "hud-tick"]) still(id, id);
  return animations;
}

function renderAtlas(animations) {
  const lines = [];
  for (const animation of animations) {
    lines.push("animations {");
    lines.push(`  id: "${animation.id}"`);
    for (const frame of animation.frames) {
      lines.push("  images {");
      lines.push(`    image: "${ATLAS_IMAGE_ROOT}/${frame}.png"`);
      lines.push("  }");
    }
    lines.push(`  playback: ${animation.playback}`);
    if (animation.fps !== undefined) lines.push(`  fps: ${animation.fps}`);
    lines.push("}");
  }
  lines.push("extrude_borders: 2");
  lines.push("");
  return lines.join("\n");
}

function renderTileSource() {
  return [
    `image: "${ATLAS_IMAGE_ROOT}/arena-tiles.png"`,
    `tile_width: ${TILE}`,
    `tile_height: ${TILE}`,
    'collision_groups: "default"',
    "animations {",
    '  id: "anim"',
    "  start_tile: 1",
    "  end_tile: 1",
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const assertions = [];
let failures = 0;

function check(label, condition, detail) {
  assertions.push({ label, ok: !!condition, detail: detail ?? null });
  if (!condition) failures += 1;
}

/**
 * Compose a 4x4 block out of the blob set and prove the seams are continuous:
 * every pixel opaque, and the outline colour appears only on the block's own
 * 1px perimeter - never at an interior seam.
 */
function verifyWallSeams(tiles) {
  const layout = [
    ["wall.nw", "wall.n", "wall.n", "wall.ne"],
    ["wall.w", "wall.centre", "wall.centre", "wall.e"],
    ["wall.w", "wall.centre", "wall.centre", "wall.e"],
    ["wall.sw", "wall.s", "wall.s", "wall.se"],
  ];
  for (const theme of ARENA_THEMES) {
    const byRole = new Map(
      tiles.filter((tile) => tile.theme === theme.id).map((tile) => [tile.semanticRole, tile.canvas]),
    );
    const block = new Canvas(4 * TILE, 4 * TILE);
    layout.forEach((row, j) => row.forEach((role, i) => block.blit(byRole.get(role), i * TILE, j * TILE)));

    let transparent = 0;
    let interiorOutline = 0;
    let perimeterNonOutline = 0;
    const isOutline = (c) => c[0] === C.outline[0] && c[1] === C.outline[1] && c[2] === C.outline[2];
    for (let y = 0; y < block.height; ++y) {
      for (let x = 0; x < block.width; ++x) {
        const pixel = block.get(x, y);
        if (pixel[3] === 0) transparent += 1;
        const perimeter = x === 0 || y === 0 || x === block.width - 1 || y === block.height - 1;
        if (!perimeter && isOutline(pixel)) interiorOutline += 1;
        if (perimeter && !isOutline(pixel)) perimeterNonOutline += 1;
      }
    }
    check(`${theme.id} wall block 4x4 is fully opaque`, transparent === 0, `${transparent} transparent px`);
    check(
      `${theme.id} wall seams carry no interior outline`,
      interiorOutline === 0,
      `${interiorOutline} interior outline px`,
    );
    check(
      `${theme.id} wall block perimeter is a clean 1px border`,
      perimeterNonOutline === 0,
      `${perimeterNonOutline} stray px`,
    );
  }
}

function verifySandbagWrap(canvas) {
  let mismatched = 0;
  for (let y = 0; y < TILE; ++y) {
    // A wrapping barrier must have no dark seam artefact at the tile join:
    // column 0 must continue column 15's bag run.
    if (canvas.alpha(0, y) === 0 || canvas.alpha(TILE - 1, y) === 0) mismatched += 1;
  }
  check("sandbag tile is edge-to-edge opaque (wraps as a barrier)", mismatched === 0, `${mismatched} gap rows`);
}

function verifySprite(sprite, bytes) {
  const decoded = decodePng(bytes);
  const round = new Canvas(decoded.width, decoded.height);
  round.data.set(decoded.data);
  const bbox = round.opaqueBbox();
  check(
    `${sprite.name}: decodes at ${sprite.canvas.width}x${sprite.canvas.height}`,
    decoded.width === sprite.canvas.width && decoded.height === sprite.canvas.height,
    `${decoded.width}x${decoded.height}`,
  );
  check(`${sprite.name}: not fully transparent`, bbox !== null);
  if (!bbox) return { bbox: null, centred: null };
  const inBounds = bbox[0] >= 0 && bbox[1] >= 0 && bbox[2] < decoded.width && bbox[3] < decoded.height;
  check(`${sprite.name}: opaque bbox within bounds`, inBounds, JSON.stringify(bbox));
  if (sprite.role === "fx" && sprite.name.startsWith("explosion")) {
    // An explosion cut off by its own canvas edge reads as a rendering fault.
    const clear = bbox[0] >= 1 && bbox[1] >= 1 && bbox[2] <= decoded.width - 2 && bbox[3] <= decoded.height - 2;
    check(`${sprite.name}: keeps 1px clearance inside the canvas`, clear, JSON.stringify(bbox));
  }
  let centred = null;
  if (sprite.anchored) {
    const bboxCentreY = (bbox[1] + bbox[3]) / 2;
    const spriteCentreY = (decoded.height - 1) / 2;
    centred = Number((bboxCentreY - spriteCentreY).toFixed(2));
    check(`${sprite.name}: vertically centred for rotation (dy=${centred})`, Math.abs(centred) <= 1);
  }
  return { bbox, centred };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function buildThemeMap(theme, tiles) {
  const themed = tiles.filter((tile) => tile.theme === theme.id);
  const tileId = (role) => {
    const tile = themed.find((candidate) => candidate.semanticRole === role);
    if (!tile) throw new Error(`theme ${theme.id} has no tile for ${role}`);
    return tile.id;
  };
  const wallTileIds = Object.fromEntries(
    themed.filter((tile) => tile.semanticRole.startsWith("wall.")).map((tile) => [tile.semanticRole.slice(5), tile.id]),
  );
  const wallMaskTileIds = ARENA_WALL_MASK_TO_FRAME.map((role) => wallTileIds[role]);
  const groundTileIds = Array.from({ length: ARENA_GROUND_VARIANT_COUNT }, (_, index) => tileId(`ground.${index}`));
  const groundRoleTileIds = Array.from({ length: ARENA_GROUND_ROLE_WALL_BASE + 16 }, () => 0);
  groundTileIds.forEach((id, index) => {
    groundRoleTileIds[index] = id;
  });
  wallMaskTileIds.forEach((id, mask) => {
    groundRoleTileIds[ARENA_GROUND_ROLE_WALL_BASE + mask] = id;
  });

  const markRoleTileIds = Array.from({ length: ARENA_MARK_ROLE_COUNT }, () => 0);
  markRoleTileIds[ARENA_MARK_ROLE_CRATE] = tileId("crate");
  markRoleTileIds[ARENA_MARK_ROLE_SANDBAG] = tileId("sandbag");
  markRoleTileIds[ARENA_MARK_ROLE_SPAWN] = tileId("spawnPad");
  markRoleTileIds[ARENA_MARK_ROLE_PICKUP] = tileId("world.pickup-pedestal");

  const decorRoleTileIds = Array.from({ length: ARENA_DECOR_ROLE_COUNT }, () => 0);
  decorRoleTileIds[ARENA_DECOR_ROLE_FLOOR_VENT] = tileId("world.floor-vent");
  decorRoleTileIds[ARENA_DECOR_ROLE_LAVA_FISSURE] = tileId("world.lava-fissure");
  decorRoleTileIds[ARENA_DECOR_ROLE_PICKUP_PEDESTAL] = tileId("world.pickup-pedestal");
  decorRoleTileIds[ARENA_DECOR_ROLE_PIPE_JUNCTION] = tileId("world.pipe-junction");
  decorRoleTileIds[ARENA_DECOR_ROLE_PIPE_RUN] = tileId("world.pipe-run");
  decorRoleTileIds[ARENA_DECOR_ROLE_THERMAL_VENT] = tileId("world.thermal-vent");

  return {
    id: theme.id,
    name: theme.name,
    groundTileIds,
    wallTileIds,
    wallMaskTileIds,
    groundRoleTileIds,
    markRoleTileIds,
    decorRoleTileIds,
    crateTileId: markRoleTileIds[ARENA_MARK_ROLE_CRATE],
    sandbagTileId: markRoleTileIds[ARENA_MARK_ROLE_SANDBAG],
    spawnPadTileId: markRoleTileIds[ARENA_MARK_ROLE_SPAWN],
    pickupPadTileId: tileId("pickupPad"),
    worldTileIds: Object.fromEntries(
      themed
        .filter((tile) => tile.semanticRole.startsWith("world."))
        .map((tile) => [tile.semanticRole.slice(6), tile.id]),
    ),
  };
}

function renderArenaArtContract(themeMaps) {
  const themes = themeMaps.map(({ id, name, groundRoleTileIds, markRoleTileIds, decorRoleTileIds }) => ({
    id,
    name,
    groundRoleTileIds,
    markRoleTileIds,
    decorRoleTileIds,
  }));
  const renderNumberArray = (property, values) => {
    const inline = `    ${property}: [${values.join(", ")}],`;
    if (inline.length <= 120) return [inline];
    const lines = [];
    let line = "      ";
    for (const value of values) {
      const token = `${value},`;
      if (line.length > 6 && line.length + token.length + 1 > 120) {
        lines.push(line);
        line = "      ";
      }
      line += line.length === 6 ? token : ` ${token}`;
    }
    lines.push(line);
    return [`    ${property}: [`, ...lines, "    ],"];
  };
  const renderedThemes = themes.flatMap((theme) => [
    "  {",
    `    id: ${JSON.stringify(theme.id)},`,
    `    name: ${JSON.stringify(theme.name)},`,
    ...renderNumberArray("groundRoleTileIds", theme.groundRoleTileIds),
    ...renderNumberArray("markRoleTileIds", theme.markRoleTileIds),
    ...renderNumberArray("decorRoleTileIds", theme.decorRoleTileIds),
    "  },",
  ]);
  return [
    "// Generated by tools/generate-art.mjs. Do not edit.",
    "// Defold tile ids are one-based, matching tilemap.setTile.",
    "export const ARENA_ART_THEMES = [",
    ...renderedThemes,
    "] as const;",
    'export type ArenaArtThemeId = (typeof ARENA_ART_THEMES)[number]["id"];',
    "",
    "export function arenaGroundTileId(themeIndex: number, role: number): number {",
    "  return ARENA_ART_THEMES[themeIndex]?.groundRoleTileIds[role] ?? 0;",
    "}",
    "",
    "export function arenaDecorTileId(themeIndex: number, role: number): number {",
    "  return ARENA_ART_THEMES[themeIndex]?.decorRoleTileIds[role] ?? 0;",
    "}",
    "",
    "export function arenaMarkTileId(themeIndex: number, role: number): number {",
    "  return ARENA_ART_THEMES[themeIndex]?.markRoleTileIds[role] ?? 0;",
    "}",
    "",
  ].join("\n");
}

function build() {
  const outputs = new Map(); // absolute path -> Buffer
  const { sheet, tiles, rows, cells } = buildTileSheet();
  verifyWallSeams(tiles);
  for (const theme of ARENA_THEMES) {
    verifySandbagWrap(tiles.find((tile) => tile.theme === theme.id && tile.semanticRole === "sandbag").canvas);
  }

  const sheetBytes = encodePng(sheet.width, sheet.height, sheet.data);
  outputs.set(resolve(outputRoot, "arena-tiles.png"), sheetBytes);
  const decodedSheet = decodePng(sheetBytes);
  check(
    "arena-tiles.png round-trips through the decoder",
    decodedSheet.width === sheet.width &&
      decodedSheet.height === sheet.height &&
      Buffer.from(decodedSheet.data).equals(Buffer.from(sheet.data)),
  );

  const sprites = buildSprites();
  const spriteRecords = [];
  for (const sprite of sprites) {
    const bytes = encodePng(sprite.canvas.width, sprite.canvas.height, sprite.canvas.data);
    outputs.set(resolve(outputRoot, `${sprite.name}.png`), bytes);
    const verified = verifySprite(sprite, bytes);
    spriteRecords.push({
      file: `${sprite.name}.png`,
      role: sprite.role,
      size: [sprite.canvas.width, sprite.canvas.height],
      outline: sprite.outlineColor,
      rotationAnchored: sprite.anchored,
      opaqueBbox: verified.bbox,
      verticalCentreOffset: verified.centred,
      sha256: sha256(bytes),
    });
  }

  const animations = buildAnimations();
  const atlasText = renderAtlas(animations);
  const tileSourceText = renderTileSource();
  outputs.set(resolve(mainRoot, "arena-sprites.atlas"), Buffer.from(atlasText));
  outputs.set(resolve(mainRoot, "arena-tiles.tilesource"), Buffer.from(tileSourceText));

  // Every atlas frame must exist as a generated PNG; this is why the atlas is
  // emitted from the same run as the images.
  const spriteNames = new Set(sprites.map((sprite) => sprite.name));
  const missing = animations.flatMap((a) => a.frames).filter((frame) => !spriteNames.has(frame));
  check("every atlas frame has a generated PNG", missing.length === 0, missing.join(", "));
  const referenced = new Set(animations.flatMap((a) => a.frames));
  const orphans = [...spriteNames].filter((name) => !referenced.has(name));
  check("every generated PNG is referenced by the atlas", orphans.length === 0, orphans.join(", "));

  const themeMaps = ARENA_THEMES.map((theme) => buildThemeMap(theme, tiles));
  for (const theme of themeMaps) {
    check(
      `${theme.id}: all 16 wall masks resolve`,
      theme.wallMaskTileIds.length === 16 && theme.wallMaskTileIds.every(Number.isInteger),
    );
    check(`${theme.id}: ground role table is total`, theme.groundRoleTileIds.filter(Number.isInteger).length === 32);
    check(`${theme.id}: mark role table is total`, theme.markRoleTileIds.every(Number.isInteger));
    check(`${theme.id}: decor role table is total`, theme.decorRoleTileIds.every(Number.isInteger));
  }
  const primaryTheme = themeMaps[0];
  const tileIdMap = {
    ordering: "Defold tile order: 1-based, left to right, top row first",
    themeIndexRule: "((mapSeed XOR defaultArenaSeed) unsigned) modulo theme count",
    themeOrder: themeMaps.map((theme) => theme.id),
    autotile: {
      maskBits: ARENA_WALL_MASK_BITS,
      bitMeaning: "set when the orthogonal neighbour is a concrete wall",
      maskToFrame: [...ARENA_WALL_MASK_TO_FRAME],
    },
    ...primaryTheme,
    themes: Object.fromEntries(themeMaps.map((theme) => [theme.id, theme])),
    tiles: tiles.map((tile) => ({
      id: tile.id,
      role: tile.role,
      semanticRole: tile.semanticRole,
      theme: tile.theme,
      layer: tile.layer,
      cell: tile.cell,
      pixelRect: [tile.cell[0] * TILE, tile.cell[1] * TILE, TILE, TILE],
    })),
  };

  const artContractText = renderArenaArtContract(themeMaps);
  outputs.set(resolve(sourceRoot, "generated-arena-art.ts"), Buffer.from(artContractText));

  const manifest = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schemaVersion: 1,
    generator: "tools/generate-art.mjs",
    source: {
      tutorial: "defold/tutorial-war-battles",
      licensedRevision: "645d9a1bc6c164237116e685694fca94021fc001",
      resourceReference: "ts-defold/tsd-template-war-battles",
      referenceRevision: "a3e6b8d066110d8607bada4cc7f456eefc529218",
      artistCredit: "Luis Zuno",
      license: "../../licenses/defold-tutorial-war-battles-MIT.txt",
      note:
        "No tutorial pixels are copied. Only the colour histogram of the pinned " +
        "tutorial PNGs is sampled; every new pixel is drawn from that sampled palette.",
    },
    determinism: {
      seed: SEED,
      rng: "mulberry32",
      zlibLevel: ZLIB_LEVEL,
      pngFilter: "none (filter type 0 on every scanline)",
      timestamps: "none",
    },
    palette: {
      sampledFrom: PALETTE_SOURCES,
      quantisation: {
        opaqueAlphaThreshold: OPAQUE_THRESHOLD,
        mergeRadiusRgb: QUANTISE_RADIUS,
        minPixelCount: MIN_PIXEL_COUNT,
        maxEntries: MAX_PALETTE_ENTRIES,
        rule:
          "Histogram every opaque pixel of the pinned sources, fold near-duplicates " +
          "within the merge radius into the more frequent colour, drop anything below " +
          "the minimum count, keep the most-used entries.",
      },
      entries: SAMPLED_PALETTE.map((entry) => ({
        hex: entry.hex,
        rgb: [entry.r, entry.g, entry.b],
        count: entry.count,
        usedByGeneratedArt: !!entry.used,
        mergedFrom: entry.merged,
        sources: [...entry.sources.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([file, count]) => ({ file, count })),
      })),
      roles: Object.fromEntries(Object.entries(C).map(([role, color]) => [role, hex(color[0], color[1], color[2])])),
    },
    teams: {
      order: TEAM_ORDER,
      rule:
        "Every team shares one shading ramp: shadow / base / light / highlight. " +
        "blue and sand are 100% sampled (sand is literally the tutorial tank's hull ramp). " +
        "red and green use hue-rotated variants where the sampled histogram has no colour " +
        "at that hue - the sampled greens are all the olive of the ground itself, which " +
        "would camouflage a tank.",
      ramps: Object.fromEntries(
        Object.entries(TEAMS).map(([team, ramp]) => [
          team,
          Object.fromEntries(
            Object.entries(ramp).map(([slot, color]) => {
              const value = hex(color[0], color[1], color[2]);
              const derivation = DERIVATIONS.find((d) => d.role === `${team}.${slot}`);
              return [
                slot,
                derivation ? { hex: value, origin: "hue-rotated", ...derivation } : { hex: value, origin: "sampled" },
              ];
            }),
          ),
        ]),
      ),
      derivations: DERIVATIONS,
    },
    outlineStyle: {
      finding:
        "The pinned tutorial sprites do carry a 1px dark border: #2c2839 is the " +
        "single most common colour in units/tank/down/1.png (159 px), " +
        "units/infantry/down/1.png (68 px), buildings/turret/1.png (146 px) and " +
        "buildings/supply-depot/1.png (547 px), and it traces the silhouette.",
      applied: "#2c2839, 1px, 8-connected, on tanks, projectiles, pickups, crate and wall edges.",
      exceptions: {
        "#423438":
          "Explosion frames 2+ use the tutorial explosion's own dark smoke instead of the " +
          "sprite outline, matching fx/explosion/3-5.png.",
        "#8a7549": "Floor markings use a gold/blue paint-edge instead of a hard black border.",
        none:
          "Self-luminous art (explosion frame 1, tracers, the railgun bolt, ricochet pulses, " +
          "muzzle flashes, sparks, the pickup glow ring) and the HUD chips carry no border; " +
          "fx/explosion/1.png in the tutorial is likewise a single flat colour with no border.",
      },
      difference:
        "The tutorial sprites feather the outermost outline pixel with partial alpha. The " +
        "generated art keeps hard edges (alpha 0 or 255) so nearest-neighbour sampling at " +
        "orthographic zoom 2 stays crisp.",
    },
    tileSheet: {
      file: "arena-tiles.png",
      tileSize: [TILE, TILE],
      columns: SHEET_COLUMNS,
      rows,
      cells,
      cellsUsed: tiles.length,
      cellsPadded: cells - tiles.length,
      padding: "trailing cells are fully transparent",
      defoldTileSource: "/main/arena-tiles.tilesource",
      sha256: sha256(sheetBytes),
      size: [sheet.width, sheet.height],
      map: tileIdMap,
    },
    sprites: spriteRecords,
    atlas: {
      file: "/main/arena-sprites.atlas",
      extrudeBorders: 2,
      sha256: sha256(Buffer.from(atlasText)),
      animations: animations.map((animation) => ({
        id: animation.id,
        playback: animation.playback,
        fps: animation.fps ?? null,
        frames: animation.frames.map((frame) => `${frame}.png`),
      })),
    },
    tileSource: {
      file: "/main/arena-tiles.tilesource",
      sha256: sha256(Buffer.from(tileSourceText)),
      note: 'The stub `animations { id: "anim" }` block mirrors main/tutorial-map.tilesource; no tile animations are defined.',
    },
    typescriptContract: {
      file: "/src/generated-arena-art.ts",
      sha256: sha256(Buffer.from(artContractText)),
      note: "Generated one-based tile ids for the runtime's semantic arena-role projector.",
    },
    rendering: {
      sampling: "nearest-neighbor",
      orthographicZoom: 2,
      rotationConvention: "sprites that rotate at runtime point +X at rotation 0",
    },
    verification: assertions,
  };

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  outputs.set(resolve(outputRoot, "arena-art.json"), manifestBytes);
  return { outputs, manifest, tiles, sprites, animations };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const checkOnly = process.argv.includes("--check");
  const { outputs, manifest } = build();

  for (const assertion of assertions) {
    process.stdout.write(
      `${assertion.ok ? "ok  " : "FAIL"} ${assertion.label}${assertion.detail ? ` (${assertion.detail})` : ""}\n`,
    );
  }
  if (failures > 0) throw new SystemExitError(`${failures} verification assertion(s) failed`);

  if (checkOnly) {
    for (const [path, bytes] of outputs) {
      let current = null;
      try {
        if (statSync(path).isFile()) current = readFileSync(path);
      } catch {
        /* missing file falls through to the mismatch below */
      }
      if (!current || !current.equals(bytes)) {
        throw new SystemExitError(`stale generated art: ${relative(exampleRoot, path)}`);
      }
    }
    process.stdout.write("war-battles-art:fresh\n");
    return;
  }

  for (const [path, bytes] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  process.stdout.write(
    `wrote ${outputs.size} files\n` +
      `  tile sheet ${manifest.tileSheet.size[0]}x${manifest.tileSheet.size[1]}, ` +
      `${manifest.tileSheet.cellsUsed}/${manifest.tileSheet.cells} cells used\n` +
      `  ${manifest.sprites.length} sprite PNGs, ${manifest.atlas.animations.length} atlas animations\n` +
      `  palette ${manifest.palette.entries.length} sampled colours, ` +
      `${manifest.teams.derivations.length} hue-rotated team shades\n`,
  );
}

class SystemExitError extends Error {}

try {
  main();
} catch (error) {
  if (error instanceof SystemExitError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
