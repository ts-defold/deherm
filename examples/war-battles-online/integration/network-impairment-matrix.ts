import {
  LOAD_HARNESS_CONFIG,
  runAuthoritativeLoadHarness,
  type LoadHarnessConfig,
} from "./authoritative-load-harness.ts";

export const NETWORK_IMPAIRMENT_MATRIX_SCHEMA_VERSION = 3;

interface NetworkProfile {
  readonly name: string;
  readonly config: Readonly<LoadHarnessConfig>;
  readonly minimumSnapshotsApplied: number;
  readonly maximumSnapshotSkipRatio: number;
}

export const NETWORK_IMPAIRMENT_PROFILES: readonly NetworkProfile[] = Object.freeze([
  Object.freeze({
    name: "broadband-adverse",
    config: Object.freeze({
      ...LOAD_HARNESS_CONFIG,
      seed: 0xb40a_d001,
      baseLatencyMilliseconds: 35,
      jitterMilliseconds: 15,
      datagramLossPercent: 5,
      uplinkBitsPerSecond: 32_000,
      downlinkBitsPerSecond: 128_000,
      minimumInputAcceptanceRatio: 0.95,
    }),
    minimumSnapshotsApplied: 90,
    maximumSnapshotSkipRatio: 0.05,
  }),
  Object.freeze({
    name: "mobile-congested",
    config: Object.freeze({
      ...LOAD_HARNESS_CONFIG,
      seed: 0xc011_5eed,
      downlinkBitsPerSecond: 96_000,
      minimumInputAcceptanceRatio: 0.92,
    }),
    minimumSnapshotsApplied: 80,
    maximumSnapshotSkipRatio: 0.2,
  }),
  Object.freeze({
    name: "edge-congested",
    config: Object.freeze({
      ...LOAD_HARNESS_CONFIG,
      seed: 0xed9e_1280,
      baseLatencyMilliseconds: 70,
      jitterMilliseconds: 35,
      datagramLossPercent: 10,
      uplinkBitsPerSecond: 20_000,
      downlinkBitsPerSecond: 64_000,
      minimumInputAcceptanceRatio: 0.85,
    }),
    minimumSnapshotsApplied: 45,
    maximumSnapshotSkipRatio: 0.5,
  }),
]);

export interface NetworkImpairmentMatrixEvidence {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly profiles: readonly Record<string, unknown>[];
  readonly evidenceBoundary: string;
}

