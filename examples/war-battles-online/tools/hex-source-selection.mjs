import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const HEX_TILE_SELECTION_PATH = "art/source/sprite-fusion/hex-tile-selection-v2.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function readHexSourceSelection(root) {
  const bytes = readFileSync(resolve(root, HEX_TILE_SELECTION_PATH));
  const selection = JSON.parse(bytes);
  if (selection.schemaVersion !== 2 || selection.kind !== "war-battles.hex-tile-selection") {
    throw new Error("unsupported Sprite Fusion hex tile selection");
  }
  return { selection, sha256: sha256(bytes) };
}

/** Resolve only one family: source identities are immutable, output pixels verified. */
export function loadHexFamilySources(root, selection, role, decode) {
  const groups = selection.families?.[role]?.sources;
  if (!Array.isArray(groups) || groups.length === 0) throw new Error(`hex family ${role} has no sources`);
  const seen = new Set();
  return groups.flatMap(({ request, indices }) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request) || !Array.isArray(indices) || indices.length === 0) {
      throw new Error(`hex family ${role} has an invalid source group`);
    }
    const manifest = JSON.parse(
      readFileSync(resolve(root, `art/source/sprite-fusion/requests/${request}.json`), "utf8"),
    );
    if (manifest.schemaVersion !== 1 || manifest.owner !== "tools/sprite-fusion.mjs") {
      throw new Error(`hex source request ${request} has an unsupported manifest`);
    }
    if (sha256(readFileSync(resolve(root, manifest.spec.path))) !== manifest.spec.sha256) {
      throw new Error(`hex source request spec changed: ${request}`);
    }
    return indices.map((index) => {
      const key = `${request}:${index}`;
      if (!Number.isInteger(index) || seen.has(key)) throw new Error(`duplicate or invalid hex source ${role}:${key}`);
      seen.add(key);
      const output = manifest.outputs.find((candidate) => candidate.index === index);
      if (!output) throw new Error(`missing hex source ${role}:${key}`);
      const bytes = readFileSync(resolve(root, output.path));
      if (sha256(bytes) !== output.sha256) throw new Error(`hex source changed: ${output.path}`);
      const image = decode(bytes);
      // Sprite Fusion style-reference keeps the requested 64px scale but can
      // expand the canvas by up to half. The floor sampler normalizes each opaque
      // bounding box, while raised collision cliffs use separately pinned 64px
      // sources. Reject large or non-square drift instead of silently rescaling
      // an unrelated image.
      if (
        image.width !== image.height ||
        image.width < 64 ||
        image.width > 96 ||
        output.width !== image.width ||
        output.height !== image.height
      ) {
        throw new Error(`selected hex source is outside the 64–96px square floor range: ${output.path}`);
      }
      return { image, role, request, index, assetId: output.assetId, path: output.path, sha256: output.sha256 };
    });
  });
}
