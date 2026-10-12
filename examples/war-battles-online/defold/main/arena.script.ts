import {
  defold,
  defineComponent,
  factory,
  go,
  hashLiteral,
  msg,
  property,
  sound,
  sys,
  tilemap,
  vmath,
  WebTransport,
  type DefoldHash,
} from "@deherm/project";

import {
  BattleClient,
  BrowserWebSocketClient,
  WebTransportGameClient,
  DEFAULT_ARENA_SEED,
  INITIAL_ONLINE_INPUT_LEAD_TICKS,
  EVENT_EXPLOSION,
  EVENT_FIRE,
  EVENT_COVER_CHANGED,
  EVENT_HAZARD_DAMAGE,
  EVENT_HIT,
  EVENT_KILL,
  EVENT_PICKUP_TAKEN,
  INFANTRY_FIRE_COOLDOWN_TICKS,
  INFANTRY_HEALTH,
  REJECT_FULL,
  CELL_CRATE,
  CELL_SANDBAG,
  MAX_PICKUPS,
  MAX_PROJECTILES,
  MAX_COVER_PANELS,
  MAP_WIDTH,
  PLAYER_MODE_INFANTRY,
  PLAYER_MODE_DEAD,
  RESPAWN_TICKS,
  isometricDepth,
  isometricSortZ,
  hexReliefLiftAtSimulation,
  deriveWorldPlanPropAnchors,
  deriveTankDepotPresentationSites,
  projectWorldPlanPropCoverage,
  cellCentreX,
  cellCentreY,
  cellOfX,
  cellOfY,
  WEAPON_MORTAR,
  createBattleEvent,
  type BattleEvent,
  type GameTransport,
  type TransportReceiver,
} from "../src/generated-war-battles/index";
import {
  ARENA_GROUND_ROLE_BORDER_BASE,
  ARENA_GROUND_ROLE_WALL_BASE,
  ARENA_VISUAL_CELL_COUNT,
  arenaThemeIndex,
  projectArenaVisualRoles,
  visibleTankDepotMarkerSite,
} from "../src/generated-war-battles/arena-visual";
import { ArenaMap } from "../src/generated-war-battles/arena";
import {
  ARENA_ART_THEMES,
  arenaDecorTileId,
  arenaGroundTileId,
  arenaMarkTileId,
  arenaWallFaceTileId,
} from "../src/generated-arena-art";
import {
  MAX_VISIBLE_PROJECTILES,
  projectedDirectionRadians,
  projectedX,
  projectedY,
  startArena,
  type ArenaMatch,
} from "../src/arena-match";
import { REMOTE_CUE_EJECT, REMOTE_CUE_REARM } from "../src/generated-war-battles/remote-lifecycle";

interface WarBattlesRuntimeConfig {
  /** Browser-only development override; game.project remains authoritative. */
  server?: string;
  /** Optional WebSocket URL for the reliable TCP fallback (defaults to port 8080/ws). */
  serverWebSocket?: string;
  /** Hex SHA-256 for a short-lived self-signed WebTransport certificate. */
  serverCertificateSha256?: string;
  /** Browser-only visual QA mode: arrange every generated landmark around the local camera. */
  artGallery?: boolean;
  /** Browser-only visual QA: show a selected chassis without changing the playable unlock economy. */
  artGalleryChassis?: number;
  /** Browser-only frozen pose fixture; indices use the generated eight-view direction order. */
  artGalleryHullDirection?: number;
  artGalleryTurretDirection?: number;
  /** Browser-only infantry atlas fixture; the match remains frozen. */
  artGalleryHeroDirection?: number;
  artGalleryHeroMoving?: boolean;
  artGalleryHeroFiring?: boolean;
  artGalleryHeroHit?: boolean;
  artGalleryHeroDead?: boolean;
}

interface WarBattlesRuntimeTelemetry {
  mode: "offline" | "online";
  state: string;
  /** The protocol selected by the arena's ordered online dial. */
  transport: "webtransport-h3-quic" | "websocket-tcp" | null;
  /** Concrete adapter behind the selected wire protocol. */
  transportBackend: "browser" | "native" | null;
  /** The lane used for tick inputs by the selected transport. */
  inputLane: "datagram" | "reliable-fallback" | null;
  playerId: number;
  rosterSize: number;
  snapshotsApplied: number;
  inputsSent: number;
  inputsDropped: number;
  lastServerTick: number;
  localTick: number;
  onlineReportedElapsedMilliseconds: number;
  onlineWallElapsedMilliseconds: number;
  onlineMaximumWallDeltaMilliseconds: number;
  /** Adaptive prediction lead currently used by this client, in 60 Hz ticks. */
  inputLeadTicks: number;
  /** Authoritative late-input feedback, independent of snapshot delivery age. */
  inputFeedbackLeadTicks: number;
  authoritativeInputsAccepted: number;
  authoritativeInputsLate: number;
  /** Measured session-channel round trip; zero until the first pong. */
  roundTripMilliseconds: number;
  pongsReceived: number;
  /** Largest same-lifecycle local reconciliation in fixed world units (16 per pixel). */
  maximumLocalCorrectionMagnitude: number;
  /** Same-lifecycle local reconciliations larger than 32 world pixels. */
  correctionsOverThirtyTwoPixels: number;
  lastLargeCorrectionMagnitude: number;
  lastLargeCorrectionPredictionErrorMagnitude: number;
  lastLargeCorrectionPredictionComparable: boolean;
  lastLargeCorrectionSnapshotTick: number;
  lastLargeCorrectionLocalTick: number;
  lastLargeCorrectionPredictedX: number;
  lastLargeCorrectionPredictedY: number;
  lastLargeCorrectionPresentedX: number;
  lastLargeCorrectionPresentedY: number;
  lastLargeCorrectionCorrectedX: number;
  lastLargeCorrectionCorrectedY: number;
  lastLargeCorrectionGeneration: number;
  lastLargeCorrectionMode: number;
  /** Remote rebase count and largest old-target-to-presented gap, in fixed world units. */
  remoteInterpolationRebases: number;
  maximumRemoteInterpolationRebaseDistance: number;
  /** Generation/mode changes hard-snap by design; keep them separate from smooth rebases. */
  remoteLifecycleHardSnaps: number;
  /** Snapshot-derived remote transition effects actually created in Defold. */
  remoteEjectEffects: number;
  remoteRearmEffects: number;
  /** Largest same-life displacement between two actually rendered remote poses. */
  maximumRemotePresentedStepDistance: number;
  remotePresentedStepsOverThirtyTwoPixels: number;
  maximumLocalPresentedStepDistance: number;
  localPresentedStepsOverThirtyTwoPixels: number;
  /** Current predicted local pose, in fixed world units (16 per pixel). */
  localWorldX: number;
  localWorldY: number;
  /** Changes on respawn; motion probes must not label a new life as a teleport. */
  localGeneration: number;
  localMode: number;
  /** Remaining cooldown proves a sampled local fire input actually reached the simulation. */
  localCooldownTicks: number;
}

interface WarBattlesBrowserGlobals {
  __warBattlesConfigV1?: WarBattlesRuntimeConfig;
  __warBattlesTelemetryV1?: WarBattlesRuntimeTelemetry;
}

/**
 * The arena director.
 *
 * It is the only component that advances the match. Everything else - hulls,
 * turrets, projectiles, pickups, the HUD - reads the world it steps. It also
 * owns every factory in the scene, so object creation happens through one
 * component's own relative URLs rather than through addresses assembled
 * elsewhere.
 *
 * The scene starts in the tutorial's scripted demonstration, which is what the
 * packaged runtime gates observe. `engage` switches it into the arena: either
 * the player pressed something, or the demonstration finished on its own.
 */

