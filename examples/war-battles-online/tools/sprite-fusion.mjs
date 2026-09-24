#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = "https://www.spritefusion.com/api/v1";
const inlineImageLimit = 1_000_000;
const inlineTotalLimit = 2_500_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    default:
      throw new Error(`Unsupported SpriteFusion input image: ${filePath}`);
  }
}

function extensionFor(contentType, url) {
  if (contentType === "image/gif") return ".gif";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/png") return ".png";
  const extension = path.extname(new URL(url).pathname);
  return extension && extension.length <= 6 ? extension : ".bin";
}

async function loadApiKey() {
  if (process.env.SPRITE_FUSION_API_KEY) return process.env.SPRITE_FUSION_API_KEY;
  const envPath = path.join(exampleRoot, ".env");
  const contents = await readFile(envPath, "utf8");
  const line = contents.split(/\r?\n/u).find((candidate) => candidate.trimStart().startsWith("SPRITE_FUSION_API_KEY="));
  if (!line) throw new Error(`SPRITE_FUSION_API_KEY is missing from ${envPath}`);
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!value) throw new Error(`SPRITE_FUSION_API_KEY is empty in ${envPath}`);
  return value;
}

async function inputDescriptor(value) {
  if (value.startsWith("asset:")) {
    const assetId = value.slice("asset:".length);
    if (!assetId) throw new Error("SpriteFusion asset input has no id");
    return { api: { asset_id: assetId }, record: { kind: "asset", assetId }, inlineBytes: 0 };
  }
  if (value.startsWith("upload:")) {
    const uploadId = value.slice("upload:".length);
    if (!uploadId) throw new Error("SpriteFusion upload input has no id");
    return { api: { upload_id: uploadId }, record: { kind: "upload", uploadId }, inlineBytes: 0 };
  }
  const absolute = path.resolve(exampleRoot, value);
  const bytes = await readFile(absolute);
  if (bytes.byteLength > inlineImageLimit) {
    throw new Error(`Inline SpriteFusion input exceeds ${inlineImageLimit} bytes: ${value}`);
  }
  const contentType = contentTypeFor(absolute);
  const relative = path.relative(exampleRoot, absolute).replaceAll(path.sep, "/");
  return {
    api: { data_url: `data:${contentType};base64,${bytes.toString("base64")}` },
    record: { kind: "file", path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) },
    inlineBytes: bytes.byteLength,
  };
}

function parseEvents(text) {
  const normalized = text.replaceAll("\r\n", "\n");
  return normalized
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((json) => JSON.parse(json));
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SpriteFusion asset download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function requestBody(spec, inputs) {
  const body = { operation: spec.operation };
  if (spec.prompt !== undefined) body.prompt = spec.prompt;
  if (spec.size !== undefined) body.size = spec.size;
  if (inputs.length) body.inputs = inputs.map((input) => input.api);
  if (spec.outputFrames !== undefined) body.output_frames = spec.outputFrames;
  if (spec.colors !== undefined) body.colors = spec.colors;
  return body;
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--spec") {
    throw new Error("Usage: node tools/sprite-fusion.mjs --spec <request.json>");
  }
  const specPath = path.resolve(exampleRoot, process.argv[3]);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(spec.name ?? "")) {
    throw new Error("SpriteFusion request name must be lowercase kebab-case");
  }
  const inputs = await Promise.all((spec.inputs ?? []).map(inputDescriptor));
  const inlineBytes = inputs.reduce((total, input) => total + input.inlineBytes, 0);
  if (inlineBytes > inlineTotalLimit) {
    throw new Error(`Inline SpriteFusion inputs exceed ${inlineTotalLimit} total bytes`);
  }

  const apiKey = await loadApiKey();
  const response = await fetch(`${apiRoot}/generate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody(spec, inputs)),
  });
  if (!response.ok) throw new Error(`SpriteFusion request failed (${response.status}): ${await response.text()}`);
  const events = parseEvents(await response.text());
  const started = events.find((event) => event.type === "started");
  const completed = events.findLast((event) => event.type === "completed");
  const outputEvents = events.filter((event) => event.type === "output");
  if (!started?.request_id) throw new Error("SpriteFusion stream has no started event");
  if (!completed) throw new Error("SpriteFusion stream ended before completed");
  if (completed.status !== "succeeded") {
    throw new Error(`SpriteFusion generation failed: ${completed.error?.message ?? "unknown failure"}`);
  }
  if (completed.output_count !== outputEvents.length) {
    throw new Error(
      `SpriteFusion output count mismatch: completed=${completed.output_count}, observed=${outputEvents.length}`,
    );
  }

  const outputRoot = path.join(exampleRoot, "art/source/sprite-fusion/outputs", spec.name);
  try {
    await access(outputRoot);
    throw new Error(`SpriteFusion output directory already exists: ${path.relative(exampleRoot, outputRoot)}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(outputRoot, { recursive: true });

  const outputs = [];
  for (const event of outputEvents) {
    const asset = event.asset;
    const extension = extensionFor(asset.contentType, asset.assetUrl);
    const localPath = path.join(outputRoot, `${String(event.index).padStart(2, "0")}${extension}`);
    const downloaded = await download(asset.assetUrl, localPath);
    const record = {
      index: event.index,
      assetId: asset.id,
      type: asset.type,
      contentType: asset.contentType,
      width: asset.width,
      height: asset.height,
      assetUrl: asset.assetUrl,
      path: path.relative(exampleRoot, localPath).replaceAll(path.sep, "/"),
      ...downloaded,
    };
    if (asset.spritesheetUrl) {
      const sheetPath = path.join(outputRoot, `${String(event.index).padStart(2, "0")}-sheet.png`);
      record.spritesheet = {
        url: asset.spritesheetUrl,
        path: path.relative(exampleRoot, sheetPath).replaceAll(path.sep, "/"),
        ...(await download(asset.spritesheetUrl, sheetPath)),
      };
    }
    if (asset.frameCount !== undefined) record.frameCount = asset.frameCount;
    if (asset.fps !== undefined) record.fps = asset.fps;
    outputs.push(record);
  }

  const specRelative = path.relative(exampleRoot, specPath).replaceAll(path.sep, "/");
  const manifest = {
    schemaVersion: 1,
    owner: "tools/sprite-fusion.mjs",
    requestId: started.request_id,
    operation: spec.operation,
    prompt: spec.prompt ?? null,
    size: spec.size ?? null,
    outputFrames: spec.outputFrames ?? null,
    colors: spec.colors ?? null,
    inputs: inputs.map((input) => input.record),
    spec: { path: specRelative, sha256: sha256(await readFile(specPath)) },
    outputs,
    credits: completed.credits ?? null,
  };
  const manifestPath = path.join(exampleRoot, "art/source/sprite-fusion/requests", `${spec.name}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `sprite-fusion:ok:${spec.name}:request=${manifest.requestId}:outputs=${outputs.length}:credits=${manifest.credits?.remaining ?? "unknown"}`,
  );
}

async function showCredits() {
  const apiKey = await loadApiKey();
  const response = await fetch(`${apiRoot}/credits`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`SpriteFusion credits request failed (${response.status})`);
  const body = await response.json();
  if (!Number.isInteger(body.credits) || body.credits < 0) {
    throw new Error("SpriteFusion credits response is invalid");
  }
  console.log(`sprite-fusion:credits:${body.credits}`);
}

if (process.argv.length === 3 && process.argv[2] === "--credits") await showCredits();
else await main();
