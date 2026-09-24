import {
  defold,
  defineComponent,
  gui,
  hashLiteral,
  vmath,
  type DefoldHash,
  type Node,
  type Vector4,
} from "@deherm/project";

import {
  EVENT_COVER_CHANGED,
  EVENT_EJECT,
  EVENT_HAZARD_DAMAGE,
  EVENT_KILL,
  EVENT_OBJECTIVE_CAPTURE,
  EVENT_TANK_ACQUIRED,
  MAX_PLAYERS,
  OBJECTIVE_CAPTURE_TICKS,
  PLAYER_MODE_INFANTRY,
  UNITS_PER_PIXEL,
  createPlayerView,
  createObjectiveView,
  chassisById,
  weaponUpgradeById,
  weaponUpgradeId,
  weaponById,
  createBattleEvent,
  driverByPlayerId,
  type BattleEvent,
  type BattleWorld,
  type PlayerView,
  type ObjectiveView,
} from "../src/generated-war-battles/index";
import { arenaMatch } from "../src/arena-match";

const ADD_SCORE = hashLiteral("#add_score");
const DEPLOY = hashLiteral("#deploy");

/** Frames between leaderboard rebuilds. The bar itself updates every frame. */
const LEADERBOARD_INTERVAL = 15;
const LEADERBOARD_ROWS = 5;
/** Characters in the health and ammunition bars. */
/** Presentation notices live for exactly three seconds at the 60 Hz update rate. */
const ANNOUNCEMENT_TICKS = 180;

interface UiSelf {
  score: number;
  node: Node;
  status: Node;
  objective: Node;
  frags: Node;
  hint: Node;
  announcement: Node;
  hudBack: Node;
  portrait: Node;
  healthBack: Node;
  healthFill: Node;
  armorBack: Node;
  armorFill: Node;
  leaderboardBack: Node;
  leaderBack: Node;
  leader: Node;
  titleBack: Node;
  titleLogo: Node;
  titlePanel: Node;
  titlePortrait: Node;
  titleEdition: Node;
  titleFeature: Node;
  titleButton: Node;
  titleDeploy: Node;
  titlePrompt: Node;
  titleSponsor: Node;
  view: PlayerView;
  objectiveView: ObjectiveView;
  order: Int32Array;
  event: BattleEvent;
  presentationWorld: BattleWorld | undefined;
  killColor: Vector4;
  deathColor: Vector4;
  remoteKillColor: Vector4;
  roundColor: Vector4;
  countdown: number;
  eventCursor: number;
  announcementTicks: number;
  round: number;
  engaged: boolean;
  titleVisible: boolean;
}

function setTitleVisible(self: UiSelf, visible: boolean): void {
  self.titleVisible = visible;
  gui.setEnabled(self.titleBack, visible);
  gui.setEnabled(self.titleLogo, visible);
  gui.setEnabled(self.titlePanel, visible);
  gui.setEnabled(self.titlePortrait, visible);
  gui.setEnabled(self.titleEdition, visible);
  gui.setEnabled(self.titleFeature, visible);
  gui.setEnabled(self.titleButton, visible);
  gui.setEnabled(self.titleDeploy, visible);
  gui.setEnabled(self.titlePrompt, visible);
  gui.setEnabled(self.titleSponsor, visible);

  const gameplayVisible = !visible;
  gui.setEnabled(self.hudBack, gameplayVisible);
  gui.setEnabled(self.portrait, gameplayVisible);
  gui.setEnabled(self.healthBack, gameplayVisible);
  gui.setEnabled(self.healthFill, gameplayVisible);
  gui.setEnabled(self.armorBack, gameplayVisible);
  gui.setEnabled(self.armorFill, gameplayVisible);
  gui.setEnabled(self.leaderboardBack, gameplayVisible);
  gui.setEnabled(self.leaderBack, gameplayVisible);
  gui.setEnabled(self.leader, gameplayVisible);
  gui.setEnabled(self.objective, gameplayVisible);
  gui.setEnabled(self.node, gameplayVisible);
  gui.setEnabled(self.status, gameplayVisible);
  gui.setEnabled(self.frags, gameplayVisible);
  gui.setEnabled(self.hint, gameplayVisible);
  gui.setEnabled(self.announcement, gameplayVisible && self.announcementTicks > 0);
}

interface AddScore {
  readonly score: number;
}

