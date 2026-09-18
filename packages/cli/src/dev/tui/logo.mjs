import { ui } from "@rezi-ui/core";

import { basaltRamp, heartRamp, prism } from "./theme.mjs";

// Fourteen raster rows become seven terminal rows through upper/lower half-blocks.
// The floating acute is part of the bitmap instead of depending on font shaping.
const glyphs = {
  d: [".....##", ".....##", ".....##", ".######", "#######", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "#######", ".######"],
  é: ["...##..", "..##...", ".......", ".#####.", "#######", "##...##", "#######", "#######", "##.....", "##.....", "##.....", "##.....", "#######", ".#####."],
  h: ["##.....", "##.....", "##.....", "######.", "#######", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##"],
  e: [".......", ".......", ".......", ".#####.", "#######", "##...##", "#######", "#######", "##.....", "##.....", "##.....", "##.....", "#######", ".#####."],
  r: ["......", "......", "......", "##.###", "######", "###...", "##....", "##....", "##....", "##....", "##....", "##....", "##....", "##...."],
  m: [".........", ".........", ".........", "##.##.##.", "########.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##."],
  heart: ["........", "........", "........", ".##..##.", "########", "########", "########", "########", ".######.", ".######.", "..####..", "...##...", "...##...", "........"]
};

function logoPixels() {
  const names = ["d", "é", "h", "e", "r", "m", "heart"];
  return Array.from({ length: 14 }, (_, y) => names.flatMap((name, index) => {
    const pixels = [...glyphs[name][y]].map((pixel) => ({ on: pixel === "#", heart: name === "heart" }));
    const gap = index === names.length - 1 ? [] : [{ on: false, heart: false }];
    return [...pixels, ...gap];
  }));
}

const logoBitmap = logoPixels();

function bitmapColor(pixel, x, y, frame) {
  if (!pixel.on) return undefined;
  if (pixel.heart) return heartRamp[Math.min(heartRamp.length - 1, Math.floor((y - 3) / 3) + ((x + frame) % 19 === 0 ? 1 : 0))];
  if (y >= 9) return prism[Math.min(prism.length - 1, y - 9)];
  const glintDistance = Math.abs((x + frame) % 31 - 15);
  return basaltRamp[glintDistance <= 1 ? 4 : glintDistance <= 3 ? 3 : glintDistance <= 5 ? 2 : 1];
}

const basaltGrain = ["⣿", "⣷", "⣯", "⣟", "⡿"];

function halfBlock(top, bottom, options) {
  if (top === undefined && bottom === undefined) return { text: " ", style: {} };
  if (top !== undefined && bottom !== undefined) {
    if (options.basaltPair) {
      const grain = basaltGrain[(options.x * 7 + options.row * 3) % basaltGrain.length];
      return { text: grain, style: { fg: top, bg: basaltRamp[0] } };
    }
    if (options.heartPair && top === bottom) return { text: "▓", style: { fg: top, bg: heartRamp[0] } };
    if (top === bottom) return { text: "█", style: { fg: top } };
    return { text: "▀", style: { fg: top, bg: bottom } };
  }
  return top !== undefined ? { text: "▀", style: { fg: top } } : { text: "▄", style: { fg: bottom } };
}

function renderBitmapRow(topPixels, bottomPixels, frame, topRow) {
  const spans = [];
  let previous;
  for (let x = 0; x < topPixels.length; x += 1) {
    const cell = halfBlock(
      bitmapColor(topPixels[x], x, topRow, frame),
      bitmapColor(bottomPixels[x], x, topRow + 1, frame),
      {
        x,
        row: topRow,
        basaltPair: topRow + 1 < 9 && topPixels[x].on && bottomPixels[x].on && !topPixels[x].heart && !bottomPixels[x].heart,
        heartPair: topPixels[x].heart && bottomPixels[x].heart
      }
    );
    const styleKey = `${cell.style.fg ?? ""}/${cell.style.bg ?? ""}`;
    if (previous?.styleKey === styleKey) previous.text += cell.text;
    else {
      previous = { styleKey, ...cell };
      spans.push(previous);
    }
  }
  return ui.richText(spans.map(({ text, style }) => ({ text, style })));
}

export function renderLogo(tick, reducedMotion, tagline) {
  const frame = reducedMotion ? 0 : Math.floor(tick / 2);
  const rows = [];
  for (let row = 0; row < logoBitmap.length; row += 2) {
    rows.push(renderBitmapRow(logoBitmap[row], logoBitmap[row + 1], frame, row));
  }
  if (tagline) rows.push(ui.text("  déherm · TypeScript at engine speed", { style: { fg: prism[2], bold: true } }));
  return ui.column({ gap: 0 }, rows);
}

export function renderCompactLogo() {
  return ui.richText([
    { text: "▰ ", style: { fg: prism[4] } },
    { text: "déherm", style: { fg: basaltRamp[4], bold: true } },
    { text: " ♥", style: { fg: heartRamp[2], bold: true } },
    { text: "  TypeScript at engine speed", style: { fg: prism[2] } }
  ]);
}
