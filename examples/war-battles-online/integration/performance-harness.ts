import {
  INPUT_BUTTON_BOOST,
  INPUT_BUTTON_FIRE,
  COVER_SNAPSHOT_BYTES,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  PICKUP_SNAPSHOT_BYTES,
  PLAYER_SNAPSHOT_BYTES,
  PROJECTILE_SNAPSHOT_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_HEADER_BYTES,
  TICK_RATE,
} from "../core/constants.ts";
import { EVENT_CAPACITY } from "../core/events.ts";
import {
  createInputCommand,
  INPUT_BUNDLE_BYTES,
  SNAPSHOT_DELTA,
  SNAPSHOT_FRAME_HEADER_BYTES,
  SNAPSHOT_KEYFRAME,
  SNAPSHOT_KEYFRAME_INTERVAL,
  SNAPSHOT_MESSAGE_BYTES,
  type InputCommand,
} from "../core/protocol.ts";
import { writeSnapshotDelta, writeSnapshotKeyframe } from "../core/snapshot.ts";
import { BattleWorld } from "../core/world.ts";

/**
 * The performance evidence deliberately uses a deterministic operation-cost
 * model instead of wall-clock numbers. CI machines and VM JIT state are not a
 * reproducible timing instrument. The model is a stable workload signal: it
 * counts the bounded stores and bytes touched by each real simulation/frame
 * pass. A device benchmark can add wall-clock observations without replacing
 * this source-bound record.
 */
export const PERFORMANCE_HARNESS_SCHEMA_VERSION = 1;
export const PERFORMANCE_HARNESS_CONFIG = Object.freeze({
  players: 32,
  ticks: 600,
  warmupTicks: 60,
  tickRate: TICK_RATE,
  seed: 0x51_4f_50_53,
  matchId: 0x50_45_52_46,
  mapSeed: 0x0bad_cafe,
  snapshotIntervalTicks: 3,
});

/**
 * Project-owned payload budgets. These are optimization targets, not claims
 * about QUIC/IP overhead or historical Quake III byte counts.
 */
export const NETWORK_PAYLOAD_TARGETS = Object.freeze({
  downstreamBytesPerSecondPerClient: 24_000,
  downstreamStretchBytesPerSecondPerClient: 8_000,
  upstreamBytesPerSecondPerClient: 6_000,
  snapshotP95Bytes: 1_100,
  keyframeBytes: 8_000,
  worstCaseDownstreamBytesPerSecondPerClient: 64_000,
});

const SNAPSHOT_REGIONS = Object.freeze([
  { name: "worldHeader", start: 0, bytes: SNAPSHOT_HEADER_BYTES },
  { name: "players", start: SNAPSHOT_HEADER_BYTES, bytes: MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES },
  {
    name: "projectiles",
    start: SNAPSHOT_HEADER_BYTES + MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES,
    bytes: MAX_PROJECTILES * PROJECTILE_SNAPSHOT_BYTES,
  },
  {
    name: "pickups",
    start: SNAPSHOT_HEADER_BYTES + MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES + MAX_PROJECTILES * PROJECTILE_SNAPSHOT_BYTES,
    bytes: MAX_PICKUPS * PICKUP_SNAPSHOT_BYTES,
  },
  {
    name: "cover",
    start:
      SNAPSHOT_HEADER_BYTES +
      MAX_PLAYERS * PLAYER_SNAPSHOT_BYTES +
      MAX_PROJECTILES * PROJECTILE_SNAPSHOT_BYTES +
      MAX_PICKUPS * PICKUP_SNAPSHOT_BYTES,
    bytes: COVER_SNAPSHOT_BYTES,
  },
]);

export interface PerformanceEvidence {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly config: Readonly<typeof PERFORMANCE_HARNESS_CONFIG>;
  readonly timings: Record<string, unknown>;
  readonly snapshotBandwidth: Record<string, unknown>;
  readonly reconciliation: Record<string, unknown>;
  readonly fixedPools: Record<string, unknown>;
  readonly allocationShape: Record<string, unknown>;
}

function percentile(values: Float64Array, quantile: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one sample");
  const sorted = new Float64Array(values);
  sorted.sort();
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index]!;
}

function summarize(values: Float64Array): Record<string, number> {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    maximum: Math.max(...values),
  };
}

function activeCount(values: Uint8Array): number {
  let active = 0;
  for (let index = 0; index < values.length; index += 1) active += values[index]!;
  return active;
}

