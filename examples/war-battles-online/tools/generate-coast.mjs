#!/usr/bin/env node
// A deterministic isometric ocean and shallow hex-edge faces. Both water and
// the forward face come from the same seed-pinned land mask as the floor.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORLD_MIN_X,
  WORLD_MIN_Y,
  UNITS_PER_PIXEL,
  WORLD_PIXEL_ORIGIN_X,
  WORLD_PIXEL_ORIGIN_Y,
} from "../core/constants.ts";
import { HEX_CLIFF_VARIANT_FAMILIES } from "../core/hex-cliffs.ts";
import { hexCellAt } from "../core/hex-landscape.ts";
import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import { buildWorldPlan, worldHexIndex, worldHexQ, worldHexR, worldPlanRoleAt } from "../core/world-plan.ts";
import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artManifest = JSON.parse(readFileSync(resolve(root, "defold/assets/derived/arena/arena-art.json"), "utf8"));
if (artManifest.schemaVersion !== 1 || artManifest.generator !== "tools/generate-art.mjs") {
  throw new Error("coast requires the checked arena art generator output");
}
const cliffTiles = new Map();
for (const family of Object.values(HEX_CLIFF_VARIANT_FAMILIES)) {
  for (let variant = family.start; variant < family.start + family.count; variant += 1) {
    const file = `hex-cliff-${variant}.png`;
    const entry = artManifest.sprites.find((sprite) => sprite.file === file && sprite.role === "world.hex-cliff");
    if (!entry) throw new Error(`missing generated coast cell ${file}`);
    const bytes = readFileSync(resolve(root, "defold/assets/derived/arena", file));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`changed generated coast cell ${file}`);
    }
    const image = decodeRgbaPng(bytes);
    if (image.width !== entry.size[0] || image.height !== entry.size[1]) {
      throw new Error(`wrong generated coast cell size ${file}`);
    }
    const [minX, minY, maxX, maxY] = entry.opaqueBbox;
    const colors = [];
    for (let y = Math.round(minY + (maxY - minY) * 0.65); y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const offset = (y * image.width + x) * 4;
        if (image.pixels[offset + 3] >= 128) {
          colors.push([image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]]);
        }
      }
    }
    colors.sort((left, right) => left[0] + left[1] + left[2] - right[0] - right[1] - right[2]);
    if (colors.length === 0) throw new Error(`coast cell ${file} has no side-wall palette`);
    cliffTiles.set(variant, { color: colors[Math.floor(colors.length / 2)], sha256: entry.sha256, file });
  }
}
const waterSelection = JSON.parse(
  readFileSync(resolve(root, "art/source/sprite-fusion/coastal-water-selection-v1.json"), "utf8"),
);
const waterRequest = JSON.parse(
  readFileSync(resolve(root, `art/source/sprite-fusion/requests/${waterSelection.request}.json`), "utf8"),
);
const selectedWater = waterRequest.outputs.find((output) => output.index === waterSelection.index);
if (
  waterSelection.schemaVersion !== 1 ||
  waterRequest.requestId !== waterSelection.requestId ||
  selectedWater?.assetId !== waterSelection.assetId ||
  selectedWater.path !== waterSelection.path ||
  selectedWater.sha256 !== waterSelection.sha256
) {
  throw new Error("coastal-water selection disagrees with its Sprite Fusion request");
}
const waterBytes = readFileSync(resolve(root, waterSelection.path));
if (createHash("sha256").update(waterBytes).digest("hex") !== waterSelection.sha256) {
  throw new Error("selected coastal-water source changed");
}
const waterSource = decodeRgbaPng(waterBytes);
const waterColors = [];
for (let offset = 0; offset < waterSource.pixels.length; offset += 4) {
  const red = waterSource.pixels[offset];
  const green = waterSource.pixels[offset + 1];
  const blue = waterSource.pixels[offset + 2];
  if (waterSource.pixels[offset + 3] >= 128 && red < 80 && green > red + 20 && blue > green && blue < 200) {
    waterColors.push([red, green, blue]);
  }
}
if (waterColors.length < 200) throw new Error("selected coastal-water source has no stable sea palette");
waterColors.sort((left, right) => left[1] + left[2] - right[1] - right[2]);
const waterBody = waterColors[Math.floor(waterColors.length / 2)];
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("Usage: node tools/generate-coast.mjs [--check]");
}