const ENGAGE = hashLiteral("#engage");
const RESTART = hashLiteral("#restart");
const RETRY_ONLINE = hashLiteral("#retry_online");
const REMOTE_LIFECYCLE_CUE = hashLiteral("#remote_lifecycle_cue");
const CAMERA = "/camera#follow";
const CAMERA_IMPACT = "camera_impact";
const ARENA_TILEMAP = "/level#tilemap";
const ARENA_FACE_TILEMAP = "/level#faces";
const ARENA_DECOR_LAYER = "decor";
const ARENA_WALL_LAYER = "walls";
const ARENA_FACE_LAYER = "faces";
const ARENA_MARKS_LAYER = "marks";

const SFX_FIRE = "#sfx_fire";
const SFX_HIT = "#sfx_hit";
const SFX_EXPLOSION = "#sfx_explosion";
const SFX_PICKUP = "#sfx_pickup";
const SFX_ROUND = "#sfx_round";

const SFX_FIRE_BIT = 1 << 0;
const SFX_HIT_BIT = 1 << 1;
const SFX_EXPLOSION_BIT = 1 << 2;
const SFX_PICKUP_BIT = 1 << 3;
const SFX_ROUND_BIT = 1 << 4;

const EXPLOSION_TICKS = 34;
const SPARK_TICKS = 14;
const MUZZLE_TICKS = 10;
const MAX_EFFECTS = 24;
const CAMERA_IMPACT_HIT = 3;
const CAMERA_IMPACT_EXPLOSION = 8;
const CAMERA_IMPACT_KILL = 12;

interface CameraImpactMessage {
  [key: string]: unknown;
  [key: symbol]: unknown;
  x: number;
  y: number;
  strength: number;
}

interface RemoteLifecycleCueMessage {
  x: number;
  y: number;
  cue: number;
}

interface ArenaSelf {
  /** Editor property: tanks in the match, local player included. */
  players: number;
  /** Editor property: bot difficulty row, 0 recruit to 3 nightmare. */
  botSkill: number;
  /** Editor property: arena layout seed. Zero keeps the built-in arena. */
  mapSeed: number;
  /** Editor property: seconds after which the arena starts on its own. */
  autoEngageSeconds: number;

  match: ArenaMatch;
  engaged: boolean;
  elapsed: number;
  event: BattleEvent;
  eventCursor: number;
  spawnedProjectile: Uint16Array;
  spawnedPickup: Uint8Array;
  /** Fixed-width, foot-sorted cover sprites; no engine calls on steady frames. */
  coverIds?: Array<DefoldHash | undefined>;
  coverMapSeed?: number;
  /** Seed/theme currently projected into Defold's three tilemap layers. */
  visualMapSeed?: number;
  visualTheme?: number;
  visualGroundRoles?: Uint16Array;
  visualDecorRoles?: Uint8Array;
  visualMarkRoles?: Uint8Array;
  visualPropCoverage?: Uint8Array;
  visualGroundScratch?: Uint16Array;
  visualDecorScratch?: Uint8Array;
  visualMarkScratch?: Uint8Array;
  visualPropScratch?: Uint8Array;
  /** Presentation-only world landmarks keyed to the authoritative map seed. */
  depotIds: DefoldHash[];
  depotMapSeed?: number;
  /** Persistent pickup pads plus one contextual on-foot depot guide. */
  markerIds?: DefoldHash[];
  markerMapSeed?: number;
  depotMarkerId?: DefoldHash;
  depotMarkerSite?: number;
  landmarkIds: DefoldHash[];
  landmarkMapSeed?: number;
  visibleProjectiles: number;
  effectIds: DefoldHash[];
  effectTicks: number[];
  /** One reusable message; drainEvents sends at most one impact per update. */
  impact: CameraImpactMessage;
  online: boolean;
  /** Invalidates any still-pending browser dials when the scene detaches. */
  onlineAttempts?: OnlineConnectionAttempts;
  sfxMask: number;
  /** Mutated in place so live observability adds no per-frame object churn. */
  telemetry: WarBattlesRuntimeTelemetry;
}

function browserGlobals(): WarBattlesBrowserGlobals {
  return globalThis as unknown as WarBattlesBrowserGlobals;
}

function artGalleryEnabled(): boolean {
  return browserGlobals().__warBattlesConfigV1?.artGallery === true;
}

