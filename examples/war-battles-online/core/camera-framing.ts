/** Seed-derived, allocation-free shoreline framing for the one local camera. */
import { hexCentreAtSimulation } from "./hex-landscape.ts";
import { isometricScreenX, isometricScreenY } from "./isometric-projection.ts";
import { WORLD_HEX_COUNT, worldHexQ, worldHexR, type WorldPlan } from "./world-plan.ts";

export interface CameraFrameTarget {
  x: number;
  y: number;
}

/**
 * Cached floor anchors, not an independent coast classifier. A view near the
 * shoreline should show playable land rather than centring half its pixels on
 * empty sea. The local actor remains within the central half of the view.
 */
export class LandwardCameraFramer {
  readonly seed: number;
  private readonly centreX: Float32Array;
  private readonly centreY: Float32Array;
  private readonly count: number;

  constructor(plan: WorldPlan) {
    this.seed = plan.seed;
    this.centreX = new Float32Array(plan.landCount);
    this.centreY = new Float32Array(plan.landCount);
    let count = 0;
    for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
      if (plan.land[index] === 0) continue;
      const centre = hexCentreAtSimulation(worldHexQ(index), worldHexR(index));
      this.centreX[count] = isometricScreenX(centre.x, centre.y);
      this.centreY[count] = isometricScreenY(centre.x, centre.y);
      count += 1;
    }
    this.count = count;
  }

  frame(actorX: number, actorY: number, halfWidth: number, halfHeight: number, output: CameraFrameTarget): void {
    output.x = actorX;
    output.y = actorY;
    if (this.count === 0 || halfWidth <= 0 || halfHeight <= 0) return;
    const reachX = halfWidth * 0.85;
    const reachY = halfHeight * 0.85;
    let weightedX = 0;
    let weightedY = 0;
    let weightTotal = 0;
    for (let index = 0; index < this.count; index += 1) {
      const dx = (this.centreX[index]! - actorX) / reachX;
      const dy = (this.centreY[index]! - actorY) / reachY;
      const weight = 1 - dx * dx - dy * dy;
      if (weight <= 0) continue;
      weightedX += this.centreX[index]! * weight;
      weightedY += this.centreY[index]! * weight;
      weightTotal += weight;
    }
    if (weightTotal === 0) return;
    const maxX = halfWidth * 0.25;
    const maxY = halfHeight * 0.25;
    output.x += Math.max(-maxX, Math.min(maxX, ((weightedX / weightTotal - actorX) * 3) / 4));
    output.y += Math.max(-maxY, Math.min(maxY, ((weightedY / weightTotal - actorY) * 3) / 4));
  }
}
