import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { connectCdp } from "./browser-host.mjs";
import { DebugSourceMap } from "./debug-source-map.mjs";
import { createDapTransport } from "./dap-protocol.mjs";
import { defaultInspectorSessionFile, discoverInspectorTarget } from "./inspector-session.mjs";

function remoteValue(remote) {
  if (!remote) return "undefined";
  if (remote.unserializableValue !== undefined) return String(remote.unserializableValue);
  if (remote.type === "string") return JSON.stringify(remote.value ?? "");
  if (remote.subtype === "null") return "null";
  if (remote.value !== undefined) return String(remote.value);
  return remote.description ?? remote.className ?? remote.type ?? "object";
}

function scopeHint(type) {
  if (type === "global") return "globals";
  if (type === "local" || type === "closure" || type === "catch") return "locals";
  return "registers";
}

const browserBundleUrlRegex = "^defold-hermes://app(?:\\.\\d+)?\\.js$";

function breakpointUrl(session) {
  return session?.runtime === "browser"
    ? { urlRegex: browserBundleUrlRegex }
    : { url: session.bundleUrl };
}

function isBundleScript(session, url) {
  if (session?.runtime === "browser") return new RegExp(browserBundleUrlRegex, "u").test(url);
  return url === session?.bundleUrl;
}

function browserBundleGeneration(url) {
  const match = /^defold-hermes:\/\/app(?:\.(\d+))?\.js$/u.exec(url ?? "");
  return match ? Number.parseInt(match[1] ?? "0", 10) : -1;
}

