import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { transform } from "esbuild";

import { createIncrementalCompiler } from "../packages/cli/src/dev/compiler.mjs";
import { createDapAdapter } from "../packages/cli/src/dev/dap-adapter.mjs";
import { createDapTransport } from "../packages/cli/src/dev/dap-protocol.mjs";
import { DebugSourceMap } from "../packages/cli/src/dev/debug-source-map.mjs";

function request(seq, command, args = {}) {
  return { seq, type: "request", command, arguments: args };
}

async function waitFor(predicate, description, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function sourceMapFixture(
  t,
  input = ["export function tick(): number {", "  const answer: number = 42;", "  return answer;", "}", ""].join("\n"),
) {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "game.script.ts");
  const generated = path.join(root, ".deherm", "dev", "app.js");
  const map = `${generated}.map`;
  const result = await transform(input, {
    loader: "ts",
    sourcefile: source,
    sourcemap: "external",
    sourcesContent: true,
    format: "iife",
  });
  await mkdir(path.dirname(map), { recursive: true });
  await writeFile(source, input);
  await writeFile(map, result.map);
  return { root, source, generated, map };
}

test("DAP framing survives fragmented headers and bodies", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createDapTransport(input, output);
  const received = new Promise((resolve) => transport.on("message", resolve));
  const body = Buffer.from(JSON.stringify(request(1, "initialize")));
  input.write(`Content-Length: ${body.length}\r\n`);
  input.write("\r\n");
  input.write(body.subarray(0, 4));
  input.write(body.subarray(4));
  assert.deepEqual(await received, request(1, "initialize"));

  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  transport.send({ seq: 2, type: "event", event: "initialized" });
  await new Promise((resolve) => setImmediate(resolve));
  const framed = Buffer.concat(chunks).toString("utf8");
  assert.match(framed, /^Content-Length: \d+\r\n\r\n/u);
  assert.match(framed, /"event":"initialized"/u);
  transport.close();
});

test("debug source maps round-trip authored TypeScript locations and content", async (t) => {
  const fixture = await sourceMapFixture(t);
  const map = new DebugSourceMap(fixture.map);
  assert.equal(await map.refresh(), true);
  const generated = map.generated(fixture.source, 2, 2);
  assert.ok(generated?.line);
  const original = map.original(generated.line, generated.column);
  assert.equal(original.source, fixture.source);
  assert.equal(original.line, 2);
  assert.match(map.content(fixture.source), /const answer: number = 42/u);
  assert.equal(await map.refresh(), false);
});

test("debug source maps canonicalize absolute Windows source references", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dap-windows-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mapFile = path.join(root, "app.js.map");
  const source = "D:\\work tree\\main\\player.script.ts";
  await writeFile(
    mapFile,
    JSON.stringify({
      version: 3,
      sources: [source],
      sourcesContent: ["const player = 1;\n"],
      names: [],
      mappings: "AAAA",
    }),
  );
  const map = new DebugSourceMap(mapFile);
  assert.equal(await map.refresh(), true);
  assert.deepEqual(map.generated(source, 1, 0), { line: 1, column: 0 });
  assert.equal(map.content(source), "const player = 1;\n");
});

test("real dehermc transforms compose authored locations into the dev bundle", async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const projectRoot = path.join(repositoryRoot, "examples/war-battles-online/defold");
  const source = path.join(projectRoot, "main/player.script.ts");
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-dap-ttsc-"));
  const generated = path.join(temporary, "app.js");
  const compiler = await createIncrementalCompiler({
    entryPoint: source,
    outputFile: generated,
    tsconfig: path.join(projectRoot, "tsconfig.deherm.bundle.json"),
  });
  t.after(async () => {
    await compiler.dispose();
    await rm(temporary, { recursive: true, force: true });
  });
  await compiler.rebuild();

  const authoredLines = (await readFile(source, "utf8")).split("\n");
  const authoredLine = authoredLines.findIndex((line) => line.includes("self.elapsed += dt;")) + 1;
  assert.ok(authoredLine > 0, "fixture must contain the executable breakpoint statement");
  const debugMap = new DebugSourceMap(`${generated}.map`);
  await debugMap.refresh();
  const mapped = debugMap.generated(source, authoredLine, 4);
  assert.ok(mapped, "authored statement must have a generated location");
  const generatedLine = (await readFile(generated, "utf8")).split("\n")[mapped.line - 1];
  assert.match(generatedLine, /self\.elapsed \+= dt;/u);
  assert.deepEqual(debugMap.original(mapped.line, mapped.column), {
    source,
    line: authoredLine,
    column: 4,
    name: null,
  });
});