const width = 1536;
const height = 800;
const presentationScale = 2;
const plan = buildWorldPlan(DEFAULT_ARENA_SEED);
// Alpha is a lossless material tag in this generated texture. The custom
// material resolves sea pixels to full opacity after applying their ripple;
// cliffs remain 255 and the interior remains transparent.
const waterMaterialAlpha = 252;
const left = WORLD_PIXEL_ORIGIN_X - (width * presentationScale) / 2;
const top = WORLD_PIXEL_ORIGIN_Y + (height * presentationScale) / 2;
const pixels = Buffer.alloc(width * height * 4);
const landHexAtPixel = new Int16Array(width * height);

function mix(x, y) {
  let value = Math.imul(x ^ 0x41ec_5eed, 0x9e37_79b1) ^ Math.imul(y, 0x85eb_ca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d);
  return (value ^ (value >>> 15)) >>> 0;
}

function put(offset, r, g, b, a = 255) {
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
}

const hexScratch = { q: 0, r: 0, dx: 0, dy: 0 };
for (let y = 0; y < height; y += 1) {
  const screenY = top - y * presentationScale;
  for (let x = 0; x < width; x += 1) {
    const screenX = left + x * presentationScale;
    const offset = (y * width + x) * 4;
    const u = (screenX - WORLD_PIXEL_ORIGIN_X) / Math.SQRT1_2;
    const v = (screenY - WORLD_PIXEL_ORIGIN_Y) / (Math.SQRT1_2 * 0.5);
    const worldX = (u + v) * 0.5;
    const worldY = (v - u) * 0.5;
    hexCellAt(worldX - WORLD_MIN_X / UNITS_PER_PIXEL, worldY - WORLD_MIN_Y / UNITS_PER_PIXEL, hexScratch);
    const hexIndex = worldHexIndex(hexScratch.q, hexScratch.r);
    if (hexIndex >= 0 && plan.land[hexIndex] !== 0) {
      landHexAtPixel[y * width + x] = hexIndex + 1;
      continue;
    }

    // A quiet two-tone sea leaves the selected source wavelets legible. The
    // old per-cell hash changed every four source pixels and read as a large
    // checkerboard once the scene camera enlarged it.
    const band = (y + (x >> 5)) % 53;
    const shade = band < 15 ? 2 : band > 42 ? -2 : 0;
    put(
      offset,
      9 + (waterBody[0] >> 1),
      34 + (waterBody[1] >> 1) + shade,
      48 + (waterBody[2] >> 1) + shade,
      waterMaterialAlpha,
    );
  }
}

// The chosen Sprite Fusion water image is a single 64px wave motif, not a
// tileset. Scatter nearest-neighbor half-size impressions on a jittered,
// seeded lattice, clipping each impression to plan-owned sea pixels. That
// keeps the coast irregular and avoids visible repeated square texture cells.
const waveBounds = alphaBounds(waterSource);
if (!waveBounds) throw new Error("selected coastal-water source has no opaque wave motif");
const waveStepX = 103;
const waveStepY = 83;
let waveletPixels = 0;
let waveletCount = 0;
for (let gy = -1; gy <= Math.ceil(height / waveStepY); gy++) {
  for (let gx = -1; gx <= Math.ceil(width / waveStepX); gx++) {
    const seed = mix(gx, gy);
    if (seed % 5 === 0) continue;
    const originX = gx * waveStepX + ((seed >>> 8) % 31) - 15;
    const originY = gy * waveStepY + ((seed >>> 16) % 29) - 14;
    let drawn = false;
    for (let sy = waveBounds[1]; sy <= waveBounds[3]; sy += 2) {
      for (let sx = waveBounds[0]; sx <= waveBounds[2]; sx += 2) {
        const x = originX + ((sx - waveBounds[0]) >> 1);
        const y = originY + ((sy - waveBounds[1]) >> 1);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const destination = (y * width + x) * 4;
        if (pixels[destination + 3] !== waterMaterialAlpha) continue;
        const sourceX = seed & 1 ? waveBounds[2] - (sx - waveBounds[0]) : sx;
        const source = (sy * waterSource.width + sourceX) * 4;
        const alpha = waterSource.pixels[source + 3];
        if (alpha < 96) continue;
        const blend = Math.min(128, Math.round(alpha * 0.42));
        for (let channel = 0; channel < 3; channel++) {
          pixels[destination + channel] = Math.round(
            (pixels[destination + channel] * (255 - blend) + waterSource.pixels[source + channel] * blend) / 255,
          );
        }
        waveletPixels++;
        drawn = true;
      }
    }
    if (drawn) waveletCount++;
  }
}

