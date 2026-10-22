import {
  defineComponent,
  factory,
  go,
  msg,
  property,
  vmath,
  type DefoldHash,
  type OnInputAction,
} from "@deherm/project";
import {
  HEIGHT,
  WIDTH,
  attractDirection,
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
  tickSeconds: number;
  state: SnakeState;
  mode: "attract" | "player";
  attractSeed: number;
  head: DefoldHash;
  body: DefoldHash[];
  food: DefoldHash;
  elapsed: number;
  lastScore: number;
  lastStatus: Status | "attract" | "";
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
  const status = self.mode === "attract" ? "attract" : self.state.status;
  if (self.lastScore === self.state.score && self.lastStatus === status) return;
  self.lastScore = self.state.score;
  self.lastStatus = status;
  msg.post("/hud#hud", "snake_state", { score: self.state.score, status });
}

function reset(self: SnakeSelf, mode: "attract" | "player"): void {
  if (self.head !== undefined) go.delete(self.head);
  if (self.food !== undefined) go.delete(self.food);
  if (self.body !== undefined) for (const id of self.body) go.delete(id);
  self.mode = mode;
  self.state = newSnake(mode === "attract" ? self.attractSeed : 0x5eedd00d);
  if (mode === "attract") self.state.status = "playing";
  self.head = factory.create("#head_factory", position(self.state.body[0]!));
  self.body = [];
  self.food = factory.create("#food_factory", position(self.state.food));
  self.elapsed = 0;
  self.lastScore = -1;
  self.lastStatus = "";
  syncSprites(self);
}

export default defineComponent({
  properties: {
    tickSeconds: property.number(0.13),
  },
  init(self: SnakeSelf): void {
    self.attractSeed = 0x5eedd00d;
    reset(self, "attract");
    msg.post(".", "acquire_input_focus");
  },
  update(self: SnakeSelf, dt: number): void {
    if (self.state.status !== "playing") return;
    self.elapsed += dt;
    if (self.elapsed < self.tickSeconds) return;
    self.elapsed = 0;
    if (self.mode === "attract") turnSnake(self.state, attractDirection(self.state));
    stepSnake(self.state);
    if (self.mode === "attract" && self.state.status !== "playing") {
      self.attractSeed = (self.attractSeed + 0x9e3779b9) >>> 0;
      reset(self, "attract");
      return;
    }
    syncSprites(self);
  },
  onInput(self: SnakeSelf, actionId: DefoldHash, action: OnInputAction): boolean {
    if (!action.pressed) return false;
    if (actionId === RESTART) {
      reset(self, "player");
      return true;
    }
    if (actionId === PAUSE) {
      if (self.mode === "attract") return false;
      self.state.status =
        self.state.status === "paused" ? "playing" : self.state.status === "playing" ? "paused" : self.state.status;
      self.elapsed = 0;
      syncSprites(self);
      return true;
    }
    const direction: Direction | undefined =
      actionId === UP ? 0 : actionId === RIGHT ? 1 : actionId === DOWN ? 2 : actionId === LEFT ? 3 : undefined;
    if (direction === undefined) return false;
    if (self.mode === "attract") reset(self, "player");
    turnSnake(self.state, direction);
    self.elapsed = 0;
    syncSprites(self);
    return true;
  },
});
