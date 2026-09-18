const MASK_64 = 0xffff_ffff_ffff_ffffn;
const MURMUR_64_MULTIPLIER = 0xc6a4_a793_5bd1_e995n;
const MURMUR_64_SHIFT = 47n;

function mix(hash, value) {
  let lane = (value * MURMUR_64_MULTIPLIER) & MASK_64;
  lane ^= lane >> MURMUR_64_SHIFT;
  lane = (lane * MURMUR_64_MULTIPLIER) & MASK_64;
  hash = (hash * MURMUR_64_MULTIPLIER) & MASK_64;
  return (hash ^ lane) & MASK_64;
}

/**
 * Defold's endian-neutral dmHashBufferNoReverse64 over UTF-8 bytes.
 * This is intentionally BigInt-only: a JavaScript number cannot represent the
 * complete unsigned 64-bit result.
 */
export function hashDefoldString64(value) {
  if (typeof value !== "string") throw new TypeError("Defold hash input must be a string");
  const bytes = new TextEncoder().encode(value);
  let hash = 0n;
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let lane = 0n;
    for (let index = 0; index < 8; index += 1) {
      lane |= BigInt(bytes[offset + index]) << BigInt(index * 8);
    }
    hash = mix(hash, lane);
    offset += 8;
  }
  let tail = 0n;
  for (let index = offset; index < bytes.length; index += 1) {
    tail |= BigInt(bytes[index]) << BigInt((index - offset) * 8);
  }
  hash = mix(hash, tail);
  hash = mix(hash, BigInt(bytes.length));
  hash ^= hash >> MURMUR_64_SHIFT;
  hash = (hash * MURMUR_64_MULTIPLIER) & MASK_64;
  hash ^= hash >> MURMUR_64_SHIFT;
  return hash & MASK_64;
}

/** Resolve `#name` authoring syntax to the hash of `name`. */
export function hashDefoldLiteral64(literal) {
  if (typeof literal !== "string" || literal.length < 2 || literal[0] !== "#") {
    throw new TypeError('Defold hash literals must start with "#" and contain a name');
  }
  return hashDefoldString64(literal.slice(1));
}

export function formatDefoldHashBigInt(value) {
  return `0x${value.toString(16).padStart(16, "0")}n`;
}