const GALLERY_SCREEN_DIRECTIONS = [
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

function galleryWorldDirection(index: number): readonly [number, number] {
  const screen = GALLERY_SCREEN_DIRECTIONS[index];
  if (screen === undefined || !Number.isInteger(index)) throw new RangeError("art gallery direction must be 0..7");
  // This inverse projection is presentation-only and the gallery is frozen.
  // Scaling both components equally keeps every direction in its authored
  // sector without changing the authoritative world transform.
  return [(screen[0] + screen[1]) * 128, (screen[1] - screen[0]) * 128];
}

function syncGalleryHeroPose(self: ArenaSelf): void {
  if (!artGalleryEnabled()) return;
  const config = browserGlobals().__warBattlesConfigV1;
  if (config?.artGalleryHeroDirection === undefined) {
    if (config?.artGalleryHeroMoving !== undefined) throw new RangeError("hero walk fixture requires a direction");
    return;
  }
  if (config.artGalleryHeroMoving !== undefined && typeof config.artGalleryHeroMoving !== "boolean") {
    throw new TypeError("art gallery hero moving flag must be boolean");
  }
  if (config.artGalleryHeroFiring !== undefined && typeof config.artGalleryHeroFiring !== "boolean") {
    throw new TypeError("art gallery hero firing flag must be boolean");
  }
  if (config.artGalleryHeroHit !== undefined && typeof config.artGalleryHeroHit !== "boolean") {
    throw new TypeError("art gallery hero hit flag must be boolean");
  }
  if (config.artGalleryHeroDead !== undefined && typeof config.artGalleryHeroDead !== "boolean") {
    throw new TypeError("art gallery hero dead flag must be boolean");
  }
  const world = self.match.world;
  if (world === undefined) throw new Error("art gallery has no offline world");
  const [x, y] = galleryWorldDirection(config.artGalleryHeroDirection);
  world.playerMode[0] = config.artGalleryHeroDead ? PLAYER_MODE_DEAD : PLAYER_MODE_INFANTRY;
  world.playerHealth[0] = config.artGalleryHeroDead
    ? 0
    : config.artGalleryHeroHit
      ? INFANTRY_HEALTH - 5
      : INFANTRY_HEALTH;
  world.playerRespawnTicks[0] = config.artGalleryHeroDead ? RESPAWN_TICKS : 0;
  world.playerHullX[0] = x;
  world.playerHullY[0] = y;
  // The frozen match never integrates this velocity; it selects the real
  // player component's walk atlas instead of inventing a separate renderer.
  // Cardinal screen facings map to two 128-unit world components. Double
  // them so every moving fixture crosses the player script's 256-unit
  // walking threshold; this velocity is never integrated by the frozen match.
  world.playerVelocityX[0] = config.artGalleryHeroMoving && !config.artGalleryHeroDead ? x * 2 : 0;
  world.playerVelocityY[0] = config.artGalleryHeroMoving && !config.artGalleryHeroDead ? y * 2 : 0;
  // A frozen cooldown exercises the production player component's firing
  // animation selection without inventing a gallery-only sprite renderer.
  world.playerCooldown[0] = config.artGalleryHeroFiring ? INFANTRY_FIRE_COOLDOWN_TICKS : 0;
}

function certificateHash(value: string): ArrayBuffer | undefined {
  const normalized = value.split(":").join("").trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(normalized)) return undefined;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function updateTelemetry(self: ArenaSelf): void {
  const client = self.match.client;
  const telemetry = self.telemetry;
  telemetry.mode = self.match.mode;
  telemetry.state = client?.state ?? (self.engaged ? "offline-running" : "offline-ready");
  telemetry.playerId = client?.playerId ?? 1;
  telemetry.rosterSize = client?.rosterSize ?? self.players;
  telemetry.snapshotsApplied = client?.stats.snapshotsApplied ?? 0;
  telemetry.inputsSent = client?.stats.inputsSent ?? 0;
  telemetry.inputsDropped = client?.stats.inputsDropped ?? 0;
  telemetry.lastServerTick = client?.stats.lastServerTick ?? 0;
  telemetry.localTick = client?.world?.tick ?? self.match.world?.tick ?? 0;
  telemetry.onlineReportedElapsedMilliseconds = self.match.onlineReportedElapsedMilliseconds;
  telemetry.onlineWallElapsedMilliseconds = self.match.onlineWallElapsedMilliseconds;
  telemetry.onlineMaximumWallDeltaMilliseconds = self.match.onlineMaximumWallDeltaMilliseconds;
  telemetry.inputLeadTicks = client?.stats.inputLeadTicks ?? 0;
  telemetry.inputFeedbackLeadTicks = client?.stats.inputFeedbackLeadTicks ?? 0;
  telemetry.authoritativeInputsAccepted = client?.stats.authoritativeInputsAccepted ?? 0;
  telemetry.authoritativeInputsLate = client?.stats.authoritativeInputsLate ?? 0;
  telemetry.roundTripMilliseconds = client?.stats.lastRoundTripMilliseconds ?? 0;
  telemetry.pongsReceived = client?.stats.pongsReceived ?? 0;
  telemetry.maximumLocalCorrectionMagnitude = client?.stats.maximumLocalCorrectionMagnitude ?? 0;
  telemetry.correctionsOverThirtyTwoPixels = client?.stats.localCorrectionBuckets[7] ?? 0;
  telemetry.lastLargeCorrectionMagnitude = client?.stats.lastLargeCorrectionMagnitude ?? 0;
  telemetry.lastLargeCorrectionPredictionErrorMagnitude =
    client?.stats.lastLargeCorrectionPredictionErrorMagnitude ?? 0;
  telemetry.lastLargeCorrectionPredictionComparable = client?.stats.lastLargeCorrectionPredictionComparable ?? false;
  telemetry.lastLargeCorrectionSnapshotTick = client?.stats.lastLargeCorrectionSnapshotTick ?? 0;
  telemetry.lastLargeCorrectionLocalTick = client?.stats.lastLargeCorrectionLocalTick ?? 0;
  telemetry.lastLargeCorrectionPredictedX = client?.stats.lastLargeCorrectionPredictedX ?? 0;
  telemetry.lastLargeCorrectionPredictedY = client?.stats.lastLargeCorrectionPredictedY ?? 0;
  telemetry.lastLargeCorrectionPresentedX = client?.stats.lastLargeCorrectionPresentedX ?? 0;
  telemetry.lastLargeCorrectionPresentedY = client?.stats.lastLargeCorrectionPresentedY ?? 0;
  telemetry.lastLargeCorrectionCorrectedX = client?.stats.lastLargeCorrectionCorrectedX ?? 0;
  telemetry.lastLargeCorrectionCorrectedY = client?.stats.lastLargeCorrectionCorrectedY ?? 0;
  telemetry.lastLargeCorrectionGeneration = client?.stats.lastLargeCorrectionGeneration ?? 0;
  telemetry.lastLargeCorrectionMode = client?.stats.lastLargeCorrectionMode ?? 0;
  telemetry.remoteInterpolationRebases = client?.stats.remoteInterpolationRebases ?? 0;
  telemetry.maximumRemoteInterpolationRebaseDistance = client?.stats.maximumRemoteInterpolationRebaseDistance ?? 0;
  telemetry.remoteLifecycleHardSnaps = client?.stats.remoteLifecycleHardSnaps ?? 0;
  telemetry.maximumRemotePresentedStepDistance = client?.stats.maximumRemotePresentedStepDistance ?? 0;
  telemetry.remotePresentedStepsOverThirtyTwoPixels = client?.stats.remotePresentedStepsOverThirtyTwoPixels ?? 0;
  telemetry.maximumLocalPresentedStepDistance = client?.stats.maximumLocalPresentedStepDistance ?? 0;
  telemetry.localPresentedStepsOverThirtyTwoPixels = client?.stats.localPresentedStepsOverThirtyTwoPixels ?? 0;
  const world = self.match.world;
  const localSlot = self.match.localSlot;
  if (world !== undefined && localSlot >= 0 && localSlot < world.playerX.length) {
    telemetry.localWorldX = world.playerX[localSlot]!;
    telemetry.localWorldY = world.playerY[localSlot]!;
    telemetry.localGeneration = world.playerGeneration[localSlot]!;
    telemetry.localMode = world.playerMode[localSlot]!;
    telemetry.localCooldownTicks = world.playerCooldown[localSlot]!;
  } else {
    telemetry.localWorldX = 0;
    telemetry.localWorldY = 0;
    telemetry.localGeneration = 0;
    telemetry.localMode = 0;
    telemetry.localCooldownTicks = 0;
  }
}

function attachOnlineTransport(
  self: ArenaSelf,
  client: BattleClient,
  transport: GameTransport,
  attempts: OnlineConnectionAttempts,
  generation: number,
  backend: "browser" | "native",
): void {
  // A dial can settle after a newer fallback has won, or after the match has
  // already detached its connecting client for offline play. Close that
  // transport without ever handing it to the detached client.
  if (
    attempts.detached ||
    self.match.client !== client ||
    self.match.mode !== "offline" ||
    !claimOnlineTransport(attempts, generation)
  ) {
    transport.close(1000, "stale connection attempt");
    return;
  }
  const protocol = transport.capabilities.protocol;
  self.telemetry.transport =
    protocol === "webtransport-h3" ? "webtransport-h3-quic" : protocol === "websocket-tcp" ? "websocket-tcp" : null;
  self.telemetry.transportBackend = backend;
  self.telemetry.inputLane = transport.capabilities.datagrams ? "datagram" : "reliable-fallback";
  client.attach(transport);
}

interface OnlineConnectionAttempts {
  generation: number;
  winner: number;
  detached: boolean;
}

function beginOnlineAttempt(attempts: OnlineConnectionAttempts): number {
  attempts.generation += 1;
  attempts.winner = 0;
  return attempts.generation;
}

function claimOnlineTransport(attempts: OnlineConnectionAttempts, generation: number): boolean {
  if (attempts.detached || generation !== attempts.generation) return false;
  if (attempts.winner !== 0 && attempts.winner !== generation) return false;
  attempts.winner = generation;
  return true;
}

function invalidateOnlineAttempts(attempts: OnlineConnectionAttempts): void {
  attempts.detached = true;
  attempts.generation += 1;
  attempts.winner = 0;
}

function attemptReceiver(
  client: BattleClient,
  attempts: OnlineConnectionAttempts,
  generation: number,
): TransportReceiver {
  const current = (): boolean =>
    !attempts.detached &&
    attempts.generation === generation &&
    (attempts.winner === 0 || attempts.winner === generation);
  return {
    onReliable: (channel, payload) => {
      if (current()) client.onReliable(channel, payload);
    },
    onDatagram: (payload) => {
      if (current()) client.onDatagram(payload);
    },
    onClose: (code, reason) => {
      if (current()) client.onClose(code, reason);
    },
  };
}

function logHmrState(self: ArenaSelf, edit: string): void {
  const world = self.match.world;
  let entities = 0;
  if (world !== undefined) {
    for (const active of world.playerActive) entities += active;
    for (const active of world.projectileActive) entities += active;
    for (const active of world.pickupActive) entities += active;
  }
  defold.log(
    "info",
    `war-battles:hmr-reload:edit=${edit}:tick=${self.match.ticksStepped}:entities=${entities}:elapsed=${self.elapsed.toFixed(3)}`,
  );
}

function playSfx(
  self: ArenaSelf,
  bit: number,
  url: typeof SFX_FIRE | typeof SFX_HIT | typeof SFX_EXPLOSION | typeof SFX_PICKUP | typeof SFX_ROUND,
  name: string,
): void {
  sound.play(url);
  if ((self.sfxMask & bit) !== 0) return;
  self.sfxMask |= bit;
  defold.log("info", `war-battles:sfx:${name}`);
}

function spawnTankParts(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  const localSlot = self.match.localSlot;
  for (let slot = 0; slot < self.players; slot += 1) {
    const worldX = world.playerX[slot]!;
    const worldY = world.playerY[slot]!;
    const depth = isometricSortZ(worldX, worldY);
    const position = vmath.vector3(projectedX(worldX, worldY), projectedY(worldX, worldY), depth);
    // Hull and turret share one game object and one sampled pose. The local
    // player's authored object owns both sprites; remote slots need one each.
    if (slot !== localSlot) {
      factory.create("#tankfactory", position, undefined, new Map<string, unknown>([["slot", slot]]));
    }
  }
}

function syncTankDepots(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined || self.depotMapSeed === world.mapSeed) return;
  for (const id of self.depotIds) go.delete(id);
  self.depotIds.length = 0;
  for (const index of deriveTankDepotPresentationSites(world.map)) {
    const facade = world.map.plan.depotFacadeCells[index]!;
    const worldX = cellCentreX(facade % MAP_WIDTH);
    const worldY = cellCentreY(Math.floor(facade / MAP_WIDTH));
    // The facade foot and the immutable collider come from the same plan cell;
    // the nearby spawn coordinate remains the separate pilot/tank apron.
    const id = factory.create(
      "#depotfactory",
      vmath.vector3(projectedX(worldX, worldY), projectedY(worldX, worldY), isometricSortZ(worldX, worldY, -0.02)),
    ) as DefoldHash | undefined;
    if (id !== undefined) self.depotIds.push(id);
  }
  self.depotMapSeed = world.mapSeed;
}

