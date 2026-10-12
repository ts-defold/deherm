import {
  defold,
  defineComponent,
  gui,
  hashLiteral,
  vmath,
  type DefoldHash,
  type Node,
  type OnInputAction,
  type Vector4,
} from "@deherm/project";

import {
  EVENT_COVER_CHANGED,
  EVENT_EJECT,
  EVENT_HAZARD_DAMAGE,
  EVENT_KILL,
  EVENT_OBJECTIVE_CAPTURE,
  EVENT_TANK_ACQUIRED,
  INFANTRY_HEALTH,
  MAX_PLAYERS,
  OBJECTIVE_CAPTURE_TICKS,
  PLAYER_MODE_INFANTRY,
  UNITS_PER_PIXEL,
  createPlayerView,
  createObjectiveView,
  chassisById,
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
const TOUCH_ENABLED = hashLiteral("#touch_enabled");
const SCOREBOARD = hashLiteral("#scoreboard");
const TOUCH_MULTI = hashLiteral("#touch_multi");

/** Frames between leaderboard rebuilds. The bar itself updates every frame. */
const LEADERBOARD_INTERVAL = 15;
const LEADERBOARD_ROWS = 5;
const VITALS_FILL_WIDTH = 178;
const VITALS_FILL_HEIGHT = 12;
const DRIVER_PORTRAITS = ["driver-portrait-0", "driver-portrait-1", "driver-portrait-2", "driver-portrait-3"] as const;
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
  touchMoveBack: Node;
  touchMoveLabel: Node;
  touchFireBack: Node;
  touchFireLabel: Node;
  announcement: Node;
  hudBack: Node;
  portrait: Node;
  portraitFrame: Node;
  healthBack: Node;
  healthFill: Node;
  healthLabel: Node;
  armorBack: Node;
  armorFill: Node;
  armorLabel: Node;
  telemetry: Node;
  leaderboardBack: Node;
  leaderBack: Node;
  leader: Node;
  objectiveBack: Node;
  announcementBack: Node;
  scoreBack: Node;
  titleBack: Node;
  titleLogo: Node;
  titlePanel: Node;
  titlePortrait: Node;
  titleEdition: Node;
  titleFeature: Node;
  titleButton: Node;
  titleDeploy: Node;
  titlePromptBack: Node;
  titlePrompt: Node;
  titleSponsorBack: Node;
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
  touchVisible: boolean;
  scoreboardVisible: boolean;
  scoreboardTouchId: number;
  scoreboardTouchSuppressionFrames: number;
  portraitVariant: number;
}

function setScoreboardVisible(self: UiSelf, visible: boolean): void {
  if (self.scoreboardVisible === visible) return;
  self.scoreboardVisible = visible;
  const show = !self.titleVisible && visible;
  gui.setEnabled(self.leaderboardBack, show);
  gui.setEnabled(self.frags, show);
  defold.log("info", `war-battles:scoreboard:visible=${show ? 1 : 0}`);
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
  gui.setEnabled(self.titlePromptBack, visible);
  gui.setEnabled(self.titlePrompt, visible);
  gui.setEnabled(self.titleSponsorBack, visible);
  gui.setEnabled(self.titleSponsor, visible);

  const gameplayVisible = !visible;
  gui.setEnabled(self.hudBack, gameplayVisible);
  gui.setEnabled(self.portrait, gameplayVisible);
  gui.setEnabled(self.portraitFrame, gameplayVisible);
  gui.setEnabled(self.healthBack, gameplayVisible);
  gui.setEnabled(self.healthFill, gameplayVisible);
  gui.setEnabled(self.healthLabel, gameplayVisible);
  gui.setEnabled(self.armorBack, gameplayVisible);
  gui.setEnabled(self.armorFill, gameplayVisible);
  gui.setEnabled(self.armorLabel, gameplayVisible);
  gui.setEnabled(self.telemetry, gameplayVisible);
  gui.setEnabled(self.leaderboardBack, gameplayVisible && self.scoreboardVisible);
  gui.setEnabled(self.leaderBack, gameplayVisible);
  gui.setEnabled(self.leader, gameplayVisible);
  gui.setEnabled(self.objectiveBack, gameplayVisible);
  gui.setEnabled(self.scoreBack, gameplayVisible);
  gui.setEnabled(self.objective, gameplayVisible);
  gui.setEnabled(self.node, gameplayVisible);
  gui.setEnabled(self.status, gameplayVisible);
  gui.setEnabled(self.frags, gameplayVisible && self.scoreboardVisible);
  gui.setEnabled(self.hint, gameplayVisible);
  for (const node of [self.touchMoveBack, self.touchMoveLabel, self.touchFireBack, self.touchFireLabel]) {
    gui.setEnabled(node, gameplayVisible && self.touchVisible);
  }
  gui.setEnabled(self.announcementBack, gameplayVisible && self.announcementTicks > 0);
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
    return `${driverByPlayerId(slot + 1).callSign} // DESTROYED // RESPAWNING ${seconds}s`;
  }
  const driver = driverByPlayerId(slot + 1);
  if (self.view.mode === PLAYER_MODE_INFANTRY) {
    return `${driver.callSign} // ON FOOT // PISTOL // GET A TANK`;
  }
  const weapon = weaponById(self.view.weaponId);
  const chassis = chassisById(self.view.chassisId);
  return `${driver.callSign} // ${chassis.name.toUpperCase()} // ${weapon.name.toUpperCase()}`;
}