test("DAP adapter maps breakpoints, stack, scopes, variables, evaluate, and reload", async (t) => {
  const fixture = await sourceMapFixture(t);
  const debugMap = new DebugSourceMap(fixture.map);
  await debugMap.refresh();
  const generated = debugMap.generated(fixture.source, 2, 2);
  const calls = [];
  const listeners = new Map();
  let breakpointSequence = 0;
  const client = {
    onEvent(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Debugger.setBreakpointByUrl")
        return {
          breakpointId: `bp-${(breakpointSequence += 1)}`,
          locations: [{ scriptId: "script-1", lineNumber: params.lineNumber, columnNumber: params.columnNumber }],
        };
      if (method === "Runtime.getProperties")
        return {
          result: [{ name: "answer", value: { type: "number", value: 42 } }],
        };
      if (method === "Debugger.evaluateOnCallFrame") return { result: { type: "number", value: 42 } };
      return {};
    },
    async close() {},
  };
  const events = [];
  const session = {
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectRoot: fixture.root,
    bundleUrl: "deherm:///deherm/app.dehermc",
    sourceMapFile: fixture.map,
    websocketUrl: "ws://127.0.0.1:9001/devtools/page/deherm",
  };
  const adapter = await createDapAdapter({
    projectRoot: fixture.root,
    sessionFile: path.join(fixture.root, ".deherm", "dev", "inspector.json"),
    emit: (message) => events.push(message),
    discoverInspectorTarget: async () => ({
      session,
      target: { webSocketDebuggerUrl: session.websocketUrl },
    }),
    connectCdp: async () => client,
  });

  const initialized = await adapter.handle(request(1, "initialize"));
  assert.equal(initialized.success, true);
  assert.equal(initialized.body.supportsConditionalBreakpoints, true);
  assert.deepEqual(
    initialized.body.exceptionBreakpointFilters.map(({ filter }) => filter),
    ["uncaught", "all"],
  );
  adapter.afterResponse(request(1, "initialize"), initialized);
  assert.equal(events.length, 0, "configuration must not start before the inspector is attached");
  const attached = await adapter.handle(request(2, "attach"));
  assert.equal(attached.success, true);
  adapter.afterResponse(request(2, "attach"), attached);
  assert.equal(events.at(-1).event, "initialized");

  const set = await adapter.handle(
    request(3, "setBreakpoints", {
      source: { path: fixture.source },
      breakpoints: [{ line: 2, column: 3, condition: "answer === 42" }],
    }),
  );
  assert.equal(set.success, true);
  assert.equal(set.body.breakpoints[0].verified, true);
  assert.equal(calls.find(({ method }) => method === "Debugger.setBreakpointByUrl").params.url, session.bundleUrl);

  listeners.get("Debugger.scriptParsed")({ scriptId: "script-1", url: session.bundleUrl });
  await waitFor(() => breakpointSequence >= 2, "the queued native HMR breakpoint reapplication");
  assert.equal(breakpointSequence, 2, "HMR script parsing reapplies the authored breakpoint");
  const replaced = await adapter.handle(
    request(31, "setBreakpoints", {
      source: { path: fixture.source },
      breakpoints: [{ line: 3, column: 3 }],
    }),
  );
  assert.equal(replaced.success, true);
  assert.ok(
    calls.some(({ method, params }) => method === "Debugger.removeBreakpoint" && params.breakpointId === "bp-2"),
    "a DAP replacement removes the preceding CDP breakpoint instead of leaking it",
  );

  await listeners.get("Debugger.paused")({
    reason: "breakpoint",
    callFrames: [
      {
        callFrameId: "frame-1",
        functionName: "tick",
        location: { scriptId: "script-1", lineNumber: generated.line - 1, columnNumber: generated.column },
        scopeChain: [{ type: "local", object: { objectId: "scope-1", type: "object" } }],
        this: { objectId: "this-1", type: "object", description: "GameObject" },
      },
    ],
  });
  let stopped;
  for (let index = 0; index < 20 && !stopped; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    stopped = events.find(({ event }) => event === "stopped");
  }
  assert.ok(stopped, `missing stopped event: ${JSON.stringify(events)}`);
  assert.equal(stopped.body.reason, "breakpoint");
  const stack = await adapter.handle(request(4, "stackTrace", { threadId: 1 }));
  assert.equal(stack.body.stackFrames[0].source.path, fixture.source);
  assert.equal(stack.body.stackFrames[0].line, 2);
  const frameId = stack.body.stackFrames[0].id;
  const scopes = await adapter.handle(request(5, "scopes", { frameId }));
  const variables = await adapter.handle(
    request(6, "variables", {
      variablesReference: scopes.body.scopes[0].variablesReference,
    }),
  );
  assert.equal(variables.body.variables[0].value, "42");
  const evaluated = await adapter.handle(request(7, "evaluate", { frameId, expression: "answer" }));
  assert.equal(evaluated.body.result, "42");
  await writeFile(fixture.source, `${await readFile(fixture.source, "utf8")}\n// edited after bundle\n`);
  const breakpointCalls = calls.filter(({ method }) => method === "Debugger.setBreakpointByUrl").length;
  const stale = await adapter.handle(
    request(71, "setBreakpoints", {
      source: { path: fixture.source },
      breakpoints: [{ line: 2, column: 3 }],
    }),
  );
  assert.equal(stale.body.breakpoints[0].verified, false);
  assert.match(stale.body.breakpoints[0].message, /differs from the running bundle/u);
  assert.equal(
    calls.filter(({ method }) => method === "Debugger.setBreakpointByUrl").length,
    breakpointCalls,
    "a stale authored location must not bind to an older generated instruction",
  );
  const unsaved = await adapter.handle(
    request(72, "setBreakpoints", {
      source: { path: fixture.source },
      sourceModified: true,
      breakpoints: [{ line: 2, column: 3 }],
    }),
  );
  assert.equal(unsaved.body.breakpoints[0].verified, false);
  assert.match(unsaved.body.breakpoints[0].message, /editor buffer is unsaved/u);
  assert.equal((await adapter.handle(request(8, "disconnect"))).success, true);
  assert.equal(calls.at(-1).method, "Debugger.resume", "disconnect resumes a paused game before detaching");
});

