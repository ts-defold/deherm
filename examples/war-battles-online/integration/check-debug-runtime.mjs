import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const projectRoot = path.join(exampleRoot, "defold");
// The arena component is permanent and this statement runs before every
// engaged/not-engaged branch, so the proof stays deterministic for a long-lived
// battle after the player or transient camera target has been destroyed.
const source = path.join(projectRoot, "main/arena.script.ts");
const marker = "self.elapsed += dt;";
const authoredLine = (await readFile(source, "utf8"))
  .split("\n")
  .findIndex((line) => line.includes(marker)) + 1;
assert.ok(authoredLine > 0, `Missing debugger proof marker: ${marker}`);

async function runSession(sessionIndex) {
const child = spawn(process.execPath, [
  path.join(repositoryRoot, "bin/deherm.mjs"),
  "debug",
  "--project",
  projectRoot
], {
  cwd: repositoryRoot,
  stdio: ["pipe", "pipe", "pipe"]
});
const childExit = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

let sequence = 0;
let received = Buffer.alloc(0);
let stderr = "";
const pending = new Map();
const events = [];
const eventWaiters = new Map();

function withTimeout(promise, label, timeoutMs = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function deliver(message) {
  if (message.type === "response") {
    const waiter = pending.get(message.request_seq);
    if (!waiter) return;
    pending.delete(message.request_seq);
    waiter.resolve(message);
    return;
  }
  if (message.type !== "event") return;
  events.push(message);
  const waiters = eventWaiters.get(message.event);
  const waiter = waiters?.shift();
  if (waiter) waiter(message);
}

function parseFrames() {
  while (true) {
    const boundary = received.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const header = received.subarray(0, boundary).toString("utf8");
    const length = Number.parseInt(/^Content-Length:\s*(\d+)$/imu.exec(header)?.[1] ?? "", 10);
    if (!Number.isInteger(length)) throw new Error(`Invalid DAP header: ${header}`);
    const bodyStart = boundary + 4;
    if (received.length < bodyStart + length) return;
    deliver(JSON.parse(received.subarray(bodyStart, bodyStart + length).toString("utf8")));
    received = received.subarray(bodyStart + length);
  }
}

child.stdout.on("data", (chunk) => {
  received = Buffer.concat([received, chunk]);
  parseFrames();
});
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("error", (error) => {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
});

function request(command, arguments_ = {}) {
  const seq = sequence += 1;
  const body = Buffer.from(JSON.stringify({ seq, type: "request", command, arguments: arguments_ }));
  const answer = new Promise((resolve, reject) => pending.set(seq, { resolve, reject }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
  return withTimeout(answer, `DAP ${command}`);
}

function waitForEvent(name, timeoutMs = 10_000) {
  const existing = events.find((event) => event.event === name);
  if (existing) return Promise.resolve(existing);
  const answer = new Promise((resolve) => {
    const waiters = eventWaiters.get(name) ?? [];
    waiters.push(resolve);
    eventWaiters.set(name, waiters);
  });
  return withTimeout(answer, `DAP ${name} event`, timeoutMs);
}

let paused = false;
try {
  assert.equal((await request("initialize")).success, true);
  assert.equal((await request("attach")).success, true);
  const set = await request("setBreakpoints", {
    source: { path: source },
    breakpoints: [{ line: authoredLine, column: 5 }]
  });
  assert.equal(set.success, true);
  assert.equal(set.body.breakpoints[0].verified, true);
  assert.equal(set.body.breakpoints[0].line, authoredLine);
  assert.equal((await request("configurationDone")).success, true);

  const stopped = await waitForEvent("stopped");
  paused = true;
  assert.equal(stopped.body.reason, "breakpoint");
  const stack = await request("stackTrace", { threadId: 1, startFrame: 0, levels: 5 });
  const frame = stack.body.stackFrames[0];
  assert.equal(frame.source.path, source);
  assert.equal(frame.line, authoredLine);
  const evaluated = await request("evaluate", {
    frameId: frame.id,
    expression: "dt",
    context: "watch"
  });
  assert.equal(evaluated.success, true);
  assert.equal(evaluated.body.type, "number");
  assert.ok(Number.isFinite(Number(evaluated.body.result)));
  assert.equal((await request("continue", { threadId: 1 })).success, true);
  paused = false;
  assert.equal((await request("disconnect", { restart: false })).success, true);
  child.stdin.end();
  const exit = await withTimeout(childExit, "DAP process exit");
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  return {
    session: sessionIndex,
    breakpoint: set.body.breakpoints[0],
    stopped: stopped.body,
    frame,
    evaluate: evaluated.body,
    continued: true,
    disconnected: true
  };
} catch (error) {
  if (paused) await request("continue", { threadId: 1 }).catch(() => {});
  await request("disconnect", { restart: false }).catch(() => {});
  child.kill("SIGTERM");
  throw new Error(`debug session ${sessionIndex}: ${error.message}${stderr ? `\nDAP stderr:\n${stderr}` : ""}`, { cause: error });
}
}

const sessions = [];
for (let index = 1; index <= 2; index += 1) {
  if (index > 1) await new Promise((resolve) => setTimeout(resolve, 300));
  sessions.push(await runSession(index));
}
console.log(JSON.stringify({
  schemaVersion: 1,
  project: projectRoot,
  reconnect: true,
  sessions
}, null, 2));
