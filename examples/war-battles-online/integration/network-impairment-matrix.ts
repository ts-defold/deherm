import {
  LOAD_HARNESS_CONFIG,
  runAuthoritativeLoadHarness,
  type LoadHarnessConfig,
} from "./authoritative-load-harness.ts";

export const NETWORK_IMPAIRMENT_MATRIX_SCHEMA_VERSION = 1;

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
      downlinkBitsPerSecond: 256_000,
      minimumInputAcceptanceRatio: 0.95,
    }),
    minimumSnapshotsApplied: 120,
    maximumSnapshotSkipRatio: 0.05,
  }),
  Object.freeze({
    name: "mobile-congested",
    config: Object.freeze({
      ...LOAD_HARNESS_CONFIG,
      seed: 0xc011_5eed,
      minimumInputAcceptanceRatio: 0.93,
    }),
    minimumSnapshotsApplied: 110,
    maximumSnapshotSkipRatio: 0.15,
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
      downlinkBitsPerSecond: 128_000,
      minimumInputAcceptanceRatio: 0.9,
    }),
    minimumSnapshotsApplied: 75,
    maximumSnapshotSkipRatio: 0.45,
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
    const serializedUplinkBytesPerSecondPerClient =
      workload.bytes.clientToServerSerialized / profile.config.players / modeledSeconds;
    const serializedDownlinkBytesPerSecondPerClient =
      workload.bytes.serverToClientSerialized / profile.config.players / modeledSeconds;
    const snapshotSkipRatio =
      server.snapshotFramesSkippedByBudget! / (server.snapshotsSent! + server.snapshotFramesSkippedByBudget!);
    const minimumSnapshotsApplied = Math.min(...clients.rows.map((row) => row.snapshotsApplied));
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
          cancelledReliable: observed.cancelledReliable,
          peakQueue: observed.peakQueue,
          peakQueuedBytes: observed.peakQueuedBytes,
          queueBound: transport.queueBound,
          maximumSerializationDelayMilliseconds: observed.maximumSerializationDelayMilliseconds,
          serializedUplinkBytesPerSecondPerClient,
          uplinkCapacityBytesPerSecond,
          uplinkCapacityUtilization: serializedUplinkBytesPerSecondPerClient / uplinkCapacityBytesPerSecond,
          serializedDownlinkBytesPerSecondPerClient,
          downlinkCapacityBytesPerSecond,
          downlinkCapacityUtilization: serializedDownlinkBytesPerSecondPerClient / downlinkCapacityBytesPerSecond,
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
          maximumLocalCorrectionMagnitude: Math.max(...clients.rows.map((row) => row.maximumLocalCorrectionMagnitude)),
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
      "The production MatchServer, BattleClient, shared NetworkBotDriver brain, prediction, reconciliation, snapshot and input codecs run for 32 clients through a deterministic per-link application-payload serializer with latency, jitter, loss, reordering, backpressure and speed caps. This is not a QUIC packet capture and excludes HTTP/3, TLS, UDP, IP, link-layer and congestion-control overhead.",
  });
}