function syncFloorMarkers(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  if (self.markerIds === undefined) self.markerIds = [];
  if (self.markerMapSeed !== world.mapSeed) {
    for (const id of self.markerIds) go.delete(id);
    self.markerIds.length = 0;
    if (self.depotMarkerId !== undefined) go.delete(self.depotMarkerId);
    self.depotMarkerId = undefined;
    self.depotMarkerSite = -1;
    for (let site = 0; site < MAX_PICKUPS; site += 1) {
      const worldX = world.map.pickupX[site]!;
      const worldY = world.map.pickupY[site]!;
      const id = factory.create(
        "#pickupmarkerfactory",
        vmath.vector3(projectedX(worldX, worldY), projectedY(worldX, worldY), isometricSortZ(worldX, worldY, -0.012)),
      ) as DefoldHash | undefined;
      if (id !== undefined) self.markerIds.push(id);
    }
    self.markerMapSeed = world.mapSeed;
  }
  const site = visibleTankDepotMarkerSite(world, self.match.localSlot);
  if (self.depotMarkerSite === site) return;
  if (self.depotMarkerId !== undefined) go.delete(self.depotMarkerId);
  self.depotMarkerId = undefined;
  self.depotMarkerSite = site;
  if (site < 0) return;
  const worldX = world.map.spawnX[site]!;
  const worldY = world.map.spawnY[site]!;
  self.depotMarkerId = factory.create(
    "#spawnmarkerfactory",
    vmath.vector3(projectedX(worldX, worldY), projectedY(worldX, worldY), isometricSortZ(worldX, worldY, -0.012)),
  ) as DefoldHash | undefined;
}

const LANDMARK_COUNT = 17;
function syncWorldLandmarks(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined || self.landmarkMapSeed === world.mapSeed) return;
  for (const id of self.landmarkIds) go.delete(id);
  self.landmarkIds.length = 0;
  if (artGalleryEnabled()) {
    for (let kind = 0; kind < LANDMARK_COUNT; kind += 1) {
      const localX = world.playerX[0]!;
      const localY = world.playerY[0]!;
      const column = kind % 4;
      const row = Math.floor(kind / 4);
      const id = factory.create(
        "#landmarkfactory",
        vmath.vector3(
          projectedX(localX, localY) + (column - 1.5) * 176,
          projectedY(localX, localY) + (1 - row) * 104,
          0.35 + row * 0.01,
        ),
        undefined,
        new Map<string, unknown>([["kind", kind]]),
      ) as DefoldHash | undefined;
      if (id !== undefined) self.landmarkIds.push(id);
    }
  } else {
    // The world-plan prop table is also the source of collision. Emit exactly
    // one ground-seated sprite per accepted tree, rock, or building so no
    // invisible obstacle can survive the island migration.
    for (const anchor of deriveWorldPlanPropAnchors(world.map)) {
      const id = factory.create(
        "#landmarkfactory",
        vmath.vector3(
          projectedX(anchor.worldX, anchor.worldY),
          projectedY(anchor.worldX, anchor.worldY),
          isometricSortZ(anchor.worldX, anchor.worldY, 0.001),
        ),
        undefined,
        new Map<string, unknown>([["kind", anchor.kind]]),
      ) as DefoldHash | undefined;
      if (id !== undefined) self.landmarkIds.push(id);
    }
    // The former mirrored square-wall landforms have no place in the seeded
    // island. All blocking scenery above comes from the world-plan table.
  }
  self.landmarkMapSeed = world.mapSeed;
}

function syncPickups(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  for (let index = 0; index < MAX_PICKUPS; index += 1) {
    const live = world.pickupActive[index] !== 0;
    if (!live) {
      // The pad's game object removes itself the moment the pad is taken, so
      // the director only has to remember that it is gone.
      self.spawnedPickup[index] = 0;
      continue;
    }
    if (self.spawnedPickup[index] !== 0) continue;
    self.spawnedPickup[index] = 1;
    factory.create(
      "#pickupfactory",
      vmath.vector3(
        projectedX(world.pickupX[index]!, world.pickupY[index]!),
        // The 40px raised pickup is bottom-anchored over its authoritative
        // world position, rather than centered through the hex floor.
        projectedY(world.pickupX[index]!, world.pickupY[index]!) + 18,
        isometricSortZ(world.pickupX[index]!, world.pickupY[index]!, -0.002),
      ),
      undefined,
      new Map<string, unknown>([
        ["index", index],
        ["kind", world.pickupKind[index]!],
      ]),
    );
  }
}

function syncProjectiles(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  let visible = 0;
  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    if (world.projectileActive[slot] === 0) {
      self.spawnedProjectile[slot] = 0;
      continue;
    }
    const generation = world.projectileGeneration[slot]!;
    if (self.spawnedProjectile[slot] === generation) {
      visible += 1;
      continue;
    }
    // A projectile whose slot was recycled has a new generation, so the stale
    // game object deletes itself and a fresh one is created here.
    if (visible >= MAX_VISIBLE_PROJECTILES) continue;
    self.spawnedProjectile[slot] = generation;
    visible += 1;
    factory.create(
      "#shotfactory",
      vmath.vector3(
        projectedX(world.projectileX[slot]!, world.projectileY[slot]!),
        projectedY(world.projectileX[slot]!, world.projectileY[slot]!),
        isometricSortZ(world.projectileX[slot]!, world.projectileY[slot]!, 0.003),
      ),
      undefined,
      new Map<string, unknown>([
        ["slot", slot],
        ["generation", generation],
        ["weapon", world.projectileWeapon[slot]!],
      ]),
    );
  }
  self.visibleProjectiles = visible;
}

