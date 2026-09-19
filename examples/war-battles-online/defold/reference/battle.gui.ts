import {
  defineComponent,
  gui,
  hashLiteral,
  msg,
  vmath,
  type DefoldHash,
  type Node,
  type OnInputAction,
  type Vector4,
} from "@deherm/project";

import {
  aimDegrees,
  arenaSpan,
  LOCAL_PLAYER_ID,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  PlayableBattle,
  projectWorldToScreen,
  TICK_RATE,
  UPGRADE_ARMOR,
  UPGRADE_DAMAGE,
  UPGRADE_MOBILITY,
  visibleAt,
  WEAPON_AUTOCANNON,
  WEAPON_RAILGUN,
  type ScreenPoint,
} from "../src/generated-war-battles/index";
import { DEFOLD_ATTACHMENT_ALLOWED } from "../src/capability-snapshot";

declare const __defoldHostV1: {
  log(level: "info", message: string): void;
};

const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 720;
const VIEW_SCALE = 0.035;
const FIXED_DT = 1 / TICK_RATE;
const VISIBLE_PROJECTILES = 160;
const MAX_CATCHUP_STEPS = 8;
const EXPLOSION_VISIBLE_TICKS = 34;

const UP = hashLiteral("#up");
const DOWN = hashLiteral("#down");
const LEFT = hashLiteral("#left");
const RIGHT = hashLiteral("#right");
const FIRE = hashLiteral("#fire");
const RESTART = hashLiteral("#restart");
const UPGRADE_DAMAGE_ACTION = hashLiteral("#upgrade_damage");
const UPGRADE_MOBILITY_ACTION = hashLiteral("#upgrade_mobility");
const UPGRADE_ARMOR_ACTION = hashLiteral("#upgrade_armor");

interface BattleGuiSelf {
  battle: PlayableBattle;
  accumulator: number;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
  bodies: Node[];
  turrets: Node[];
  projectiles: Node[];
  explosions: Node[];
  previousHealth: Int16Array;
  explosionUntil: Int32Array;
  arena: Node;
  healthFill: Node;
  hud: Node;
  capability: Node;
  point: ScreenPoint;
  teamA: Vector4;
  teamB: Vector4;
  local: Vector4;
  turret: Vector4;
  cannon: Vector4;
  autocannon: Vector4;
  railgun: Vector4;
  runtimeUpdateObserved: boolean;
}

