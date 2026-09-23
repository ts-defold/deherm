import { defineComponent, gui, hashLiteral, type DefoldHash, type Node } from "@deherm/project";

import {
  MAX_PLAYERS,
  createPlayerView,
  weaponById,
  type PlayerView,
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

interface UiSelf {
  score: number;
  node: Node;
  status: Node;
  frags: Node;
  hint: Node;
  view: PlayerView;
  order: Int32Array;
  countdown: number;
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
  const ammo = weapon.maximumAmmo === 0 ? "INF" : `${self.view.ammo}`;
  const overdrive = self.view.overdriveTicks > 0 ? "  OVERDRIVE" : "";
  return `HP ${bar(self.view.health, 200)} ${self.view.health}` +
    `   AR ${self.view.armor}` +
    `   ${weapon.name.toUpperCase()} ${ammo}` +
    `   BOOST ${bar(self.view.boostTicks, 90)}${overdrive}` +
    `   ROUND ${match?.mode === "offline" ? match.battle.round : 1}`;
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

export default defineComponent({
  init(self: UiSelf): void {
    self.score = 0;
    self.node = gui.getNode("score");
    self.status = gui.getNode("status");
    self.frags = gui.getNode("frags");
    self.hint = gui.getNode("hint");
    self.view = createPlayerView();
    self.order = new Int32Array(MAX_PLAYERS);
    self.countdown = 0;
    self.engaged = false;
    gui.setText(self.node, "SCORE 0");
    __defoldHostV1.log("info", "war-battles:ui-init");
  },

  update(self: UiSelf, _dt: number): void {
    const match = arenaMatch();
    if (match === undefined || !match.engaged) return;
    if (!self.engaged) {
      self.engaged = true;
      gui.setText(self.hint, "ARROWS/WASD DRIVE   SPACE FIRE   SHIFT BOOST   1-6 WEAPON   R RESTART");
    }
    gui.setText(self.status, statusLine(self));
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