interface SnapshotByteAttribution {
  frameHeaders: number;
  runHeaders: number;
  worldHeader: number;
  players: number;
  projectiles: number;
  pickups: number;
  cover: number;
}

function createSnapshotByteAttribution(): SnapshotByteAttribution {
  return { frameHeaders: 0, runHeaders: 0, worldHeader: 0, players: 0, projectiles: 0, pickups: 0, cover: 0 };
}

function addRegionBytes(attribution: SnapshotByteAttribution, offset: number, length: number): void {
  const end = offset + length;
  for (const region of SNAPSHOT_REGIONS) {
    const overlap = Math.max(0, Math.min(end, region.start + region.bytes) - Math.max(offset, region.start));
    if (overlap > 0) attribution[region.name as keyof SnapshotByteAttribution] += overlap;
  }
}

function attributeSnapshotFrame(frame: Uint8Array, length: number, attribution: SnapshotByteAttribution): void {
  attribution.frameHeaders += SNAPSHOT_FRAME_HEADER_BYTES;
  const kind = frame[8];
  const runCount = frame[14]! | (frame[15]! << 8);
  if (kind === SNAPSHOT_KEYFRAME && runCount === 0 && length === SNAPSHOT_MESSAGE_BYTES) {
    addRegionBytes(attribution, 0, SNAPSHOT_BYTES);
    return;
  }
  if (kind !== SNAPSHOT_KEYFRAME && kind !== SNAPSHOT_DELTA) throw new Error(`unknown snapshot frame kind ${kind}`);
  let cursor = SNAPSHOT_FRAME_HEADER_BYTES;
  let previousEnd = 0;
  for (let run = 0; run < runCount; run += 1) {
    const headerStart = cursor;
    const packedGap = readFrameVarUint(frame, cursor, length);
    cursor = packedGap & 0xffff;
    const gap = packedGap >>> 16;
    const packedLength = readFrameVarUint(frame, cursor, length);
    cursor = packedLength & 0xffff;
    const runLength = packedLength >>> 16;
    const offset = previousEnd + gap;
    attribution.runHeaders += cursor - headerStart;
    if (cursor + runLength > length) throw new Error("snapshot attribution found a truncated run body");
    addRegionBytes(attribution, offset, runLength);
    cursor += runLength;
    previousEnd = offset + runLength;
  }
  if (cursor !== length) throw new Error("snapshot attribution found trailing bytes");
}

function readFrameVarUint(frame: Uint8Array, offset: number, limit: number): number {
  let value = 0;
  for (let byte = 0; byte < 3; byte += 1) {
    if (offset >= limit) throw new Error("snapshot attribution found a truncated run header");
    const current = frame[offset++]!;
    value |= (current & 0x7f) << (byte * 7);
    if ((current & 0x80) === 0) return ((value << 16) | offset) >>> 0;
  }
  throw new Error("snapshot attribution found an invalid run header");
}

function sumAttribution(attribution: SnapshotByteAttribution): number {
  return Object.values(attribution).reduce((sum, value) => sum + value, 0);
}

function setInput(
  command: InputCommand,
  matchId: number,
  playerId: number,
  tick: number,
  seed: number,
  drift: boolean,
): void {
  const phase = seed & 0x0f;
  command.matchId = matchId;
  command.playerId = playerId;
  command.tick = tick;
  command.sequence = tick & 0xffff;
  command.moveX = ((tick + playerId + phase) % 3) - 1;
  command.moveY = ((tick * 2 + playerId + phase) % 3) - 1;
  command.aimX = playerId % 2 === 0 ? -127 : 127;
  command.aimY = ((tick + playerId + phase) % 5) - 2;
  command.buttons =
    ((tick + playerId + phase) % 7 < 3 ? INPUT_BUTTON_FIRE : 0) |
    ((tick + playerId + phase) % 19 === 0 ? INPUT_BUTTON_BOOST : 0);
  command.weaponRequest = (tick + playerId + phase) % 11 === 0 ? 1 : 0;
  command.fireSubtick = 255;
  command.latestSnapshotTick = 0;
  command.snapshotAckBits = 0;
  if (drift && playerId === 1 && tick % 23 === 0) {
    // The predicted stream intentionally misses a deterministic local input.
    // Snapshot restore must remove this error; it is not a gameplay claim.
    command.moveX = command.moveX === 0 ? 1 : -command.moveX;
  }
}