export async function createDapAdapter(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const sessionFile = path.resolve(options.sessionFile ?? defaultInspectorSessionFile(projectRoot));
  const emit = options.emit ?? (() => {});
  const connect = options.connectCdp ?? connectCdp;
  const discover = options.discoverInspectorTarget ?? discoverInspectorTarget;
  let sequence = 1;
  let client;
  let session;
  let sourceMap;
  let paused = [];
  let pauseDetails = null;
  let nextFrameId = 1;
  let nextVariableReference = 1;
  let nextBreakpointId = 1;
  let breakpointQueue = Promise.resolve();
  const frameById = new Map();
  const objectByReference = new Map();
  const breakpointSources = new Map();
  const cdpBreakpoints = new Map();
  const scripts = new Map();
  let newestBundleScriptId;

  const message = (value) => emit({ seq: sequence += 1, ...value });
  const event = (name, body = {}) => message({ type: "event", event: name, body });
  const response = (request, body = {}) => ({
    seq: sequence += 1,
    type: "response",
    request_seq: request.seq,
    command: request.command,
    success: true,
    body
  });
  const failure = (request, error) => ({
    seq: sequence += 1,
    type: "response",
    request_seq: request.seq,
    command: request.command,
    success: false,
    message: error instanceof Error ? error.message : String(error),
    body: { error: { id: 1, format: error instanceof Error ? error.message : String(error) } }
  });
  const refreshMap = async () => {
    if (!session?.sourceMapFile) return false;
    sourceMap ??= new DebugSourceMap(session.sourceMapFile);
    try {
      return await sourceMap.refresh();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  const dapSource = (file) => file ? { name: path.basename(file), path: file } : undefined;
  const rawScriptSource = (source) => {
    if (source?.url?.startsWith("file:")) return dapSource(fileURLToPath(source.url));
    if (source?.url) return { name: source.url.split("/").at(-1) || source.url, path: source.url };
    return undefined;
  };
  const sourceUsesCurrentMap = (source) => {
    if (session?.runtime !== "browser") return true;
    return source?.scriptId === newestBundleScriptId && isBundleScript(session, source.url);
  };
  const mapGeneratedLocation = (source, lineNumber, columnNumber = 0) => {
    const original = sourceMap?.trace && sourceUsesCurrentMap(source)
      ? sourceMap.original(lineNumber + 1, columnNumber)
      : null;
    if (original) return {
      source: dapSource(original.source),
      line: original.line,
      column: original.column + 1
    };
    return {
      source: rawScriptSource(source),
      line: lineNumber + 1,
      column: columnNumber + 1
    };
  };
  const preferredBreakpointLocation = (locations = []) => {
    if (session?.runtime !== "browser") return locations[0];
    const current = locations.find(({ scriptId }) => scriptId === newestBundleScriptId);
    if (current) return current;
    return locations
      .filter(({ scriptId }) => isBundleScript(session, scripts.get(scriptId)?.url))
      .sort((left, right) => browserBundleGeneration(scripts.get(right.scriptId)?.url)
        - browserBundleGeneration(scripts.get(left.scriptId)?.url))[0];
  };
  const referenceFor = (object) => {
    if (!object?.objectId) return 0;
    const reference = nextVariableReference;
    nextVariableReference += 1;
    objectByReference.set(reference, object.objectId);
    return reference;
  };
  const clearPause = () => {
    paused = [];
    pauseDetails = null;
    frameById.clear();
    objectByReference.clear();
    nextFrameId = 1;
    nextVariableReference = 1;
  };
  const applyBreakpointSource = async (record) => {
    for (const id of record.cdpIds) {
      await client.send("Debugger.removeBreakpoint", { breakpointId: id }, { timeoutMs: 5_000 }).catch(() => {});
      cdpBreakpoints.delete(id);
    }
    record.cdpIds = [];
    await refreshMap();
    const results = [];
    for (const spec of record.breakpoints) {
      const generated = sourceMap?.trace
        ? sourceMap.generated(record.source, spec.line, Math.max(0, (spec.column ?? 1) - 1))
        : null;
      if (!session?.bundleUrl || !generated) {
        results.push({
          id: spec.id,
          verified: false,
          source: dapSource(record.source),
          line: spec.line,
          column: spec.column ?? 1,
          message: session?.bundleUrl ? "No executable source-map location for this line" : "The dev session published no debug bundle URL"
        });
        continue;
      }
      const answer = await client.send("Debugger.setBreakpointByUrl", {
        lineNumber: generated.line - 1,
        columnNumber: generated.column,
        ...breakpointUrl(session),
        ...(spec.condition ? { condition: spec.condition } : {})
      }, { timeoutMs: 10_000 });
      record.cdpIds.push(answer.breakpointId);
      cdpBreakpoints.set(answer.breakpointId, { record, spec });
      const actual = preferredBreakpointLocation(answer.locations);
      const actualSource = actual ? scripts.get(actual.scriptId) : undefined;
      const mapped = actual
        ? mapGeneratedLocation(actualSource, actual.lineNumber, actual.columnNumber)
        : { source: dapSource(record.source), line: spec.line, column: spec.column ?? 1 };
      results.push({
        id: spec.id,
        verified: Boolean(actual),
        ...mapped,
        ...(!actual ? { message: "Breakpoint is pending the next matching script load" } : {})
      });
    }
    return results;
  };
  const enqueueBreakpoints = (operation) => {
    const current = breakpointQueue.then(operation);
    breakpointQueue = current.catch(() => {});
    return current;
  };
  const reapplyBreakpoints = () => enqueueBreakpoints(async () => {
    for (const record of breakpointSources.values()) {
      const results = await applyBreakpointSource(record);
      for (const breakpoint of results) event("breakpoint", { reason: "changed", breakpoint });
    }
  });
  const onPaused = async (params) => {
    await refreshMap();
    clearPause();
    paused = params.callFrames ?? [];
    pauseDetails = params;
    for (const callFrame of paused) {
      const id = nextFrameId;
      nextFrameId += 1;
      frameById.set(id, callFrame);
      callFrame.__dapFrameId = id;
    }
    event("stopped", {
      reason: params.reason === "exception" ? "exception" : params.reason === "step" ? "step" : "breakpoint",
      threadId: 1,
      allThreadsStopped: true,
      ...(params.description ? { description: params.description } : {})
    });
  };

  const attach = async (args = {}) => {
    if (client) {
      if (paused.length) await client.send("Debugger.resume", {}, { timeoutMs: 5_000 }).catch(() => {});
      await client.close();
      client = undefined;
      clearPause();
    }
    scripts.clear();
    newestBundleScriptId = undefined;
    const discovered = await discover({
      projectRoot,
      sessionFile: args.inspectorSession ? path.resolve(projectRoot, args.inspectorSession) : sessionFile,
      replaceDebugger: args.replaceDebugger === true || options.replaceDebugger === true
    });
    session = discovered.session;
    await refreshMap();
    const websocket = new URL(discovered.target.webSocketDebuggerUrl);
    if (session.runtime !== "browser" &&
        (args.replaceDebugger === true || options.replaceDebugger === true)) {
      websocket.searchParams.set("replace", "1");
    }
    client = await connect(websocket.href, { retain: false });
    client.onEvent("Debugger.scriptParsed", (params) => {
      scripts.set(params.scriptId, params);
      if (isBundleScript(session, params.url)) {
        const previous = newestBundleScriptId ? scripts.get(newestBundleScriptId) : undefined;
        if (!previous || browserBundleGeneration(params.url) >= browserBundleGeneration(previous.url)) {
          newestBundleScriptId = params.scriptId;
        }
      }
      if (isBundleScript(session, params.url) && breakpointSources.size) {
        void reapplyBreakpoints().catch((error) => event("output", {
          category: "stderr",
          output: `déherm could not reapply breakpoints after reload: ${error.message}\n`
        }));
      }
    });
    client.onEvent("Debugger.breakpointResolved", ({ breakpointId, location }) => {
      const owner = cdpBreakpoints.get(breakpointId);
      if (!owner) return;
      const source = scripts.get(location.scriptId);
      if (session?.runtime === "browser" && !sourceUsesCurrentMap(source)) return;
      const mapped = mapGeneratedLocation(source, location.lineNumber, location.columnNumber);
      event("breakpoint", {
        reason: "changed",
        breakpoint: { id: owner.spec.id, verified: true, ...mapped }
      });
    });
    client.onEvent("Debugger.paused", (params) => {
      void onPaused(params).catch((error) => event("output", { category: "stderr", output: `${error.message}\n` }));
    });
    client.onEvent("Debugger.resumed", () => {
      clearPause();
      event("continued", { threadId: 1, allThreadsContinued: true });
    });
    await client.send("Runtime.enable", {}, { timeoutMs: 10_000 });
    await client.send("Debugger.enable", {}, { timeoutMs: 10_000 });
    await client.send("Debugger.setBreakpointsActive", { active: true }, { timeoutMs: 10_000 });
  };

  return {
    async handle(request) {
      try {
        switch (request.command) {
          case "initialize":
            return response(request, {
              supportsConfigurationDoneRequest: true,
              supportsEvaluateForHovers: true,
              supportsLoadedSourcesRequest: true,
              supportsExceptionInfoRequest: true,
              supportsTerminateRequest: false,
              supportsConditionalBreakpoints: true,
              supportsHitConditionalBreakpoints: false,
              supportsLogPoints: false,
              exceptionBreakpointFilters: [
                { filter: "uncaught", label: "Uncaught exceptions", default: true },
                { filter: "all", label: "All exceptions", default: false }
              ]
            });
          case "attach":
          case "launch":
            await attach(request.arguments);
            return response(request);
          case "configurationDone":
            return response(request);
          case "threads":
            return response(request, { threads: [{ id: 1, name: "Hermes / Defold" }] });
          case "setBreakpoints": {
            if (!client) throw new Error("Attach to a running déherm dev session before setting breakpoints");
            const requestedSource = request.arguments?.source?.path;
            if (typeof requestedSource !== "string" || !requestedSource) {
              throw new Error("setBreakpoints requires source.path");
            }
            const source = path.resolve(requestedSource);
            await access(source);
            const record = breakpointSources.get(source) ?? { source, cdpIds: [], breakpoints: [] };
            record.breakpoints = (request.arguments?.breakpoints ?? []).map((breakpoint) => {
              const id = nextBreakpointId;
              nextBreakpointId += 1;
              return { ...breakpoint, id };
            });
            breakpointSources.set(source, record);
            const breakpoints = await enqueueBreakpoints(() => applyBreakpointSource(record));
            return response(request, { breakpoints });
          }
          case "setExceptionBreakpoints": {
            const filters = new Set(request.arguments?.filters ?? []);
            const state = filters.has("all") ? "all" : filters.has("uncaught") ? "uncaught" : "none";
            await client.send("Debugger.setPauseOnExceptions", { state }, { timeoutMs: 10_000 });
            return response(request);
          }
          case "stackTrace": {
            const start = request.arguments?.startFrame ?? 0;
            const levels = request.arguments?.levels ?? paused.length;
            const stackFrames = paused.slice(start, start + levels).map((callFrame) => {
              const mapped = mapGeneratedLocation(
                scripts.get(callFrame.location.scriptId),
                callFrame.location.lineNumber,
                callFrame.location.columnNumber
              );
              return {
                id: callFrame.__dapFrameId,
                name: callFrame.functionName || "(anonymous)",
                ...mapped
              };
            });
            return response(request, { stackFrames, totalFrames: paused.length });
          }
          case "scopes": {
            const callFrame = frameById.get(request.arguments?.frameId);
            if (!callFrame) throw new Error("Unknown or stale stack frame");
            const scopes = (callFrame.scopeChain ?? []).map((scope) => ({
              name: scope.name || scope.type || "scope",
              presentationHint: scopeHint(scope.type),
              variablesReference: referenceFor(scope.object),
              expensive: scope.type === "global"
            }));
            if (callFrame.this) scopes.push({
              name: "this",
              presentationHint: "locals",
              variablesReference: referenceFor(callFrame.this),
              expensive: false
            });
            return response(request, { scopes });
          }
          case "variables": {
            const objectId = objectByReference.get(request.arguments?.variablesReference);
            if (!objectId) throw new Error("Unknown or stale variables reference");
            const result = await client.send("Runtime.getProperties", {
              objectId,
              ownProperties: false,
              accessorPropertiesOnly: false,
              generatePreview: true
            }, { timeoutMs: 10_000 });
            const variables = (result.result ?? []).filter((property) => property.value).map((property) => ({
              name: property.name,
              value: remoteValue(property.value),
              type: property.value.type,
              variablesReference: referenceFor(property.value),
              evaluateName: property.name
            }));
            return response(request, { variables });
          }
          case "evaluate": {
            const callFrame = frameById.get(request.arguments?.frameId);
            const result = callFrame
              ? await client.send("Debugger.evaluateOnCallFrame", {
                  callFrameId: callFrame.callFrameId,
                  expression: request.arguments.expression,
                  generatePreview: true,
                  returnByValue: false
                }, { timeoutMs: 10_000 })
              : await client.send("Runtime.evaluate", {
                  expression: request.arguments.expression,
                  generatePreview: true,
                  returnByValue: false
                }, { timeoutMs: 10_000 });
            return response(request, {
              result: remoteValue(result.result),
              type: result.result?.type,
              variablesReference: referenceFor(result.result)
            });
          }
          case "continue":
            await client.send("Debugger.resume", {}, { timeoutMs: 10_000 });
            return response(request, { allThreadsContinued: true });
          case "next":
            await client.send("Debugger.stepOver", {}, { timeoutMs: 10_000 });
            return response(request);
          case "stepIn":
            await client.send("Debugger.stepInto", {}, { timeoutMs: 10_000 });
            return response(request);
          case "stepOut":
            await client.send("Debugger.stepOut", {}, { timeoutMs: 10_000 });
            return response(request);
          case "pause":
            await client.send("Debugger.pause", {}, { timeoutMs: 10_000 });
            return response(request);
          case "loadedSources":
            await refreshMap();
            return response(request, { sources: (sourceMap?.sources ?? []).map((source) => dapSource(source.path)) });
          case "source": {
            await refreshMap();
            const requested = request.arguments?.source?.path;
            const content = requested ? sourceMap?.content(requested) : null;
            if (content == null) throw new Error("Source content is unavailable");
            return response(request, { content, mimeType: "text/typescript" });
          }
          case "exceptionInfo":
            return response(request, {
              exceptionId: pauseDetails?.data?.className ?? "hermes",
              description: pauseDetails?.description ?? pauseDetails?.data?.description ?? "Hermes JavaScript exception",
              breakMode: "always"
            });
          case "disconnect":
          case "terminate":
            if (paused.length) await client?.send("Debugger.resume", {}, { timeoutMs: 5_000 }).catch(() => {});
            await client?.close();
            client = undefined;
            return response(request);
          default:
            throw new Error(`Unsupported DAP request: ${request.command}`);
        }
      } catch (error) {
        return failure(request, error);
      }
    },
    afterResponse(request) {
      if (request.command === "initialize") event("initialized");
      if (request.command === "disconnect" || request.command === "terminate") event("terminated");
    },
    async close() {
      await client?.close();
      client = undefined;
    }
  };
}

export async function runDapSession(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const transport = createDapTransport(input, output);
  const adapter = await createDapAdapter({ ...options, emit: (message) => transport.send(message) });
  let queue = Promise.resolve();
  return new Promise((resolve, reject) => {
    transport.on("error", (error) => {
      void adapter.close().finally(() => reject(error));
    });
    transport.on("end", () => {
      void queue.finally(() => adapter.close()).then(resolve, reject);
    });
    transport.on("message", (request) => {
      if (request?.type !== "request") return;
      queue = queue.then(async () => {
        const answer = await adapter.handle(request);
        transport.send(answer);
        adapter.afterResponse(request);
        if (request.command === "disconnect" || request.command === "terminate") {
          transport.close();
          resolve();
        }
      });
    });
  });
}