test("authored arguments, locals, and module scopes precede this/global and stale references fail closed", async (t) => {
  const fixture = await sourceMapFixture(
    t,
    [
      "const UP = '#up';",
      "export function onInput(self: object, actionId: string, action: object): boolean {",
      "  const direction = actionId === UP ? 0 : 1;",
      "  return direction === 0;",
      "}",
      "",
    ].join("\n"),
  );
  const listeners = new Map();
  const client = {
    onEvent(name, listener) {
      listeners.set(name, listener);
    },
    async send(method, params) {
      if (method === "Debugger.evaluateOnCallFrame") {
        if (params.expression === "actionId") return { result: { type: "string", value: "#left" } };
        if (params.expression === "action") return { result: { type: "object", objectId: "action-1" } };
        if (params.expression === "self") return { result: { type: "object", objectId: "self-1" } };
        if (params.expression === "direction") return { result: { type: "number", value: 0 } };
        if (params.expression === "UP") return { result: { type: "string", value: "#up" } };
        if (params.expression === "onInput") return { result: { type: "function", objectId: "function-1" } };
      }
      return {};
    },
    async close() {},
  };
  const adapter = await createDapAdapter({
    projectRoot: fixture.root,
    discoverInspectorTarget: async () => ({
      session: {
        projectRoot: fixture.root,
        bundleUrl: "deherm:///deherm/app.dehermc",
        sourceMapFile: fixture.map,
      },
      target: { webSocketDebuggerUrl: "ws://127.0.0.1:9001/devtools/page/deherm" },
    }),
    connectCdp: async () => client,
  });
  assert.equal((await adapter.handle(request(1, "attach"))).success, true);
  listeners.get("Debugger.scriptParsed")({ scriptId: "script-1", url: "deherm:///deherm/app.dehermc" });
  const map = new DebugSourceMap(fixture.map);
  await map.refresh();
  const generated = map.generated(fixture.source, 4, 3);
  await listeners.get("Debugger.paused")({
    reason: "breakpoint",
    callFrames: [
      {
        callFrameId: "on-input-1",
        functionName: "onInput",
        location: { scriptId: "script-1", lineNumber: generated.line - 1, columnNumber: generated.column },
        scopeChain: [{ type: "global", object: { objectId: "global-1" } }],
        this: { objectId: "this-1", type: "object" },
      },
    ],
  });
  const scopes = await adapter.handle(request(2, "scopes", { frameId: 1 }));
  assert.deepEqual(
    scopes.body.scopes.map(({ name }) => name),
    ["Arguments", "Locals", "Module", "this", "global"],
  );
  const reference = scopes.body.scopes[0].variablesReference;
  const values = await adapter.handle(request(3, "variables", { variablesReference: reference }));
  assert.deepEqual(
    values.body.variables.map(({ name }) => name),
    ["self", "actionId", "action"],
  );
  assert.equal(values.body.variables[1].value, '"#left"');
  const locals = await adapter.handle(
    request(31, "variables", { variablesReference: scopes.body.scopes[1].variablesReference }),
  );
  assert.deepEqual(
    locals.body.variables.map(({ name }) => name),
    ["direction"],
  );
  const module = await adapter.handle(
    request(32, "variables", { variablesReference: scopes.body.scopes[2].variablesReference }),
  );
  assert.deepEqual(
    module.body.variables.map(({ name }) => name),
    ["UP", "onInput"],
  );
  listeners.get("Debugger.resumed")();
  assert.equal((await adapter.handle(request(4, "variables", { variablesReference: reference }))).success, false);
});