function setupWorld(matchId: number, mapSeed: number, players: number): BattleWorld {
  const world = new BattleWorld(matchId, mapSeed);
  for (let playerId = 1; playerId <= players; playerId += 1) world.addPlayer(playerId);
  return world;
}

/** Runs the real BattleWorld and snapshot codec with fixed-capacity stores. */
export function runPerformanceHarness(
  config: Readonly<typeof PERFORMANCE_HARNESS_CONFIG> = PERFORMANCE_HARNESS_CONFIG,
): PerformanceEvidence {
  if (config.players !== MAX_PLAYERS) throw new Error("performance fixture must exercise all 32 player slots");
  if (config.warmupTicks >= config.ticks) throw new Error("performance warmup must leave measured ticks");
  const authoritative = setupWorld(config.matchId, config.mapSeed, config.players);
  const predicted = setupWorld(config.matchId, config.mapSeed, config.players);
  const authoritativeInputs: InputCommand[] = [];
  const predictedInputs: InputCommand[] = [];
  for (let player = 1; player <= config.players; player += 1) {
    authoritativeInputs.push(createInputCommand(config.matchId, player));
    predictedInputs.push(createInputCommand(config.matchId, player));
  }

  const rawSnapshot = new Uint8Array(SNAPSHOT_BYTES);
  const baselineSnapshot = new Uint8Array(SNAPSHOT_BYTES);
  const snapshotFrame = new Uint8Array(SNAPSHOT_BYTES + 16);
  const restoredSnapshot = new Uint8Array(SNAPSHOT_BYTES);
  const simulationSamples = new Float64Array(config.ticks - config.warmupTicks);
  const frameSamples = new Float64Array(config.ticks - config.warmupTicks);
  const reconciliationSamples = new Float64Array(Math.ceil(config.ticks / config.snapshotIntervalTicks));
  const snapshotSizeSamples = new Float64Array(Math.ceil(config.ticks / config.snapshotIntervalTicks));
  let simulationSampleCount = 0;
  let frameSampleCount = 0;
  let reconciliationSampleCount = 0;
  let snapshotSizeSampleCount = 0;
  let previousEventSequence = 0;
  let baselineTick = -1;
  let framesSinceKeyframe = SNAPSHOT_KEYFRAME_INTERVAL;
  let keyframes = 0;
  let deltas = 0;
  let snapshotBytes = 0;
  let maximumKeyframeBytes = 0;
  const snapshotByteAttribution = createSnapshotByteAttribution();
  let snapshotBufferFailures = 0;
  let projectileHighWater = 0;
  let eventHighWater = 0;
  let eventDrops = 0;
  let maxReconciliationError = 0;
  let correctedSnapshots = 0;

  for (let tick = 1; tick <= config.ticks; tick += 1) {
    for (let player = 1; player <= config.players; player += 1) {
      const index = player - 1;
      setInput(authoritativeInputs[index]!, config.matchId, player, tick, config.seed, false);
      setInput(predictedInputs[index]!, config.matchId, player, tick, config.seed, true);
      authoritative.submitInput(authoritativeInputs[index]!);
      predicted.submitInput(predictedInputs[index]!);
    }
    authoritative.step();
    predicted.step();

    const projectiles = activeCount(authoritative.projectileActive);
    const events = authoritative.events.sequence - previousEventSequence;
    previousEventSequence = authoritative.events.sequence;
    projectileHighWater = Math.max(projectileHighWater, projectiles);
    // The packaged arena drains presentation events once per frame. Model that
    // consumer cadence instead of treating the ring's lifetime sequence as
    // simultaneous occupancy: only a single tick producing more than the
    // ring capacity overwrites an unread effect.
    eventHighWater = Math.max(eventHighWater, Math.min(events, EVENT_CAPACITY));
    eventDrops += Math.max(0, events - EVENT_CAPACITY);

    // This cost model is intentionally simple and stable. Its factors represent
    // the bounded player/projectile/event loops and are not nanoseconds.
    const simulationWork = 64 + config.players * 18 + projectiles * 11 + events * 7;
    let frameWork = simulationWork;
    if (tick % config.snapshotIntervalTicks === 0) {
      authoritative.writeSnapshot(rawSnapshot);
      let frameBytes: number;
      if (baselineTick < 0 || framesSinceKeyframe >= SNAPSHOT_KEYFRAME_INTERVAL - 1) {
        frameBytes = writeSnapshotKeyframe(snapshotFrame, tick, rawSnapshot);
        keyframes += 1;
        framesSinceKeyframe = 0;
      } else {
        frameBytes = writeSnapshotDelta(snapshotFrame, tick, baselineTick, baselineSnapshot, rawSnapshot);
        if (frameBytes < 0) {
          frameBytes = writeSnapshotKeyframe(snapshotFrame, tick, rawSnapshot);
          keyframes += 1;
          framesSinceKeyframe = 0;
        } else {
          deltas += 1;
          framesSinceKeyframe += 1;
        }
      }
      if (snapshotFrame[8] === SNAPSHOT_KEYFRAME) maximumKeyframeBytes = Math.max(maximumKeyframeBytes, frameBytes);
      if (frameBytes > snapshotFrame.byteLength) snapshotBufferFailures += 1;
      snapshotBytes += frameBytes;
      attributeSnapshotFrame(snapshotFrame, frameBytes, snapshotByteAttribution);
      snapshotSizeSamples[snapshotSizeSampleCount++] = frameBytes;
      baselineSnapshot.set(rawSnapshot);
      baselineTick = tick;
      frameWork += frameBytes * 2;

      let positionError = 0;
      for (let slot = 0; slot < config.players; slot += 1) {
        positionError +=
          Math.abs(authoritative.playerX[slot]! - predicted.playerX[slot]!) +
          Math.abs(authoritative.playerY[slot]! - predicted.playerY[slot]!);
      }
      reconciliationSamples[reconciliationSampleCount++] = positionError;
      maxReconciliationError = Math.max(maxReconciliationError, positionError);
      if (positionError !== 0) correctedSnapshots += 1;
      predicted.restoreSnapshot(rawSnapshot);
      predicted.writeSnapshot(restoredSnapshot);
      for (let byte = 0; byte < rawSnapshot.byteLength; byte += 1) {
        if (restoredSnapshot[byte] !== rawSnapshot[byte]) {
          throw new Error(`snapshot reconciliation failed at tick ${tick}, byte ${byte}`);
        }
      }
    }
    if (tick > config.warmupTicks) {
      simulationSamples[simulationSampleCount++] = simulationWork;
      frameSamples[frameSampleCount++] = frameWork;
    }
  }

  const measuredSimulation = simulationSamples.subarray(0, simulationSampleCount);
  const measuredFrame = frameSamples.subarray(0, frameSampleCount);
  const measuredReconciliation = reconciliationSamples.subarray(0, reconciliationSampleCount);
  const measuredSnapshotSizes = snapshotSizeSamples.subarray(0, snapshotSizeSampleCount);
  const fixedFrameCapacity = snapshotFrame.byteLength;
  if (sumAttribution(snapshotByteAttribution) !== snapshotBytes) {
    throw new Error(
      `snapshot byte attribution mismatch: ${sumAttribution(snapshotByteAttribution)} attributed, ${snapshotBytes} sent`,
    );
  }
  const snapshotBytesPerSecond = Math.round((snapshotBytes * config.tickRate * 100) / config.ticks) / 100;
  const inputBytesPerSecond = INPUT_BUNDLE_BYTES * config.tickRate;
  const aggregateSnapshotBytesPerSecond = snapshotBytesPerSecond * config.players;
  const snapshotFramesPerSecond = config.tickRate / config.snapshotIntervalTicks;
  const worstCaseSnapshotBytesPerSecond = fixedFrameCapacity * snapshotFramesPerSecond;
  const requiredDownstreamReduction = Math.max(
    0,
    1 - NETWORK_PAYLOAD_TARGETS.downstreamBytesPerSecondPerClient / snapshotBytesPerSecond,
  );
  return Object.freeze({
    schemaVersion: PERFORMANCE_HARNESS_SCHEMA_VERSION,
    kind: "war-battles.performance-operability",
    config,
    timings: {
      unit: "deterministic-work-units",
      wallClockObserved: false,
      simulation: summarize(measuredSimulation),
      frame: summarize(measuredFrame),
      evidenceBoundary:
        "Percentiles are source-bound operation-cost signals, not wall-clock milliseconds or VM/JIT timings.",
    },
    snapshotBandwidth: {
      intervalTicks: config.snapshotIntervalTicks,
      frames: snapshotSizeSampleCount,
      keyframes,
      deltas,
      totalBytes: snapshotBytes,
      bytesPerSimulatedSecond: snapshotBytesPerSecond,
      bitsPerSimulatedSecond: snapshotBytesPerSecond * 8,
      aggregateServerPayloadBytesPerSecond: aggregateSnapshotBytesPerSecond,
      aggregateServerPayloadBitsPerSecond: aggregateSnapshotBytesPerSecond * 8,
      inputPayloadBytesPerSecondPerClient: inputBytesPerSecond,
      inputPayloadBitsPerSecondPerClient: inputBytesPerSecond * 8,
      aggregateInputPayloadBytesPerSecond: inputBytesPerSecond * config.players,
      frameBytes: summarize(measuredSnapshotSizes),
      keyframeBytes: maximumKeyframeBytes,
      fixedFrameCapacity,
      worstCaseBound: {
        assumption: "Every scheduled snapshot reaches the fixed frame capacity.",
        framesPerSecond: snapshotFramesPerSecond,
        bytesPerSecondPerClient: worstCaseSnapshotBytesPerSecond,
        bitsPerSecondPerClient: worstCaseSnapshotBytesPerSecond * 8,
        aggregateServerBytesPerSecond: worstCaseSnapshotBytesPerSecond * config.players,
        aggregateServerBitsPerSecond: worstCaseSnapshotBytesPerSecond * config.players * 8,
      },
      byteAttribution: snapshotByteAttribution,
      targets: {
        ...NETWORK_PAYLOAD_TARGETS,
        downstreamTargetSatisfied: snapshotBytesPerSecond <= NETWORK_PAYLOAD_TARGETS.downstreamBytesPerSecondPerClient,
        downstreamStretchTargetSatisfied:
          snapshotBytesPerSecond <= NETWORK_PAYLOAD_TARGETS.downstreamStretchBytesPerSecondPerClient,
        upstreamTargetSatisfied: inputBytesPerSecond <= NETWORK_PAYLOAD_TARGETS.upstreamBytesPerSecondPerClient,
        snapshotP95TargetSatisfied: percentile(measuredSnapshotSizes, 0.95) <= NETWORK_PAYLOAD_TARGETS.snapshotP95Bytes,
        keyframeTargetSatisfied: maximumKeyframeBytes <= NETWORK_PAYLOAD_TARGETS.keyframeBytes,
        worstCaseDownstreamTargetSatisfied:
          worstCaseSnapshotBytesPerSecond <= NETWORK_PAYLOAD_TARGETS.worstCaseDownstreamBytesPerSecondPerClient,
        requiredDownstreamReductionRatio: requiredDownstreamReduction,
      },
      evidenceBoundary:
        "Application payload bytes only. QUIC, HTTP/3, TLS, UDP, IP, Ethernet, retransmission, acknowledgement, and congestion overhead are not observed by this deterministic codec harness.",
    },
    reconciliation: {
      samples: reconciliationSampleCount,
      errorUnit: "sum of absolute fixed-point position units across all players before authoritative restore",
      error: summarize(measuredReconciliation),
      maximumError: maxReconciliationError,
      correctedSnapshots,
      postRestoreError: 0,
    },
    fixedPools: {
      players: { capacity: MAX_PLAYERS, highWater: config.players, failures: 0 },
      projectiles: { capacity: MAX_PROJECTILES, highWater: projectileHighWater, failures: 0 },
      pickups: { capacity: MAX_PICKUPS, highWater: MAX_PICKUPS, failures: 0 },
      presentationEvents: {
        capacity: EVENT_CAPACITY,
        highWater: eventHighWater,
        failures: eventDrops,
        droppedByOverflow: eventDrops,
        overflowPolicy: "drop-oldest",
      },
      snapshotFrame: {
        capacity: fixedFrameCapacity,
        highWater: Math.max(...measuredSnapshotSizes),
        failures: snapshotBufferFailures,
      },
      arena: { observable: false, failures: null, reason: "This pure TypeScript harness enters no native/VM arena." },
    },
    allocationShape: {
      evidence: "unmeasured",
      vmAllocationsMeasured: false,
      warmupTicks: config.warmupTicks,
      simulationHotPath: {
        sourceInspectionImplemented: false,
        explicitHeapAllocationsPerTick: null,
        dynamicContainerGrowthPerTick: null,
        limit: "unmeasured until a transitive AST/source-shape checker covers BattleWorld.step and its callees",
      },
      snapshotBoundary: {
        callerOwnedBuffers: 4,
        transientDataViewsPerSnapshot: 2,
        limit: "fixed snapshot buffers; DataView construction is observable source shape, not a VM allocation count",
      },
      excluded: [
        "Hermes/JS VM allocations",
        "Defold engine allocations",
        "native heap allocations",
        "browser transport queues",
      ],
    },
  });
}
