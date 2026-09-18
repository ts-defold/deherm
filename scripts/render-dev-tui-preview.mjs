#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTestRenderer } from "@rezi-ui/core";

import { renderDevDashboard } from "../packages/cli/src/dev/tui.mjs";

const cellWidth = 9;
const cellHeight = 18;
const generatedAt = Date.parse("2026-09-17T22:00:00-04:00");

const snapshot = {
  phase: "awaiting-activation",
  generation: 38,
  lastSuccessfulGeneration: 38,
  activeBuild: undefined,
  lastBuildMetrics: {
    bytes: 184_832,
    byteDelta: -12_448,
    durationMs: 21.7,
    moduleCount: 73,
    modules: [
      { file: "game/tank.script.ts", bytes: 28_410 },
      { file: "@ts-defold/deherm/sdk", bytes: 21_096 },
      { file: "game/weapons/railgun.ts", bytes: 12_802 },
      { file: "game/ui/hud.gui_script.ts", bytes: 9_316 }
    ]
  },
  history: [{ generation: 38, status: "built", resources: ["/deherm/app.dehermc"] }],
  targets: [
    {
      id: "iphone",
      name: "Justin’s iPhone · arm64-ios",
      url: "http://192.168.1.42:8001",
      status: "awaiting-activation",
      pendingGeneration: 38,
      appliedGeneration: 37,
      signalledGeneration: 38,
      telemetry: {
        frameMs: 8.21,
        frameSamples: [8.7, 8.2, 7.9, 9.1, 8.4, 8.0, 7.8, 8.2, 8.1, 8.21],
        hermesHeapBytes: 6_828_032,
        hermesRoots: 418,
        arenaHighWaterBytes: 49_152,
        luaRegistryUsed: 32,
        luaRegistryCapacity: 512,
        droppedEvents: 0
      }
    },
    {
      id: "browser",
      name: "Chrome · wasm-web",
      url: "ws://127.0.0.1:9317",
      status: "connected",
      appliedGeneration: 38,
      telemetry: {}
    }
  ],
  logs: [
    { id: "watch-38", at: generatedAt - 900, level: "info", source: "watch", message: "2 files changed · invalidated 7 modules" },
    { id: "ttsc-38", at: generatedAt - 730, level: "info", source: "ttsc", message: "typed transform 11.4 ms · cache 91%" },
    { id: "bundle-38", at: generatedAt - 480, level: "info", source: "bundle", message: "generation 38 · 180.5 KiB (-12.2 KiB)" },
    { id: "signal-38", at: generatedAt - 260, level: "info", source: "iphone", message: "reload message enqueued · activation is not yet verified" },
    { id: "candidate-38", at: generatedAt - 80, level: "debug", source: "hermes", message: "candidate realm validating component schema 9f3a…" }
  ]
};

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function color(value, fallback) {
  if (!value) return fallback;
  return `#${value.toString(16).padStart(6, "0")}`;
}

async function renderPreview({ cols, rows }, output) {
  const renderer = createTestRenderer({ viewport: { cols, rows } });
  const result = renderer.render(renderDevDashboard({
    tick: 9,
    reducedMotion: false,
    viewport: { cols, rows },
    logScroll: 0,
    setLogScroll() {},
    snapshot
  }));
  const elements = [];
  for (const operation of result.ops) {
    if (operation.kind === "fillRect") {
      elements.push(`<rect x="${operation.x * cellWidth}" y="${operation.y * cellHeight}" width="${operation.w * cellWidth}" height="${operation.h * cellHeight}" fill="${color(operation.style?.bg ?? operation.style?.fg, "#11151a")}"/>`);
    } else if (operation.kind === "drawText") {
      const weight = operation.style?.bold ? 700 : 450;
      const opacity = operation.style?.dim ? 0.62 : 1;
      if (operation.style?.bg) {
        elements.push(`<rect x="${operation.x * cellWidth}" y="${operation.y * cellHeight}" width="${[...operation.text].length * cellWidth}" height="${cellHeight}" fill="${color(operation.style.bg, "#080a0c")}" opacity="${opacity}"/>`);
      }
      elements.push(`<text x="${operation.x * cellWidth}" y="${(operation.y + 0.78) * cellHeight}" fill="${color(operation.style?.fg, "#d3d6d8")}" font-weight="${weight}" opacity="${opacity}">${escapeXml(operation.text)}</text>`);
    }
  }
  await writeFile(output, `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cellWidth}" height="${rows * cellHeight}" viewBox="0 0 ${cols * cellWidth} ${rows * cellHeight}">
<rect width="100%" height="100%" rx="12" fill="#080a0c"/>
<style>text { font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 14px; white-space: pre; }</style>
${elements.join("\n")}
</svg>\n`);
  console.log(output);
}

const outputDirectory = path.resolve("docs/assets/brand");
await mkdir(outputDirectory, { recursive: true });
for (const viewport of [{ cols: 80, rows: 24 }, { cols: 120, rows: 30 }, { cols: 150, rows: 48 }]) {
  await renderPreview(viewport, path.join(outputDirectory, `deherm-dev-tui-preview-${viewport.cols}x${viewport.rows}.svg`));
}
await renderPreview({ cols: 150, rows: 48 }, path.join(outputDirectory, "deherm-dev-tui-preview.svg"));
