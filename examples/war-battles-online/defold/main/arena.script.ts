import {
  defineComponent,
  factory,
  go,
  hashLiteral,
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
  online: boolean;
  sfxMask: number;
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

function drainEvents(self: ArenaSelf): void {
  const world = self.match.world;
  if (world === undefined) return;
  const localPlayerId = self.match.localSlot + 1;
  const oldest = world.events.oldest();
  if (self.eventCursor < oldest) self.eventCursor = oldest;
  while (self.eventCursor < world.events.sequence) {
    if (!world.events.read(self.eventCursor, self.event)) break;
    self.eventCursor += 1;
    const kind = self.event.kind;
    if (kind === EVENT_EXPLOSION) {
      spawnEffect(self, true, self.event.x, self.event.y);
    } else if (kind === EVENT_KILL) {
      spawnEffect(self, true, self.event.x, self.event.y);
      if (self.event.a === localPlayerId || self.event.b === localPlayerId) {
        playSfx(self, SFX_EXPLOSION_BIT, SFX_EXPLOSION, "explosion");
      }
    } else if (kind === EVENT_HIT && self.event.a === localPlayerId) {
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
  const url = sys.getConfigString("war_battles.server", "") ?? "";
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
  void BrowserWebTransportClient.connect(url, client).then(
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
    self.sfxMask = 0;
    const players = Math.max(2, Math.min(32, Math.trunc(self.players)));
    self.players = players;
    self.match = startArena({
      players,
      botSkill: Math.max(0, Math.min(3, Math.trunc(self.botSkill))),
      mapSeed: self.mapSeed > 0 ? Math.trunc(self.mapSeed) : 0,
    });
    self.online = connectOnline(self);
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
      return;
    }
    if (self.match.advance(dt) === 0 && self.match.world === undefined) return;
    syncProjectiles(self);
    syncPickups(self);
    drainEvents(self);
    ageEffects(self);
  },

  final(self: ArenaSelf): void {
    for (const id of self.effectIds) go.delete(id);
    self.effectIds.length = 0;
    self.effectTicks.length = 0;
    self.match.client?.close(1000, "scene teardown");
    __defoldHostV1.log("info", "war-battles:arena-final");
  },
});
