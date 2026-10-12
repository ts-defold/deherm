// Defold may substitute a short non-hex block marker for at most four ASCII
// bytes of a custom-resource fingerprint. This is a bounded provenance guard,
// not cryptographic authentication of the archive: omitted digits are unknown.
const fingerprintMarker = Buffer.from('__DEFOLD_HERMES_BUILD_FINGERPRINT__ = "', "ascii");

export function matchesPackagedBundleFingerprint(archiveBytes, fingerprint) {
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new TypeError("expected a 64-digit bundle fingerprint");
  const bytes = Buffer.from(archiveBytes);
  const expected = Buffer.from(fingerprint, "ascii");
  let markerOffset = bytes.indexOf(fingerprintMarker);
  while (markerOffset >= 0) {
    const offset = markerOffset + fingerprintMarker.length;
    if (bytes.subarray(offset, offset + 64).equals(expected) && bytes[offset + 64] === 34) return true;
    for (let split = 1; split < 64; split += 1) {
      if (!bytes.subarray(offset, offset + split).equals(expected.subarray(0, split))) break;
      for (let omitted = 1; omitted <= 4; omitted += 1) {
        for (let markerLength = 1; markerLength <= 8; markerLength += 1) {
          const block = bytes.subarray(offset + split, offset + split + markerLength);
          if (
            block.length !== markerLength ||
            block.some((byte) => (byte >= 48 && byte <= 57) || (byte >= 97 && byte <= 102))
          )
            continue;
          const suffix = expected.subarray(split + omitted);
          const suffixOffset = offset + split + markerLength;
          if (
            bytes.subarray(suffixOffset, suffixOffset + suffix.length).equals(suffix) &&
            bytes[suffixOffset + suffix.length] === 34
          )
            return true;
        }
      }
    }
    markerOffset = bytes.indexOf(fingerprintMarker, markerOffset + fingerprintMarker.length);
  }
  return false;
}