function syncCoverSprites(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  // A compatible hot reload may preserve an older self without this field.
  if (self.coverIds === undefined) self.coverIds = Array.from({ length: MAX_COVER_PANELS }, () => undefined);
  if (self.coverMapSeed !== world.mapSeed) {
    for (const id of self.coverIds) if (id !== undefined) go.delete(id);
    self.coverIds.fill(undefined);
    self.coverMapSeed = world.mapSeed;
  }
  for (let panel = 0; panel < world.map.coverPanelCount; panel += 1) {
    const id = self.coverIds[panel];
    if (world.map.coverHealth[panel] === 0) {
      if (id !== undefined) go.delete(id);
      self.coverIds[panel] = undefined;
      continue;
    }
    if (id !== undefined) continue;
    const worldX = world.map.coverX[panel]!;
    const worldY = world.map.coverY[panel]!;
    const cellX = cellOfX(worldX);
    const cellY = cellOfY(worldY);
    const cell = world.map.cellAt(cellX, cellY);
    const kind = cell === CELL_CRATE ? 0 : cell === CELL_SANDBAG ? 1 + (panel & 1) : -1;
    if (kind < 0) continue;
    self.coverIds[panel] = factory.create(
      kind === 0 ? "#coverfactory" : kind === 1 ? "#sandbagafactory" : "#sandbagbfactory",
      vmath.vector3(
        projectedX(worldX, worldY),
        projectedY(worldX, worldY) + (kind === 0 ? 17 : 13),
        isometricSortZ(worldX, worldY, -0.001),
      ),
    ) as DefoldHash | undefined;
  }
}

function ensureArenaVisualState(self: ArenaSelf): void {
  if (
    self.visualGroundRoles !== undefined &&
    self.visualDecorRoles !== undefined &&
    self.visualMarkRoles !== undefined &&
    self.visualPropCoverage !== undefined &&
    self.visualGroundScratch !== undefined &&
    self.visualDecorScratch !== undefined &&
    self.visualMarkScratch !== undefined &&
    self.visualPropScratch !== undefined &&
    self.visualMapSeed !== undefined &&
    self.visualTheme !== undefined
  ) {
    return;
  }
  self.visualGroundRoles = new Uint16Array(ARENA_VISUAL_CELL_COUNT);
  self.visualDecorRoles = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  self.visualMarkRoles = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  self.visualPropCoverage = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  self.visualGroundScratch = new Uint16Array(ARENA_VISUAL_CELL_COUNT);
  self.visualDecorScratch = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  self.visualMarkScratch = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  self.visualPropScratch = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  const baseline = new ArenaMap(DEFAULT_ARENA_SEED);
  projectArenaVisualRoles(
    baseline,
    DEFAULT_ARENA_SEED,
    self.visualGroundRoles,
    self.visualDecorRoles,
    self.visualMarkRoles,
  );
  projectWorldPlanPropCoverage(baseline, self.visualPropCoverage);
  self.visualMapSeed = DEFAULT_ARENA_SEED;
  self.visualTheme = arenaThemeIndex(DEFAULT_ARENA_SEED, DEFAULT_ARENA_SEED, ARENA_ART_THEMES.length);
}

/**
 * Re-project only when the authoritative map changes. The six fixed arrays are
 * retained on `self`; steady frames allocate nothing and make no tilemap calls.
 */
function syncArenaVisualMap(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  ensureArenaVisualState(self);
  const seed = world.mapSeed >>> 0;
  const theme = arenaThemeIndex(seed, DEFAULT_ARENA_SEED, ARENA_ART_THEMES.length);
  if (self.visualMapSeed === seed && self.visualTheme === theme) return;

  const currentGround = self.visualGroundRoles!;
  const currentDecor = self.visualDecorRoles!;
  const currentMarks = self.visualMarkRoles!;
  const currentProps = self.visualPropCoverage!;
  const nextGround = self.visualGroundScratch!;
  const nextDecor = self.visualDecorScratch!;
  const nextMarks = self.visualMarkScratch!;
  const nextProps = self.visualPropScratch!;
  const priorTheme = self.visualTheme!;
  projectArenaVisualRoles(world.map, seed, nextGround, nextDecor, nextMarks);
  projectWorldPlanPropCoverage(world.map, nextProps);
  for (let index = 0; index < ARENA_VISUAL_CELL_COUNT; index += 1) {
    const cellX = index % MAP_WIDTH;
    const cellY = Math.floor(index / MAP_WIDTH);
    const x = cellX + 1;
    const y = cellY + 1;
    const oldRole = currentGround[index]!;
    const newRole = nextGround[index]!;
    const oldWall =
      oldRole >= ARENA_GROUND_ROLE_WALL_BASE && currentProps[index] === 0 ? arenaGroundTileId(priorTheme, oldRole) : 0;
    const newWall =
      newRole >= ARENA_GROUND_ROLE_WALL_BASE && nextProps[index] === 0 ? arenaGroundTileId(theme, newRole) : 0;
    const oldFace =
      oldRole >= ARENA_GROUND_ROLE_WALL_BASE && oldRole < ARENA_GROUND_ROLE_BORDER_BASE && currentProps[index] === 0
        ? arenaWallFaceTileId(priorTheme, oldRole - ARENA_GROUND_ROLE_WALL_BASE)
        : 0;
    const newFace =
      newRole >= ARENA_GROUND_ROLE_WALL_BASE && newRole < ARENA_GROUND_ROLE_BORDER_BASE && nextProps[index] === 0
        ? arenaWallFaceTileId(theme, newRole - ARENA_GROUND_ROLE_WALL_BASE)
        : 0;
    const oldDecor = arenaDecorTileId(priorTheme, currentDecor[index]!);
    const newDecor = arenaDecorTileId(theme, nextDecor[index]!);
    const oldMark = arenaMarkTileId(priorTheme, currentMarks[index]!);
    const newMark = arenaMarkTileId(theme, nextMarks[index]!);
    if (oldWall !== newWall) tilemap.setTile(ARENA_TILEMAP, ARENA_WALL_LAYER, x, y, newWall);
    if (oldFace !== newFace) tilemap.setTile(ARENA_FACE_TILEMAP, ARENA_FACE_LAYER, x, y, newFace);
    if (oldDecor !== newDecor) tilemap.setTile(ARENA_TILEMAP, ARENA_DECOR_LAYER, x, y, newDecor);
    if (oldMark !== newMark) tilemap.setTile(ARENA_TILEMAP, ARENA_MARKS_LAYER, x, y, newMark);
  }
  self.visualGroundRoles = nextGround;
  self.visualDecorRoles = nextDecor;
  self.visualMarkRoles = nextMarks;
  self.visualPropCoverage = nextProps;
  self.visualGroundScratch = currentGround;
  self.visualDecorScratch = currentDecor;
  self.visualMarkScratch = currentMarks;
  self.visualPropScratch = currentProps;
  self.visualMapSeed = seed;
  self.visualTheme = theme;
  defold.log("info", `war-battles:arena-theme:${ARENA_ART_THEMES[theme]!.id}:seed=${seed}`);
}

