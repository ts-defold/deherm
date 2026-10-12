// Source-pixel mounting coordinates are declared beside the selected art.
// The fixed atlas target lets hull and independently aimed turret frames share
// one Defold component position without generating 8×8 animation pairs.
export const TANK_DIRECTIONS = Object.freeze(["se", "s", "sw", "w", "e", "nw", "n", "ne"]);

function point(value, label, width, height) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(Number.isInteger) ||
    value[0] < 0 ||
    value[1] < 0 ||
    value[0] >= width ||
    value[1] >= height
  ) {
    throw new Error(`invalid tank mount ${label}`);
  }
  return value;
}

export function tankLayerPlacement(selected, layer, direction, sourceWidth, sourceHeight, cellSize = 128) {
  if (layer !== "hull" && layer !== "turret") throw new Error(`invalid tank layer ${layer}`);
  if (!TANK_DIRECTIONS.includes(direction)) throw new Error(`invalid tank direction ${direction}`);
  const scale = layer === "turret" ? selected.turretScale : 1;
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 1) throw new Error(`invalid tank ${layer} scale`);
  const width = Math.ceil(sourceWidth * scale);
  const height = Math.ceil(sourceHeight * scale);
  const registration = selected.mountRegistration;
  if (!registration) {
    return {
      x: Math.floor((cellSize - width) / 2),
      y: Math.floor((cellSize - height) / 2),
      width,
      height,
      registered: false,
    };
  }
  if (
    registration.schemaVersion !== 1 ||
    registration.hullRequest !== selected.hullRequest ||
    registration.turretRequest !== selected.turretRequest
  ) {
    throw new Error("tank mount registration does not match selected source requests");
  }
  const target = point(registration.targetCellPixel, "targetCellPixel", cellSize, cellSize);
  const anchors = layer === "hull" ? registration.hullMountByDirection : registration.turretMountByDirection;
  if (
    !anchors ||
    Object.keys(anchors).length !== TANK_DIRECTIONS.length ||
    TANK_DIRECTIONS.some((id) => !Object.hasOwn(anchors, id))
  ) {
    throw new Error(`incomplete tank ${layer} mount registration`);
  }
  const source = point(anchors[direction], `${layer}.${direction}`, sourceWidth, sourceHeight);
  const x = target[0] - Math.floor(source[0] * scale);
  const y = target[1] - Math.floor(source[1] * scale);
  if (x < 0 || y < 0 || x + width > cellSize || y + height > cellSize) {
    throw new Error(`tank ${layer}.${direction} registered pixels exceed the atlas cell`);
  }
  return { x, y, width, height, registered: true };
}