export default defineComponent({
  init(self: BattleGuiSelf): void {
    // The retained mockup is the 32-tank presentation target, so it asks for a
    // full roster and two teams rather than the arena's default eight.
    self.battle = new PlayableBattle({ players: MAX_PLAYERS, botSkill: 2, teams: true });
    self.accumulator = 0;
    self.up = false;
    self.down = false;
    self.left = false;
    self.right = false;
    self.fire = false;
    self.point = { x: 0, y: 0 };
    self.teamA = vmath.vector4(0.62, 0.95, 1, 1);
    self.teamB = vmath.vector4(1, 0.6, 0.48, 1);
    self.local = vmath.vector4(0.82, 1, 0.54, 1);
    self.turret = vmath.vector4(0.93, 0.96, 1, 1);
    self.cannon = vmath.vector4(1, 0.86, 0.2, 1);
    self.autocannon = vmath.vector4(0.4, 1, 0.62, 1);
    self.railgun = vmath.vector4(0.95, 0.42, 1, 1);
    self.runtimeUpdateObserved = false;
    self.arena = gui.getNode("arena");
    self.healthFill = gui.getNode("health_fill");
    self.hud = gui.getNode("hud");
    self.capability = gui.getNode("capability");
    self.bodies = nodeSeries("tank_body_", MAX_PLAYERS, 2);
    self.turrets = nodeSeries("tank_turret_", MAX_PLAYERS, 2);
    self.projectiles = nodeSeries("projectile_", VISIBLE_PROJECTILES, 3);
    self.explosions = nodeSeries("explosion_", MAX_PLAYERS, 2);
    self.previousHealth = new Int16Array(MAX_PLAYERS);
    self.explosionUntil = new Int32Array(MAX_PLAYERS);
    self.previousHealth.set(self.battle.world.playerHealth);
    for (const body of self.bodies) {
      gui.setTexture(body, "combat");
      gui.setSize(body, vmath.vector3(48, 48, 0));
      gui.playFlipbook(body, "tank-down");
    }
    for (const turret of self.turrets) gui.setEnabled(turret, false);
    for (const projectile of self.projectiles) {
      gui.setTexture(projectile, "combat");
      gui.setSize(projectile, vmath.vector3(23, 13, 0));
      gui.playFlipbook(projectile, "rocket");
    }
    for (const explosion of self.explosions) {
      gui.setTexture(explosion, "combat");
      gui.setSize(explosion, vmath.vector3(122, 71, 0));
      gui.setEnabled(explosion, false);
    }
    gui.setSize(self.arena, vmath.vector3(arenaSpan() * VIEW_SCALE, arenaSpan() * VIEW_SCALE, 0));
    gui.setText(
      self.capability,
      DEFOLD_ATTACHMENT_ALLOWED
        ? "DEHERM ENGINE ATTACHMENT VERIFIED"
        : "DEHERM ENGINE ATTACHMENT UNVERIFIED — VISUAL SLICE READY",
    );
    msg.post(".", "acquire_input_focus");
    render(self);
    __defoldHostV1.log("info", `war-battles-runtime:gui-init-rendered:${self.bodies.length}:${self.projectiles.length}`);
  },

  update(self: BattleGuiSelf, dt: number): void {
    self.accumulator = Math.min(self.accumulator + dt, FIXED_DT * MAX_CATCHUP_STEPS);
    let steps = 0;
    while (self.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      self.accumulator -= FIXED_DT;
      steps += 1;
      self.battle.setControls({
        moveX: (self.right ? 1 : 0) - (self.left ? 1 : 0),
        moveY: (self.up ? 1 : 0) - (self.down ? 1 : 0),
        fire: self.fire,
      });
      self.battle.step();
    }
    render(self);
    if (!self.runtimeUpdateObserved) {
      self.runtimeUpdateObserved = true;
      __defoldHostV1.log("info", `war-battles-runtime:first-update-rendered:${self.bodies.length}:${self.projectiles.length}`);
    }
  },

  onInput(self: BattleGuiSelf, actionId: DefoldHash, action: OnInputAction): boolean {
    if (actionId === RESTART && action.pressed) {
      self.battle.restart();
      return true;
    }
    if (actionId === UPGRADE_DAMAGE_ACTION && action.pressed) {
      self.battle.buyUpgrade(UPGRADE_DAMAGE);
      return true;
    }
    if (actionId === UPGRADE_MOBILITY_ACTION && action.pressed) {
      self.battle.buyUpgrade(UPGRADE_MOBILITY);
      return true;
    }
    if (actionId === UPGRADE_ARMOR_ACTION && action.pressed) {
      self.battle.buyUpgrade(UPGRADE_ARMOR);
      return true;
    }
    const down = action.released ? false : action.pressed ? true : undefined;
    if (down === undefined) return false;
    if (actionId === UP) self.up = down;
    else if (actionId === DOWN) self.down = down;
    else if (actionId === LEFT) self.left = down;
    else if (actionId === RIGHT) self.right = down;
    else if (actionId === FIRE) self.fire = down;
    else return false;
    return true;
  },

  final(_self: BattleGuiSelf): void {
    msg.post(".", "release_input_focus");
  },
});

