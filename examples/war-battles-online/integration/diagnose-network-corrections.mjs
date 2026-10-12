#!/usr/bin/env node

// Deterministic, cold-path diagnostic. This does not change the production
// client/server or relax the impairment gate.
import { cellCentreX, cellCentreY } from "../core/arena.ts";
import { MAP_WIDTH, UNITS_PER_PIXEL } from "../core/constants.ts";
import { LOAD_HARNESS_CONFIG, runAuthoritativeLoadHarness } from "./authoritative-load-harness.ts";
import { NETWORK_IMPAIRMENT_PROFILES } from "./network-impairment-matrix.ts";

const clean = {
  ...LOAD_HARNESS_CONFIG,
  players: 16,
  baseLatencyMilliseconds: 0,
  jitterMilliseconds: 0,
  datagramLossPercent: 0,
  uplinkBitsPerSecond: 10_000_000,
  downlinkBitsPerSecond: 10_000_000,
  minimumInputAcceptanceRatio: 0.99,
};
const profiles = [["clean-localhost", clean], ...NETWORK_IMPAIRMENT_PROFILES.map(({ name, config }) => [name, config])];
const selected = process.argv[2];
if (selected && !profiles.some(([name]) => name === selected)) {
  throw new Error(`Unknown profile ${selected}; choose ${profiles.map(([name]) => name).join(", ")}`);
}

for (const [name, config] of profiles) {
  if (selected && name !== selected) continue;
  const seenSnapshots = new Uint32Array(config.players);
  const actorDistanceHistory = Array.from({ length: config.players }, () => new Float32Array(32).fill(Infinity));
  const actorDistanceCursor = new Uint8Array(config.players);
  const events = [];
  let nearActorWithinFortyPixels = 0;
  let nearActorInRecentStepsWithinFortyPixels = 0;
  let nearDepotWithinFortyPixels = 0;
  await runAuthoritativeLoadHarness(config, {
    now: () => performance.now(),
    onClientStep({ tick, client, clientIndex }) {
      const player = client.playerId - 1;
      if (player < 0 || !client.world) return;
      const world = client.world;
      const x = world.playerX[player];
      const y = world.playerY[player];
      let nearestActor = Infinity;
      for (let other = 0; other < world.playerActive.length; other += 1) {
        if (other === player || !world.playerActive[other]) continue;
        nearestActor = Math.min(nearestActor, Math.hypot(x - world.playerX[other], y - world.playerY[other]));
      }
      const actorPixels = nearestActor / UNITS_PER_PIXEL;
      const history = actorDistanceHistory[clientIndex];
      history[actorDistanceCursor[clientIndex] % history.length] = actorPixels;
      actorDistanceCursor[clientIndex] += 1;
      if (client.stats.snapshotsApplied === seenSnapshots[player]) return;
      seenSnapshots[player] = client.stats.snapshotsApplied;
      const magnitude = client.stats.lastPredictionErrorMagnitude;
      if (magnitude <= 8 * UNITS_PER_PIXEL) return;
      let nearestDepot = Infinity;
      for (const cell of world.map.plan.depotFacadeCells) {
        if (cell < 0) continue;
        nearestDepot = Math.min(
          nearestDepot,
          Math.hypot(x - cellCentreX(cell % MAP_WIDTH), y - cellCentreY(Math.trunc(cell / MAP_WIDTH))),
        );
      }
      const depotPixels = nearestDepot / UNITS_PER_PIXEL;
      const recentActorPixels = Math.min(...history);
      if (actorPixels <= 40) nearActorWithinFortyPixels += 1;
      if (recentActorPixels <= 40) nearActorInRecentStepsWithinFortyPixels += 1;
      if (depotPixels <= 40) nearDepotWithinFortyPixels += 1;
      const large =
        magnitude > 32 * UNITS_PER_PIXEL &&
        client.stats.lastLargeCorrectionSnapshotTick === client.stats.lastServerTick;
      let predictedActorPixels = Infinity;
      if (large) {
        const predictedX = client.stats.lastLargeCorrectionPredictedX;
        const predictedY = client.stats.lastLargeCorrectionPredictedY;
        for (let other = 0; other < world.playerActive.length; other += 1) {
          if (other === player || !world.playerActive[other]) continue;
          predictedActorPixels = Math.min(
            predictedActorPixels,
            Math.hypot(predictedX - world.playerX[other], predictedY - world.playerY[other]) / UNITS_PER_PIXEL,
          );
        }
      }
      events.push({
        tick,
        playerId: client.playerId,
        errorPixels: magnitude / UNITS_PER_PIXEL,
        actorPixels,
        nearestActorInLast32ClientStepsPixels: recentActorPixels,
        depotPixels,
        ...(large
          ? {
              snapshotTick: client.stats.lastLargeCorrectionSnapshotTick,
              localTick: client.stats.lastLargeCorrectionLocalTick,
              leadTicks: client.stats.inputLeadTicks,
              predictedActorPixels,
              predictedInSolid: world.map.solidAtWorld(
                client.stats.lastLargeCorrectionPredictedX,
                client.stats.lastLargeCorrectionPredictedY,
              ),
              predictedPixels: [
                client.stats.lastLargeCorrectionPredictedX / UNITS_PER_PIXEL,
                client.stats.lastLargeCorrectionPredictedY / UNITS_PER_PIXEL,
              ],
              correctedPixels: [x / UNITS_PER_PIXEL, y / UNITS_PER_PIXEL],
            }
          : {}),
      });
    },
  });
  events.sort((a, b) => b.errorPixels - a.errorPixels);
  console.log(
    JSON.stringify({
      profile: name,
      overEightPixelEvents: events.length,
      nearActorWithinFortyPixels,
      nearActorInRecentStepsWithinFortyPixels,
      nearDepotWithinFortyPixels,
      largest: events.slice(0, 10),
      evidenceBoundary:
        "Deterministic application-payload harness. Current actor/depot distances are measured after correction; actor history holds the last 32 client-step samples, including correction steps. Proximity is correlation, not collision causality or packaged-rendering proof.",
    }),
  );
}
