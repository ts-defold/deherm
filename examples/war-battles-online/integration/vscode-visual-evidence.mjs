import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const VISUAL_EVIDENCE_KIND = "deherm.war-battles.vscode-live-values-evidence";
export const VISUAL_EVIDENCE_SCHEMA_VERSION = 2;
export const ARENA_SOURCE = "main/arena.script.ts";
export const EXPECTED_PROPERTIES = Object.freeze({
  players: 8,
  botSkill: 1,
  mapSeed: 0,
  autoEngageSeconds: 0,
});

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function hashFile(repositoryRoot, relativePath) {
  const bytes = await readFile(path.join(repositoryRoot, relativePath));
  return { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) };
}

export function readPngSize(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("VS Code visual evidence is not a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function propertyRecord(instance) {
  return Object.fromEntries((instance.properties ?? []).map((property) => [property.name, property.value?.value]));
}

export function requireArenaInstance(state) {
  for (const target of state.targets ?? []) {
    for (const instance of target.instances ?? []) {
      if (instance.source !== ARENA_SOURCE || instance.schemaStatus !== "current") continue;
      const properties = propertyRecord(instance);
      for (const [name, expected] of Object.entries(EXPECTED_PROPERTIES)) {
        if (properties[name] !== expected) {
          throw new Error(`Live arena property ${name} is ${String(properties[name])}, expected ${expected}`);
        }
      }
      return { target, instance, properties };
    }
  }
  throw new Error(`No current-schema ${ARENA_SOURCE} instance exists in the editor state`);
}

export function requireInlineValueTexts(renderedText) {
  const normalized = renderedText.replace(/\s+/gu, " ");
  return Object.entries(EXPECTED_PROPERTIES).map(([name, value]) => {
    const expected = `= ${value}`;
    if (!normalized.includes(expected)) {
      throw new Error(`The rendered VS Code document does not contain the inline ${name} value`);
    }
    return expected;
  });
}

export function evidenceKey(document) {
  const copy = structuredClone(document);
  delete copy.evidenceKey;
  return sha256(JSON.stringify(copy));
}

export function buildVisualEvidence({
  screenshot,
  renderedText,
  state,
  sourceInputs,
  vscode,
  packageArtifact,
  vsixArtifact,
}) {
  const arena = requireArenaInstance(state);
  const inlineValueTexts = requireInlineValueTexts(renderedText);
  const png = readPngSize(screenshot.bytes);
  const document = {
    schemaVersion: VISUAL_EVIDENCE_SCHEMA_VERSION,
    kind: VISUAL_EVIDENCE_KIND,
    platform: "arm64-macos",
    observation: {
      editor: "Visual Studio Code",
      title: vscode.title,
      userAgent: vscode.userAgent,
      targetId: arena.target.id,
      targetRuntime: arena.target.runtime,
      source: ARENA_SOURCE,
      instanceId: arena.instance.instanceId,
      componentId: arena.instance.componentId,
      schemaFingerprint: arena.instance.schemaFingerprint,
      schemaStatus: arena.instance.schemaStatus,
      properties: arena.properties,
      inlineValueTexts,
      projectedInstanceCount: arena.target.instances.length,
      omittedInstanceCount: arena.target.instanceProjection?.omittedInstances ?? null,
    },
    screenshot: {
      path: screenshot.path,
      bytes: screenshot.bytes.length,
      sha256: sha256(screenshot.bytes),
      width: png.width,
      height: png.height,
    },
    observedArtifacts: {
      npmPackage: packageArtifact,
      vsix: vsixArtifact,
    },
    sourceInputs,
  };
  document.evidenceKey = evidenceKey(document);
  return document;
}

export async function verifyVisualEvidence(document, repositoryRoot) {
  if (document.schemaVersion !== VISUAL_EVIDENCE_SCHEMA_VERSION || document.kind !== VISUAL_EVIDENCE_KIND) {
    throw new Error("VS Code visual evidence schema is unsupported");
  }
  if (document.evidenceKey !== evidenceKey(document)) throw new Error("VS Code visual evidence key is stale");
  if (document.observation.source !== ARENA_SOURCE || document.observation.schemaStatus !== "current") {
    throw new Error("VS Code visual evidence is not bound to the current arena schema");
  }
  if (!Array.isArray(document.observation.inlineValueTexts)) {
    throw new Error("VS Code visual evidence has no inline property values");
  }
  requireInlineValueTexts(document.observation.inlineValueTexts.join("\n"));
  for (const [name, expected] of Object.entries(EXPECTED_PROPERTIES)) {
    if (document.observation.properties?.[name] !== expected) {
      throw new Error(`Recorded VS Code property ${name} is stale`);
    }
  }
  const screenshotPath = path.join(repositoryRoot, document.screenshot.path);
  const screenshotBytes = await readFile(screenshotPath);
  const png = readPngSize(screenshotBytes);
  if (
    sha256(screenshotBytes) !== document.screenshot.sha256 ||
    screenshotBytes.length !== document.screenshot.bytes ||
    png.width !== document.screenshot.width ||
    png.height !== document.screenshot.height
  ) {
    throw new Error("VS Code screenshot bytes do not match the recorded evidence");
  }
  for (const input of document.sourceInputs ?? []) {
    const current = await hashFile(repositoryRoot, input.path);
    if (JSON.stringify(current) !== JSON.stringify(input)) {
      throw new Error(`VS Code visual evidence source is stale: ${input.path}`);
    }
  }
  return document;
}
