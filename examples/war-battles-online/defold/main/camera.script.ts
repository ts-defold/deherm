import {
  camera,
  defineComponent,
  go,
  hashLiteral,
  property,
  sys,
  vmath,
  type DefoldHash,
} from "@deherm/project";

declare const __defoldHostV1: {
  log(level: "info", message: string): void;
};

/**
 * The follow target reports itself instead of being sampled.
 *
 * `go.get_position(id)` is declared for `String`, `Hash` and `Url` but only the
 * current-instance shape is implemented in the generated value bindings, so a
 * camera cannot read another game object's transform yet. A message carries the
 * target's world position instead, which is an implemented
 * `msg.post(String, String, Table)` shape.
 */
const PLAYER_AT = hashLiteral("#player_at");

interface PlayerAt {
  readonly x: number;
  readonly y: number;
}

interface CameraSelf {
  /** Editor properties: the world rectangle the view is clamped inside, in pixels. */
  worldMinX: number;
  worldMinY: number;
  worldMaxX: number;
  worldMaxY: number;
  /** Editor property: maximum look-ahead ahead of the target, in pixels. */
  lookAhead: number;
  /** Editor property: target speed at which look-ahead reaches its maximum. */
  lookAheadSpeed: number;
  /** Editor property: exponential rate at which look-ahead eases in and out. */
  lookAheadRate: number;
  /** Editor property: exponential rate at which the view converges on its target. */
  followRate: number;
  /** Editor property: seconds between camera trace lines, 0 disables them. */
  traceInterval: number;
  /** Editor property: fallback orthographic zoom when no camera component answers. */
  zoom: number;

