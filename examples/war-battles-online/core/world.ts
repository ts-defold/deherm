import {
  DIRECTION_DIAGONAL,
  DIRECTION_SCALE,
  INPUT_BUTTON_FIRE,
  INPUT_HISTORY_TICKS,
  INPUT_HOLD_TICKS,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  MUZZLE_OFFSET,
  PLAYER_RADIUS,
  PROJECTILE_RADIUS,
  SNAPSHOT_BYTES,
  WORLD_MAX,
  WORLD_MIN,
} from "./constants.ts";
import {
  UPGRADE_ARMOR,
  UPGRADE_DAMAGE,
  UPGRADE_MOBILITY,
  WEAPON_CANNON,
  upgradeById,
  upgradeCost,
  weaponById,
} from "./content.ts";
import { validateInputCommand, type InputCommand } from "./protocol.ts";
import { readWorldSnapshot, writeWorldSnapshot } from "./snapshot.ts";

export interface PlayerView {
  active: boolean;
  entityId: number;
  playerId: number;
  team: number;
  x: number;
  y: number;
  aimX: number;
  aimY: number;
  health: number;
  score: number;
  credits: number;
  weaponId: number;
  damageLevel: number;
  mobilityLevel: number;
  armorLevel: number;
}

export interface ProjectileView {
  active: boolean;
  entityId: number;
  ownerPlayerId: number;
  weaponId: number;
  x: number;
  y: number;
  directionX: number;
  directionY: number;
  damage: number;
  lifeTicks: number;
}

const ENTITY_KIND_PLAYER = 1;
const ENTITY_KIND_PROJECTILE = 2;
const EMPTY_INPUT_TICK = 0xffff_ffff;

/**
 * Server-authoritative deterministic state. All gameplay stores and input history
 * are fixed-size typed arrays allocated by the constructor. step() itself creates
 * no objects or containers; this is an architectural property, not a VM-level
 * zero-allocation measurement.
 */
export class BattleWorld {
  tick = 0;
  projectileCursor = 0;
  readonly matchId: number;

  readonly playerActive = new Uint8Array(MAX_PLAYERS);
  readonly playerGeneration = new Uint16Array(MAX_PLAYERS);
  readonly playerTeam = new Uint8Array(MAX_PLAYERS);
  readonly playerWeapon = new Uint8Array(MAX_PLAYERS);
  readonly playerDamageLevel = new Uint8Array(MAX_PLAYERS);
  readonly playerMobilityLevel = new Uint8Array(MAX_PLAYERS);
  readonly playerArmorLevel = new Uint8Array(MAX_PLAYERS);
  readonly playerX = new Int32Array(MAX_PLAYERS);
  readonly playerY = new Int32Array(MAX_PLAYERS);
  readonly playerAimX = new Int16Array(MAX_PLAYERS);
  readonly playerAimY = new Int16Array(MAX_PLAYERS);
  readonly playerHealth = new Int16Array(MAX_PLAYERS);
  readonly playerCooldown = new Uint16Array(MAX_PLAYERS);
  readonly playerScore = new Int32Array(MAX_PLAYERS);
  readonly playerCredits = new Int32Array(MAX_PLAYERS);
  readonly playerLastInputTick = new Int32Array(MAX_PLAYERS);
  readonly playerLastSequence = new Uint16Array(MAX_PLAYERS);
  readonly playerLastMoveX = new Int8Array(MAX_PLAYERS);
  readonly playerLastMoveY = new Int8Array(MAX_PLAYERS);
  readonly playerLastAimX = new Int8Array(MAX_PLAYERS);
  readonly playerLastAimY = new Int8Array(MAX_PLAYERS);
  readonly playerLastButtons = new Uint8Array(MAX_PLAYERS);

  readonly projectileActive = new Uint8Array(MAX_PROJECTILES);
  readonly projectileGeneration = new Uint16Array(MAX_PROJECTILES);
  readonly projectileOwner = new Uint8Array(MAX_PROJECTILES);
  readonly projectileWeapon = new Uint8Array(MAX_PROJECTILES);
  readonly projectileDamage = new Int16Array(MAX_PROJECTILES);
  readonly projectileX = new Int32Array(MAX_PROJECTILES);
  readonly projectileY = new Int32Array(MAX_PROJECTILES);
  readonly projectileDirectionX = new Int16Array(MAX_PROJECTILES);
  readonly projectileDirectionY = new Int16Array(MAX_PROJECTILES);
  readonly projectileLife = new Uint16Array(MAX_PROJECTILES);

