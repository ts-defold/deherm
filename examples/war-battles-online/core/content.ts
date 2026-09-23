// Data-driven weapons, pickups and upgrades.
//
// Every definition is frozen and indexed by its wire id, so a snapshot carries
// one byte per weapon and both ends resolve the same numbers. The tuning here
// is the whole of the game's feel: short time-to-kill, one weapon that is always
// available, and five pickups that each change how a fight is fought.

export const WEAPON_CANNON = 1;
export const WEAPON_AUTOCANNON = 2;
export const WEAPON_RAILGUN = 3;
export const WEAPON_SCATTER = 4;
export const WEAPON_MORTAR = 5;
export const WEAPON_RICOCHET = 6;
export const WEAPON_COUNT = 6;
/** The weapon a tank always has, with unlimited ammunition. */
export const SPAWN_WEAPON = WEAPON_CANNON;

export const UPGRADE_DAMAGE = 1;
export const UPGRADE_MOBILITY = 2;
export const UPGRADE_ARMOR = 3;

// Chassis are content, not branching simulation code. The mask is the set of
// weapon slots the chassis can carry; bit zero is unused because weapon ids are
// one-based on the wire. Values are fixed-point simulation units so a client
// and server resolve the same handling without floats in the hot path.
export const CHASSIS_SCOUT = 1;
export const CHASSIS_ASSAULT = 2;
export const CHASSIS_BULWARK = 3;
export const CHASSIS_ARTILLERY = 4;
export const CHASSIS_COUNT = 4;
export const CHASSIS_UNLOCK_MASK = (1 << CHASSIS_COUNT) - 1;

export interface ChassisDefinition {
  readonly id: number;
  readonly name: string;
  readonly role: string;
  /** Existing atlas/tutorial art id used by the Defold presentation. */
  readonly sprite: string;
  readonly maxHealth: number;
  readonly baseArmor: number;
  readonly acceleration: number;
  readonly maxSpeed: number;
  readonly dragShift: number;
  readonly wallBounce: number;
  readonly hullSlew: number;
  readonly turretSlew: number;
  /** 256 is neutral; smaller values resist knockback. */
  readonly knockbackFactor: number;
  readonly weaponMask: number;
  readonly unlockCost: number;
}

export interface WeaponDefinition {
  readonly id: number;
  readonly name: string;
  /** Atlas animation id for this weapon's projectile. */
  readonly sprite: string;
  readonly damage: number;
  /** Simulation units travelled per tick. */
  readonly projectileSpeed: number;
  readonly cooldownTicks: number;
  readonly lifetimeTicks: number;
  readonly projectileRadius: number;
  /** Projectiles released per trigger pull. */
  readonly pellets: number;
  /** Cone half-width in 1/256ths of a right angle; zero is perfectly straight. */
  readonly spread: number;
  /** Wall bounces before the projectile expires. */
  readonly bounces: number;
  /** Splash radius in simulation units; zero means no splash. */
  readonly splashRadius: number;
  readonly splashDamage: number;
  /** Extra tanks a single projectile may pass through before stopping. */
  readonly pierce: number;
  /** Recoil pushed into the shooter, in velocity units. */
  readonly recoil: number;
  /** Rounds granted by one pickup, and the carry cap. Zero means unlimited. */
  readonly pickupAmmo: number;
  readonly maximumAmmo: number;
  /** How eagerly a bot prefers this weapon when choosing what to carry. */
  readonly botPreference: number;
}

export interface PickupDefinition {
  readonly kind: number;
  readonly name: string;
  readonly sprite: string;
  readonly respawnTicks: number;
  /** Weapon granted, or zero for a support pickup. */
  readonly weapon: number;
  readonly health: number;
  readonly armor: number;
  readonly overdriveTicks: number;
}

export interface UpgradeDefinition {
  readonly id: number;
  readonly name: string;
  readonly maximumLevel: number;
  readonly baseCost: number;
  readonly costPerLevel: number;
}

const weapon = (definition: WeaponDefinition): WeaponDefinition => Object.freeze(definition);

