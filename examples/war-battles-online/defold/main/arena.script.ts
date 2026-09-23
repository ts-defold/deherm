import {
  defineComponent,
  factory,
  go,
  hashLiteral,
  msg,
  property,
  sound,
  sys,
  vmath,
  type DefoldHash,
} from "@deherm/project";

import {
  BattleClient,
  BrowserWebTransportClient,
  EVENT_EXPLOSION,
  EVENT_FIRE,
  EVENT_HIT,
  EVENT_KILL,
  EVENT_PICKUP_TAKEN,
  MAX_PICKUPS,
  MAX_PROJECTILES,
  WEAPON_MORTAR,
  createBattleEvent,
  type BattleEvent,
} from "../src/generated-war-battles/index";
import {
  MAX_VISIBLE_PROJECTILES,
  pixelX,
  pixelY,
  startArena,
  type ArenaMatch,
} from "../src/arena-match";

declare const __defoldHostV1: {
  log(level: "info", message: string): void;
};

interface WarBattlesRuntimeConfig {
  /** Browser-only development override; game.project remains authoritative. */
  server?: string;
  /** Hex SHA-256 for a short-lived self-signed WebTransport certificate. */
  serverCertificateSha256?: string;
}

interface WarBattlesRuntimeTelemetry {
  mode: "offline" | "online";
  state: string;
  playerId: number;
  rosterSize: number;
  snapshotsApplied: number;
  inputsSent: number;
  inputsDropped: number;
  lastServerTick: number;
  localTick: number;
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
const CAMERA = "/camera#follow";
const CAMERA_IMPACT = "camera_impact";

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

/** Part discriminator understood by `tank.script.ts`. */
const PART_HULL = 0;
const PART_TURRET = 1;

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
  visibleProjectiles: number;
  effectIds: DefoldHash[];
  effectTicks: number[];
  /** One reusable message; drainEvents sends at most one impact per update. */
  impact: CameraImpactMessage;
  online: boolean;
  sfxMask: number;
  /** Mutated in place so live observability adds no per-frame object churn. */
  telemetry: WarBattlesRuntimeTelemetry;
}

function browserGlobals(): WarBattlesBrowserGlobals {
  return globalThis as unknown as WarBattlesBrowserGlobals;
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
}

