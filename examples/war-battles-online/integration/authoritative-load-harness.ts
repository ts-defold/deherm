import {
  BattleClient,
  MatchServer,
  TICK_MILLISECONDS,
  type BattleClientOptions,
  type GameTransport,
  type ReliableChannel,
  type SendDisposition,
  SESSION_TOKEN_BYTES,
  type SessionTokenClaims,
  type SessionTokenExpectation,
  type SessionTokenProvider,
  type TransportReceiver,
} from "../core/index.ts";

export const LOAD_HARNESS_SCHEMA_VERSION = 1;
/** Conservative floor below the deterministic 98.5% impaired-run baseline. */
export const MINIMUM_INPUT_ACCEPTANCE_RATIO = 0.95;
export const LOAD_HARNESS_CONFIG = Object.freeze({
  players: 32,
  ticks: 600,
  seed: 0x5eed_1234,
  matchId: 0x10ad_0032,
  mapSeed: 0x0bad_cafe,
  baseLatencyMilliseconds: 42,
  jitterMilliseconds: 25,
  datagramLossPercent: 12,
  datagramQueueCapacity: 4,
  reliableQueueCapacity: 8,
  drainMilliseconds: 500,
});

const RELIABLE_CHANNELS: readonly ReliableChannel[] = [1, 2, 3, 4];

/**
 * The load gate proves simulation and transport behavior, not WebCrypto.
 * Keeping token issue completion synchronous and ordered prevents host crypto
 * scheduling from perturbing the seeded network packet sequence between runs.
 */
class DeterministicLoadTokenProvider implements SessionTokenProvider {
  issue(claims: SessionTokenClaims): Promise<Uint8Array> {
    const token = new Uint8Array(SESSION_TOKEN_BYTES);
    const view = new DataView(token.buffer);
    view.setUint32(0, claims.matchId, true);
    view.setUint32(4, claims.slot, true);
    view.setUint32(8, claims.generation, true);
    view.setUint32(12, claims.issuedAtTick, true);
    return Promise.resolve(token);
  }

  verify(_token: Uint8Array, _expected: SessionTokenExpectation): Promise<SessionTokenClaims | null> {
    return Promise.resolve(null);
  }
}

interface PendingPacket {
  readonly id: number;
  readonly linkId: number;
  readonly direction: "client-to-server" | "server-to-client";
  readonly kind: "reliable" | "datagram";
  readonly channel?: ReliableChannel;
  readonly payload: Uint8Array;
  readonly sequence: number;
  readonly due: number;
  readonly receiver: TransportReceiver;
  readonly resolve: (disposition: SendDisposition) => void;
}

/**
 * A deterministic, bounded network seam for the real production transport
 * contract. Reliable channels retain per-channel stream ordering and delivery;
 * datagrams are the only lane exposed to loss, reordering and backpressure.
 */
class ImpairedNetwork {
  readonly config: Readonly<typeof LOAD_HARNESS_CONFIG>;
  readonly queue: PendingPacket[] = [];
  readonly stats = {
    sentReliable: 0,
    deliveredReliable: 0,
    backpressuredReliable: 0,
    sentDatagrams: 0,
    deliveredDatagrams: 0,
    droppedDatagrams: 0,
    backpressuredDatagrams: 0,
    reorderedDatagrams: 0,
    peakQueue: 0,
    reliableOrderViolations: 0,
  };

  private now = 0;
  private nextPacketId = 1;
  private nextSequence = new Map<string, number>();
  private reliableTail = new Map<string, number>();
  private lastReliableDelivered = new Map<string, number>();
  private lastDatagramDelivered = new Map<string, number>();
  private randomState: number;

  constructor(config: Readonly<typeof LOAD_HARNESS_CONFIG>) {
    this.config = config;
    this.randomState = config.seed >>> 0;
  }

  time(): number {
    return this.now;
  }