function statusLine(self: UiSelf): string {
  const match = arenaMatch();
  const world = match?.world;
  const slot = match === undefined ? -1 : match.localSlot;
  if (world === undefined || slot < 0) return "";
  world.readPlayer(slot + 1, self.view);
  if (!self.view.alive) {
    const seconds = (self.view.respawnTicks / 60).toFixed(1);
    return `WRECKED - RESPAWN IN ${seconds}s`;
  }
  const driver = driverByPlayerId(slot + 1);
  if (self.view.mode === PLAYER_MODE_INFANTRY) {
    const depot = world.nearestTankDepot(slot + 1);
    const dx = world.map.spawnX[depot]! - self.view.x;
    const dy = world.map.spawnY[depot]! - self.view.y;
    const distance = Math.round(Math.sqrt(dx * dx + dy * dy) / UNITS_PER_PIXEL);
    const direction = directionArrow(dx, dy);
    const lock = self.view.respawnTicks > 0 ? `  ACCESS ${Math.ceil(self.view.respawnTicks / 60)}s` : "";
    return `${driver.callSign} // LAST CHANCE // HP ${self.view.health} // PISTOL // DEPOT ${direction} ${distance}px${lock}`;
  }
  const weapon = weaponById(self.view.weaponId);
  const chassis = chassisById(self.view.chassisId);
  const ammo = weapon.maximumAmmo === 0 ? "INF" : `${self.view.ammo}`;
  const branch = (self.view.weaponUpgradeSelections >>> ((weapon.id - 1) * 2)) & 3;
  const upgradeId = weaponUpgradeId(weapon.id, branch);
  const upgrade = upgradeId === 0 ? undefined : weaponUpgradeById(upgradeId);
  const upgradeLabel = upgrade === undefined ? "BASE" : upgrade.name.toUpperCase();
  const overdrive = self.view.overdriveTicks > 0 ? " // OVERDRIVE" : "";
  const hazard = world.activeHazardIndex();
  const hazardText = hazard < 0 ? " // VENTS COOL" : ` // VENT ${hazard + 1} LIVE`;
  return (
    `${driver.callSign} // ${chassis.name.toUpperCase()} // ${weapon.name.toUpperCase()} ${upgradeLabel} // AMMO ${ammo}` +
    ` // CR ${self.view.credits} // BOOST ${self.view.boostTicks}${overdrive}${hazardText}`
  );
}

function directionArrow(x: number, y: number): string {
  const horizontal = x > 0 ? "→" : "←";
  const vertical = y > 0 ? "↑" : "↓";
  if (Math.abs(x) > Math.abs(y) * 2) return horizontal;
  if (Math.abs(y) > Math.abs(x) * 2) return vertical;
  if (x >= 0) return y >= 0 ? "↗" : "↘";
  return y >= 0 ? "↖" : "↙";
}

function leaderboard(self: UiSelf): string {
  const match = arenaMatch();
  const world = match?.world;
  if (world === undefined) return "";
  let count = 0;
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    if (world.playerActive[slot] === 0) continue;
    self.order[count] = slot;
    count += 1;
  }
  // Insertion sort over at most 32 entries, descending by frags. Stable on ties
  // by slot, so the board does not flicker between equal scores.
  for (let index = 1; index < count; index += 1) {
    const candidate = self.order[index]!;
    let position = index - 1;
    while (position >= 0 && world.playerScore[self.order[position]!]! < world.playerScore[candidate]!) {
      self.order[position + 1] = self.order[position]!;
      position -= 1;
    }
    self.order[position + 1] = candidate;
  }
  const localSlot = match === undefined ? -1 : match.localSlot;
  const rows = count < LEADERBOARD_ROWS ? count : LEADERBOARD_ROWS;
  let text = "TOP TANKS       K / D\n";
  for (let row = 0; row < rows; row += 1) {
    const slot = self.order[row]!;
    const marker = slot === localSlot ? ">" : " ";
    const driver = driverByPlayerId(slot + 1);
    text += `${row + 1} ${marker}${driver.callSign}  ${world.playerScore[slot]!} / ${world.playerDeaths[slot]!}\n`;
  }
  if (rows > 0) {
    const leader = self.order[0]!;
    gui.setText(self.leader, `★ LEADER  ${driverByPlayerId(leader + 1).callSign}  //  ${world.playerScore[leader]!}`);
  }
  return text;
}

function updatePlayerHud(self: UiSelf): void {
  const match = arenaMatch();
  const world = match?.world;
  const slot = match === undefined ? -1 : match.localSlot;
  if (world === undefined || slot < 0) return;
  const chassis = chassisById(self.view.chassisId);
  const healthRatio = Math.max(0, Math.min(1, self.view.health / chassis.maxHealth));
  const armorRatio = Math.max(0, Math.min(1, self.view.armor / 200));
  gui.setSize(self.healthFill, vmath.vector3(220 * healthRatio, 11, 0));
  gui.setSize(self.armorFill, vmath.vector3(220 * armorRatio, 8, 0));
}

