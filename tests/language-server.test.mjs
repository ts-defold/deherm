import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { applyContentChanges, runLanguageServer } from "../packages/cli/src/lsp/server.mjs";
import { createContentLengthJsonTransport } from "../packages/cli/src/protocol/content-length-json.mjs";
import { createResourceSemanticIndex } from "../packages/cli/src/lsp/resource-semantics.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-lsp-"));
  await mkdir(path.join(root, ".deherm", "generated"), { recursive: true });
  await mkdir(path.join(root, "main"), { recursive: true });
  await writeFile(path.join(root, "game.project"), "[project]\ntitle = LSP fixture\n");
  await writeFile(path.join(root, "main", "player.go"), "components {\n  id: \"sprite\"\n}\n");
  await writeFile(path.join(root, "main", "main.collection"), "instances {\n  id: \"player\"\n}\n");
  return root;
}

function symbols(extra = {}) {
  return {
    schemaVersion: 1,
    generator: "fixture",
    declarations: {
      "/main/player.go": {
        "go:component": [{ name: "sprite", line: 2, field: "components" }]
      },
      "/main/player.atlas": {
        "atlas:animation": [{ name: "idle", line: 7, field: "animations" }]
      }
    },
    gameObjects: {
      "/main/player.go": {
        components: {
          sprite: { line: 2, type: "sprite", component: null, resources: {} }
        }
      }
    },
    collections: {
      "/main/main.collection": {
        instances: {
          player: { line: 2, prototype: "/main/player.go" }
        }
      }
    },
    components: {
      "main/player.script.ts": {
        proxy: "/main/player.script",
        gameObject: "/main/player.go",
        componentId: "player",
        collection: "/main/main.collection"
      }
    },
    diagnostics: [],
    ...extra
  };
}

function client(serverInput, serverOutput) {
  const transport = createContentLengthJsonTransport(serverOutput, serverInput, { protocol: "test LSP client" });
  const pending = new Map();
  let nextId = 1;
  transport.on("message", (message) => {
    if (!Object.hasOwn(message, "id")) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  return {
    notify(method, params) {
      transport.send({ jsonrpc: "2.0", method, params });
    },
    request(method, params) {
      const id = nextId++;
      const result = new Promise((resolve) => pending.set(id, resolve));
      transport.send({ jsonrpc: "2.0", id, method, params });
      return result;
    }
  };
}

test("Defold semantic LSP completes, explains, and locates generated project symbols", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".deherm", "generated", "resource-symbols.json"), `${JSON.stringify(symbols())}\n`);
  const serverInput = new PassThrough();
  const serverOutput = new PassThrough();
  const running = runLanguageServer({ projectRoot: root, input: serverInput, output: serverOutput });
  const rpc = client(serverInput, serverOutput);
  const initialized = await rpc.request("initialize", { rootUri: pathToFileURL(root).href, capabilities: {} });
  assert.equal(initialized.result.serverInfo.name, "deherm");
  assert.equal(initialized.result.capabilities.hoverProvider, true);

  const uri = pathToFileURL(path.join(root, "main", "player.script.ts")).href;
  const text = 'const target = "#sprite";\n';
  rpc.notify("initialized", {});
  rpc.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version: 1, text }
  });

  const completion = await rpc.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 0, character: 19 }
  });
  assert.ok(completion.result.some(({ label }) => label === "#sprite"));
  assert.ok(completion.result.some(({ label }) => label === "/player#sprite"));

  const hover = await rpc.request("textDocument/hover", {
    textDocument: { uri },
    position: { line: 0, character: 20 }
  });
  assert.match(hover.result.contents.value, /component · sprite/u);
  assert.match(hover.result.contents.value, /player\.go/u);

  const definition = await rpc.request("textDocument/definition", {
    textDocument: { uri },
    position: { line: 0, character: 20 }
  });
  assert.equal(definition.result[0].uri, pathToFileURL(path.join(root, "main", "player.go")).href);
  assert.equal(definition.result[0].range.start.line, 1);

  assert.equal((await rpc.request("shutdown", null)).result, null);
  rpc.notify("exit", null);
  assert.equal(await running, 0);
});