  private readonly inputTick = new Uint32Array(MAX_PLAYERS * INPUT_HISTORY_TICKS);
  private readonly inputSequence = new Uint16Array(MAX_PLAYERS * INPUT_HISTORY_TICKS);
  private readonly inputMoveX = new Int8Array(MAX_PLAYERS * INPUT_HISTORY_TICKS);
  private readonly inputMoveY = new Int8Array(MAX_PLAYERS * INPUT_HISTORY_TICKS);
  private readonly inputAimX = new Int8Array(MAX_PLAYERS * INPUT_HISTORY_TICKS);
  private readonly inputAimY = new Int8Array(MAX_PLAYERS * INPUT_HISTORY_TICKS);
  private readonly inputButtons = new Uint8Array(MAX_PLAYERS * INPUT_HISTORY_TICKS);
  private readonly hashScratch = new Uint8Array(SNAPSHOT_BYTES);

  constructor(matchId: number) {
    if (!Number.isInteger(matchId) || matchId < 0 || matchId > 0xffff_ffff) {
      throw new RangeError("matchId must be an unsigned 32-bit integer");
    }
    this.matchId = matchId;
    this.inputTick.fill(EMPTY_INPUT_TICK);
    this.playerLastInputTick.fill(-1);
  }

  addPlayer(playerId: number, team = 0, x?: number, y?: number): number {
    const slot = playerSlot(playerId);
    if (this.playerActive[slot] !== 0) throw new Error(`player ${playerId} is already active`);
    if (!Number.isInteger(team) || team < 0 || team > 255) throw new RangeError("team must be an unsigned byte");
    const generation = nextGeneration(this.playerGeneration[slot]!);
    this.playerGeneration[slot] = generation;
    this.playerActive[slot] = 1;
    this.playerTeam[slot] = team;
    this.playerWeapon[slot] = WEAPON_CANNON;
    this.playerX[slot] = checkedCoordinate(x ?? defaultSpawnX(slot));
    this.playerY[slot] = checkedCoordinate(y ?? defaultSpawnY(slot));
    this.playerAimX[slot] = DIRECTION_SCALE;
    this.playerAimY[slot] = 0;
    this.playerHealth[slot] = maximumHealth(0);
    this.playerLastInputTick[slot] = -1;
    return entityId(ENTITY_KIND_PLAYER, slot, generation);
  }

  removePlayer(playerId: number): void {
    const slot = playerSlot(playerId);
    this.playerActive[slot] = 0;
    for (let projectile = 0; projectile < MAX_PROJECTILES; projectile += 1) {
      if (this.projectileActive[projectile] !== 0 && this.projectileOwner[projectile] === playerId) {
        this.projectileActive[projectile] = 0;
      }
    }
  }

  submitInput(command: Readonly<InputCommand>): boolean {
    validateInputCommand(command);
    if (command.matchId !== this.matchId) return false;
    const slot = playerSlot(command.playerId);
    if (this.playerActive[slot] === 0) return false;
    if (command.tick <= this.tick || command.tick > this.tick + INPUT_HISTORY_TICKS - 1) return false;
    const input = inputIndex(slot, command.tick);
    if (this.inputTick[input] === command.tick && !sequenceIsNewer(command.sequence, this.inputSequence[input]!)) return false;
    this.inputTick[input] = command.tick;
    this.inputSequence[input] = command.sequence;
    this.inputMoveX[input] = command.moveX;
    this.inputMoveY[input] = command.moveY;
    this.inputAimX[input] = command.aimX;
    this.inputAimY[input] = command.aimY;
    this.inputButtons[input] = command.buttons;
    return true;
  }