// Indexed by the wire id. Index zero is an intentional invalid sentinel.
export const WEAPONS: readonly (WeaponDefinition | undefined)[] = Object.freeze([
  undefined,
  weapon({
    id: WEAPON_CANNON,
    name: "cannon",
    sprite: "proj-cannon",
    damage: 30,
    projectileSpeed: 176,
    cooldownTicks: 36,
    lifetimeTicks: 75,
    projectileRadius: 5 * 16,
    pellets: 1,
    spread: 0,
    bounces: 0,
    splashRadius: 0,
    splashDamage: 0,
    pierce: 0,
    recoil: 900,
    pickupAmmo: 0,
    maximumAmmo: 0,
    botPreference: 10,
  }),
  weapon({
    id: WEAPON_AUTOCANNON,
    name: "autocannon",
    sprite: "proj-machinegun",
    damage: 9,
    projectileSpeed: 232,
    cooldownTicks: 5,
    lifetimeTicks: 58,
    projectileRadius: 3 * 16,
    pellets: 1,
    spread: 7,
    bounces: 0,
    splashRadius: 0,
    splashDamage: 0,
    pierce: 0,
    recoil: 90,
    pickupAmmo: 120,
    maximumAmmo: 400,
    botPreference: 45,
  }),
  weapon({
    id: WEAPON_RAILGUN,
    name: "railgun",
    sprite: "proj-railgun",
    damage: 72,
    projectileSpeed: 512,
    cooldownTicks: 90,
    lifetimeTicks: 36,
    projectileRadius: 3 * 16,
    pellets: 1,
    spread: 0,
    bounces: 0,
    splashRadius: 0,
    splashDamage: 0,
    pierce: 2,
    recoil: 1400,
    pickupAmmo: 6,
    maximumAmmo: 20,
    botPreference: 70,
  }),
  weapon({
    id: WEAPON_SCATTER,
    name: "scatter",
    sprite: "proj-scatter",
    damage: 11,
    projectileSpeed: 208,
    cooldownTicks: 48,
    lifetimeTicks: 22,
    projectileRadius: 3 * 16,
    pellets: 7,
    spread: 42,
    bounces: 0,
    splashRadius: 0,
    splashDamage: 0,
    pierce: 0,
    recoil: 2200,
    pickupAmmo: 12,
    maximumAmmo: 40,
    botPreference: 60,
  }),
  weapon({
    id: WEAPON_MORTAR,
    name: "mortar",
    sprite: "proj-mortar",
    damage: 58,
    projectileSpeed: 128,
    cooldownTicks: 60,
    lifetimeTicks: 130,
    projectileRadius: 7 * 16,
    pellets: 1,
    spread: 0,
    bounces: 0,
    splashRadius: 56 * 16,
    splashDamage: 46,
    pierce: 0,
    recoil: 1800,
    pickupAmmo: 6,
    maximumAmmo: 24,
    botPreference: 80,
  }),
  weapon({
    id: WEAPON_RICOCHET,
    name: "ricochet",
    sprite: "proj-ricochet",
    damage: 21,
    projectileSpeed: 256,
    cooldownTicks: 12,
    lifetimeTicks: 150,
    projectileRadius: 4 * 16,
    pellets: 1,
    spread: 4,
    bounces: 4,
    splashRadius: 0,
    splashDamage: 0,
    pierce: 0,
    recoil: 260,
    pickupAmmo: 40,
    maximumAmmo: 120,
    botPreference: 55,
  }),
]);

const chassis = (definition: ChassisDefinition): ChassisDefinition => Object.freeze(definition);
const weaponMask = (...ids: number[]): number => ids.reduce((mask, id) => mask | (1 << id), 0);

export const CHASSIS: readonly (ChassisDefinition | undefined)[] = Object.freeze([
  undefined,
  chassis({ id: CHASSIS_SCOUT, name: "scout", role: "interceptor", sprite: "scout", maxHealth: 120, baseArmor: 5,
    acceleration: 8 * 256, maxSpeed: 112 * 256, dragShift: 4, wallBounce: 112, hullSlew: 58, turretSlew: 36,
    knockbackFactor: 180, weaponMask: weaponMask(WEAPON_CANNON, WEAPON_AUTOCANNON, WEAPON_RICOCHET), unlockCost: 0 }),
  chassis({ id: CHASSIS_ASSAULT, name: "assault", role: "linebreaker", sprite: "assault", maxHealth: 170, baseArmor: 20,
    acceleration: 6 * 256, maxSpeed: 88 * 256, dragShift: 5, wallBounce: 96, hullSlew: 44, turretSlew: 26,
    knockbackFactor: 128, weaponMask: weaponMask(WEAPON_CANNON, WEAPON_AUTOCANNON, WEAPON_SCATTER), unlockCost: 150 }),
  chassis({ id: CHASSIS_BULWARK, name: "bulwark", role: "anchor", sprite: "bulwark", maxHealth: 240, baseArmor: 55,
    acceleration: 4 * 256, maxSpeed: 66 * 256, dragShift: 6, wallBounce: 76, hullSlew: 30, turretSlew: 20,
    knockbackFactor: 72, weaponMask: weaponMask(WEAPON_CANNON, WEAPON_MORTAR, WEAPON_RAILGUN), unlockCost: 300 }),
  chassis({ id: CHASSIS_ARTILLERY, name: "artillery", role: "siege", sprite: "artillery", maxHealth: 190, baseArmor: 30,
    acceleration: 5 * 256, maxSpeed: 74 * 256, dragShift: 6, wallBounce: 84, hullSlew: 28, turretSlew: 18,
    knockbackFactor: 96, weaponMask: weaponMask(WEAPON_CANNON, WEAPON_RAILGUN, WEAPON_MORTAR, WEAPON_RICOCHET), unlockCost: 225 }),
]);

