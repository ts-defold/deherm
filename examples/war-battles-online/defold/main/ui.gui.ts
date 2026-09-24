import { defineComponent, gui, hashLiteral, vmath, type DefoldHash, type Node, type Vector4 } from "@deherm/project";

import {
  EVENT_KILL,
  EVENT_OBJECTIVE_CAPTURE,
  MAX_PLAYERS,
  OBJECTIVE_CAPTURE_TICKS,
  createPlayerView,
  createObjectiveView,
  chassisById,
  weaponUpgradeById,
  weaponUpgradeId,
  weaponById,
  createBattleEvent,
  type BattleEvent,
  type BattleWorld,
  type PlayerView,
  type ObjectiveView,
} from "../src/generated-war-battles/index";
import { arenaMatch } from "../src/arena-match";

declare const __defoldHostV1: {
  log(level: "info", message: string): void;
};

const ADD_SCORE = hashLiteral("#add_score");

/** Frames between leaderboard rebuilds. The bar itself updates every frame. */
const LEADERBOARD_INTERVAL = 15;
const LEADERBOARD_ROWS = 5;
/** Characters in the health and ammunition bars. */
const BAR_CELLS = 20;
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
}

interface AddScore {
  readonly score: number;
}

/** A fixed-width bar drawn out of two characters, so the HUD needs no textures. */
function bar(value: number, maximum: number): string {
  if (maximum <= 0) return "";
  let filled = Math.round((value * BAR_CELLS) / maximum);
  if (filled < 0) filled = 0;
  if (filled > BAR_CELLS) filled = BAR_CELLS;
  let text = "";
  for (let cell = 0; cell < BAR_CELLS; cell += 1) text += cell < filled ? "#" : ".";
  return text;
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
  const weapon = weaponById(self.view.weaponId);
  const chassis = chassisById(self.view.chassisId);
  const ammo = weapon.maximumAmmo === 0 ? "INF" : `${self.view.ammo}`;
  const branch = (self.view.weaponUpgradeSelections >>> ((weapon.id - 1) * 2)) & 3;
  const upgradeId = weaponUpgradeId(weapon.id, branch);
  const upgrade = upgradeId === 0 ? undefined : weaponUpgradeById(upgradeId);
  const upgradeLabel = upgrade === undefined ? "BASE" : upgrade.name.toUpperCase();
  const overdrive = self.view.overdriveTicks > 0 ? "  OVERDRIVE" : "";
  return `${chassis.name.toUpperCase()} ${chassis.role.toUpperCase()}  HP ${self.view.health}/${chassis.maxHealth}` +
    ` AR ${self.view.armor}  ${weapon.name.toUpperCase()}/${upgradeLabel} ${ammo}` +
    `  CR ${self.view.credits} B${self.view.boostTicks} R${match?.mode === "offline" ? match.battle.round : 1}${overdrive}`;
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
  let text = "FRAGS\n";
  for (let row = 0; row < rows; row += 1) {
    const slot = self.order[row]!;
    const marker = slot === localSlot ? ">" : " ";
    text += `${marker}P${slot + 1} ${world.playerScore[slot]!}/${world.playerDeaths[slot]!}\n`;
  }
  return text;
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
    if (self.event.kind !== EVENT_KILL) continue;
    const attacker = self.event.a;
    const victim = self.event.b;
    if (attacker === localPlayerId) {
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
    gui.setText(self.node, "SCORE 0");
    gui.setText(self.announcement, "");
    gui.setText(self.objective, "");
    gui.setEnabled(self.announcement, false);
    __defoldHostV1.log("info", "war-battles:ui-init");
  },

  update(self: UiSelf, _dt: number): void {
    const match = arenaMatch();
    if (match === undefined || !match.engaged) return;
    if (!self.engaged) {
      self.engaged = true;
      gui.setText(self.hint, "ARROWS/WASD DRIVE  SPACE FIRE  SHIFT BOOST  1-6 WEAPON  7-0 CHASSIS  Q/E BRANCH  R RESTART");
    }
    gui.setText(self.status, statusLine(self));
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
    if (messageId !== ADD_SCORE) return;
    self.score += message.score;
    gui.setText(self.node, `SCORE ${self.score}`);
    __defoldHostV1.log("info", `war-battles:score:${self.score}`);
  },
});