test("Defold semantic LSP reloads its generated index without restarting", async () => {
  const root = await fixture();
  const symbolFile = path.join(root, ".deherm", "generated", "resource-symbols.json");
  await writeFile(symbolFile, `${JSON.stringify(symbols())}\n`);
  const serverInput = new PassThrough();
  const serverOutput = new PassThrough();
  const running = runLanguageServer({ projectRoot: root, input: serverInput, output: serverOutput });
  const rpc = client(serverInput, serverOutput);
  await rpc.request("initialize", { rootUri: pathToFileURL(root).href, capabilities: {} });
  rpc.notify("initialized", {});
  const uri = pathToFileURL(path.join(root, "main", "player.script.ts")).href;
  rpc.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version: 1, text: 'const target = "#bo";\n' }
  });
  const before = await rpc.request("textDocument/completion", {
    textDocument: { uri }, position: { line: 0, character: 19 }
  });
  assert.equal(before.result.some(({ label }) => label === "#body"), false);

  const updated = symbols();
  updated.gameObjects["/main/player.go"].components.body = { line: 3, type: "collisionobject", component: null, resources: {} };
  await writeFile(symbolFile, `${JSON.stringify(updated)}\n`);
  rpc.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(symbolFile).href, type: 2 }] });
  const after = await rpc.request("textDocument/completion", {
    textDocument: { uri }, position: { line: 0, character: 19 }
  });
  assert.ok(after.result.some(({ label }) => label === "#body"));

  await rpc.request("shutdown", null);
  rpc.notify("exit", null);
  assert.equal(await running, 0);
});

test("missing generated semantics is an actionable request error, not a server crash", async () => {
  const root = await fixture();
  const serverInput = new PassThrough();
  const serverOutput = new PassThrough();
  const running = runLanguageServer({ projectRoot: root, input: serverInput, output: serverOutput });
  const rpc = client(serverInput, serverOutput);
  await rpc.request("initialize", { rootUri: pathToFileURL(root).href, capabilities: {} });
  const uri = pathToFileURL(path.join(root, "main", "player.script.ts")).href;
  rpc.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version: 1, text: 'const target = "#sp";\n' }
  });
  const missing = await rpc.request("textDocument/completion", {
    textDocument: { uri }, position: { line: 0, character: 19 }
  });
  assert.equal(missing.error.code, -32603);
  assert.match(missing.error.message, /resource-symbols\.json/u);
  assert.match(missing.error.message, /deherm generate/u);

  await writeFile(path.join(root, ".deherm", "generated", "resource-symbols.json"), `${JSON.stringify(symbols())}\n`);
  const recovered = await rpc.request("textDocument/completion", {
    textDocument: { uri }, position: { line: 0, character: 19 }
  });
  assert.ok(recovered.result.some(({ label }) => label === "#sprite"));

  await rpc.request("shutdown", null);
  rpc.notify("exit", null);
  assert.equal(await running, 0);
});

test("incremental LSP edits preserve CRLF offsets and UTF-16 character positions", () => {
  assert.equal(
    applyContentChanges("first\r\nconst target = \"#old\";\r\nlast", [{
      range: {
        start: { line: 1, character: 16 },
        end: { line: 1, character: 20 }
      },
      text: "#new"
    }]),
    "first\r\nconst target = \"#new\";\r\nlast"
  );
  assert.equal(
    applyContentChanges("const emoji = \"🚀old\";", [{
      range: {
        start: { line: 0, character: 17 },
        end: { line: 0, character: 20 }
      },
      text: "new"
    }]),
    "const emoji = \"🚀new\";"
  );
});

test("malformed generated state is actionable and non-file documents stay outside the project", async () => {
  const root = await fixture();
  const symbolFile = path.join(root, ".deherm", "generated", "resource-symbols.json");
  await writeFile(symbolFile, "{ not json\n");
  const index = createResourceSemanticIndex(root);
  await assert.rejects(
    index.complete(
      pathToFileURL(path.join(root, "main", "player.script.ts")).href,
      'const target = "#sp";',
      { line: 0, character: 19 }
    ),
    /malformed.*deherm generate/u
  );
  assert.deepEqual(await index.complete(
    "untitled:Untitled-1",
    'const target = "#sp";',
    { line: 0, character: 19 }
  ), []);
});

test("an in-flight semantic request cannot reply after an orderly exit", async () => {
  let releaseCompletion;
  const completion = new Promise((resolve) => { releaseCompletion = resolve; });
  const semanticIndex = {
    invalidate() {},
    complete: async () => await completion,
    hover: async () => null,
    definition: async () => null
  };
  const serverInput = new PassThrough();
  const serverOutput = new PassThrough();
  const running = runLanguageServer({ projectRoot: "/fixture", input: serverInput, output: serverOutput, semanticIndex });
  const rpc = client(serverInput, serverOutput);
  await rpc.request("initialize", { capabilities: {} });
  rpc.notify("textDocument/didOpen", {
    textDocument: { uri: "file:///fixture/main.script.ts", languageId: "typescript", version: 1, text: 'const target = "#sp";' }
  });
  void rpc.request("textDocument/completion", {
    textDocument: { uri: "file:///fixture/main.script.ts" },
    position: { line: 0, character: 19 }
  });
  await rpc.request("shutdown", null);
  rpc.notify("exit", null);
  assert.equal(await running, 0);
  releaseCompletion([]);
  await new Promise((resolve) => setImmediate(resolve));
});