export const PICKUP_HEALTH = 10;
export const PICKUP_ARMOR = 11;
export const PICKUP_OVERDRIVE = 12;
export const PICKUP_KIND_COUNT = 13;

const pickup = (definition: PickupDefinition): PickupDefinition => Object.freeze(definition);

/** Indexed by pickup kind. Weapon pickups reuse their weapon id as the kind. */
export const PICKUPS: readonly (PickupDefinition | undefined)[] = Object.freeze([
  undefined,
  undefined, // the cannon is never a pickup; every tank spawns with it
  pickup({ kind: WEAPON_AUTOCANNON, name: "autocannon", sprite: "pickup-machinegun", respawnTicks: 720, weapon: WEAPON_AUTOCANNON, health: 0, armor: 0, overdriveTicks: 0 }),
  pickup({ kind: WEAPON_RAILGUN, name: "railgun", sprite: "pickup-railgun", respawnTicks: 1500, weapon: WEAPON_RAILGUN, health: 0, armor: 0, overdriveTicks: 0 }),
  pickup({ kind: WEAPON_SCATTER, name: "scatter", sprite: "pickup-scatter", respawnTicks: 900, weapon: WEAPON_SCATTER, health: 0, armor: 0, overdriveTicks: 0 }),
  pickup({ kind: WEAPON_MORTAR, name: "mortar", sprite: "pickup-mortar", respawnTicks: 1500, weapon: WEAPON_MORTAR, health: 0, armor: 0, overdriveTicks: 0 }),
  pickup({ kind: WEAPON_RICOCHET, name: "ricochet", sprite: "pickup-ricochet", respawnTicks: 1080, weapon: WEAPON_RICOCHET, health: 0, armor: 0, overdriveTicks: 0 }),
  undefined,
  undefined,
  undefined,
  pickup({ kind: PICKUP_HEALTH, name: "health", sprite: "pickup-health", respawnTicks: 900, weapon: 0, health: 35, armor: 0, overdriveTicks: 0 }),
  pickup({ kind: PICKUP_ARMOR, name: "armor", sprite: "pickup-armor", respawnTicks: 1200, weapon: 0, health: 0, armor: 50, overdriveTicks: 0 }),
  pickup({ kind: PICKUP_OVERDRIVE, name: "overdrive", sprite: "pickup-overdrive", respawnTicks: 2400, weapon: 0, health: 0, armor: 0, overdriveTicks: 600 }),
]);

export const UPGRADES: readonly (UpgradeDefinition | undefined)[] = Object.freeze([
  undefined,
  Object.freeze({ id: UPGRADE_DAMAGE, name: "damage", maximumLevel: 3, baseCost: 100, costPerLevel: 75 }),
  Object.freeze({ id: UPGRADE_MOBILITY, name: "mobility", maximumLevel: 3, baseCost: 100, costPerLevel: 75 }),
  Object.freeze({ id: UPGRADE_ARMOR, name: "armor", maximumLevel: 3, baseCost: 125, costPerLevel: 100 }),
]);

export function weaponById(id: number): WeaponDefinition {
  const definition = WEAPONS[id];
  if (definition === undefined) throw new RangeError(`unknown weapon id ${id}`);
  return definition;
}

export function chassisById(id: number): ChassisDefinition {
  const definition = CHASSIS[id];
  if (definition === undefined) throw new RangeError(`unknown chassis id ${id}`);
  return definition;
}

export function chassisUnlockBit(id: number): number {
  chassisById(id);
  return 1 << (id - 1);
}

export function canUseWeapon(chassisId: number, weaponId: number): boolean {
  return (chassisById(chassisId).weaponMask & (1 << weaponId)) !== 0;
}

export function pickupByKind(kind: number): PickupDefinition {
  const definition = PICKUPS[kind];
  if (definition === undefined) throw new RangeError(`unknown pickup kind ${kind}`);
  return definition;
}

export function upgradeById(id: number): UpgradeDefinition {
  const upgrade = UPGRADES[id];
  if (upgrade === undefined) throw new RangeError(`unknown upgrade id ${id}`);
  return upgrade;
}

export function upgradeCost(upgrade: UpgradeDefinition, currentLevel: number): number {
  return upgrade.baseCost + upgrade.costPerLevel * currentLevel;
}

/** True when the weapon id exists and is carryable. */
export function isWeaponId(id: number): boolean {
  return Number.isInteger(id) && id >= 1 && id <= WEAPON_COUNT;
}
