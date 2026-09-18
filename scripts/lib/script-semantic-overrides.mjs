import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function loadScriptSemanticOverrides(root) {
  const definitionUrl = new URL("bindings/overrides/script-api-semantic-overrides.json", root);
  const definition = JSON.parse(await readFile(definitionUrl, "utf8"));
  if (definition.schemaVersion !== 1 || !Array.isArray(definition.overrides)) {
    throw new Error(`Unsupported script semantic override schema in ${definitionUrl.pathname}`);
  }
  const validated = new Map();
  for (const override of definition.overrides) {
    if (typeof override.id !== "string" || validated.has(override.id)) {
      throw new Error(`Script semantic override IDs must be unique: ${override.id}`);
    }
    if (!override.parameterOptional || typeof override.parameterOptional !== "object") {
      throw new Error(`${override.id}: parameterOptional is required`);
    }
    const sourceUrl = new URL(`upstream/defold/${override.evidence?.source ?? ""}`, root);
    const contents = await readFile(sourceUrl, "utf8");
    const line = contents.split(/\r?\n/)[override.evidence.line - 1] ?? "";
    if (!line.includes(override.evidence.observed)) {
      throw new Error(`Semantic override evidence is stale for ${override.id} at ${override.evidence.source}:${override.evidence.line}`);
    }
    validated.set(override.id, {
      parameterOptional: { ...override.parameterOptional },
      evidence: {
        ...override.evidence,
        sourceSha256: createHash("sha256").update(contents).digest("hex")
      }
    });
  }
  return validated;
}
