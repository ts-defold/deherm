import { defineComponent, factory, go, msg, vmath, type DefoldHash, type OnInputAction } from "@deherm/project";
import {
  HEIGHT,
  WIDTH,
  newSnake,
  stepSnake,
  turnSnake,
  type Direction,
  type SnakeState,
  type Status,
} from "../src/snake";

const UP: DefoldHash = "#up";
const RIGHT: DefoldHash = "#right";
const DOWN: DefoldHash = "#down";
const LEFT: DefoldHash = "#left";
const PAUSE: DefoldHash = "#pause";
const RESTART: DefoldHash = "#restart";
const CELL = 24;
const LEFT_EDGE = 480 - (WIDTH * CELL) / 2 + CELL / 2;
const BOTTOM_EDGE = 258 - (HEIGHT * CELL) / 2 + CELL / 2;

interface SnakeSelf {
  state: SnakeState;
  head: DefoldHash;
  body: DefoldHash[];
  food: DefoldHash;
  elapsed: number;
  lastScore: number;
  lastStatus: Status | "";
}

function position(cell: number): ReturnType<typeof vmath.vector3> {
  return vmath.vector3(LEFT_EDGE + (cell % WIDTH) * CELL, BOTTOM_EDGE + Math.floor(cell / WIDTH) * CELL, 0);
}

function syncSprites(self: SnakeSelf): void {
  go.setPosition(position(self.state.body[0]!), self.head);
  while (self.body.length < self.state.length - 1) {
    self.body.push(factory.create("#body_factory", position(self.state.body[self.body.length + 1]!)));
  }
  for (let index = 0; index < self.body.length; index++) {
    go.setPosition(position(self.state.body[index + 1]!), self.body[index]!);
  }
  if (self.state.food >= 0) go.setPosition(position(self.state.food), self.food);
  else msg.post(self.food, "disable");
  if (self.lastScore === self.state.score && self.lastStatus === self.state.status) return;
  self.lastScore = self.state.score;
  self.lastStatus = self.state.status;
  msg.post("/hud#hud", "snake_state", { score: self.state.score, status: self.state.status });
}

function reset(self: SnakeSelf): void {
  if (self.head !== undefined) go.delete(self.head);
  if (self.food !== undefined) go.delete(self.food);
  if (self.body !== undefined) for (const id of self.body) go.delete(id);
  self.state = newSnake(0x5eedd00d);
  self.head = factory.create("#head_factory", position(self.state.body[0]!));
  self.body = [];
  self.food = factory.create("#food_factory", position(self.state.food));
  self.elapsed = 0;
  self.lastScore = -1;
  self.lastStatus = "";
  syncSprites(self);
}

export default defineComponent({
  init(self: SnakeSelf): void {
    reset(self);
    msg.post(".", "acquire_input_focus");
  },
  update(self: SnakeSelf, dt: number): void {
    self.elapsed += dt;
    if (self.elapsed < 0.13) return;
    self.elapsed = 0;
    stepSnake(self.state);
    syncSprites(self);
  },
  onInput(self: SnakeSelf, actionId: DefoldHash, action: OnInputAction): boolean {
    if (!action.pressed) return false;
    if (actionId === RESTART) {
      reset(self);
      return true;
    }
    if (actionId === PAUSE) {
      self.state.status =
        self.state.status === "paused" ? "playing" : self.state.status === "playing" ? "paused" : self.state.status;
      syncSprites(self);
      return true;
    }
    const direction: Direction | undefined =
      actionId === UP ? 0 : actionId === RIGHT ? 1 : actionId === DOWN ? 2 : actionId === LEFT ? 3 : undefined;
    if (direction === undefined) return false;
    turnSnake(self.state, direction);
    return true;
  },
});
