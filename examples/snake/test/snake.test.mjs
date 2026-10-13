import assert from "node:assert/strict";
import test from "node:test";

import { CELL_COUNT, WIDTH, newSnake, stepSnake, turnSnake } from "../src/snake.ts";

test("a fixed seed produces a playable deterministic start", () => {
  const first = newSnake(123);
  const second = newSnake(123);
  assert.equal(first.food, second.food);
  assert.ok(first.food >= 0 && first.food < CELL_COUNT);
  assert.equal(first.length, 3);
  assert.equal(first.status, "playing");
  assert.notEqual(first.food, first.body[0]);
});

test("turning cannot reverse into the neck", () => {
  const state = newSnake();
  turnSnake(state, 3);
  stepSnake(state);
  assert.equal(state.direction, 1);
  turnSnake(state, 0);
  stepSnake(state);
  assert.equal(state.direction, 0);
});

test("food grows the snake and moving into a vacated tail is legal", () => {
  const state = newSnake();
  state.food = state.body[0] + 1;
  stepSnake(state);
  assert.equal(state.length, 4);
  assert.equal(state.score, 10);
  assert.equal(state.status, "playing");
  state.body[0] = 5 * WIDTH + 5;
  state.body[1] = 4 * WIDTH + 5;
  state.body[2] = 4 * WIDTH + 4;
  state.body[3] = 5 * WIDTH + 4;
  state.length = 4;
  state.direction = 0;
  state.pendingDirection = 3;
  state.food = 0;
  stepSnake(state);
  assert.equal(state.body[0], 5 * WIDTH + 4);
  assert.equal(state.status, "playing");
});

test("wall contact ends movement and restart gives a fresh game", () => {
  const state = newSnake();
  state.body[0] = 7 * WIDTH + WIDTH - 1;
  stepSnake(state);
  assert.equal(state.status, "lost");
  const restarted = newSnake(123);
  assert.equal(restarted.status, "playing");
  assert.equal(restarted.score, 0);
});