function objectiveLine(self: UiSelf): string {
  const match = arenaMatch();
  const world = match?.world;
  if (world === undefined) return "";
  const localSlot = match === undefined ? -1 : match.localSlot;
  if (localSlot < 0 || world.playerTeam[localSlot] === 0) return "FREE-FOR-ALL  —  COMMAND BEACON DISABLED";
  const objective = world.readObjective(self.objectiveView);
  if (objective.teamOneScore === 0 && objective.teamTwoScore === 0 && objective.progress === 0) {
    return "COMMAND BEACON  —  TEAM MATCH CAPTURE ZONE";
  }
  const owner = objective.owner === 1 ? "BLUE" : objective.owner === 2 ? "RED" : "CONTESTED";
  const percent = Math.round((Math.abs(objective.progress) * 100) / OBJECTIVE_CAPTURE_TICKS);
  return `COMMAND BEACON  ${owner}  BLUE ${objective.teamOneScore} - ${objective.teamTwoScore} RED  ${percent}%`;
}

function announce(self: UiSelf, text: string, color: Vector4): void {
  // This is deliberately one authored node. A kill storm replaces the current
  // notice rather than allocating GUI nodes or retaining a queue.
  gui.setText(self.announcement, text);
  gui.setColor(self.announcement, color);
  gui.setEnabled(self.announcement, true);
  self.announcementTicks = ANNOUNCEMENT_TICKS;
}

function drainPresentation(self: UiSelf, match: ReturnType<typeof arenaMatch>): void {
  if (match === undefined) return;
  const world = match.world;
  if (world === undefined) return;

  // An offline restart or online reconnect can replace the world with a new
  // ring whose sequence is greater than the old cursor. Identity, not sequence
  // ordering, is therefore the authoritative reset signal.
  if (self.presentationWorld !== world) {
    self.presentationWorld = world;
    self.eventCursor = world.events.oldest();
  }
  if (self.eventCursor < world.events.oldest()) self.eventCursor = world.events.oldest();
  const localPlayerId = match.localSlot + 1;
  while (self.eventCursor < world.events.sequence) {
    if (!world.events.read(self.eventCursor, self.event)) break;
    self.eventCursor += 1;
    if (self.event.kind === EVENT_OBJECTIVE_CAPTURE) {
      announce(self, `TEAM ${self.event.a === 1 ? "BLUE" : "RED"} CAPTURED COMMAND BEACON`, self.roundColor);
      continue;
    }
    if (self.event.kind === EVENT_HAZARD_DAMAGE) {
      if (self.event.a === localPlayerId) announce(self, `VENT ${self.event.b + 1} HIT YOU`, self.deathColor);
      continue;
    }
    if (self.event.kind === EVENT_COVER_CHANGED) {
      if (self.event.b === 0) announce(self, `COVER PANEL ${self.event.a + 1} DESTROYED`, self.roundColor);
      continue;
    }
    if (self.event.kind === EVENT_EJECT) {
      announce(
        self,
        self.event.b === localPlayerId ? "TANK LOST — FIGHT ON FOOT" : `P${self.event.b} EJECTED`,
        self.deathColor,
      );
      continue;
    }
    if (self.event.kind === EVENT_TANK_ACQUIRED) {
      if (self.event.a === localPlayerId) announce(self, "REPLACEMENT TANK ACQUIRED", self.killColor);
      continue;
    }
    if (self.event.kind !== EVENT_KILL) continue;
    const attacker = self.event.a;
    const victim = self.event.b;
    if (attacker === 0) {
      announce(self, victim === localPlayerId ? "VENT DESTROYED YOU" : `P${victim} DESTROYED BY VENT`, self.deathColor);
    } else if (attacker === localPlayerId) {
      announce(self, `YOU DESTROYED P${victim}`, self.killColor);
    } else if (victim === localPlayerId) {
      announce(self, `P${attacker} DESTROYED YOU`, self.deathColor);
    } else {
      announce(self, `P${attacker} DESTROYED P${victim}`, self.remoteKillColor);
    }
  }

  // PlayableBattle owns the authoritative round counter. The event ring is
  // presentation-only, so round changes are sampled once at the same boundary
  // and rendered through the same coalescing/expiry path.
  const round = match.mode === "offline" ? match.battle.round : self.round;
  if (self.round === 0) {
    self.round = round;
  } else if (round !== self.round) {
    self.round = round;
    announce(self, `ROUND ${round}`, self.roundColor);
  }
}