  advanceTo(target: number): void {
    if (!Number.isFinite(target) || target < this.now) throw new RangeError("network time must move forward");
    while (true) {
      let selected = -1;
      let selectedDue = Infinity;
      let selectedId = Infinity;
      for (let index = 0; index < this.queue.length; index += 1) {
        const packet = this.queue[index]!;
        if (packet.due > target) continue;
        if (packet.due < selectedDue || (packet.due === selectedDue && packet.id < selectedId)) {
          selected = index;
          selectedDue = packet.due;
          selectedId = packet.id;
        }
      }
      if (selected < 0) break;
      const [packet] = this.queue.splice(selected, 1);
      this.now = packet!.due;
      if (packet!.kind === "reliable") {
        this.stats.deliveredReliable += 1;
        const key = `${packet!.linkId}:${packet!.direction}:${packet!.channel}`;
        const previous = this.lastReliableDelivered.get(key);
        if (previous !== undefined && packet!.sequence <= previous) this.stats.reliableOrderViolations += 1;
        this.lastReliableDelivered.set(key, packet!.sequence);
        packet!.receiver!.onReliable(packet!.channel!, packet!.payload);
      } else {
        this.stats.deliveredDatagrams += 1;
        const key = `${packet!.linkId}:${packet!.direction}`;
        const previous = this.lastDatagramDelivered.get(key);
        if (previous !== undefined && packet!.sequence < previous) this.stats.reorderedDatagrams += 1;
        this.lastDatagramDelivered.set(key, Math.max(previous ?? -1, packet!.sequence));
        packet!.receiver!.onDatagram(packet!.payload);
      }
      packet!.resolve("sent");
    }
    this.now = target;
  }

  enqueue(
    linkId: number,
    direction: "client-to-server" | "server-to-client",
    receiver: TransportReceiver,
    kind: "reliable" | "datagram",
    payload: Uint8Array,
    channel?: ReliableChannel,
  ): Promise<SendDisposition> {
    const sequenceKey = `${linkId}:${direction}:${kind}:${channel ?? 0}`;
    const sequence = this.nextSequence.get(sequenceKey) ?? 0;
    this.nextSequence.set(sequenceKey, sequence + 1);
    if (kind === "datagram") {
      this.stats.sentDatagrams += 1;
      const pending = this.queue.filter(
        (packet) => packet.linkId === linkId && packet.direction === direction && packet.kind === kind,
      ).length;
      if (pending >= this.config.datagramQueueCapacity) {
        this.stats.backpressuredDatagrams += 1;
        return Promise.resolve("backpressured");
      }
      if (this.nextRandom() < this.config.datagramLossPercent) {
        this.stats.droppedDatagrams += 1;
        return Promise.resolve("sent");
      }
    } else {
      this.stats.sentReliable += 1;
      const pending = this.queue.filter(
        (packet) =>
          packet.linkId === linkId &&
          packet.direction === direction &&
          packet.kind === kind &&
          packet.channel === channel,
      ).length;
      if (pending >= this.config.reliableQueueCapacity) {
        this.stats.backpressuredReliable += 1;
        return Promise.resolve("backpressured");
      }
    }
    const jitter = this.nextInteger(-this.config.jitterMilliseconds, this.config.jitterMilliseconds);
    const proposed = this.now + this.config.baseLatencyMilliseconds + jitter;
    const orderedKey = `${linkId}:${direction}:${channel ?? 0}`;
    const due =
      kind === "reliable"
        ? Math.max(proposed, (this.reliableTail.get(orderedKey) ?? this.now) + 0.001)
        : Math.max(this.now + 1, proposed);
    if (kind === "reliable") this.reliableTail.set(orderedKey, due);
    return new Promise<SendDisposition>((resolve) => {
      const packet: PendingPacket = {
        id: this.nextPacketId++,
        linkId,
        direction,
        kind,
        channel,
        payload: payload.slice(),
        sequence,
        due,
        resolve,
        receiver,
      };
      this.queue.push(packet);
      if (this.queue.length > this.stats.peakQueue) this.stats.peakQueue = this.queue.length;
    });
  }

  private nextRandom(): number {
    let value = this.randomState >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState % 100;
  }

