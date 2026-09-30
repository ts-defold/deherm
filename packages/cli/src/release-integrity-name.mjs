// The release sidecar naming contract is intentionally dependency-free.
// CI resolves build rows before installing workspace dependencies, while the
// full archive verifier depends on fflate for ZIP inspection.
export function releaseIntegrityAssetName(asset) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(asset ?? "")) {
    throw new Error(`Invalid release asset ${JSON.stringify(asset)}`);
  }
  return `${asset}.integrity.json`;
}