  step(): void {
    this.tick = (this.tick + 1) >>> 0;
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      if (this.playerActive[slot] === 0) continue;
      this.consumeInput(slot);
      if (this.playerCooldown[slot]! > 0) this.playerCooldown[slot] = this.playerCooldown[slot]! - 1;
      this.movePlayer(slot);
      if ((this.playerLastButtons[slot]! & INPUT_BUTTON_FIRE) !== 0) this.tryFire(slot);
      // Buttons are impulses. Axes remain held for a bounded loss-tolerance window.
      this.playerLastButtons[slot] = 0;
    }
    this.stepProjectiles();
  }

  setWeapon(playerId: number, weaponId: number): void {
    weaponById(weaponId);
    const slot = activePlayerSlot(this, playerId);
    this.playerWeapon[slot] = weaponId;
  }

  grantCredits(playerId: number, amount: number): void {
    if (!Number.isInteger(amount) || amount < 0) throw new RangeError("credit grant must be a non-negative integer");
    const slot = activePlayerSlot(this, playerId);
    const next = this.playerCredits[slot]! + amount;
    if (next > 0x7fff_ffff) throw new RangeError("credit grant overflows the score representation");
    this.playerCredits[slot] = next;
  }

  applyUpgrade(playerId: number, upgradeId: number): boolean {
    const slot = activePlayerSlot(this, playerId);
    const definition = upgradeById(upgradeId);
    const current = upgradeId === UPGRADE_DAMAGE
      ? this.playerDamageLevel[slot]!
      : upgradeId === UPGRADE_MOBILITY
        ? this.playerMobilityLevel[slot]!
        : this.playerArmorLevel[slot]!;
    if (current >= definition.maximumLevel) return false;
    const cost = upgradeCost(definition, current);
    if (this.playerCredits[slot]! < cost) return false;
    this.playerCredits[slot] = this.playerCredits[slot]! - cost;
    if (upgradeId === UPGRADE_DAMAGE) this.playerDamageLevel[slot] = current + 1;
    else if (upgradeId === UPGRADE_MOBILITY) this.playerMobilityLevel[slot] = current + 1;
    else {
      this.playerArmorLevel[slot] = current + 1;
      this.playerHealth[slot] = this.playerHealth[slot]! + 25;
    }
    return true;
  }

  readPlayer(playerId: number, output: PlayerView): boolean {
    const slot = playerSlot(playerId);
    const active = this.playerActive[slot] !== 0;
    output.active = active;
    output.playerId = playerId;
    output.entityId = entityId(ENTITY_KIND_PLAYER, slot, this.playerGeneration[slot]!);
    output.team = this.playerTeam[slot]!;
    output.x = this.playerX[slot]!;
    output.y = this.playerY[slot]!;
    output.aimX = this.playerAimX[slot]!;
    output.aimY = this.playerAimY[slot]!;
    output.health = this.playerHealth[slot]!;
    output.score = this.playerScore[slot]!;
    output.credits = this.playerCredits[slot]!;
    output.weaponId = this.playerWeapon[slot]!;
    output.damageLevel = this.playerDamageLevel[slot]!;
    output.mobilityLevel = this.playerMobilityLevel[slot]!;
    output.armorLevel = this.playerArmorLevel[slot]!;
    return active;
  }

  readProjectile(slot: number, output: ProjectileView): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PROJECTILES) throw new RangeError("projectile slot is out of range");
    const active = this.projectileActive[slot] !== 0;
    output.active = active;
    output.entityId = entityId(ENTITY_KIND_PROJECTILE, slot, this.projectileGeneration[slot]!);
    output.ownerPlayerId = this.projectileOwner[slot]!;
    output.weaponId = this.projectileWeapon[slot]!;
    output.x = this.projectileX[slot]!;
    output.y = this.projectileY[slot]!;
    output.directionX = this.projectileDirectionX[slot]!;
    output.directionY = this.projectileDirectionY[slot]!;
    output.damage = this.projectileDamage[slot]!;
    output.lifeTicks = this.projectileLife[slot]!;
    return active;
  }

  writeSnapshot(target: Uint8Array, byteOffset = 0): number {
    return writeWorldSnapshot(this, target, byteOffset);
  }

  restoreSnapshot(source: Uint8Array, byteOffset = 0): number {
    return readWorldSnapshot(this, source, byteOffset);
  }

  stateHash(): number {
    this.writeSnapshot(this.hashScratch);
    let hash = 0x811c9dc5;
    for (let index = 0; index < this.hashScratch.length; index += 1) {
      hash ^= this.hashScratch[index]!;
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  private consumeInput(slot: number): void {
    const input = inputIndex(slot, this.tick);
    if (this.inputTick[input] === this.tick) {
      this.playerLastInputTick[slot] = this.tick;
      this.playerLastSequence[slot] = this.inputSequence[input]!;
      this.playerLastMoveX[slot] = this.inputMoveX[input]!;
      this.playerLastMoveY[slot] = this.inputMoveY[input]!;
      this.playerLastAimX[slot] = this.inputAimX[input]!;
      this.playerLastAimY[slot] = this.inputAimY[input]!;
      this.playerLastButtons[slot] = this.inputButtons[input]!;
      this.inputTick[input] = EMPTY_INPUT_TICK;
    } else if (this.tick - this.playerLastInputTick[slot]! > INPUT_HOLD_TICKS) {
      this.playerLastMoveX[slot] = 0;
      this.playerLastMoveY[slot] = 0;
    }
    if (this.playerLastAimX[slot] !== 0 || this.playerLastAimY[slot] !== 0) {
      this.playerAimX[slot] = directionComponent(this.playerLastAimX[slot]!, this.playerLastAimY[slot]!);
      this.playerAimY[slot] = directionComponent(this.playerLastAimY[slot]!, this.playerLastAimX[slot]!);
    }
  }

  private movePlayer(slot: number): void {
    const moveX = this.playerLastMoveX[slot]!;
    const moveY = this.playerLastMoveY[slot]!;
    if (moveX === 0 && moveY === 0) return;
    const directionX = directionComponent(moveX, moveY);
    const directionY = directionComponent(moveY, moveX);
    const speed = 64 + this.playerMobilityLevel[slot]! * 8;
    this.playerX[slot] = clampWorld(this.playerX[slot]! + Math.trunc(directionX * speed / DIRECTION_SCALE));
    this.playerY[slot] = clampWorld(this.playerY[slot]! + Math.trunc(directionY * speed / DIRECTION_SCALE));
  }

  private tryFire(slot: number): void {
    if (this.playerCooldown[slot] !== 0 || this.playerHealth[slot]! <= 0) return;
    const weapon = weaponById(this.playerWeapon[slot]!);
    const projectile = this.acquireProjectile();
    if (projectile < 0) return;
    const aimX = this.playerAimX[slot]!;
    const aimY = this.playerAimY[slot]!;
    this.projectileActive[projectile] = 1;
    this.projectileOwner[projectile] = slot + 1;
    this.projectileWeapon[projectile] = weapon.id;
    this.projectileDamage[projectile] = weapon.damage + this.playerDamageLevel[slot]! * 5;
    this.projectileDirectionX[projectile] = aimX;
    this.projectileDirectionY[projectile] = aimY;
    this.projectileX[projectile] = this.playerX[slot]! + Math.trunc(aimX * MUZZLE_OFFSET / DIRECTION_SCALE);
    this.projectileY[projectile] = this.playerY[slot]! + Math.trunc(aimY * MUZZLE_OFFSET / DIRECTION_SCALE);
    this.projectileLife[projectile] = weapon.lifetimeTicks;
    this.playerCooldown[slot] = weapon.cooldownTicks;
  }

  private acquireProjectile(): number {
    for (let count = 0; count < MAX_PROJECTILES; count += 1) {
      const slot = (this.projectileCursor + count) % MAX_PROJECTILES;
      if (this.projectileActive[slot] === 0) {
        this.projectileCursor = (slot + 1) % MAX_PROJECTILES;
        this.projectileGeneration[slot] = nextGeneration(this.projectileGeneration[slot]!);
        return slot;
      }
    }
    return -1;
  }

  private stepProjectiles(): void {
    const hitRadius = PLAYER_RADIUS + PROJECTILE_RADIUS;
    const hitRadiusSquared = hitRadius * hitRadius;
    for (let projectile = 0; projectile < MAX_PROJECTILES; projectile += 1) {
      if (this.projectileActive[projectile] === 0) continue;
      const weapon = weaponById(this.projectileWeapon[projectile]!);
      this.projectileX[projectile] = this.projectileX[projectile]! + Math.trunc(this.projectileDirectionX[projectile]! * weapon.projectileSpeed / DIRECTION_SCALE);
      this.projectileY[projectile] = this.projectileY[projectile]! + Math.trunc(this.projectileDirectionY[projectile]! * weapon.projectileSpeed / DIRECTION_SCALE);
      this.projectileLife[projectile] = this.projectileLife[projectile]! - 1;
      if (
        this.projectileLife[projectile] === 0 ||
        this.projectileX[projectile]! < WORLD_MIN || this.projectileX[projectile]! > WORLD_MAX ||
        this.projectileY[projectile]! < WORLD_MIN || this.projectileY[projectile]! > WORLD_MAX
      ) {
        this.projectileActive[projectile] = 0;
        continue;
      }
      const ownerPlayerId = this.projectileOwner[projectile]!;
      const ownerSlot = ownerPlayerId - 1;
      for (let target = 0; target < MAX_PLAYERS; target += 1) {
        if (target === ownerSlot || this.playerActive[target] === 0 || this.playerHealth[target]! <= 0) continue;
        if (this.playerTeam[target] !== 0 && this.playerTeam[target] === this.playerTeam[ownerSlot]) continue;
        const dx = this.playerX[target]! - this.projectileX[projectile]!;
        const dy = this.playerY[target]! - this.projectileY[projectile]!;
        if (dx * dx + dy * dy > hitRadiusSquared) continue;
        this.playerHealth[target] = Math.max(0, this.playerHealth[target]! - this.projectileDamage[projectile]!);
        this.projectileActive[projectile] = 0;
        if (this.playerHealth[target] === 0) {
          this.playerScore[ownerSlot] = this.playerScore[ownerSlot]! + 1;
          this.playerCredits[ownerSlot] = this.playerCredits[ownerSlot]! + 100;
        }
        break;
      }
    }
  }
}

function playerSlot(playerId: number): number {
  if (!Number.isInteger(playerId) || playerId < 1 || playerId > MAX_PLAYERS) {
    throw new RangeError("playerId must be in [1, 32]");
  }
  return playerId - 1;
}

function activePlayerSlot(world: BattleWorld, playerId: number): number {
  const slot = playerSlot(playerId);
  if (world.playerActive[slot] === 0) throw new Error(`player ${playerId} is not active`);
  return slot;
}

function inputIndex(slot: number, tick: number): number {
  return slot * INPUT_HISTORY_TICKS + (tick % INPUT_HISTORY_TICKS);
}

function sequenceIsNewer(candidate: number, existing: number): boolean {
  const distance = (candidate - existing) & 0xffff;
  return distance !== 0 && distance < 0x8000;
}

function directionComponent(primary: number, secondary: number): number {
  if (primary === 0) return 0;
  const sign = primary < 0 ? -1 : 1;
  if (secondary === 0) return sign * DIRECTION_SCALE;
  return sign * DIRECTION_DIAGONAL;
}

function clampWorld(value: number): number {
  return value < WORLD_MIN ? WORLD_MIN : value > WORLD_MAX ? WORLD_MAX : value;
}

function checkedCoordinate(value: number): number {
  if (!Number.isInteger(value) || value < WORLD_MIN || value > WORLD_MAX) {
    throw new RangeError(`coordinate must be an integer in [${WORLD_MIN}, ${WORLD_MAX}]`);
  }
  return value;
}

function defaultSpawnX(slot: number): number {
  return -12_000 + (slot % 8) * 3_200;
}

function defaultSpawnY(slot: number): number {
  return -12_000 + Math.trunc(slot / 8) * 6_400;
}

function maximumHealth(armorLevel: number): number {
  return 100 + armorLevel * 25;
}

function nextGeneration(current: number): number {
  const next = (current + 1) & 0xffff;
  return next === 0 ? 1 : next;
}

function entityId(kind: number, slot: number, generation: number): number {
  return (((generation & 0xffff) << 16) | ((kind & 0x0f) << 12) | (slot & 0x0fff)) >>> 0;
}
