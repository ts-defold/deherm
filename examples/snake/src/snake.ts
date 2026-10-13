/** Pure, deterministic Snake rules: no Defold or Hermes globals. */
export const WIDTH = 20;
export const HEIGHT = 14;
export const CELL_COUNT = WIDTH * HEIGHT;

export type Direction = 0 | 1 | 2 | 3;
export type Status = "playing" | "paused" | "lost" | "won";

export interface SnakeState {
  readonly body: Uint16Array;
  length: number;
  direction: Direction;
  pendingDirection: Direction;
  food: number;
  score: number;
  seed: number;
  status: Status;
}

function random(state: SnakeState): number {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed;
}

function occupies(state: SnakeState, cell: number, length = state.length): boolean {
  for (let index = 0; index < length; index++) if (state.body[index] === cell) return true;
  return false;
}

function placeFood(state: SnakeState): void {
  const free = CELL_COUNT - state.length;
  if (free === 0) {
    state.food = -1;
    state.status = "won";
    return;
  }
  let choice = random(state) % free;
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if (occupies(state, cell)) continue;
    if (choice-- === 0) {
      state.food = cell;
      return;
    }
  }
  throw new Error("Snake food placement exhausted the board");
}

export function newSnake(seed = 1): SnakeState {
  const body = new Uint16Array(CELL_COUNT);
  const head = 7 * WIDTH + 10;
  body[0] = head;
  body[1] = head - 1;
  body[2] = head - 2;
  const state: SnakeState = {
    body,
    length: 3,
    direction: 1,
    pendingDirection: 1,
    food: -1,
    score: 0,
    seed: seed >>> 0,
    status: "playing",
  };
  placeFood(state);
  return state;
}

export function turnSnake(state: SnakeState, direction: Direction): void {
  if (state.status !== "playing") return;
  if ((direction + 2) % 4 !== state.direction) state.pendingDirection = direction;
}

export function stepSnake(state: SnakeState): void {
  if (state.status !== "playing") return;
  state.direction = state.pendingDirection;
  const head = state.body[0];
  const x = head % WIDTH;
  const y = Math.floor(head / WIDTH);
  const dx = state.direction === 1 ? 1 : state.direction === 3 ? -1 : 0;
  const dy = state.direction === 0 ? 1 : state.direction === 2 ? -1 : 0;
  const nextX = x + dx;
  const nextY = y + dy;
  if (nextX < 0 || nextX >= WIDTH || nextY < 0 || nextY >= HEIGHT) {
    state.status = "lost";
    return;
  }
  const next = nextY * WIDTH + nextX;
  const eating = next === state.food;
  // The tail vacates its cell on a non-growing move, so entering it is legal.
  if (occupies(state, next, eating ? state.length : state.length - 1)) {
    state.status = "lost";
    return;
  }
  if (eating) state.length++;
  for (let index = state.length - 1; index > 0; index--) state.body[index] = state.body[index - 1];
  state.body[0] = next;
  if (eating) {
    state.score += 10;
    placeFood(state);
  }
}