  private nextInteger(minimum: number, maximum: number): number {
    return minimum + (this.nextRandom() % (maximum - minimum + 1));
  }
}

class ImpairedTransport implements GameTransport {
  readonly capabilities = Object.freeze({
    protocol: "in-memory" as const,
    reliableStreams: true,
    datagrams: true,
    maxDatagramBytes: 1_200,
  });
  private closed = false;
  private readonly network: ImpairedNetwork;
  private readonly linkId: number;
  private readonly direction: "client-to-server" | "server-to-client";
  private readonly receiver: TransportReceiver;

  constructor(
    network: ImpairedNetwork,
    linkId: number,
    direction: "client-to-server" | "server-to-client",
    receiver: TransportReceiver,
  ) {
    this.network = network;
    this.linkId = linkId;
    this.direction = direction;
    this.receiver = receiver;
  }

  sendReliable(channel: ReliableChannel, payload: Uint8Array, _signal?: AbortSignal): Promise<SendDisposition> {
    if (this.closed) return Promise.resolve("closed");
    return this.network.enqueue(this.linkId, this.direction, this.receiver, "reliable", payload, channel);
  }

  trySendDatagram(payload: Uint8Array): Promise<SendDisposition> {
    if (this.closed) return Promise.resolve("closed");
    return this.network.enqueue(this.linkId, this.direction, this.receiver, "datagram", payload);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.receiver.onClose(code, reason);
  }
}

/**
 * Admission uses the host WebCrypto provider and is intentionally asynchronous
 * at the session boundary. Keep the deterministic simulation clock paused until
 * every initial handshake has reached its ready/closed terminal state. A timer
 * turn is required here because Deno's WebCrypto completion is not guaranteed
 * to run in the same microtask turn as Node's provider; this is harness
 * synchronization only and does not alter production admission semantics.
 */