function spawnEffect(self: ArenaSelf, big: boolean, x: number, y: number): boolean {
  if (self.effectIds.length >= MAX_EFFECTS) return false;
  // A dynamic factory can fail when the Defold gameobject buffer is full.
  // Do not retain an absent id: go.delete only accepts a real address.
  const id = factory.create(
    big ? "#boomfactory" : "#sparkfactory",
    vmath.vector3(
      projectedX(x, y),
      projectedY(x, y) + hexReliefLiftAtSimulation(x, y),
      (big ? 0.6 : 0.5) + isometricDepth(x, y) * 0.05,
    ),
  ) as DefoldHash | undefined;
  if (id === undefined) return false;
  self.effectIds.push(id);
  self.effectTicks.push(big ? EXPLOSION_TICKS : SPARK_TICKS);
  return true;
}

function spawnMuzzle(self: ArenaSelf, x: number, y: number, directionX: number, directionY: number): void {
  // Muzzle prototypes are sprite-only: the director's bounded effect pool is
  // the sole owner and retires them after the atlas animation has played.
  if (self.effectIds.length >= MAX_EFFECTS) return;
  const id = factory.create(
    "#muzzlefactory",
    vmath.vector3(
      projectedX(x, y),
      projectedY(x, y) + hexReliefLiftAtSimulation(x, y),
      0.55 + isometricDepth(x, y) * 0.05,
    ),
    vmath.quatRotationZ(projectedDirectionRadians(directionX, directionY)),
  ) as DefoldHash | undefined;
  if (id === undefined) return;
  self.effectIds.push(id);
  self.effectTicks.push(MUZZLE_TICKS);
}

function requestCameraImpact(self: ArenaSelf, strength: number, x: number, y: number): void {
  // Multiple authoritative events can arrive in one update (a kill writes an
  // explosion immediately after it). Keep one strongest message instead of
  // allocating or queueing a message for every event.
  if (strength <= self.impact.strength) return;
  self.impact.x = projectedX(x, y);
  self.impact.y = projectedY(x, y);
  self.impact.strength = strength;
}

function drainEvents(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  self.impact.strength = 0;
  const localPlayerId = self.match.localSlot + 1;
  const oldest = world.events.oldest();
  if (self.eventCursor < oldest) self.eventCursor = oldest;
  while (self.eventCursor < world.events.sequence) {
    if (!world.events.read(self.eventCursor, self.event)) break;
    self.eventCursor += 1;
    const kind = self.event.kind;
    if (kind === EVENT_EXPLOSION) {
      requestCameraImpact(self, CAMERA_IMPACT_EXPLOSION, self.event.x, self.event.y);
      spawnEffect(self, true, self.event.x, self.event.y);
    } else if (kind === EVENT_COVER_CHANGED) {
      // Cover damage is authoritative; this bounded spark is presentation-only.
      spawnEffect(self, false, self.event.x, self.event.y);
    } else if (kind === EVENT_HAZARD_DAMAGE) {
      spawnEffect(self, false, self.event.x, self.event.y);
      if (self.event.a === localPlayerId) playSfx(self, SFX_HIT_BIT, SFX_HIT, "hazard");
    } else if (kind === EVENT_KILL) {
      requestCameraImpact(self, CAMERA_IMPACT_KILL, self.event.x, self.event.y);
      spawnEffect(self, true, self.event.x, self.event.y);
      if (self.event.a === localPlayerId || self.event.b === localPlayerId) {
        playSfx(self, SFX_EXPLOSION_BIT, SFX_EXPLOSION, "explosion");
      }
    } else if (kind === EVENT_HIT && self.event.a === localPlayerId) {
      requestCameraImpact(self, CAMERA_IMPACT_HIT, self.event.x, self.event.y);
      playSfx(self, SFX_HIT_BIT, SFX_HIT, "hit");
    } else if (kind === EVENT_FIRE && self.event.b === WEAPON_MORTAR) {
      const shooter = self.event.a - 1;
      spawnMuzzle(self, self.event.x, self.event.y, world.playerTurretX[shooter]!, world.playerTurretY[shooter]!);
      spawnEffect(self, false, self.event.x, self.event.y);
      if (self.event.a === localPlayerId) playSfx(self, SFX_FIRE_BIT, SFX_FIRE, "fire");
    } else if (kind === EVENT_FIRE && self.event.a === localPlayerId) {
      const shooter = self.event.a - 1;
      spawnMuzzle(self, self.event.x, self.event.y, world.playerTurretX[shooter]!, world.playerTurretY[shooter]!);
      playSfx(self, SFX_FIRE_BIT, SFX_FIRE, "fire");
    } else if (kind === EVENT_FIRE) {
      const shooter = self.event.a - 1;
      spawnMuzzle(self, self.event.x, self.event.y, world.playerTurretX[shooter]!, world.playerTurretY[shooter]!);
    } else if (kind === EVENT_PICKUP_TAKEN) {
      spawnEffect(self, false, self.event.x, self.event.y);
      if (self.event.a === localPlayerId) playSfx(self, SFX_PICKUP_BIT, SFX_PICKUP, "pickup");
    }
  }
  if (self.impact.strength > 0) msg.post(CAMERA, CAMERA_IMPACT, self.impact);
}

function ageEffects(self: ArenaSelf): void {
  for (let index = self.effectIds.length - 1; index >= 0; index -= 1) {
    const remaining = self.effectTicks[index]! - 1;
    if (remaining > 0) {
      self.effectTicks[index] = remaining;
      continue;
    }
    go.delete(self.effectIds[index]!);
    self.effectIds.splice(index, 1);
    self.effectTicks.splice(index, 1);
  }
}

function engage(self: ArenaSelf): void {
  if (self.engaged) return;
  // WELCOME proves admission, not the spawn pose. Keep the title on screen
  // until the first authoritative keyframe is restored; otherwise the camera
  // follows the locally guessed roster and visibly jumps on correction.
  if (self.match.mode === "online" && self.match.client?.hasAuthoritativeSnapshot !== true) return;
  self.engaged = true;
  self.match.engaged = true;
  spawnTankParts(self);
  syncPickups(self);
  const world = self.match.world;
  defold.log(
    "info",
    `war-battles:arena-engaged:players=${self.players}:skill=${Math.trunc(self.botSkill)}` +
      `:seed=${world === undefined ? 0 : world.mapSeed}:mode=${self.match.mode}`,
  );
}

function restart(self: ArenaSelf): void {
  if (!self.match.restart()) {
    defold.log("info", "war-battles:arena-restart-denied:online");
    return;
  }
  self.eventCursor = 0;
  self.spawnedProjectile.fill(0);
  self.spawnedPickup.fill(0);
  for (const id of self.effectIds) go.delete(id);
  self.effectIds.length = 0;
  self.effectTicks.length = 0;
  syncPickups(self);
  playSfx(self, SFX_ROUND_BIT, SFX_ROUND, "round");
  defold.log("info", `war-battles:arena-restart:round=${self.match.battle.round}`);
}

/**
 * Starts an online session when the project declares a server. WebTransport is
 * always attempted first. If its QUIC handshake is unavailable, the browser
 * uses the explicit reliable WebSocket/TCP endpoint before going offline.
 */