function directionArrow(x: number, y: number): string {
  const horizontal = x > 0 ? "E" : "W";
  const vertical = y > 0 ? "N" : "S";
  if (Math.abs(x) > Math.abs(y) * 2) return horizontal;
  if (Math.abs(y) > Math.abs(x) * 2) return vertical;
  if (x >= 0) return y >= 0 ? "NE" : "SE";
  return y >= 0 ? "NW" : "SW";
}

function telemetryLine(self: UiSelf): string {
  const match = arenaMatch();
  const world = match?.world;
  const slot = match === undefined ? -1 : match.localSlot;
  if (world === undefined || slot < 0) return "";
  if (!self.view.alive) return "SYSTEM OFFLINE";
  if (self.view.mode === PLAYER_MODE_INFANTRY) {
    const depot = world.nearestTankDepot(slot + 1);
    const dx = world.map.spawnX[depot]! - self.view.x;
    const dy = world.map.spawnY[depot]! - self.view.y;
    const distance = Math.round(Math.sqrt(dx * dx + dy * dy) / UNITS_PER_PIXEL);
    const lock = self.view.respawnTicks > 0 ? `  LOCK ${Math.ceil(self.view.respawnTicks / 60)}s` : "";
    return `DEPOT ${directionArrow(dx, dy)} ${distance}m${lock}`;
  }
  const weapon = weaponById(self.view.weaponId);
  const ammo = weapon.maximumAmmo === 0 ? "INF" : `${self.view.ammo}`;
  const hazard = world.activeHazardIndex();
  const hazardText = hazard < 0 ? "VENT SAFE" : `VENT ${hazard + 1}`;
  const boost = self.view.overdriveTicks > 0 ? "OVERDRIVE" : `BOOST ${self.view.boostTicks}`;
  return `AMMO ${ammo}  CR ${self.view.credits}\n${boost}  ${hazardText}`;
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
  let text = "TOP 5          K D\n";
  for (let row = 0; row < rows; row += 1) {
    const slot = self.order[row]!;
    const marker = slot === localSlot ? ">" : " ";
    const driver = driverByPlayerId(slot + 1);
    const callSign = driver.callSign.slice(0, 8).padEnd(8, " ");
    text += `${row + 1} ${marker}${callSign} ${world.playerScore[slot]!} ${world.playerDeaths[slot]!}\n`;
  }
  if (rows > 0) {
    const leader = self.order[0]!;
    gui.setText(self.leader, `LEADER  ${driverByPlayerId(leader + 1).callSign}  //  ${world.playerScore[leader]!}`);
  }
  return text;
}

function updatePlayerHud(self: UiSelf): void {
  const match = arenaMatch();
  const world = match?.world;
  const slot = match === undefined ? -1 : match.localSlot;
  if (world === undefined || slot < 0) return;
  const portraitVariant = driverByPlayerId(slot + 1).variant;
  if (self.portraitVariant !== portraitVariant) {
    gui.playFlipbook(self.portrait, DRIVER_PORTRAITS[portraitVariant]!);
    self.portraitVariant = portraitVariant;
  }
  const chassis = chassisById(self.view.chassisId);
  const maximumHealth = self.view.mode === PLAYER_MODE_INFANTRY ? INFANTRY_HEALTH : chassis.maxHealth;
  const healthRatio = Math.max(0, Math.min(1, self.view.health / maximumHealth));
  const armorRatio = Math.max(0, Math.min(1, self.view.armor / 200));
  gui.setSize(self.healthFill, vmath.vector3(VITALS_FILL_WIDTH * healthRatio, VITALS_FILL_HEIGHT, 0));
  gui.setSize(self.armorFill, vmath.vector3(VITALS_FILL_WIDTH * armorRatio, VITALS_FILL_HEIGHT, 0));
  gui.setText(
    self.healthLabel,
    self.view.alive ? `${self.view.mode === PLAYER_MODE_INFANTRY ? "PILOT" : "HULL"} ${self.view.health}` : "DOWN 0",
  );
  gui.setText(self.armorLabel, `ARMOR ${self.view.armor}`);
  gui.setText(self.telemetry, telemetryLine(self));
}