test("DAP launch owns only its fresh dev process and stops it on disconnect", async (t) => {
  const fixture = await sourceMapFixture(t);
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.signalCode = signal;
    child.emit("exit", null, signal);
    return true;
  };
  const spawned = [];
  let reads = 0;
  const session = {
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    pid: child.pid,
    projectRoot: fixture.root,
    bundleUrl: "deherm:///deherm/app.dehermc",
    sourceMapFile: fixture.map,
    websocketUrl: "ws://127.0.0.1:9001/devtools/page/deherm",
  };
  const adapter = await createDapAdapter({
    projectRoot: fixture.root,
    cliPath: path.join(fixture.root, "bin", "deherm.mjs"),
    spawnDev: (...args) => {
      spawned.push(args);
      return child;
    },
    readInspectorSession: async () => (++reads === 1 ? { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : session),
    discoverInspectorTarget: async () => ({ session, target: { webSocketDebuggerUrl: session.websocketUrl } }),
    connectCdp: async () => ({
      onEvent() {},
      async send() {
        return {};
      },
      async close() {},
    }),
  });
  const missing = await adapter.handle(request(1, "launch"));
  assert.equal(missing.success, false);
  assert.match(missing.message, /requires an authored TypeScript 'entry'/u);
  assert.equal((await adapter.handle(request(2, "launch", { entry: "main/snake.script.ts" }))).success, true);
  assert.deepEqual(spawned[0][1].slice(1, 7), [
    "dev",
    "--project",
    fixture.root,
    "--entry",
    "main/snake.script.ts",
    "--headless",
  ]);
  assert.equal((await adapter.handle(request(3, "disconnect"))).success, true);
  assert.equal(child.signalCode, "SIGTERM");
});

test("DAP launch reports a failed spawn without waiting for an exit that cannot occur", async (t) => {
  const fixture = await sourceMapFixture(t);
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => assert.fail("a process without a PID must not be killed");
  const adapter = await createDapAdapter({
    projectRoot: fixture.root,
    cliPath: path.join(fixture.root, "bin", "deherm.mjs"),
    readInspectorSession: async () => null,
    spawnDev: () => {
      queueMicrotask(() => child.emit("error", new Error("spawn denied")));
      return child;
    },
  });
  const result = await adapter.handle(request(1, "launch", { entry: "main/snake.script.ts" }));
  assert.equal(result.success, false);
  assert.match(result.message, /spawn denied/u);
  await adapter.close();
});