function connectOnline(self: ArenaSelf): boolean {
  const runtimeConfig = browserGlobals().__warBattlesConfigV1;
  if (runtimeConfig?.server !== undefined && typeof runtimeConfig.server !== "string") {
    defold.log("info", "war-battles:arena-online-fallback:config-server:invalid");
    return false;
  }
  if (
    runtimeConfig?.serverCertificateSha256 !== undefined &&
    typeof runtimeConfig.serverCertificateSha256 !== "string"
  ) {
    defold.log("info", "war-battles:arena-online-fallback:config-certificate-sha256:invalid");
    return false;
  }
  const url = runtimeConfig?.server ?? sys.getConfigString("war_battles.server", "") ?? "";
  if (url === "") return false;
  const nativeRuntime = defold.runtime() === "hermes";
  let client: BattleClient;
  let websocketAttempted = false;
  const attempts: OnlineConnectionAttempts = { generation: 0, winner: 0, detached: false };
  self.onlineAttempts = attempts;
  const fallbackOffline = (reason: string): void => {
    // `ArenaMatch` creates its offline battle before dialing. Keep that battle
    // and engage it when the handshake cannot reach welcome; a post-welcome
    // disconnect is a real online lifecycle and is not silently converted.
    if (!client || self.match.client !== client || self.match.mode !== "offline" || attempts.detached) return;
    invalidateOnlineAttempts(attempts);
    self.match.fallbackToOffline();
    self.online = false;
    defold.log("info", `war-battles:arena-online-fallback:${reason}`);
    engage(self);
  };
  const dialWebSocket = (reason: string): void => {
    if (websocketAttempted) {
      fallbackOffline(reason);
      return;
    }
    websocketAttempted = true;
    const generation = beginOnlineAttempt(attempts);
    const websocketUrl = fallbackWebSocketUrl(url, runtimeConfig);
    if (websocketUrl === undefined) {
      fallbackOffline(`${reason}:websocket-url-invalid`);
      return;
    }
    defold.log("info", `war-battles:arena-online-fallback:${reason}:websocket-tcp`);
    void BrowserWebSocketClient.connect(websocketUrl, attemptReceiver(client, attempts, generation)).then(
      (transport) => {
        if (attempts.detached || attempts.generation !== generation) {
          transport.close(1000, "stale connection attempt");
          return;
        }
        defold.log("info", "war-battles:net:transport=websocket-tcp");
        // The owner call is guarded by the generation/winner arguments below:
        // attachOnlineTransport(self, client, transport)
        attachOnlineTransport(self, client, transport, attempts, generation, "browser");
      },
      (error: unknown) => {
        if (attempts.detached || attempts.generation !== generation) return;
        fallbackOffline(`websocket-dial:${String(error)}`);
      },
    );
  };
  const fallback = (reason: string, expectedGeneration?: number): void => {
    if (!client || self.match.client !== client || self.match.mode !== "offline" || attempts.detached) return;
    if (expectedGeneration !== undefined && attempts.generation !== expectedGeneration) return;
    if (nativeRuntime) fallbackOffline(reason);
    else dialWebSocket(reason);
  };
  client = new BattleClient({
    name: "defold",
    leadTicks: INITIAL_ONLINE_INPUT_LEAD_TICKS,
    onLog: (line: string) => defold.log("info", `war-battles:net:${line}`),
    onError: (error: unknown) => defold.log("info", `war-battles:net-error:${String(error)}`),
    onReject: (reject) => {
      if (reject.code === REJECT_FULL) {
        defold.log("info", `war-battles:arena-online-room-full:${reject.reason}`);
        return;
      }
      fallback(`reject:${reject.code}:${reject.reason}`);
    },
    onClose: (close) => {
      if (!close.welcomed && !(close.state === "rejected" && client.lastReject?.code === REJECT_FULL)) {
        fallback(`close:${close.code}:${close.reason}`);
      }
    },
    onWelcome: (welcome) => {
      // The authoritative roster is selected by the server. Adopt it before
      // presentation starts, but wait for a snapshot before showing any of its
      // guessed spawn positions or moving the camera.
      self.players = Math.max(2, Math.min(32, Math.trunc(welcome.maximumPlayers)));
      self.match.mode = "online";
    },
  });
  self.match.client = client;
  const configuredHash =
    runtimeConfig?.serverCertificateSha256 ?? sys.getConfigString("war_battles.server_certificate_sha256", "") ?? "";
  const hash = configuredHash === "" ? undefined : certificateHash(configuredHash);
  if (configuredHash !== "" && hash === undefined) {
    fallback("certificate-sha256:invalid");
    return false;
  }
  const options = hash === undefined ? undefined : { serverCertificateHashes: [{ algorithm: "sha-256", value: hash }] };
  const generation = beginOnlineAttempt(attempts);
  void WebTransportGameClient.connect(url, attemptReceiver(client, attempts, generation), WebTransport, options).then(
    (transport) => {
      if (attempts.detached || attempts.generation !== generation) {
        transport.close(1000, "stale connection attempt");
        return;
      }
      const backend = nativeRuntime ? "native" : "browser";
      defold.log("info", `war-battles:net:transport=webtransport-h3-quic:backend=${backend}`);
      attachOnlineTransport(self, client, transport, attempts, generation, backend);
    },
    (error: unknown) => {
      if (attempts.detached || attempts.generation !== generation) return;
      defold.log("info", `war-battles:net-error:${String(error)}`);
      fallback(`dial:${String(error)}`, generation);
    },
  );
  defold.log("info", `war-battles:arena-online-dialing:${url}`);
  return true;
}