function render(self: BattleGuiSelf): void {
  const world = self.battle.world;
  const localSlot = LOCAL_PLAYER_ID - 1;
  const cameraX = world.playerX[localSlot]!;
  const cameraY = world.playerY[localSlot]!;
  projectWorldToScreen(0, 0, cameraX, cameraY, SCREEN_WIDTH, SCREEN_HEIGHT, VIEW_SCALE, self.point);
  gui.setPosition(self.arena, vmath.vector3(self.point.x, self.point.y, 0));

  let livingA = 0;
  let livingB = 0;
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    const alive = world.playerHealth[slot]! > 0;
    if (alive && world.playerTeam[slot] === 1) livingA += 1;
    if (alive && world.playerTeam[slot] === 2) livingB += 1;
    projectWorldToScreen(world.playerX[slot]!, world.playerY[slot]!, cameraX, cameraY, SCREEN_WIDTH, SCREEN_HEIGHT, VIEW_SCALE, self.point);
    const visible = alive && visibleAt(self.point, SCREEN_WIDTH, SCREEN_HEIGHT);
    const body = self.bodies[slot]!;
    const turret = self.turrets[slot]!;
    const explosion = self.explosions[slot]!;
    const currentHealth = world.playerHealth[slot]!;
    if (currentHealth < self.previousHealth[slot]!) {
      self.explosionUntil[slot] = world.tick + EXPLOSION_VISIBLE_TICKS;
      gui.playFlipbook(explosion, "explosion");
    }
    self.previousHealth[slot] = currentHealth;
    const explosionVisible = world.tick < self.explosionUntil[slot]! && visibleAt(self.point, SCREEN_WIDTH, SCREEN_HEIGHT, 80);
    gui.setEnabled(explosion, explosionVisible);
    if (explosionVisible) gui.setPosition(explosion, vmath.vector3(self.point.x, self.point.y, 0));
    gui.setEnabled(body, visible);
    gui.setEnabled(turret, false);
    if (!visible) continue;
    const position = vmath.vector3(self.point.x, self.point.y, 0);
    gui.setPosition(body, position);
    gui.setColor(body, slot === localSlot ? self.local : world.playerTeam[slot] === 1 ? self.teamA : self.teamB);
    gui.setEuler(body, vmath.vector3(0, 0, aimDegrees(world.playerHullX[slot]!, world.playerHullY[slot]!) + 90));
  }

  let activeProjectiles = 0;
  let renderedProjectiles = 0;
  for (let slot = 0; slot < MAX_PROJECTILES; slot += 1) {
    if (world.projectileActive[slot] === 0) continue;
    activeProjectiles += 1;
    if (renderedProjectiles >= VISIBLE_PROJECTILES) continue;
    projectWorldToScreen(world.projectileX[slot]!, world.projectileY[slot]!, cameraX, cameraY, SCREEN_WIDTH, SCREEN_HEIGHT, VIEW_SCALE, self.point);
    if (!visibleAt(self.point, SCREEN_WIDTH, SCREEN_HEIGHT, 12)) continue;
    const node = self.projectiles[renderedProjectiles]!;
    renderedProjectiles += 1;
    gui.setEnabled(node, true);
    gui.setPosition(node, vmath.vector3(self.point.x, self.point.y, 0));
    gui.setEuler(node, vmath.vector3(0, 0, aimDegrees(world.projectileDirectionX[slot]!, world.projectileDirectionY[slot]!)));
    const weapon = world.projectileWeapon[slot]!;
    gui.setColor(node, weapon === WEAPON_RAILGUN ? self.railgun : weapon === WEAPON_AUTOCANNON ? self.autocannon : self.cannon);
  }
  for (let index = renderedProjectiles; index < VISIBLE_PROJECTILES; index += 1) gui.setEnabled(self.projectiles[index]!, false);

  const health = Math.max(0, world.playerHealth[localSlot]!);
  gui.setSize(self.healthFill, vmath.vector3(240 * Math.min(health, 175) / 175, 16, 0));
  gui.setText(
    self.hud,
    `ROUND ${self.battle.round}  TICK ${world.tick}  HP ${health}  SCORE ${world.playerScore[localSlot]}  CREDITS ${world.playerCredits[localSlot]}\n` +
    `TEAL ${livingA}  ORANGE ${livingB}  PROJECTILES ${activeProjectiles}` +
    (activeProjectiles > renderedProjectiles ? ` (${activeProjectiles - renderedProjectiles} CULLED)` : ""),
  );
}

function nodeSeries(prefix: string, count: number, width: number): Node[] {
  const nodes: Node[] = [];
  for (let index = 0; index < count; index += 1) nodes.push(gui.getNode(prefix + String(index + 1).padStart(width, "0")));
  return nodes;
}
