/**
 * Recolor only neutral armor pixels from the selected source art, then place
 * the class's own armor marking in the source frame's direction. Team signal
 * paint, warm lights, deep outlines, and alpha remain source-owned. This is a
 * deterministic finishing recipe, shared by the preview and runtime atlas.
 */
export function paintTankArmor(red, green, blue, alpha, livery, layer, pixel) {
  if (!livery) throw new Error("production tank livery is missing");
  if (alpha < 32) return [red, green, blue, alpha];
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const luminance = (red * 3 + green * 4 + blue) / 8;
  if (maximum - minimum > 36 || luminance < 45 || luminance > 196) {
    return [red, green, blue, alpha];
  }
  const pigment = livery.armorPigment;
  if (
    !Array.isArray(pigment) ||
    pigment.length !== 3 ||
    pigment.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    throw new Error("production tank livery needs an RGB armor pigment");
  }
  const strength = layer === "turret" ? livery.turretStrength : livery.hullStrength;
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new Error("production tank livery strength must be within 0..1");
  }
  if (pixel && isSignaturePixel(livery.signature, layer, pixel)) {
    const mark = livery.signaturePigment;
    if (
      !Array.isArray(mark) ||
      mark.length !== 3 ||
      mark.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
    ) {
      throw new Error("production tank livery needs an RGB signature pigment");
    }
    const shade = Math.max(0.72, Math.min(1.12, luminance / 118));
    return [...mark.map((channel) => Math.min(255, Math.round(channel * shade))), alpha];
  }
  const pigmentMean = (pigment[0] * 3 + pigment[1] * 4 + pigment[2]) / 8;
  const shade = Math.min(1, luminance / 100);
  const source = [red, green, blue];
  const recolored = source.map((channel, index) =>
    Math.max(0, Math.min(255, Math.round(channel + (pigment[index] - pigmentMean) * shade * strength))),
  );
  return [...recolored, alpha];
}

const FORWARD = Object.freeze({
  e: [1, 0],
  ne: [Math.SQRT1_2, -Math.SQRT1_2],
  n: [0, -1],
  nw: [-Math.SQRT1_2, -Math.SQRT1_2],
  w: [-1, 0],
  sw: [-Math.SQRT1_2, Math.SQRT1_2],
  s: [0, 1],
  se: [Math.SQRT1_2, Math.SQRT1_2],
});

export function isSignaturePixel(signature, layer, pixel) {
  const forward = FORWARD[pixel.direction];
  if (
    !forward ||
    ![pixel.x, pixel.y, pixel.width, pixel.height].every(Number.isFinite) ||
    pixel.width <= 0 ||
    pixel.height <= 0
  ) {
    throw new Error("production tank signature needs a bounded directional source pixel");
  }
  const radius = Math.min(pixel.width, pixel.height) * 0.5;
  const dx = (pixel.x - (pixel.width - 1) * 0.5) / radius;
  const dy = (pixel.y - (pixel.height - 1) * 0.5) / radius;
  const along = dx * forward[0] + dy * forward[1];
  const across = -dx * forward[1] + dy * forward[0];
  switch (signature) {
    case "twin-rails":
      return layer === "hull"
        ? Math.abs(along) < 0.66 && Math.abs(Math.abs(across) - 0.32) < 0.11
        : Math.abs(along - 0.12) < 0.17 && Math.abs(across) < 0.17;
    case "breach-chevron":
      return Math.abs(across) < 0.62 && Math.abs(along - (0.36 - Math.abs(across) * 0.7)) < 0.15;
    case "shield-bar":
      return (
        (Math.abs(along) < 0.18 && Math.abs(across) < 0.72) ||
        (layer === "hull" && Math.abs(across) < 0.17 && Math.abs(along) < 0.42)
      );
    case "range-spine":
      return layer === "turret"
        ? Math.abs(across) < 0.16 && along > -0.58 && along < 0.78
        : Math.abs(along + 0.14) < 0.12 && Math.abs(across) < 0.58;
    default:
      throw new Error(`unknown production tank signature ${signature}`);
  }
}
