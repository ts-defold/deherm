import { BotController } from "./bots.ts";
import { WEAPON_COUNT, weaponUpgradeId } from "./content.ts";
import { INPUT_BUTTON_BOOST, INPUT_BUTTON_FIRE } from "./constants.ts";
import type { BattleClient } from "./client.ts";
import type { PlayControls } from "./playable.ts";
import { createInputCommand, type InputCommand } from "./protocol.ts";

export interface NetworkBotDriverOptions {
  /** The same 0-3 difficulty rows used by local and authoritative bots. */
  readonly skill?: number;
}

export interface NetworkBotDriverStats {
  commandsStaged: number;
  nonIdleCommands: number;
  chassisRequests: number;
  weaponUpgradeRequests: number;
}

/**
 * Adapts the shared deterministic bot brain to a real network client.
 *
 * `BotController` still reads a predicted `BattleWorld` and stages the same
 * command shape used by local/server bots. `BattleClient` remains responsible
 * for sequencing, snapshot acknowledgements, prediction and transport. This
 * seam only copies the bot's intent into the ordinary client control API.
 */
export class NetworkBotDriver {
  readonly client: BattleClient;
  readonly controller = new BotController();
  readonly stats: NetworkBotDriverStats = {
    commandsStaged: 0,
    nonIdleCommands: 0,
    chassisRequests: 0,
    weaponUpgradeRequests: 0,
  };
  private readonly staged: InputCommand = createInputCommand(0, 1);
  private readonly controls: PlayControls = { moveX: 0, moveY: 0, fire: false, boost: false, weapon: 0 };
  private skill: number;

  constructor(client: BattleClient, options: NetworkBotDriverOptions = {}) {
    this.client = client;
    this.skill = normalizeSkill(options.skill ?? 1);
  }

  setSkill(skill: number): void {
    this.skill = normalizeSkill(skill);
  }

  reset(): void {
    this.controller.reset();
  }

  /** Stages bot intent and advances the ordinary predictive network client. */
  update(elapsedMilliseconds: number, maximumSteps = 8): number {
    const world = this.client.world;
    const playerId = this.client.playerId;
    if (this.client.state !== "ready" || world === undefined || playerId <= 0) {
      return this.client.update(elapsedMilliseconds, maximumSteps);
    }

    // Bot skill is decision state rather than an authoritative gameplay
    // mutation. Reapply the dashboard-selected row after each snapshot restore.
    world.setBotSkill(playerId, this.skill);
    const slot = playerId - 1;
    const previousChassis = world.playerChassis[slot]!;
    const previousWeaponSelections = world.playerWeaponUpgradeSelections[slot]!;
    this.controller.stage(world, this.staged, playerId, world.tick + 1);
    this.stats.commandsStaged += 1;
    if (this.staged.moveX !== 0 || this.staged.moveY !== 0 || this.staged.buttons !== 0) {
      this.stats.nonIdleCommands += 1;
    }

    const selectedChassis = world.playerChassis[slot]!;
    if (selectedChassis !== previousChassis) {
      this.client.sendChassis(selectedChassis);
      this.stats.chassisRequests += 1;
    }
    const selectedWeaponUpgrades = world.playerWeaponUpgradeSelections[slot]!;
    for (let weaponId = 1; weaponId <= WEAPON_COUNT; weaponId += 1) {
      const shift = (weaponId - 1) * 2;
      const previousBranch = (previousWeaponSelections >>> shift) & 3;
      const selectedBranch = (selectedWeaponUpgrades >>> shift) & 3;
      if (selectedBranch === 0 || selectedBranch === previousBranch) continue;
      this.client.sendWeaponUpgrade(weaponUpgradeId(weaponId, selectedBranch));
      this.stats.weaponUpgradeRequests += 1;
    }
    this.controls.moveX = this.staged.moveX;
    this.controls.moveY = this.staged.moveY;
    this.controls.fire = (this.staged.buttons & INPUT_BUTTON_FIRE) !== 0;
    this.controls.boost = (this.staged.buttons & INPUT_BUTTON_BOOST) !== 0;
    this.controls.weapon = this.staged.weaponRequest;
    this.client.setControls(this.controls);
    this.client.setAim(this.staged.aimX, this.staged.aimY);
    return this.client.update(elapsedMilliseconds, maximumSteps);
  }
}

function normalizeSkill(skill: number): number {
  if (!Number.isFinite(skill)) return 1;
  return Math.max(0, Math.min(3, Math.trunc(skill)));
}
