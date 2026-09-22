import assert from "node:assert/strict";
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

async function sourceMapFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-dap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "game.script.ts");
  const generated = path.join(root, ".deherm", "dev", "app.js");
  const map = `${generated}.map`;
  const input = [
    "export function tick(): number {",
    "  const answer: number = 42;",
    "  return answer;",
    "}",
    ""
  ].join("\n");
  const result = await transform(input, {
    loader: "ts",
    sourcefile: source,
    sourcemap: "external",
    sourcesContent: true,
    format: "iife"
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

test("real dehermc transforms compose authored locations into the dev bundle", async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const projectRoot = path.join(repositoryRoot, "examples/war-battles-online/defold");
  const source = path.join(projectRoot, "main/player.script.ts");
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-dap-ttsc-"));
  const generated = path.join(temporary, "app.js");
  const compiler = await createIncrementalCompiler({
    entryPoint: source,
    outputFile: generated,
    tsconfig: path.join(projectRoot, "tsconfig.deherm.bundle.json")
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
    name: null
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
    onEvent(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Debugger.setBreakpointByUrl") return {
        breakpointId: `bp-${breakpointSequence += 1}`,
        locations: [{ scriptId: "script-1", lineNumber: params.lineNumber, columnNumber: params.columnNumber }]
      };
      if (method === "Runtime.getProperties") return {
        result: [{ name: "answer", value: { type: "number", value: 42 } }]
      };
      if (method === "Debugger.evaluateOnCallFrame") return { result: { type: "number", value: 42 } };
      return {};
    },
    async close() {}
  };
  const events = [];
  const session = {
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectRoot: fixture.root,
    bundleUrl: "deherm:///deherm/app.dehermc",
    sourceMapFile: fixture.map,
    websocketUrl: "ws://127.0.0.1:9001/devtools/page/deherm"
  };
  const adapter = await createDapAdapter({
    projectRoot: fixture.root,
    sessionFile: path.join(fixture.root, ".deherm", "dev", "inspector.json"),
    emit: (message) => events.push(message),
    discoverInspectorTarget: async () => ({
      session,
      target: { webSocketDebuggerUrl: session.websocketUrl }
    }),
    connectCdp: async () => client
  });

  const initialized = await adapter.handle(request(1, "initialize"));
  assert.equal(initialized.success, true);
  assert.equal(initialized.body.supportsConditionalBreakpoints, true);
  assert.deepEqual(
    initialized.body.exceptionBreakpointFilters.map(({ filter }) => filter),
    ["uncaught", "all"]
  );
  adapter.afterResponse(request(1, "initialize"));
  assert.equal(events.at(-1).event, "initialized");
  assert.equal((await adapter.handle(request(2, "attach"))).success, true);

  const set = await adapter.handle(request(3, "setBreakpoints", {
    source: { path: fixture.source },
    breakpoints: [{ line: 2, column: 3, condition: "answer === 42" }]
  }));
  assert.equal(set.success, true);
  assert.equal(set.body.breakpoints[0].verified, true);
  assert.equal(calls.find(({ method }) => method === "Debugger.setBreakpointByUrl").params.url, session.bundleUrl);

  listeners.get("Debugger.scriptParsed")({ scriptId: "script-1", url: session.bundleUrl });
  for (let index = 0; index < 20 && breakpointSequence < 2; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(breakpointSequence, 2, "HMR script parsing reapplies the authored breakpoint");
  const replaced = await adapter.handle(request(31, "setBreakpoints", {
    source: { path: fixture.source },
    breakpoints: [{ line: 3, column: 3 }]
  }));
  assert.equal(replaced.success, true);
  assert.ok(
    calls.some(({ method, params }) => method === "Debugger.removeBreakpoint" && params.breakpointId === "bp-2"),
    "a DAP replacement removes the preceding CDP breakpoint instead of leaking it"
  );

  listeners.get("Debugger.paused")({
    reason: "breakpoint",
    callFrames: [{
      callFrameId: "frame-1",
      functionName: "tick",
      location: { scriptId: "script-1", lineNumber: generated.line - 1, columnNumber: generated.column },
      scopeChain: [{ type: "local", object: { objectId: "scope-1", type: "object" } }],
      this: { objectId: "this-1", type: "object", description: "GameObject" }
    }]
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
  const variables = await adapter.handle(request(6, "variables", {
    variablesReference: scopes.body.scopes[0].variablesReference
  }));
  assert.equal(variables.body.variables[0].value, "42");
  const evaluated = await adapter.handle(request(7, "evaluate", { frameId, expression: "answer" }));
  assert.equal(evaluated.body.result, "42");
  assert.equal((await adapter.handle(request(8, "disconnect"))).success, true);
  assert.equal(calls.at(-1).method, "Debugger.resume", "disconnect resumes a paused game before detaching");
});