function objectiveLine(self: UiSelf): string {
  const match = arenaMatch();
  const world = match?.world;
  if (world === undefined) return "";
  const localSlot = match === undefined ? -1 : match.localSlot;
  if (localSlot < 0 || world.playerTeam[localSlot] === 0) return "FREE-FOR-ALL  //  BEACON OFFLINE";
  const objective = world.readObjective(self.objectiveView);
  if (objective.teamOneScore === 0 && objective.teamTwoScore === 0 && objective.progress === 0) {
    return "COMMAND BEACON  //  CAPTURE AND HOLD";
  }
  const owner = objective.owner === 1 ? "BLUE" : objective.owner === 2 ? "RED" : "CONTESTED";
  const percent = Math.round((Math.abs(objective.progress) * 100) / OBJECTIVE_CAPTURE_TICKS);
  return `BEACON ${owner}  //  BLUE ${objective.teamOneScore} - ${objective.teamTwoScore} RED  //  ${percent}%`;
}

function announce(self: UiSelf, text: string, color: Vector4): void {
  // This is deliberately one authored node. A kill storm replaces the current
  // notice rather than allocating GUI nodes or retaining a queue. Its centered
  // nine-slice only occupies the width needed by the message; a short round
  // marker should not black out half the battlefield.
  const width = Math.min(520, Math.max(144, text.length * 11 + 44));
  gui.setSize(self.announcementBack, vmath.vector3(width, 42, 0));
  gui.setText(self.announcement, text);
  gui.setColor(self.announcement, color);
  gui.setEnabled(self.announcementBack, true);
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
  gui.setEnabled(self.announcementBack, false);
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
    self.touchMoveBack = gui.getNode("touch_move_back");
    self.touchMoveLabel = gui.getNode("touch_move_label");
    self.touchFireBack = gui.getNode("touch_fire_back");
    self.touchFireLabel = gui.getNode("touch_fire_label");
    self.announcement = gui.getNode("announcement");
    self.hudBack = gui.getNode("hud_back");
    self.portrait = gui.getNode("portrait");
    self.portraitFrame = gui.getNode("portrait_frame");
    self.healthBack = gui.getNode("health_back");
    self.healthFill = gui.getNode("health_fill");
    self.healthLabel = gui.getNode("health_label");
    self.armorBack = gui.getNode("armor_back");
    self.armorFill = gui.getNode("armor_fill");
    self.armorLabel = gui.getNode("armor_label");
    self.telemetry = gui.getNode("telemetry");
    self.leaderboardBack = gui.getNode("leaderboard_back");
    self.leaderBack = gui.getNode("leader_back");
    self.leader = gui.getNode("leader");
    self.objectiveBack = gui.getNode("objective_back");
    self.announcementBack = gui.getNode("announcement_back");
    self.scoreBack = gui.getNode("score_back");
    self.titleBack = gui.getNode("title_back");
    self.titleLogo = gui.getNode("title_logo");
    self.titlePanel = gui.getNode("title_panel");
    self.titlePortrait = gui.getNode("title_portrait");
    self.titleEdition = gui.getNode("title_edition");
    self.titleFeature = gui.getNode("title_feature");
    self.titleButton = gui.getNode("title_button");
    self.titleDeploy = gui.getNode("title_deploy");
    self.titlePromptBack = gui.getNode("title_prompt_back");
    self.titlePrompt = gui.getNode("title_prompt");
    self.titleSponsorBack = gui.getNode("title_sponsor_back");
    self.titleSponsor = gui.getNode("title_sponsor");
    const bottomLeftNodes = [
      self.hudBack,
      self.portrait,
      self.portraitFrame,
      self.healthBack,
      self.healthFill,
      self.healthLabel,
      self.armorBack,
      self.armorFill,
      self.armorLabel,
      self.telemetry,
      self.status,
      self.hint,
    ];
    for (const node of bottomLeftNodes) {
      gui.setXanchor(node, gui.ANCHOR_LEFT);
      gui.setYanchor(node, gui.ANCHOR_BOTTOM);
    }
    for (const node of [self.leaderboardBack, self.frags]) {
      gui.setXanchor(node, gui.ANCHOR_RIGHT);
      gui.setYanchor(node, gui.ANCHOR_TOP);
    }
    for (const node of [self.leaderBack, self.leader, self.objectiveBack, self.objective]) {
      gui.setYanchor(node, gui.ANCHOR_TOP);
    }
    for (const node of [self.announcementBack, self.announcement]) {
      gui.setYanchor(node, gui.ANCHOR_TOP);
    }
    for (const node of [self.scoreBack, self.node]) {
      gui.setXanchor(node, gui.ANCHOR_LEFT);
      gui.setYanchor(node, gui.ANCHOR_TOP);
    }
    for (const node of [self.touchMoveBack, self.touchMoveLabel]) {
      gui.setXanchor(node, gui.ANCHOR_LEFT);
      gui.setYanchor(node, gui.ANCHOR_BOTTOM);
    }
    for (const node of [self.touchFireBack, self.touchFireLabel]) {
      gui.setXanchor(node, gui.ANCHOR_RIGHT);
      gui.setYanchor(node, gui.ANCHOR_BOTTOM);
    }
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
    self.touchVisible = false;
    self.scoreboardVisible = false;
    self.scoreboardTouchId = -1;
    self.scoreboardTouchSuppressionFrames = 0;
    self.portraitVariant = -1;
    gui.setText(self.node, "SCORE 0");
    gui.setText(self.announcement, "");
    gui.setText(self.objective, "");
    gui.setEnabled(self.announcementBack, false);
    gui.setEnabled(self.announcement, false);
    gui.playFlipbook(self.portrait, DRIVER_PORTRAITS[0]);
    gui.playFlipbook(self.titlePortrait, DRIVER_PORTRAITS[driverByPlayerId(1).variant]!);
    gui.setText(self.titleFeature, `${driverByPlayerId(1).callSign} // 16 PLAYERS // 6 WEAPONS`);
    setTitleVisible(self, true);
    defold.log("info", "war-battles:ui-init");
  },

  update(self: UiSelf, _dt: number): void {
    if (self.scoreboardTouchSuppressionFrames > 0) self.scoreboardTouchSuppressionFrames -= 1;
    if (self.titleVisible) return;
    const match = arenaMatch();
    if (match === undefined || !match.engaged) return;
    if (!self.engaged) {
      self.engaged = true;
      gui.setText(
        self.hint,
        self.touchVisible
          ? "LEFT DRIVE   RIGHT AIM + FIRE   TAP LEADER: SCORES"
          : "WASD DRIVE   MOUSE AIM   SPACE FIRE   TAB SCORES",
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
    if (messageId === TOUCH_ENABLED) {
      self.touchVisible = true;
      gui.setText(self.hint, "LEFT DRIVE   RIGHT AIM + FIRE   TAP LEADER: SCORES");
      setTitleVisible(self, self.titleVisible);
      return;
    }
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

  onInput(self: UiSelf, actionId: DefoldHash, action: OnInputAction): boolean {
    if (self.titleVisible) return false;
    if (actionId === SCOREBOARD) {
      if (action.pressed) setScoreboardVisible(self, true);
      else if (action.released) setScoreboardVisible(self, false);
      return true;
    }
    // HTML5 can dispatch a mouse-style press before the touch action and a
    // mouse release afterward. Activating pointers on release lets the touch
    // path consume the tap first. Keep suppressing mouse actions for the full
    // lifetime of that finger, not just a fixed number of held frames.
    if (actionId === DEPLOY && (self.scoreboardTouchId >= 0 || self.scoreboardTouchSuppressionFrames > 0)) {
      return true;
    }
    if (
      actionId === DEPLOY &&
      action.released &&
      action.x !== undefined &&
      action.y !== undefined &&
      gui.pickNode(self.leaderBack, action.x, action.y)
    ) {
      setScoreboardVisible(self, !self.scoreboardVisible);
      return true;
    }
    if (actionId === TOUCH_MULTI && action.touch !== undefined) {
      for (const touch of action.touch) {
        if (touch.released && touch.id === self.scoreboardTouchId) {
          self.scoreboardTouchId = -1;
          self.scoreboardTouchSuppressionFrames = 20;
          return true;
        }
        if (self.scoreboardTouchId >= 0 || !touch.pressed || !gui.pickNode(self.leaderBack, touch.x, touch.y)) {
          continue;
        }
        self.scoreboardTouchId = touch.id;
        setScoreboardVisible(self, !self.scoreboardVisible);
        return true;
      }
      if (self.scoreboardTouchId >= 0 && action.touch.length === 0) {
        self.scoreboardTouchId = -1;
        self.scoreboardTouchSuppressionFrames = 20;
        return true;
      }
    }
    return false;
  },
});