// The shoreline uses the same 96px q-axis pitch as the authored floor hexes.
// The hex floor already supplies the exact top-face silhouette. Its land mask
// is the authoritative coast outline; extrude only the forward-facing water
// pixels immediately below it. This keeps the logical anchor fixed, follows
// every irregular hex edge, and makes high/standard/low shallow tiers visible
// without giant repeated prism sprites or a straight ribbon. Each face takes
// its rock palette from the selected source hex's lower wall pixels.
const faceDepthByTier = [3, 5, 7];
for (let y = 1; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const pixel = y * width + x;
    if (landHexAtPixel[pixel] !== 0) continue;
    for (let distance = 1; distance <= faceDepthByTier[2] && distance <= y; distance++) {
      const landIndex = landHexAtPixel[(y - distance) * width + x] - 1;
      if (landIndex < 0) continue;
      if (distance > faceDepthByTier[plan.elevation[landIndex]]) break;
      const q = worldHexQ(landIndex);
      const r = worldHexR(landIndex);
      const role = worldPlanRoleAt(plan, q, r);
      const family = HEX_CLIFF_VARIANT_FAMILIES[role];
      if (!family) throw new Error(`no coast hex family for ${role}`);
      const variant = family.start + (mix(q, r) % family.count);
      const color = cliffTiles.get(variant)?.color;
      if (!color) throw new Error(`missing coast source color for ${variant}`);
      const light = distance <= 2 ? 17 : distance <= 4 ? 7 : 0;
      put(pixel * 4, color[0] + light, color[1] + light, color[2] + light);
      break;
    }
  }
}