function fallbackWebSocketUrl(httpUrl: string, config: WarBattlesRuntimeConfig | undefined): string | undefined {
  const configured = config?.serverWebSocket ?? sys.getConfigString("war_battles.server_websocket", "") ?? "";
  try {
    const parsed = new URL(configured === "" ? httpUrl : configured);
    if (configured === "") {
      parsed.port = "8080";
      parsed.pathname = "/ws";
      parsed.search = "";
      parsed.hash = "";
    }
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    else if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export default defineComponent({
  properties: {
    // Mirror DEFAULT_ROSTER_SIZE; Defold editor properties require literals.
    players: property.number(16),
    botSkill: property.number(1),
    mapSeed: property.number(0),
    autoEngageSeconds: property.number(0),
  },

  init(self: ArenaSelf): void {
    self.engaged = false;
    self.elapsed = 0;
    self.eventCursor = 0;
    self.event = createBattleEvent();
    self.spawnedProjectile = new Uint16Array(MAX_PROJECTILES);
    self.spawnedPickup = new Uint8Array(MAX_PICKUPS);
    self.coverIds = Array.from({ length: MAX_COVER_PANELS }, () => undefined);
    self.visibleProjectiles = 0;
    self.effectIds = [];
    self.effectTicks = [];
    self.depotIds = [];
    self.markerIds = [];
    self.depotMarkerSite = -1;
    self.landmarkIds = [];
    self.impact = { x: 0, y: 0, strength: 0 };
    self.sfxMask = 0;
    self.telemetry = {
      mode: "offline",
      state: "initializing",
      transport: null,
      transportBackend: null,
      inputLane: null,
      playerId: 0,
      rosterSize: 0,
      snapshotsApplied: 0,
      inputsSent: 0,
      inputsDropped: 0,
      lastServerTick: 0,
      localTick: 0,
      onlineReportedElapsedMilliseconds: 0,
      onlineWallElapsedMilliseconds: 0,
      onlineMaximumWallDeltaMilliseconds: 0,
      inputLeadTicks: 0,
      inputFeedbackLeadTicks: 0,
      authoritativeInputsAccepted: 0,
      authoritativeInputsLate: 0,
      roundTripMilliseconds: 0,
      pongsReceived: 0,
      maximumLocalCorrectionMagnitude: 0,
      correctionsOverThirtyTwoPixels: 0,
      lastLargeCorrectionMagnitude: 0,
      lastLargeCorrectionPredictionErrorMagnitude: 0,
      lastLargeCorrectionPredictionComparable: false,
      lastLargeCorrectionSnapshotTick: 0,
      lastLargeCorrectionLocalTick: 0,
      lastLargeCorrectionPredictedX: 0,
      lastLargeCorrectionPredictedY: 0,
      lastLargeCorrectionPresentedX: 0,
      lastLargeCorrectionPresentedY: 0,
      lastLargeCorrectionCorrectedX: 0,
      lastLargeCorrectionCorrectedY: 0,
      lastLargeCorrectionGeneration: 0,
      lastLargeCorrectionMode: 0,
      remoteInterpolationRebases: 0,
      maximumRemoteInterpolationRebaseDistance: 0,
      remoteLifecycleHardSnaps: 0,
      remoteEjectEffects: 0,
      remoteRearmEffects: 0,
      maximumRemotePresentedStepDistance: 0,
      remotePresentedStepsOverThirtyTwoPixels: 0,
      maximumLocalPresentedStepDistance: 0,
      localPresentedStepsOverThirtyTwoPixels: 0,
      localWorldX: 0,
      localWorldY: 0,
      localGeneration: 0,
      localMode: 0,
      localCooldownTicks: 0,
    };
    browserGlobals().__warBattlesTelemetryV1 = self.telemetry;
    const players = Math.max(2, Math.min(32, Math.trunc(self.players)));
    self.players = players;
    self.match = startArena({
      players,
      botSkill: Math.max(0, Math.min(3, Math.trunc(self.botSkill))),
      mapSeed: self.mapSeed > 0 ? Math.trunc(self.mapSeed) : 0,
    });
    const galleryChassis = browserGlobals().__warBattlesConfigV1?.artGalleryChassis;
    if (artGalleryEnabled() && galleryChassis !== undefined) {
      if (!Number.isInteger(galleryChassis) || galleryChassis < 1 || galleryChassis > 4) {
        throw new RangeError("art gallery chassis must be an integer from 1 to 4");
      }
      // This is a frozen visual fixture, not a player purchase. Use the
      // world's administrative roster method so health/weapon compatibility
      // follows the same chassis contract as a real match.
      const galleryWorld = self.match.world;
      if (galleryWorld === undefined) throw new Error("art gallery has no offline world");
      galleryWorld.setChassis(1, galleryChassis);
      defold.log("info", `war-battles:art-gallery-chassis:${galleryChassis}`);
    }
    if (artGalleryEnabled()) {
      const galleryConfig = browserGlobals().__warBattlesConfigV1;
      const hullIndex = galleryConfig?.artGalleryHullDirection;
      const turretIndex = galleryConfig?.artGalleryTurretDirection ?? hullIndex;
      if (hullIndex !== undefined || turretIndex !== undefined) {
        const galleryWorld = self.match.world;
        if (galleryWorld === undefined) throw new Error("art gallery has no offline world");
        const [hullX, hullY] = galleryWorldDirection(hullIndex ?? turretIndex!);
        const [turretX, turretY] = galleryWorldDirection(turretIndex ?? hullIndex!);
        galleryWorld.playerHullX[0] = hullX;
        galleryWorld.playerHullY[0] = hullY;
        galleryWorld.playerTurretX[0] = turretX;
        galleryWorld.playerTurretY[0] = turretY;
        defold.log(
          "info",
          `war-battles:art-gallery-facing:hull=${hullIndex ?? turretIndex}:turret=${turretIndex ?? hullIndex}`,
        );
      }
    }
    syncGalleryHeroPose(self);
    syncArenaVisualMap(self);
    if (!artGalleryEnabled()) syncTankDepots(self);
    if (!artGalleryEnabled()) syncFloorMarkers(self);
    syncWorldLandmarks(self);
    self.online = connectOnline(self);
    updateTelemetry(self);
    defold.log("info", `war-battles:arena-init:players=${players}:online=${self.online ? 1 : 0}`);
    logHmrState(self, "initial");
  },

  onMessage(self: ArenaSelf, messageId: DefoldHash, message: RemoteLifecycleCueMessage): void {
    if (messageId === ENGAGE) engage(self);
    else if (messageId === RESTART) restart(self);
    else if (messageId === RETRY_ONLINE) {
      const client = self.match.client;
      if (client?.state !== "rejected" || client.lastReject?.code !== REJECT_FULL) return;
      if (self.onlineAttempts !== undefined) invalidateOnlineAttempts(self.onlineAttempts);
      client.close(1000, "retrying full room admission");
      self.match.client = undefined;
      self.online = connectOnline(self);
      defold.log("info", `war-battles:arena-online-retry:${self.online ? "started" : "unavailable"}`);
    } else if (messageId === REMOTE_LIFECYCLE_CUE) {
      if (!Number.isFinite(message?.x) || !Number.isFinite(message?.y)) return;
      if (message.cue === REMOTE_CUE_EJECT) {
        if (spawnEffect(self, true, message.x, message.y)) self.telemetry.remoteEjectEffects += 1;
      } else if (message.cue === REMOTE_CUE_REARM) {
        if (spawnEffect(self, false, message.x, message.y)) self.telemetry.remoteRearmEffects += 1;
      }
    }
  },

  // This small marker is intentionally observable from the native dev session:
  // it proves that the live match kept advancing between compatible reloads.
  onReload(self: ArenaSelf): void {
    logHmrState(self, "baseline");
  },

  update(self: ArenaSelf, dt: number): void {
    self.elapsed += dt;
    syncGalleryHeroPose(self);
    syncArenaVisualMap(self);
    if (!artGalleryEnabled()) syncTankDepots(self);
    if (!artGalleryEnabled()) syncFloorMarkers(self);
    syncWorldLandmarks(self);
    // Native transports are poll-driven because their worker threads may not
    // call Hermes, Lua, or Defold. Pump before the engagement gate: the first
    // restored snapshot, not the welcome's guessed roster, begins presentation.
    if (!self.engaged) {
      if (self.match.mode === "online") {
        self.match.advanceOnline(dt);
        if (self.match.client?.hasAuthoritativeSnapshot === true) engage(self);
      } else if (self.autoEngageSeconds > 0 && self.elapsed >= self.autoEngageSeconds) engage(self);
      updateTelemetry(self);
      return;
    }
    // Gallery captures compare material frames at one fixed camera/world pose.
    // Keep rendering (and the coast material's engine TIME constant) running,
    // but do not let offline bots or combat move the reference pixels.
    if (artGalleryEnabled()) {
      updateTelemetry(self);
      return;
    }
    if (self.match.advance(dt) === 0 && self.match.world === undefined) {
      updateTelemetry(self);
      return;
    }
    syncProjectiles(self);
    syncPickups(self);
    syncCoverSprites(self);
    drainEvents(self);
    ageEffects(self);
    updateTelemetry(self);
  },

  final(self: ArenaSelf): void {
    for (const id of self.effectIds) go.delete(id);
    for (const id of self.depotIds) go.delete(id);
    for (const id of self.markerIds ?? []) go.delete(id);
    if (self.depotMarkerId !== undefined) go.delete(self.depotMarkerId);
    for (const id of self.landmarkIds) go.delete(id);
    for (const id of self.coverIds ?? []) if (id !== undefined) go.delete(id);
    self.effectIds.length = 0;
    self.depotIds.length = 0;
    if (self.markerIds !== undefined) self.markerIds.length = 0;
    self.depotMarkerId = undefined;
    self.depotMarkerSite = -1;
    self.landmarkIds.length = 0;
    self.effectTicks.length = 0;
    if (self.onlineAttempts !== undefined) invalidateOnlineAttempts(self.onlineAttempts);
    self.match.client?.close(1000, "scene teardown");
    browserGlobals().__warBattlesTelemetryV1 = undefined;
    defold.log("info", "war-battles:arena-final");
  },
});
