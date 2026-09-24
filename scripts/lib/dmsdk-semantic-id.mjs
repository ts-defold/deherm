// Defold's imported declaration IDs end in source coordinates. Coordinates are
// evidence for one revision, not semantic identity across revisions. Package-
// owned lowering recipes key through this projection so an unchanged API may
// move without requiring a new package release.
export function semanticDeclarationId(id) {
  return String(id).replace(/:\d+:\d+$/u, "");
}

export function semanticEntryMap(entries, label = "dmSDK policy") {
  const result = new Map();
  for (const [id, value] of Object.entries(entries ?? {})) {
    const semanticId = semanticDeclarationId(id);
    if (result.has(semanticId)) throw new Error(`${label} contains duplicate semantic declaration ${semanticId}`);
    result.set(semanticId, value);
  }
  return result;
}