const imageBytes = encodeRgbaPng(width, height, pixels);
const atlas = Buffer.from(
  'animations {\n  id: "island-coast"\n  images {\n    image: "/assets/derived/world/island-coast.png"\n  }\n}\nextrude_borders: 2\n',
);
const gameObject = Buffer.from(
  'embedded_components {\n  id: "sprite"\n  type: "sprite"\n' +
    '  data: "tile_set: \\"/main/island-coast.atlas\\"\\n"\n' +
    '  "default_animation: \\"island-coast\\"\\n"\n' +
    '  "material: \\"/main/island-coast.material\\"\\n"\n' +
    '  "blend_mode: BLEND_MODE_ALPHA\\n"\n' +
    '  ""\n}\n',
);
const fragmentProgram = Buffer.from(`#version 140

in mediump vec2 var_texcoord0;
out vec4 out_fragColor;

uniform mediump sampler2D texture_sampler;
uniform fs_uniforms
{
    mediump vec4 tint;
    highp vec4 time;
};

void main()
{
    vec4 pixel = texture(texture_sampler, var_texcoord0);
    // The generator tags only ocean pixels with alpha 252/255. This avoids
    // animating dark cliff shadows or the transparent interior by color guess.
    if (pixel.a > 0.97 && pixel.a < 0.995)
    {
        // A short, one-source-pixel foam dash crosses a wave row on each
        // quarter-second tick. The previous four-pixel diagonal cell pattern
        // amplified into a checkerboard at gameplay camera zoom.
        vec2 texel = floor(var_texcoord0 * vec2(${width}.0, ${height}.0));
        float phase = floor(time.x * 4.0);
        float row = mod(texel.y + phase + floor(texel.x / 48.0) * 3.0, 31.0);
        float segment = mod(texel.x + floor(texel.y / 31.0) * 17.0, 47.0);
        float foam = (1.0 - step(1.0, row)) * (1.0 - step(12.0, segment));
        pixel.rgb += foam * vec3(0.025, 0.040, 0.040);
        pixel.a = 1.0;
    }
    vec4 tint_pm = vec4(tint.xyz * tint.w, tint.w);
    out_fragColor = pixel * tint_pm;
}
`);
const material = Buffer.from(`name: "island-coast"
tags: "tile"
vertex_program: "/builtins/materials/sprite.vp"
fragment_program: "/main/island-coast.fp"
vertex_space: VERTEX_SPACE_WORLD
vertex_constants {
  name: "view_proj"
  type: CONSTANT_TYPE_VIEWPROJ
}
fragment_constants {
  name: "tint"
  type: CONSTANT_TYPE_USER
  value { x: 1.0 y: 1.0 z: 1.0 w: 1.0 }
}
fragment_constants {
  name: "time"
  type: CONSTANT_TYPE_TIME
}
samplers {
  name: "texture_sampler"
  wrap_u: WRAP_MODE_CLAMP_TO_EDGE
  wrap_v: WRAP_MODE_CLAMP_TO_EDGE
  filter_min: FILTER_MODE_MIN_DEFAULT
  filter_mag: FILTER_MODE_MAG_DEFAULT
  max_anisotropy: 1.0
}
max_page_count: 0
`);
const manifest = Buffer.from(
  JSON.stringify(
    {
      schemaVersion: 2,
      owner: "tools/generate-coast.mjs",
      worldPlan: { seed: plan.seed, rulesVersion: plan.rulesVersion, landHexes: plan.landCount },
      source: {
        generator: artManifest.generator,
        cells: [...cliffTiles.values()].map(({ file, sha256 }) => ({ file, sha256 })),
      },
      waterSource: {
        requestId: waterSelection.requestId,
        assetId: waterSelection.assetId,
        path: waterSelection.path,
        sha256: waterSelection.sha256,
      },
      image: { width, height, sha256: createHash("sha256").update(imageBytes).digest("hex") },
      placement: {
        centreX: WORLD_PIXEL_ORIGIN_X,
        centreY: WORLD_PIXEL_ORIGIN_Y,
        z: -0.5,
        scale: presentationScale,
      },
      animation: {
        owner: "main/island-coast.fp",
        maskAlpha: waterMaterialAlpha,
        cadenceHz: 4,
        pixelCell: 1,
        rule: "one-pixel segmented foam rows over tagged sea only; no game-script update or extra full-screen frames",
      },
      wavelets: {
        source: waterSelection.path,
        sourceBounds: waveBounds,
        sourceSampling: "nearest-neighbor half-size, clipped to water material alpha",
        step: [waveStepX, waveStepY],
        count: waveletCount,
        pixels: waveletPixels,
      },
      coastWall: {
        shape: "forward-facing water pixels extruded from the exact planned hex top-face mask",
        faceDepthByTier,
        palette: "median lower-wall source colors from the selected raised-hex family",
        anchor: "logical floor top-face; relief is entirely below the land mask",
      },
      transparency:
        "planned land reveals the matching hex floor; planned water receives animated sea or a shallow source-colored forward face",
    },
    null,
    2,
  ) + "\n",
);
const outputs = new Map([
  ["defold/assets/derived/world/island-coast.png", imageBytes],
  ["defold/assets/derived/world/island-coast.json", manifest],
  ["defold/main/island-coast.atlas", atlas],
  ["defold/main/island-coast.go", gameObject],
  ["defold/main/island-coast.fp", fragmentProgram],
  ["defold/main/island-coast.material", material],
]);
for (const [relativePath, bytes] of outputs) {
  const destination = resolve(root, relativePath);
  if (check) {
    if (!readFileSync(destination).equals(bytes)) throw new Error(`stale generated coast: ${relativePath}`);
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}
console.log(`island-coast:${check ? "fresh" : "generated"}:${width}x${height}`);