function logHmrState(self: ArenaSelf, edit: string): void {
  const world = self.match.world;
  let entities = 0;
  if (world !== undefined) {
    for (const active of world.playerActive) entities += active;
    for (const active of world.projectileActive) entities += active;
    for (const active of world.pickupActive) entities += active;
  }
  __defoldHostV1.log(
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
  __defoldHostV1.log("info", `war-battles:sfx:${name}`);
}

function spawnTankParts(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  const localSlot = self.match.localSlot;
  for (let slot = 0; slot < self.players; slot += 1) {
    const position = vmath.vector3(pixelX(world.playerX[slot]!), pixelY(world.playerY[slot]!), 0.2);
    // The local hull is the authored `player` game object, so only its turret
    // is spawned here; every other tank gets both parts.
    if (slot !== localSlot) {
      factory.create("#tankfactory", position, undefined, new Map<string, unknown>([
        ["slot", slot],
        ["part", PART_HULL],
      ]));
    }
    factory.create("#tankfactory", vmath.vector3(position.x, position.y, 0.3), undefined, new Map<string, unknown>([
      ["slot", slot],
      ["part", PART_TURRET],
    ]));
  }
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
      vmath.vector3(pixelX(world.pickupX[index]!), pixelY(world.pickupY[index]!), 0.1),
      undefined,
      new Map<string, unknown>([["index", index], ["kind", world.pickupKind[index]!]]),
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
      vmath.vector3(pixelX(world.projectileX[slot]!), pixelY(world.projectileY[slot]!), 0.4),
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

function spawnEffect(self: ArenaSelf, big: boolean, x: number, y: number): void {
  if (self.effectIds.length >= MAX_EFFECTS) return;
  // A dynamic factory can fail when the Defold gameobject buffer is full.
  // Do not retain an absent id: go.delete only accepts a real address.
  const id = factory.create(
    big ? "#boomfactory" : "#sparkfactory",
    vmath.vector3(pixelX(x), pixelY(y), big ? 0.6 : 0.5),
  ) as DefoldHash | undefined;
  if (id === undefined) return;
  self.effectIds.push(id);
  self.effectTicks.push(big ? EXPLOSION_TICKS : SPARK_TICKS);
}

function spawnMuzzle(self: ArenaSelf, x: number, y: number, directionX: number, directionY: number): void {
  // Muzzle prototypes are sprite-only: the director's bounded effect pool is
  // the sole owner and retires them after the atlas animation has played.
  if (self.effectIds.length >= MAX_EFFECTS) return;
  const id = factory.create(
    "#muzzlefactory",
    vmath.vector3(pixelX(x), pixelY(y), 0.55),
    vmath.quatRotationZ(Math.atan2(directionY, directionX)),
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
  self.impact.x = x;
  self.impact.y = y;
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
  self.engaged = true;
  self.match.engaged = true;
  spawnTankParts(self);
  syncPickups(self);
  const world = self.match.world;
  __defoldHostV1.log(
    "info",
    `war-battles:arena-engaged:players=${self.players}:skill=${Math.trunc(self.botSkill)}` +
    `:seed=${world === undefined ? 0 : world.mapSeed}:mode=${self.match.mode}`,
  );
}

function restart(self: ArenaSelf): void {
  if (!self.match.restart()) {
    __defoldHostV1.log("info", "war-battles:arena-restart-denied:online");
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
  __defoldHostV1.log("info", `war-battles:arena-restart:round=${self.match.battle.round}`);
}

/**
 * Starts an online session when the project declares a server. WebTransport
 * only exists on the browser host; a native engine has no client extension for
 * it yet, so this returns false there and the arena stays offline. That is the
 * boundary described in the example README, not an accident.
 */
function connectOnline(self: ArenaSelf): boolean {
  const runtimeConfig = browserGlobals().__warBattlesConfigV1;
  if (runtimeConfig?.server !== undefined && typeof runtimeConfig.server !== "string") {
    __defoldHostV1.log("info", "war-battles:arena-online-fallback:config-server:invalid");
    return false;
  }
  if (runtimeConfig?.serverCertificateSha256 !== undefined
    && typeof runtimeConfig.serverCertificateSha256 !== "string") {
    __defoldHostV1.log("info", "war-battles:arena-online-fallback:config-certificate-sha256:invalid");
    return false;
  }
  const url = runtimeConfig?.server ?? sys.getConfigString("war_battles.server", "") ?? "";
  if (url === "") return false;
  const constructor = (globalThis as { WebTransport?: unknown }).WebTransport;
  if (constructor === undefined) {
    __defoldHostV1.log("info", "war-battles:arena-online-unavailable:no-webtransport");
    return false;
  }
  let client: BattleClient;
  const fallback = (reason: string): void => {
    // `ArenaMatch` creates its offline battle before dialing. Keep that battle
    // and engage it when the handshake cannot reach welcome; a post-welcome
    // disconnect is a real online lifecycle and is not silently converted.
    if (!client || self.match.client !== client || self.match.mode !== "offline") return;
    self.match.fallbackToOffline();
    self.online = false;
    __defoldHostV1.log("info", `war-battles:arena-online-fallback:${reason}`);
    engage(self);
  };
  client = new BattleClient({
    name: "defold",
    onLog: (line: string) => __defoldHostV1.log("info", `war-battles:net:${line}`),
    onError: (error: unknown) => __defoldHostV1.log("info", `war-battles:net-error:${String(error)}`),
    onReject: (reject) => fallback(`reject:${reject.code}:${reject.reason}`),
    onClose: (close) => {
      if (!close.welcomed) fallback(`close:${close.code}:${close.reason}`);
    },
    onWelcome: () => {
      self.match.mode = "online";
      engage(self);
    },
  });
  self.match.client = client;
  const configuredHash = runtimeConfig?.serverCertificateSha256
    ?? sys.getConfigString("war_battles.server_certificate_sha256", "")
    ?? "";
  const hash = configuredHash === "" ? undefined : certificateHash(configuredHash);
  if (configuredHash !== "" && hash === undefined) {
    fallback("certificate-sha256:invalid");
    return false;
  }
  const options = hash === undefined
    ? undefined
    : { serverCertificateHashes: [{ algorithm: "sha-256", value: hash }] };
  void BrowserWebTransportClient.connect(url, client, undefined, options).then(
    (transport) => client.attach(transport),
    (error: unknown) => {
      __defoldHostV1.log("info", `war-battles:net-error:${String(error)}`);
      fallback(`dial:${String(error)}`);
    },
  );
  __defoldHostV1.log("info", `war-battles:arena-online-dialing:${url}`);
  return true;
}

export default defineComponent({
  properties: {
    players: property.number(8),
    botSkill: property.number(2),
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
    self.visibleProjectiles = 0;
    self.effectIds = [];
    self.effectTicks = [];
    self.impact = { x: 0, y: 0, strength: 0 };
    self.sfxMask = 0;
    self.telemetry = {
      mode: "offline",
      state: "initializing",
      playerId: 0,
      rosterSize: 0,
      snapshotsApplied: 0,
      inputsSent: 0,
      inputsDropped: 0,
      lastServerTick: 0,
      localTick: 0,
    };
    browserGlobals().__warBattlesTelemetryV1 = self.telemetry;
    const players = Math.max(2, Math.min(32, Math.trunc(self.players)));
    self.players = players;
    self.match = startArena({
      players,
      botSkill: Math.max(0, Math.min(3, Math.trunc(self.botSkill))),
      mapSeed: self.mapSeed > 0 ? Math.trunc(self.mapSeed) : 0,
    });
    self.online = connectOnline(self);
    updateTelemetry(self);
    __defoldHostV1.log("info", `war-battles:arena-init:players=${players}:online=${self.online ? 1 : 0}`);
    logHmrState(self, "initial");
  },

  onMessage(self: ArenaSelf, messageId: DefoldHash): void {
    if (messageId === ENGAGE) engage(self);
    else if (messageId === RESTART) restart(self);
  },

  // This small marker is intentionally observable from the native dev session:
  // it proves that the live match kept advancing between compatible reloads.
  onReload(self: ArenaSelf): void {
    logHmrState(self, "baseline");
  },

  update(self: ArenaSelf, dt: number): void {
    self.elapsed += dt;
    if (!self.engaged) {
      if (self.autoEngageSeconds > 0 && self.elapsed >= self.autoEngageSeconds) engage(self);
      updateTelemetry(self);
      return;
    }
    if (self.match.advance(dt) === 0 && self.match.world === undefined) {
      updateTelemetry(self);
      return;
    }
    syncProjectiles(self);
    syncPickups(self);
    drainEvents(self);
    ageEffects(self);
    updateTelemetry(self);
  },

  final(self: ArenaSelf): void {
    for (const id of self.effectIds) go.delete(id);
    self.effectIds.length = 0;
    self.effectTicks.length = 0;
    self.match.client?.close(1000, "scene teardown");
    browserGlobals().__warBattlesTelemetryV1 = undefined;
    __defoldHostV1.log("info", "war-battles:arena-final");
  },
});
