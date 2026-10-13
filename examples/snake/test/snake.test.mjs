import assert from "node:assert/strict";
import test from "node:test";

import { CELL_COUNT, WIDTH, attractDirection, newSnake, stepSnake, turnSnake } from "../src/snake.ts";

test("a fixed seed produces a playable deterministic start", () => {
  const first = newSnake(123);
  const second = newSnake(123);
  assert.equal(first.food, second.food);
  assert.ok(first.food >= 0 && first.food < CELL_COUNT);
  assert.equal(first.length, 3);
  assert.equal(first.status, "ready");
  assert.notEqual(first.food, first.body[0]);
  const firstCell = first.body[0];
  for (let frame = 0; frame < 500; frame++) stepSnake(first);
  assert.equal(first.body[0], firstCell, "an unattended game must not move or die");
  assert.equal(first.status, "ready");
});

test("turning cannot reverse into the neck", () => {
  const state = newSnake();
  turnSnake(state, 3);
  assert.equal(state.status, "ready", "reverse input must not start into the snake's neck");
  turnSnake(state, 1);
  stepSnake(state);
  assert.equal(state.direction, 1);
  turnSnake(state, 0);
  stepSnake(state);
  assert.equal(state.direction, 0);
});

test("food grows the snake and moving into a vacated tail is legal", () => {
  const state = newSnake();
  turnSnake(state, 1);
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
  turnSnake(state, 1);
  state.body[0] = 7 * WIDTH + WIDTH - 1;
  stepSnake(state);
  assert.equal(state.status, "lost");
  const restarted = newSnake(123);
  assert.equal(restarted.status, "ready");
  assert.equal(restarted.score, 0);
});

test("attract steering keeps moving, takes food, and avoids immediate collision", () => {
  const state = newSnake(0x5eedd00d);
  state.status = "playing";
  let moves = 0;
  while (moves < 250 && state.status === "playing") {
    turnSnake(state, attractDirection(state));
    stepSnake(state);
    moves++;
  }
  assert.ok(moves >= 100, `attract run was too short: ${moves} moves`);
  assert.ok(state.score > 0, "the demo should visibly collect food");
});

test("attract steering turns away from a wall", () => {
  const state = newSnake(1);
  state.status = "playing";
  state.body[0] = 7 * WIDTH + WIDTH - 1;
  assert.notEqual(attractDirection(state), 1);
});
