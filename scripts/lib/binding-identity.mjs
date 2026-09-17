/** Persistent public identity derived from the canonical semantic-token key. */
export function stableBindingId(canonicalId) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(canonicalId, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hexBindingId(value) {
  return `0x${value.toString(16).padStart(8, "0")}u`;
}