async function settleInitialAdmissions(
  sessions: readonly { readonly ready: boolean; readonly closed: boolean }[],
  pumpReliableHandshake: () => void,
): Promise<void> {
  const maximumTurns = 256;
  for (let turn = 0; turn < maximumTurns; turn += 1) {
    if (sessions.every((session) => session.ready || session.closed)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    pumpReliableHandshake();
    await Promise.resolve();
  }
  const pending = sessions.reduce((count, session) => count + (session.ready || session.closed ? 0 : 1), 0);
  throw new Error(
    `initial session admission did not settle (${pending} pending after ${maximumTurns} event-loop turns)`,
  );
}

export interface LoadHarnessEvidence {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly config: Readonly<typeof LOAD_HARNESS_CONFIG>;
  readonly transport: Record<string, unknown>;
  readonly server: Record<string, unknown>;
  readonly clients: Record<string, unknown>;
  readonly convergence: Record<string, unknown>;
  readonly errors: Record<string, unknown>;
}

/**
 * Optional observation seam for runtime measurements. The default load gate
 * does not pass an observer, so its evidence remains deterministic. A runtime
 * owner may supply a monotonic clock to observe the real authoritative step
 * without teaching the production server about a benchmark or changing the
 * deterministic workload record.
 */
export interface AuthoritativeLoadObserver {
  readonly now: () => number;
  readonly onAuthoritativeStep?: (sample: { readonly tick: number; readonly durationMilliseconds: number }) => void;
}

export async function runAuthoritativeLoadHarness(
  config: Readonly<typeof LOAD_HARNESS_CONFIG> = LOAD_HARNESS_CONFIG,
  observer?: AuthoritativeLoadObserver,
): Promise<LoadHarnessEvidence> {
  const serverErrors: string[] = [];
  const serverLogs: string[] = [];
  const network = new ImpairedNetwork(config);
  const server = new MatchServer({
    matchId: config.matchId,
    mapSeed: config.mapSeed,
    rosterSize: config.players,
    resumeTokenService: new DeterministicLoadTokenProvider(),
    nowMilliseconds: () => network.time(),
    onError: (error) => serverErrors.push(String(error instanceof Error ? error.message : error)),
    onLog: (line) => serverLogs.push(line),
  });
  const clients: BattleClient[] = [];
  const clientErrors: string[][] = [];
  const clientLogs: string[][] = [];
  const sessions = [];
  for (let index = 0; index < config.players; index += 1) {
    const errors: string[] = [];
    const logs: string[] = [];
    const options: BattleClientOptions = {
      name: `load-${index + 1}`,
      leadTicks: 2,
      onError: (error) => errors.push(String(error instanceof Error ? error.message : error)),
      onLog: (line) => logs.push(line),
    };
    const client = new BattleClient(options);
    const session = server.createSession();
    const clientTransport = new ImpairedTransport(network, index + 1, "client-to-server", session);
    const serverTransport = new ImpairedTransport(network, index + 1, "server-to-client", client);
    session.attach(serverTransport);
    client.attach(clientTransport);
    clients.push(client);
    sessions.push(session);
    clientErrors.push(errors);
    clientLogs.push(logs);
  }

  // Complete the session lane before the first authoritative tick. The
  // production server may queue a snapshot as soon as a hello is accepted;
  // keeping the welcome boundary ahead of that first frame is the same
  // handshake sequencing required by a real reliable transport.
  let simulationTime = config.baseLatencyMilliseconds * 4 + config.jitterMilliseconds * 2;
  network.advanceTo(simulationTime);
  await settleInitialAdmissions(sessions, () => {
    // Protocol-v9 admission is a reliable hello/welcome/ack exchange. Pump one
    // worst-case reliable latency per host-crypto turn while the simulation
    // clock remains paused; completion still requires the server-side ack.
    simulationTime += config.baseLatencyMilliseconds + config.jitterMilliseconds + 1;
    network.advanceTo(simulationTime);
  });
  await Promise.resolve();
  for (const client of clients) client.update(0);
  await Promise.resolve();
  for (let tick = 1; tick <= config.ticks; tick += 1) {
    network.advanceTo(simulationTime);
    await Promise.resolve();
    for (let index = 0; index < clients.length; index += 1) {
      const player = index + 1;
      clients[index]!.setControls({
        moveX: ((tick + player) % 3) - 1,
        moveY: ((tick * 2 + player) % 3) - 1,
        fire: (tick + player) % 7 < 3,
        boost: (tick + player) % 19 === 0,
        weapon: (tick + player) % 4 === 0 ? 1 : 0,
      });
      clients[index]!.setAim((player % 2 === 0 ? -1 : 1) * 256, ((tick + player) % 5) - 2);
    }
    const stepStarted = observer === undefined ? undefined : observer.now();
    server.step();
    if (stepStarted !== undefined && observer !== undefined) {
      const durationMilliseconds = observer.now() - stepStarted;
      if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) {
        throw new Error(`authoritative observer clock moved backwards at tick ${server.world.tick}`);
      }
      observer.onAuthoritativeStep?.({ tick: server.world.tick, durationMilliseconds });
    }
    for (const client of clients) client.update(TICK_MILLISECONDS);
    await Promise.resolve();
    simulationTime += TICK_MILLISECONDS;
  }

  // Prediction intentionally leaves each client at its adaptive lead. Stop
  // producing commands, advance the server through the furthest predicted
  // tick, then finish the current snapshot cadence. This drains any configured
  // or learned lead without assuming the old fixed value of two.
  const predictedTargetTick = Math.max(...clients.map((client) => client.world?.tick ?? server.world.tick));
  while (server.world.tick < predictedTargetTick || server.world.tick % server.snapshotIntervalTicks !== 0) {
    server.step();
    simulationTime += TICK_MILLISECONDS;
    network.advanceTo(simulationTime);
    await Promise.resolve();
  }

  // Reliable frames are allowed to settle, including the final pending
  // snapshot for each session. update(0) applies the latest decoded frame
  // without creating another predicted command.
  for (let step = 0; step <= config.drainMilliseconds; step += 1) {
    network.advanceTo(simulationTime + step);
    await Promise.resolve();
    for (const client of clients) client.update(0);
    await Promise.resolve();
    if (network.queue.length === 0) break;
  }
  network.advanceTo(simulationTime + config.drainMilliseconds + 1);
  await Promise.resolve();
  for (const client of clients) client.update(0);
  await Promise.resolve();

  const authoritativeHash = server.world.stateHash();
  const clientRows = clients.map((client, index) => {
    const converged =
      client.state === "ready" &&
      client.world?.stateHash() === authoritativeHash &&
      client.world.tick === server.world.tick;
    return {
      index: index + 1,
      state: client.state,
      playerId: client.playerId,
      worldTick: client.world?.tick ?? -1,
      snapshotsApplied: client.stats.snapshotsApplied,
      snapshotsIgnored: client.stats.snapshotsIgnored,
      inputsSent: client.stats.inputsSent,
      inputsDropped: client.stats.inputsDropped,
      inputCommandsSent: client.stats.inputCommandsSent,
      inputLeadTicks: client.stats.inputLeadTicks,
      inputLeadIncreases: client.stats.inputLeadIncreases,
      inputLeadDecreases: client.stats.inputLeadDecreases,
      inputLeadCatchdownSkips: client.stats.inputLeadCatchdownSkips,
      maximumLocalCorrectionMagnitude: client.stats.maximumLocalCorrectionMagnitude,
      remoteInterpolationRebases: client.stats.remoteInterpolationRebases,
      maximumRemoteInterpolationRebaseDistance: client.stats.maximumRemoteInterpolationRebaseDistance,
      maximumRemoteInterpolationDiscontinuity: client.stats.maximumRemoteInterpolationDiscontinuity,
      remoteLifecycleHardSnaps: client.stats.remoteLifecycleHardSnaps,
      rateLimitAdvisories: client.stats.rateLimitAdvisories,
      replayedTicks: client.stats.replayedTicks,
      converged,
      errors: clientErrors[index]!.length,
    };
  });
  const allConverged = clientRows.every((client) => client.converged);
  const uniquePlayerIds = new Set(clientRows.map((client) => client.playerId));
  const reliableOrderPreserved = network.stats.reliableOrderViolations === 0;
  const reliableDeliveryComplete =
    network.stats.backpressuredReliable === 0 && network.stats.sentReliable === network.stats.deliveredReliable;
  const noErrors = serverErrors.length === 0 && clientErrors.every((errors) => errors.length === 0);
  // Capacity is enforced independently for both directions of every link and,
  // for reliable traffic, independently per channel. This is the structural
  // maximum the network seam can retain, not a bound inferred from this run's
  // lower observed high-water mark.
  const queueBound =
    config.players * 2 * (config.datagramQueueCapacity + config.reliableQueueCapacity * RELIABLE_CHANNELS.length);
  const boundedQueues = network.stats.peakQueue <= queueBound;
  const everyClientAttemptedEveryTick = clientRows.every(
    (client) =>
      client.inputsSent + client.inputsDropped ===
      config.ticks + client.inputLeadIncreases - client.inputLeadCatchdownSkips,
  );
  const generatedInputCommands = clientRows.reduce(
    (total, client) => total + config.ticks + client.inputLeadIncreases - client.inputLeadCatchdownSkips,
    0,
  );
  const inputAcceptanceRatio = server.stats.inputsAccepted / generatedInputCommands;
  const inputLateRatio = server.stats.inputsLate / generatedInputCommands;
  const inputCommandsUnobserved = generatedInputCommands - server.stats.inputsAccepted - server.stats.inputsLate;
  if (
    !allConverged ||
    uniquePlayerIds.size !== config.players ||
    !reliableOrderPreserved ||
    !reliableDeliveryComplete ||
    !everyClientAttemptedEveryTick ||
    inputAcceptanceRatio < MINIMUM_INPUT_ACCEPTANCE_RATIO ||
    !noErrors ||
    !boundedQueues ||
    network.queue.length !== 0
  ) {
    throw new Error(
      `authoritative load harness failed: ${JSON.stringify({ allConverged, uniquePlayerIds: uniquePlayerIds.size, reliableOrderPreserved, reliableDeliveryComplete, everyClientAttemptedEveryTick, inputAcceptanceRatio, minimumInputAcceptanceRatio: MINIMUM_INPUT_ACCEPTANCE_RATIO, noErrors, pending: network.queue.length, serverTick: server.world.tick, serverErrors, clientErrors, rows: clientRows.filter((client) => !client.converged) })}`,
    );
  }
  return Object.freeze({
    schemaVersion: LOAD_HARNESS_SCHEMA_VERSION,
    kind: "war-battles.authoritative-32-player-load",
    config,
    transport: {
      protocol: "in-memory-impairment",
      reliableStreams: true,
      datagrams: true,
      orderedReliableChannels: RELIABLE_CHANNELS,
      latencyMilliseconds: config.baseLatencyMilliseconds,
      jitterMilliseconds: config.jitterMilliseconds,
      datagramLossPercent: config.datagramLossPercent,
      observed: { ...network.stats },
      pendingQueue: network.queue.length,
      queueCapacity: config.datagramQueueCapacity,
      reliableQueueCapacity: config.reliableQueueCapacity,
      queueBound,
    },
    server: {
      tick: server.world.tick,
      rosterSize: server.rosterSize,
      humans: server.stats.humans,
      bots: server.stats.bots,
      snapshotsSent: server.stats.snapshotsSent,
      inputsAccepted: server.stats.inputsAccepted,
      inputsRejected: server.stats.inputsRejected,
      inputsLate: server.stats.inputsLate,
      generatedInputCommands,
      inputAcceptanceRatio,
      inputLateRatio,
      inputCommandsUnobserved,
      minimumInputAcceptanceRatio: MINIMUM_INPUT_ACCEPTANCE_RATIO,
      logs: serverLogs.length,
      sessionsReady: sessions.filter((session) => session.ready).length,
    },
    clients: {
      count: clients.length,
      ready: clientRows.filter((client) => client.state === "ready").length,
      rows: clientRows,
      attemptedInputsPerClient: config.ticks,
      minInputsSent: Math.min(...clientRows.map((client) => client.inputsSent)),
      maxInputsSent: Math.max(...clientRows.map((client) => client.inputsSent)),
      maxInputsDropped: Math.max(...clientRows.map((client) => client.inputsDropped)),
      minInputLeadTicks: Math.min(...clientRows.map((client) => client.inputLeadTicks)),
      maxInputLeadTicks: Math.max(...clientRows.map((client) => client.inputLeadTicks)),
      totalInputLeadDecreases: clientRows.reduce((total, client) => total + client.inputLeadDecreases, 0),
      maximumLocalCorrectionMagnitude: Math.max(...clientRows.map((client) => client.maximumLocalCorrectionMagnitude)),
      totalRemoteInterpolationRebases: clientRows.reduce(
        (total, client) => total + client.remoteInterpolationRebases,
        0,
      ),
      maximumRemoteInterpolationRebaseDistance: Math.max(
        ...clientRows.map((client) => client.maximumRemoteInterpolationRebaseDistance),
      ),
      maximumRemoteInterpolationDiscontinuity: Math.max(
        ...clientRows.map((client) => client.maximumRemoteInterpolationDiscontinuity),
      ),
      totalRemoteLifecycleHardSnaps: clientRows.reduce((total, client) => total + client.remoteLifecycleHardSnaps, 0),
      maxSnapshotsIgnored: Math.max(...clientRows.map((client) => client.snapshotsIgnored)),
    },
    convergence: {
      authoritativeHash,
      allClientsConverged: allConverged,
      uniquePlayerIds: uniquePlayerIds.size,
      finalTick: server.world.tick,
    },
    errors: {
      uncaught: 0,
      server: serverErrors,
      clients: clientErrors.flat(),
      protocolErrors: serverErrors.length + clientErrors.reduce((count, errors) => count + errors.length, 0),
    },
  });
}