  halfWidth: number;
  halfHeight: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  viewX: number;
  viewY: number;
  viewZ: number;
  leadX: number;
  leadY: number;
  targetX: number;
  targetY: number;
  previousTargetX: number;
  previousTargetY: number;
  clampedX: boolean;
  clampedY: boolean;
  traceElapsed: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

/**
 * Derive the clamp rectangle from the world bounds and the half view. A world
 * smaller than the view on an axis collapses that axis to its centre so the
 * camera never shows outside the map on one side while chasing the other.
 */
function resolveBounds(self: CameraSelf): void {
  self.minX = self.worldMinX + self.halfWidth;
  self.maxX = self.worldMaxX - self.halfWidth;
  if (self.minX > self.maxX) {
    const centre = (self.worldMinX + self.worldMaxX) * 0.5;
    self.minX = centre;
    self.maxX = centre;
  }
  self.minY = self.worldMinY + self.halfHeight;
  self.maxY = self.worldMaxY - self.halfHeight;
  if (self.minY > self.maxY) {
    const centre = (self.worldMinY + self.worldMaxY) * 0.5;
    self.minY = centre;
    self.maxY = centre;
  }
}

/** Write the smoothed view position, snapped to whole world pixels. */
function commit(self: CameraSelf): void {
  const x = clamp(self.viewX, self.minX, self.maxX);
  const y = clamp(self.viewY, self.minY, self.maxY);
  self.clampedX = x !== self.viewX;
  self.clampedY = y !== self.viewY;
  self.viewX = x;
  self.viewY = y;
  // The reference scale is a whole-pixel integer zoom, so the view origin is
  // snapped to whole world pixels; a fractional origin would shimmer the
  // tilemap at the authored scale.
  go.setPosition(vmath.vector3(Math.round(x), Math.round(y), self.viewZ));
}

export default defineComponent({
  properties: {
    worldMinX: property.number(0),
    worldMinY: property.number(0),
    worldMaxX: property.number(0),
    worldMaxY: property.number(0),
    lookAhead: property.number(56),
    lookAheadSpeed: property.number(180),
    lookAheadRate: property.number(3),
    followRate: property.number(7),
    traceInterval: property.number(1),
    zoom: property.number(2),
  },

  init(self: CameraSelf): void {
    // The visible world rectangle is the reference display size divided by the
    // camera's effective orthographic zoom. Auto-fit contributes a
    // browser-size-dependent multiplier; reading it from the active camera
    // keeps clamp arithmetic and projection from drifting apart.
    const cameras = camera.getCameras();
    const active = cameras.length > 0 ? cameras[0] : undefined;
    const zoomMultiplier = active === undefined ? self.zoom : camera.getOrthographicZoom(active);
    // Defold specifies 1.0 for fixed mode, so this call covers every mode
    // without evaluating a generated script constant at runtime.
    const autoZoom = active === undefined ? 1 : camera.getOrthographicAutoZoom(active);
    const zoom = zoomMultiplier * autoZoom;
    const displayWidth = sys.getConfigNumber("display.width", 1280);
    const displayHeight = sys.getConfigNumber("display.height", 720);
    self.halfWidth = displayWidth / zoom / 2;
    self.halfHeight = displayHeight / zoom / 2;
    resolveBounds(self);
    __defoldHostV1.log(
      "info",
      `war-battles:camera-init:zoom=${zoom.toFixed(2)}:view=${(self.halfWidth * 2).toFixed(0)}x${(self.halfHeight * 2).toFixed(0)}` +
      `:cameras=${cameras.length}`,
    );
    __defoldHostV1.log(
      "info",
      `war-battles:camera-bounds:x=[${self.minX.toFixed(1)},${self.maxX.toFixed(1)}]:y=[${self.minY.toFixed(1)},${self.maxY.toFixed(1)}]`,
    );

    // The authored camera position seeds the view until the first target
    // report arrives, so a launch never starts from the world origin.
    const position = go.getPosition();
    self.viewZ = position.z;
    self.viewX = position.x;
    self.viewY = position.y;
    self.targetX = position.x;
    self.targetY = position.y;
    self.previousTargetX = position.x;
    self.previousTargetY = position.y;
    self.leadX = 0;
    self.leadY = 0;
    self.clampedX = false;
    self.clampedY = false;
    self.traceElapsed = 0;
    commit(self);
  },

  onMessage(self: CameraSelf, messageId: DefoldHash, message: PlayerAt): void {
    if (messageId !== PLAYER_AT) return;
    self.targetX = message.x;
    self.targetY = message.y;
  },

  update(self: CameraSelf, dt: number): void {
    if (dt <= 0) return;

    // Look-ahead is derived from the target's own motion rather than from its
    // input, so the camera stays decoupled from the player component.
    const velocityX = (self.targetX - self.previousTargetX) / dt;
    const velocityY = (self.targetY - self.previousTargetY) / dt;
    self.previousTargetX = self.targetX;
    self.previousTargetY = self.targetY;

    const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY);
    let desiredLeadX = 0;
    let desiredLeadY = 0;
    if (speed > 1 && self.lookAhead > 0) {
      const reach = Math.min(1, speed / self.lookAheadSpeed) * self.lookAhead;
      desiredLeadX = (velocityX / speed) * reach;
      desiredLeadY = (velocityY / speed) * reach;
    }
    const leadBlend = 1 - Math.exp(-self.lookAheadRate * dt);
    self.leadX += (desiredLeadX - self.leadX) * leadBlend;
    self.leadY += (desiredLeadY - self.leadY) * leadBlend;

    const followBlend = 1 - Math.exp(-self.followRate * dt);
    self.viewX += (self.targetX + self.leadX - self.viewX) * followBlend;
    self.viewY += (self.targetY + self.leadY - self.viewY) * followBlend;
    commit(self);

    if (self.traceInterval <= 0) return;
    self.traceElapsed += dt;
    if (self.traceElapsed < self.traceInterval) return;
    self.traceElapsed = 0;
    const clamped = self.clampedX ? (self.clampedY ? "xy" : "x") : self.clampedY ? "y" : "none";
    __defoldHostV1.log(
      "info",
      `war-battles:camera:${self.viewX.toFixed(1)}:${self.viewY.toFixed(1)}` +
      `:target=${self.targetX.toFixed(1)},${self.targetY.toFixed(1)}:lead=${self.leadX.toFixed(1)},${self.leadY.toFixed(1)}:clamped=${clamped}`,
    );
  },
});
