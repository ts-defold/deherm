#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { runReplay } from "./match.ts";
import { buildBotReplay, readReplayHeader } from "./replay.ts";

const options = parseArguments(process.argv.slice(2));
const replay =
  options.replayIn === undefined
    ? buildBotReplay({ players: options.players, ticks: options.ticks, seed: options.seed, matchId: options.matchId })
    : new Uint8Array(await readFile(options.replayIn));
const header = readReplayHeader(replay);
if (options.replayOut !== undefined) await writeFile(options.replayOut, replay);

const rollback =
  header.ticks >= 120
    ? { restoreTick: Math.floor(header.ticks / 3), triggerTick: Math.floor(header.ticks / 3) + 60 }
    : undefined;
const started = performance.now();
const baseline = runReplay(replay);
const authoritative = runReplay(replay, rollback);
const elapsedMs = performance.now() - started;
if (baseline.stateHash !== authoritative.stateHash) {
  throw new Error(`rollback replay diverged: ${baseline.stateHash} != ${authoritative.stateHash}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      replayBytes: replay.byteLength,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      baseline,
      authoritative,
    },
    null,
    2,
  )}\n`,
);

function parseArguments(argv) {
  const parsed = { players: 32, ticks: 3_600, seed: 0xc0ffee, matchId: 77 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--players") parsed.players = integer(argv[++index], argument);
    else if (argument === "--ticks") parsed.ticks = integer(argv[++index], argument);
    else if (argument === "--seed") parsed.seed = integer(argv[++index], argument);
    else if (argument === "--match-id") parsed.matchId = integer(argv[++index], argument);
    else if (argument === "--replay-in") parsed.replayIn = required(argv[++index], argument);
    else if (argument === "--replay-out") parsed.replayOut = required(argv[++index], argument);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return parsed;
}

function integer(value, option) {
  const parsed = Number(required(value, option));
  if (!Number.isInteger(parsed)) throw new Error(`${option} requires an integer`);
  return parsed;
}

function required(value, option) {
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}