test("browser DAP breakpoints cover the initial bundle and numbered HMR generations", async (t) => {
  const fixture = await sourceMapFixture(t);
  const generated = new DebugSourceMap(fixture.map);
  await generated.refresh();
  const location = generated.generated(fixture.source, 2, 2);
  const calls = [];
  const listeners = new Map();
  let breakpointSequence = 0;
  let currentBrowserScript = "browser-initial";
  const client = {
    onEvent(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Debugger.enable") {
        listeners.get("Debugger.scriptParsed")({
          scriptId: "browser-initial",
          url: "defold-hermes://app.js",
        });
        return {};
      }
      if (method === "Debugger.setBreakpointByUrl")
        return {
          breakpointId: `browser-${(breakpointSequence += 1)}`,
          locations: [
            { scriptId: "browser-initial", lineNumber: params.lineNumber, columnNumber: params.columnNumber },
            ...(currentBrowserScript === "browser-initial"
              ? []
              : [{ scriptId: currentBrowserScript, lineNumber: params.lineNumber, columnNumber: params.columnNumber }]),
          ],
        };
      return {};
    },
    async close() {},
  };
  const session = {
    runtime: "browser",
    projectRoot: fixture.root,
    bundleUrl: "defold-hermes://app.js",
    sourceMapFile: fixture.map,
    websocketUrl: "ws://127.0.0.1:9222/devtools/page/browser",
  };
  const events = [];
  const adapter = await createDapAdapter({
    projectRoot: fixture.root,
    emit: (event) => events.push(event),
    discoverInspectorTarget: async () => ({ session, target: { webSocketDebuggerUrl: session.websocketUrl } }),
    connectCdp: async (url) => {
      assert.equal(url, session.websocketUrl, "browser CDP URLs do not receive the native replacement query");
      return client;
    },
  });
  assert.equal((await adapter.handle(request(40, "attach"))).success, true);
  const set = await adapter.handle(
    request(41, "setBreakpoints", {
      source: { path: fixture.source },
      breakpoints: [{ line: 2, column: 3 }],
    }),
  );
  assert.equal(set.body.breakpoints[0].verified, true);
  const command = calls.find(({ method }) => method === "Debugger.setBreakpointByUrl");
  assert.equal(command.params.url, undefined);
  assert.equal(command.params.urlRegex, "^defold-hermes://app(?:\\.\\d+)?\\.js$");
  assert.equal(command.params.lineNumber, location.line - 1);
  assert.equal(set.body.breakpoints[0].source.path, fixture.source);

  currentBrowserScript = "hmr-2";
  listeners.get("Debugger.scriptParsed")({ scriptId: "hmr-2", url: "defold-hermes://app.2.js" });
  await waitFor(() => breakpointSequence >= 2, "the queued HMR breakpoint reapplication");
  assert.equal(breakpointSequence, 2, "a numbered browser HMR source reapplies the authored breakpoint");
  listeners.get("Debugger.scriptParsed")({ scriptId: "other", url: "https://example.test/app.js" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(breakpointSequence, 2, "unrelated page scripts do not reapply game breakpoints");

  const replaced = await adapter.handle(
    request(42, "setBreakpoints", {
      source: { path: fixture.source },
      breakpoints: [{ line: 2, column: 3 }],
    }),
  );
  assert.equal(
    replaced.body.breakpoints[0].source.path,
    fixture.source,
    "the newest HMR script wins even when Chrome returns an older location first",
  );

  await listeners.get("Debugger.paused")({
    reason: "breakpoint",
    callFrames: [
      {
        callFrameId: "old-frame",
        functionName: "oldCallback",
        location: { scriptId: "browser-initial", lineNumber: location.line - 1, columnNumber: location.column },
        scopeChain: [],
      },
    ],
  });
  const oldStack = await adapter.handle(request(43, "stackTrace", { threadId: 1 }));
  assert.equal(
    oldStack.body.stackFrames[0].source.path,
    "defold-hermes://app.js",
    "an old live closure is not mapped through the newest generation's source map",
  );

  await listeners.get("Debugger.paused")({
    reason: "exception",
    callFrames: [
      {
        callFrameId: "foreign-frame",
        functionName: "loader",
        location: { scriptId: "other", lineNumber: location.line - 1, columnNumber: location.column },
        scopeChain: [],
      },
    ],
  });
  const foreignStack = await adapter.handle(request(44, "stackTrace", { threadId: 1 }));
  assert.equal(
    foreignStack.body.stackFrames[0].source.path,
    "https://example.test/app.js",
    "a page script is never projected through the game bundle's TypeScript map",
  );
  assert.ok(events.some(({ event }) => event === "stopped"));
  await adapter.close();
});
