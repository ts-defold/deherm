import path from "node:path";

function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("protobuf varint must be a non-negative safe integer");
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
}

export function normalizeResourcePaths(resources) {
  const normalized = new Set();
  for (const resource of resources) {
    if (typeof resource !== "string" || resource.includes("\0")) {
      throw new TypeError("resource paths must be NUL-free strings");
    }
    const slashPath = resource.replaceAll("\\", "/");
    if (slashPath.split("/").includes("..")) {
      throw new Error(`invalid Defold resource path: ${resource}`);
    }
    const absolute = slashPath.startsWith("/") ? slashPath : `/${slashPath}`;
    const canonical = path.posix.normalize(absolute);
    if (canonical === "/" || canonical === "/.." || canonical.startsWith("/../")) {
      throw new Error(`invalid Defold resource path: ${resource}`);
    }
    normalized.add(canonical);
  }
  return [...normalized].sort();
}

export function encodeResourceReload(resources) {
  const chunks = [];
  let byteLength = 0;
  for (const resource of normalizeResourcePaths(resources)) {
    const value = Buffer.from(resource, "utf8");
    const length = Buffer.from(encodeVarint(value.byteLength));
    const tag = Buffer.from([0x0a]);
    chunks.push(tag, length, value);
    byteLength += tag.byteLength + length.byteLength + value.byteLength;
  }
  return Buffer.concat(chunks, byteLength);
}

export function encodeResourceReloadBatches(resources, maxPayloadBytes = 1_024) {
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    throw new TypeError("maximum reload payload must be a positive safe integer");
  }
  const batches = [];
  let batch = [];
  let byteLength = 0;
  for (const resource of normalizeResourcePaths(resources)) {
    const encoded = encodeResourceReload([resource]);
    if (encoded.byteLength > maxPayloadBytes) {
      throw new Error(`Defold resource path exceeds ${maxPayloadBytes}-byte reload payload limit: ${resource}`);
    }
    if (byteLength + encoded.byteLength > maxPayloadBytes) {
      batches.push(Buffer.concat(batch, byteLength));
      batch = [];
      byteLength = 0;
    }
    batch.push(encoded);
    byteLength += encoded.byteLength;
  }
  if (batch.length) batches.push(Buffer.concat(batch, byteLength));
  return batches;
}

export async function postResourceReload(targetUrl, resources, options = {}) {
  const url = new URL("/post/@resource/reload", targetUrl);
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 2_000);
  for (const body of encodeResourceReloadBatches(resources, options.maxPayloadBytes ?? 1_024)) {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
      signal
    });
    if (!response.ok) {
      throw new Error(`Defold reload failed: ${response.status} ${response.statusText}`);
    }
  }
}

export async function readTargetState(targetUrl, options = {}) {
  const response = await (options.fetch ?? globalThis.fetch)(new URL("/state", targetUrl), {
    method: "POST",
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 2_000)
  });
  if (!response.ok) throw new Error(`Defold target state failed: ${response.status} ${response.statusText}`);
  return response.json();
}