export async function runNetworkImpairmentMatrix(): Promise<NetworkImpairmentMatrixEvidence> {
  const rows: Record<string, unknown>[] = [];
  for (const profile of NETWORK_IMPAIRMENT_PROFILES) {
    const evidence = await runAuthoritativeLoadHarness(profile.config);
    const observed = evidence.transport.observed as Record<string, number>;
    const clients = evidence.clients as {
      readonly rows: readonly {
        readonly snapshotsApplied: number;
        readonly maximumLocalCorrectionMagnitude: number;
        readonly botCommandsStaged: number;
        readonly botNonIdleCommands: number;
      }[];
      readonly maximumRemoteInterpolationDiscontinuity: number;
      readonly everyBotDroveTheProduct: boolean;
      readonly localCorrectionBucketUpperBounds: readonly number[];
      readonly localCorrectionBuckets: readonly number[];
      readonly workloadCorrections: {
        readonly maximumLocalCorrectionMagnitude: number;
        readonly localCorrectionBuckets: readonly number[];
        readonly maximumPredictionErrorMagnitude: number;
        readonly predictionErrorBuckets: readonly number[];
        readonly maximumLocalPresentedStepDistance: number;
        readonly localPresentedStepsOverThirtyTwoPixels: number;
      };
    };
    const server = evidence.server as Record<string, number>;
    const transport = evidence.transport as Record<string, unknown>;
    const workload = transport.workload as {
      readonly durationMilliseconds: number;
      readonly bytes: {
        readonly clientToServerSerialized: number;
        readonly clientToServerDelivered: number;
        readonly serverToClientSerialized: number;
        readonly serverToClientDelivered: number;
      };
    };
    const modeledSeconds = workload.durationMilliseconds / 1_000;
    const uplinkCapacityBytesPerSecond = profile.config.uplinkBitsPerSecond / 8;
    const downlinkCapacityBytesPerSecond = profile.config.downlinkBitsPerSecond / 8;
    const admittedUplinkPayloadBytesPerSecondPerClient =
      workload.bytes.clientToServerSerialized / profile.config.players / modeledSeconds;
    const admittedDownlinkPayloadBytesPerSecondPerClient =
      workload.bytes.serverToClientSerialized / profile.config.players / modeledSeconds;
    const uplinkDemandRatio = admittedUplinkPayloadBytesPerSecondPerClient / uplinkCapacityBytesPerSecond;
    const downlinkDemandRatio = admittedDownlinkPayloadBytesPerSecondPerClient / downlinkCapacityBytesPerSecond;
    const snapshotSkipRatio =
      server.snapshotFramesSkippedByBudget! / (server.snapshotsSent! + server.snapshotFramesSkippedByBudget!);
    const minimumSnapshotsApplied = Math.min(...clients.rows.map((row) => row.snapshotsApplied));
    const correctionSamples = clients.workloadCorrections.localCorrectionBuckets.reduce((sum, count) => sum + count, 0);
    const overEightPixels = clients.workloadCorrections.localCorrectionBuckets
      .slice(5)
      .reduce((sum, count) => sum + count, 0);
    const overThirtyTwoPixels = clients.workloadCorrections.localCorrectionBuckets[7]!;
    const sameTickSamples = clients.workloadCorrections.predictionErrorBuckets.reduce((sum, count) => sum + count, 0);
    const sameTickOverEightPixels = clients.workloadCorrections.predictionErrorBuckets
      .slice(5)
      .reduce((sum, count) => sum + count, 0);
    rows.push(
      Object.freeze({
        name: profile.name,
        config: profile.config,
        transport: Object.freeze({
          modeledDurationMilliseconds: transport.modeledDurationMilliseconds,
          workload,
          capBoundary: transport.capBoundary,
          offeredBytes: observed.offeredBytes,
          serializedBytes: observed.serializedBytes,
          deliveredBytes: observed.deliveredBytes,
          droppedBytes: observed.droppedBytes,
          backpressuredBytes: observed.backpressuredBytes,
          cancelledReliableBytes: observed.cancelledReliableBytes,
          clientToServerSerializedBytes: observed.clientToServerSerializedBytes,
          clientToServerDeliveredBytes: observed.clientToServerDeliveredBytes,
          serverToClientSerializedBytes: observed.serverToClientSerializedBytes,
          serverToClientDeliveredBytes: observed.serverToClientDeliveredBytes,
          droppedDatagrams: observed.droppedDatagrams,
          backpressuredDatagrams: observed.backpressuredDatagrams,
          reorderedDatagrams: observed.reorderedDatagrams,
          reorderedSnapshotStreams: observed.reorderedSnapshotStreams,
          reliableOrderViolations: observed.reliableOrderViolations,
          cancelledReliable: observed.cancelledReliable,
          peakQueue: observed.peakQueue,
          peakQueuedBytes: observed.peakQueuedBytes,
          queueBound: transport.queueBound,
          maximumSerializationDelayMilliseconds: observed.maximumSerializationDelayMilliseconds,
          admittedUplinkPayloadBytesPerSecondPerClient,
          uplinkCapacityBytesPerSecond,
          uplinkDemandRatio,
          uplinkAdmittedDemandSaturation: Math.min(1, uplinkDemandRatio),
          admittedDownlinkPayloadBytesPerSecondPerClient,
          downlinkCapacityBytesPerSecond,
          downlinkDemandRatio,
          downlinkAdmittedDemandSaturation: Math.min(1, downlinkDemandRatio),
        }),
        server: Object.freeze({
          finalTick: server.tick,
          snapshotsSent: server.snapshotsSent,
          snapshotBytesSent: server.snapshotBytesSent,
          snapshotFramesSkippedByBudget: server.snapshotFramesSkippedByBudget,
          snapshotSkipRatio,
          maximumSnapshotSkipRatio: profile.maximumSnapshotSkipRatio,
          inputsAccepted: server.inputsAccepted,
          inputsLate: server.inputsLate,
          inputAcceptanceRatio: server.inputAcceptanceRatio,
          minimumInputAcceptanceRatio: server.minimumInputAcceptanceRatio,
        }),
        clients: Object.freeze({
          minimumSnapshotsApplied,
          minimumSnapshotsAppliedFloor: profile.minimumSnapshotsApplied,
          maximumSnapshotsApplied: Math.max(...clients.rows.map((row) => row.snapshotsApplied)),
          maximumLocalCorrectionMagnitude: clients.workloadCorrections.maximumLocalCorrectionMagnitude,
          maximumLocalPresentedStepDistance: clients.workloadCorrections.maximumLocalPresentedStepDistance,
          localPresentedStepsOverThirtyTwoPixels: clients.workloadCorrections.localPresentedStepsOverThirtyTwoPixels,
          localCorrectionBucketUpperBounds: clients.localCorrectionBucketUpperBounds,
          localCorrectionBuckets: clients.workloadCorrections.localCorrectionBuckets,
          localCorrectionSamples: correctionSamples,
          localCorrectionOverEightPixelRatio: correctionSamples > 0 ? overEightPixels / correctionSamples : 0,
          localCorrectionOverThirtyTwoPixelRatio: correctionSamples > 0 ? overThirtyTwoPixels / correctionSamples : 0,
          maximumPredictionErrorMagnitude: clients.workloadCorrections.maximumPredictionErrorMagnitude,
          predictionErrorBuckets: clients.workloadCorrections.predictionErrorBuckets,
          predictionErrorSamples: sameTickSamples,
          predictionErrorOverEightPixelRatio: sameTickSamples > 0 ? sameTickOverEightPixels / sameTickSamples : 0,
          convergenceProbeCorrectionBuckets: clients.localCorrectionBuckets.map(
            (count, bucket) => count - clients.workloadCorrections.localCorrectionBuckets[bucket]!,
          ),
          maximumRemoteInterpolationDiscontinuity: clients.maximumRemoteInterpolationDiscontinuity,
          everyBotDroveTheProduct: clients.everyBotDroveTheProduct,
          minimumBotCommandsStaged: Math.min(...clients.rows.map((row) => row.botCommandsStaged)),
          minimumBotNonIdleCommands: Math.min(...clients.rows.map((row) => row.botNonIdleCommands)),
        }),
        convergence: evidence.convergence,
        errors: evidence.errors,
      }),
    );
  }
  return Object.freeze({
    schemaVersion: NETWORK_IMPAIRMENT_MATRIX_SCHEMA_VERSION,
    kind: "war-battles.32-player-network-impairment-matrix",
    profiles: Object.freeze(rows),
    evidenceBoundary:
      "The production MatchServer, BattleClient, shared NetworkBotDriver brain, prediction, reconciliation, snapshot and input codecs run for 32 clients through a deterministic per-link application-payload serializer with latency, jitter, loss, reordering, backpressure and speed caps. Session/control/fallback-input streams are ordered, while independent reliable snapshot streams may reorder; the focused harness test forces that case even if these three profiles do not. Correction headlines measure only the active-input workload; forced final convergence has separate buckets. Same-tick prediction-error buckets exclude cross-tick visual deltas and are reported separately from local presentation correction. Demand fields count payload admitted during the exact workload window; serialization may finish or be cancelled after that window, so they are not delivered throughput or observed link utilization. This is not a QUIC packet capture and excludes HTTP/3, TLS, UDP, IP, link-layer and congestion-control overhead.",
  });
}
