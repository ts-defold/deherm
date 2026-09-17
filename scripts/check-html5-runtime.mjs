import assert from "node:assert/strict";

const pageUrl = process.env.DEFOLD_HERMES_HTML5_URL
  ?? "http://127.0.0.1:4174/build/bundle/Defold%20Hermes%20Spike/index.html";
const discoveryUrl = process.env.DEFOLD_HERMES_CDP_URL
  ?? "http://127.0.0.1:9223/json/list";

const targets = await (await fetch(discoveryUrl)).json();
const target = targets.find((candidate) => candidate.type === "page" && candidate.url === pageUrl);
assert.ok(target?.webSocketDebuggerUrl, `No Chrome page target found for ${pageUrl}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const events = [];
let sawInit = false;
let sawGeneratedCall = false;
let sawUpdate = false;
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const continuation = pending.get(message.id);
    if (!continuation) return;
    pending.delete(message.id);
    if (message.error) continuation.reject(new Error(message.error.message));
    else continuation.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const event = {
      kind: "console",
      level: message.params.type,
      values: message.params.args.map((argument) => argument.value ?? argument.description)
    };
    const rendered = event.values.join(" ");
    sawInit ||= rendered.includes("init:browser");
    sawGeneratedCall ||= rendered.includes("module:42");
    if (rendered.includes("update:")) {
      if (sawUpdate) return;
      sawUpdate = true;
    }
    events.push(event);
  } else if (message.method === "Runtime.exceptionThrown") {
    events.push({ kind: "exception", detail: message.params.exceptionDetails.text });
  } else if (message.method === "Log.entryAdded") {
    events.push({
      kind: "log",
      level: message.params.entry.level,
      text: message.params.entry.text,
      url: message.params.entry.url ?? null
    });
  }
});

function send(method, params = {}) {
  const id = nextId++;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });

const deadline = Date.now() + 15_000;
let state;
while (Date.now() < deadline) {
  state = await evaluate(`({
    documentReady: document.readyState,
    engineStarted: Boolean(globalThis.Module && Module.calledRun),
    appRegistered: Boolean(globalThis.__defoldAppV1),
    hostRuntime: globalThis.__defoldHostV1?.runtime ?? null,
    modules: Object.keys(globalThis.__defoldModulesV1 ?? {}).sort(),
    canvas: (() => {
      const value = document.querySelector("canvas");
      return value ? { width: value.width, height: value.height } : null;
    })()
  })`);
  if (state.engineStarted && state.appRegistered && sawInit && sawGeneratedCall && sawUpdate) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

socket.close();

const relevantEvents = events.filter((event) =>
  event.kind === "exception"
  || event.level === "error"
  || (JSON.stringify(event).includes("defold-hermes")
    && !JSON.stringify(event).includes("update:")));
const diagnosticEvents = events.slice(-100);

const evidence = JSON.stringify({ state, events: diagnosticEvents });
assert.equal(state?.engineStarted, true, `Defold Emscripten runtime did not start: ${evidence}`);
assert.equal(state?.appRegistered, true, `TypeScript application did not register: ${evidence}`);
assert.equal(state?.hostRuntime, "browser", "Application did not use the browser host adapter");
assert.deepEqual(state?.modules, ["ExampleMath", "Timer"]);
assert.equal(sawInit, true, "Defold did not invoke the TypeScript init lifecycle");
assert.equal(sawGeneratedCall, true, "Generated ExampleMath binding did not return 42 from Wasm");
assert.equal(sawUpdate, true, "Defold did not invoke the TypeScript update lifecycle");
const fatalEvents = relevantEvents.filter((event) =>
  event.kind === "exception"
  || (event.level === "error" && !event.url?.endsWith("/favicon.ico")));
assert.equal(fatalEvents.length, 0, `Browser errors: ${JSON.stringify(fatalEvents)}`);

console.log(JSON.stringify({ state, events: relevantEvents }, null, 2));