function ageAnnouncement(self: UiSelf): void {
  if (self.announcementTicks <= 0) return;
  self.announcementTicks -= 1;
  if (self.announcementTicks > 0) return;
  gui.setText(self.announcement, "");
  gui.setEnabled(self.announcement, false);
}

export default defineComponent({
  init(self: UiSelf): void {
    self.score = 0;
    self.node = gui.getNode("score");
    self.status = gui.getNode("status");
    self.objective = gui.getNode("objective");
    self.frags = gui.getNode("frags");
    self.hint = gui.getNode("hint");
    self.announcement = gui.getNode("announcement");
    self.hudBack = gui.getNode("hud_back");
    self.portrait = gui.getNode("portrait");
    self.healthBack = gui.getNode("health_back");
    self.healthFill = gui.getNode("health_fill");
    self.armorBack = gui.getNode("armor_back");
    self.armorFill = gui.getNode("armor_fill");
    self.leaderboardBack = gui.getNode("leaderboard_back");
    self.leaderBack = gui.getNode("leader_back");
    self.leader = gui.getNode("leader");
    self.titleBack = gui.getNode("title_back");
    self.titleLogo = gui.getNode("title_logo");
    self.titlePanel = gui.getNode("title_panel");
    self.titlePortrait = gui.getNode("title_portrait");
    self.titleEdition = gui.getNode("title_edition");
    self.titleFeature = gui.getNode("title_feature");
    self.titleButton = gui.getNode("title_button");
    self.titleDeploy = gui.getNode("title_deploy");
    self.titlePrompt = gui.getNode("title_prompt");
    self.titleSponsor = gui.getNode("title_sponsor");
    self.view = createPlayerView();
    self.objectiveView = createObjectiveView();
    self.order = new Int32Array(MAX_PLAYERS);
    self.event = createBattleEvent();
    self.presentationWorld = undefined;
    self.killColor = vmath.vector4(1, 0.86, 0.2, 1);
    self.deathColor = vmath.vector4(1, 0.3, 0.25, 1);
    self.remoteKillColor = vmath.vector4(0.45, 0.9, 1, 1);
    self.roundColor = vmath.vector4(0.82, 1, 0.54, 1);
    self.countdown = 0;
    self.eventCursor = 0;
    self.announcementTicks = 0;
    self.round = 0;
    self.engaged = false;
    self.titleVisible = true;
    gui.setText(self.node, "SCORE 0");
    gui.setText(self.announcement, "");
    gui.setText(self.objective, "");
    gui.setEnabled(self.announcement, false);
    gui.playFlipbook(self.portrait, "driver-portrait-radio-idle");
    gui.playFlipbook(self.titlePortrait, "driver-portrait-radio-idle");
    gui.setText(self.titleFeature, `${driverByPlayerId(1).callSign} // 32 DRIVERS // 6 WEAPONS // NO MERCY`);
    setTitleVisible(self, true);
    defold.log("info", "war-battles:ui-init");
  },

  update(self: UiSelf, _dt: number): void {
    if (self.titleVisible) return;
    const match = arenaMatch();
    if (match === undefined || !match.engaged) return;
    if (!self.engaged) {
      self.engaged = true;
      gui.setText(
        self.hint,
        "ARROWS/WASD DRIVE  SPACE FIRE  SHIFT BOOST  1-6 WEAPON  7-0 CHASSIS  Q/E BRANCH  R RESTART",
      );
    }
    gui.setText(self.status, statusLine(self));
    updatePlayerHud(self);
    gui.setText(self.objective, objectiveLine(self));
    drainPresentation(self, match);
    ageAnnouncement(self);
    if (self.countdown > 0) {
      self.countdown -= 1;
      return;
    }
    self.countdown = LEADERBOARD_INTERVAL;
    gui.setText(self.frags, leaderboard(self));
    const world = match.world;
    const slot = match.localSlot;
    if (world !== undefined && slot >= 0) {
      gui.setText(self.node, `SCORE ${world.playerScore[slot]!}`);
    }
  },

  onMessage(self: UiSelf, messageId: DefoldHash, message: AddScore): void {
    if (messageId === DEPLOY) {
      defold.log("info", "war-battles:title-hidden-by-deploy");
      setTitleVisible(self, false);
      const world = arenaMatch()?.world;
      if (world !== undefined) {
        self.presentationWorld = world;
        self.eventCursor = world.events.sequence;
      }
      return;
    }
    if (messageId !== ADD_SCORE) return;
    self.score += message.score;
    if (!self.titleVisible) gui.setText(self.node, `SCORE ${self.score}`);
    defold.log("info", `war-battles:score:${self.score}`);
  },
});
