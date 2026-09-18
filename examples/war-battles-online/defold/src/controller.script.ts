import { builtins, msg, type DefoldHash } from "@deherm/project";

import { BattleWorld, INPUT_BUTTON_FIRE, MAX_PLAYERS, TICK_RATE, type InputCommand } from "./generated-war-battles/index";
import { CURRENT_TRANSPORT_EVIDENCE, TransportSelectionMachine } from "./generated-war-battles/transport-selection";
import { DEFOLD_ATTACHMENT_ALLOWED } from "./capability-snapshot";
import { defineComponent } from "./component";

interface InputAction {
  readonly pressed?: boolean;
  readonly released?: boolean;
}

interface ControllerSelf {
  world: BattleWorld;
  command: InputCommand;
  accumulator: number;
  moveX: number;
  moveY: number;
  fire: boolean;
  transport: TransportSelectionMachine;
}

const UP = builtins.hash("up");
const DOWN = builtins.hash("down");
const LEFT = builtins.hash("left");
const RIGHT = builtins.hash("right");
const FIRE = builtins.hash("fire");
const FIXED_DT = 1 / TICK_RATE;

export default defineComponent({
  init(self: ControllerSelf): void {
    if (!DEFOLD_ATTACHMENT_ALLOWED) {
      throw new Error(
        "War Battles Defold attachment is capability-gated: proxy-provider conformance " +
        "and packaged-engine gameplay evidence must both be positive",
      );
    }
    self.world = new BattleWorld(77);
    for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
      self.world.addPlayer(playerId, playerId <= 16 ? 1 : 2);
    }
    self.command = emptyCommand();
    self.accumulator = 0;
    self.moveX = 0;
    self.moveY = 0;
    self.fire = false;
    self.transport = new TransportSelectionMachine(CURRENT_TRANSPORT_EVIDENCE);
    self.transport.begin();
    msg.post(".", "acquire_input_focus");
  },

  update(self: ControllerSelf, dt: number): void {
    self.accumulator += dt;
    while (self.accumulator >= FIXED_DT) {
      self.accumulator -= FIXED_DT;
      const tick = self.world.tick + 1;
      stageLocalInput(self.command, tick, self.moveX, self.moveY, self.fire);
      self.world.submitInput(self.command);
      self.fire = false;
      self.world.step();
    }
  },

  onInput(self: ControllerSelf, actionId: DefoldHash, action: InputAction): boolean {
    const value = action.released ? 0 : action.pressed ? 1 : undefined;
    if (value === undefined) return false;
    if (actionId === UP) self.moveY = value;
    else if (actionId === DOWN) self.moveY = -value;
    else if (actionId === LEFT) self.moveX = -value;
    else if (actionId === RIGHT) self.moveX = value;
    else if (actionId === FIRE && action.pressed) self.fire = true;
    else return false;
    return true;
  },

  final(_self: ControllerSelf): void {
    msg.post(".", "release_input_focus");
  },
});

function emptyCommand(): InputCommand {
  return {
    matchId: 77,
    playerId: 1,
    tick: 1,
    sequence: 1,
    moveX: 0,
    moveY: 0,
    aimX: 127,
    aimY: 0,
    buttons: 0,
    fireSubtick: 255,
    latestSnapshotTick: 0,
    snapshotAckBits: 0,
  };
}

function stageLocalInput(
  command: InputCommand,
  tick: number,
  moveX: number,
  moveY: number,
  fire: boolean,
): void {
  command.tick = tick;
  command.sequence = tick & 0xffff;
  command.moveX = moveX;
  command.moveY = moveY;
  command.buttons = fire ? INPUT_BUTTON_FIRE : 0;
  command.fireSubtick = fire ? 127 : 255;
  command.latestSnapshotTick = tick > 0 ? tick - 1 : 0;
  command.snapshotAckBits = 0xffff_ffff;
}
