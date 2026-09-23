import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { applyContentChanges, runLanguageServer } from "../packages/cli/src/lsp/server.mjs";
import { createContentLengthJsonTransport } from "../packages/cli/src/protocol/content-length-json.mjs";
import { createResourceSemanticIndex, semanticContextAt } from "../packages/cli/src/lsp/resource-semantics.mjs";

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
    namespaceKinds: {
      "atlas:animation": { kind: "animation", extension: ".atlas" },
      "collection:instance": { kind: "instance", extension: ".collection" },
      "go:component": { kind: "component", extension: ".go" },
      "gui:node": { kind: "node", extension: ".gui" },
      "material:constant": { kind: "constant", extension: ".material" },
      "render:material": { kind: "material", extension: ".render" }
    },
    declarations: {
      "/main/player.go": {
        "go:component": [{ name: "sprite", line: 2, field: "components" }]
      },
      "/main/player.atlas": {
        "atlas:animation": [
          { name: "idle", line: 7, field: "animations" },
          { name: "run", line: 11, field: "animations" }
        ]
      },
      "/main/enemy.atlas": {
        "atlas:animation": [{ name: "enemy-idle", line: 5, field: "animations" }]
      },
      "/main/hud.gui": {
        "gui:node": [
          { name: "score", line: 4, field: "nodes" },
          { name: "status", line: 9, field: "nodes" }
        ]
      },
      "/main/menu.gui": {
        "gui:node": [{ name: "status", line: 19, field: "nodes" }]
      },
      "/main/game.render": {
        "render:material": [{ name: "world", line: 6, field: "materials" }]
      }
    },
    gameObjects: {
      "/main/player.go": {
        components: {
          sprite: {
            line: 2,
            type: "sprite",
            component: null,
            resources: { ".atlas": { path: "/main/player.atlas", line: 3 } }
          },
          enemy_sprite: {
            line: 5,
            type: "sprite",
            component: null,
            resources: { ".atlas": { path: "/main/enemy.atlas", line: 6 } }
          }
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
      },
      "main/hud.gui.ts": {
        proxy: "/main/hud.gui_script",
        attachedResource: "/main/hud.gui",
        attachedExtension: ".gui",
        gameObject: "/main/player.go",
        componentId: "hud",
        collection: "/main/main.collection"
      },
      "main/game.render.ts": {
        proxy: "/main/game.render_script",
        attachedResource: "/main/game.render",
        attachedExtension: ".render"
      }
    },
    routes: {
      "GuiApi.getNode": {
        0: { parameter: "id", jsParameter: "id", namespaces: ["gui:node"], scope: "attached-resource" }
      },
      "MsgApi.post": {
        0: { parameter: "receiver", jsParameter: "receiver", namespaces: ["go:component", "collection:instance"], scope: "component-address" }
      },
      "RenderApi.enableMaterial": {
        0: { parameter: "material_id", jsParameter: "materialId", namespaces: ["render:material"], scope: "attached-resource" }
      },
      "SpriteApi.playFlipbook": {
        0: { parameter: "url", jsParameter: "url", namespaces: ["go:component", "collection:instance"], scope: "component-address" },
        1: {
          parameter: "id",
          jsParameter: "id",
          namespaces: ["atlas:animation"],
          scope: "addressed-component-resource",
          addressParameter: 0
        }
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

function positionOf(text, needle, occurrence = 0, inside = 1) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) offset = text.indexOf(needle, offset + 1);
  assert.notEqual(offset, -1, `missing ${JSON.stringify(needle)} occurrence ${occurrence}`);
  offset += inside;
  const prefix = text.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1).replace(/\r$/u, "").length };
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

test("route metadata scopes completion, hover, and definition to the exact Defold call argument", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".deherm", "generated", "resource-symbols.json"), `${JSON.stringify(symbols())}\n`);
  const index = createResourceSemanticIndex(root);
  const guiUri = pathToFileURL(path.join(root, "main", "hud.gui.ts")).href;
  const guiText = 'import { gui as ui } from "@deherm/project";\r\nconst emoji = "🚀"; ui.getNode("status");';
  const guiPosition = { line: 1, character: guiText.split("\r\n")[1].indexOf("status") + 3 };
  const guiCompletion = await index.complete(guiUri, guiText, guiPosition);
  assert.deepEqual(guiCompletion.map(({ label }) => label), ["status"]);
  assert.ok(guiCompletion.every(({ detail }) => detail === "gui:node"));
  assert.equal(guiCompletion.some(({ label }) => label === "idle" || label === "#sprite"), false);

  const guiHover = await index.hover(guiUri, guiText, guiPosition);
  assert.match(guiHover.contents.value, /gui:node/u);
  assert.match(guiHover.contents.value, /main\/hud\.gui/u);
  assert.doesNotMatch(guiHover.contents.value, /main\/menu\.gui/u);
  const guiDefinition = await index.definition(guiUri, guiText, guiPosition);
  assert.deepEqual(guiDefinition, [{
    uri: pathToFileURL(path.join(root, "main", "hud.gui")).href,
    range: { start: { line: 8, character: 0 }, end: { line: 8, character: 0 } }
  }]);
  const namespaceAliasText = 'import * as sdk from "@deherm/project";\nsdk.gui.getNode("status");';
  const namespaceAliasCompletion = await index.complete(guiUri, namespaceAliasText, { line: 1, character: 22 });
  assert.deepEqual(namespaceAliasCompletion.map(({ label }) => label), ["status"]);

  const scriptUri = pathToFileURL(path.join(root, "main", "player.script.ts")).href;
  const atlasText = 'sprite.playFlipbook("#sprite", "idle");';
  const atlasPosition = { line: 0, character: atlasText.indexOf("idle") + 2 };
  const atlasCompletion = await index.complete(scriptUri, atlasText, atlasPosition);
  assert.deepEqual(atlasCompletion.map(({ label }) => label), ["idle"]);
  const atlasHover = await index.hover(scriptUri, atlasText, atlasPosition);
  assert.match(atlasHover.contents.value, /main\/player\.atlas/u);
  assert.doesNotMatch(atlasHover.contents.value, /enemy\.atlas/u);
  const atlasDefinition = await index.definition(scriptUri, atlasText, atlasPosition);
  assert.equal(atlasDefinition[0].uri, pathToFileURL(path.join(root, "main", "player.atlas")).href);
  assert.equal(atlasDefinition[0].range.start.line, 6);

  const renderUri = pathToFileURL(path.join(root, "main", "game.render.ts")).href;
  const renderText = 'render.enableMaterial("world");';
  const renderCompletion = await index.complete(renderUri, renderText, { line: 0, character: 27 });
  assert.deepEqual(renderCompletion.map(({ label }) => label), ["world"]);

  const unrelatedImport = 'import { gui } from "unrelated";\ngui.getNode("");';
  const unrelatedCompletion = await index.complete(guiUri, unrelatedImport, { line: 1, character: 13 });
  assert.ok(unrelatedCompletion.some(({ label }) => label === "idle"));
  assert.ok(unrelatedCompletion.some(({ label }) => label === "#sprite"));
});

test("addressed material routes project every bound same-extension resource", async () => {
  const root = await fixture();
  const table = symbols({
    declarations: {
      "/main/body.material": {
        "material:constant": [{ name: "body_tint", line: 4, field: "vertex_constants" }]
      },
      "/main/turret.material": {
        "material:constant": [{ name: "turret_tint", line: 7, field: "fragment_constants" }]
      }
    },
    gameObjects: {
      "/main/player.go": {
        components: {
          sprite: {
            line: 2,
            type: "sprite",
            component: null,
            resources: {
              ".material": {
                path: "/main/body.material",
                line: 3,
                paths: ["/main/body.material", "/main/turret.material"]
              }
            }
          }
        }
      }
    },
    routes: {
      "SpriteApi.resetConstant": {
        0: { parameter: "url", jsParameter: "url", namespaces: ["go:component", "collection:instance"], scope: "component-address" },
        1: { parameter: "constant", jsParameter: "constant", namespaces: ["material:constant"], scope: "addressed-component-resource", addressParameter: 0 }
      }
    }
  });
  await writeFile(path.join(root, ".deherm", "generated", "resource-symbols.json"), `${JSON.stringify(table)}\n`);
  const index = createResourceSemanticIndex(root);
  const uri = pathToFileURL(path.join(root, "main", "player.script.ts")).href;
  const text = 'sprite.resetConstant("#sprite", "turret_");';
  const position = { line: 0, character: text.indexOf("turret_") + 3 };
  const completion = await index.complete(uri, text, position);
  assert.deepEqual(completion.map(({ label }) => label), ["turret_tint"]);

  const fullText = 'sprite.resetConstant("#sprite", "body_tint");';
  const fullPosition = { line: 0, character: fullText.indexOf("body_tint") + 3 };
  const hover = await index.hover(uri, fullText, fullPosition);
  assert.match(hover.contents.value, /body\.material/u);
  const definition = await index.definition(uri, fullText, fullPosition);
  assert.equal(definition[0].uri, pathToFileURL(path.join(root, "main", "body.material")).href);
  assert.equal(definition[0].range.start.line, 3);
});

test("route matching respects lexical bindings, direct arguments, regular expressions, and approved literal wrappers", async () => {
  const root = await fixture();
  const table = symbols();
  await writeFile(path.join(root, ".deherm", "generated", "resource-symbols.json"), `${JSON.stringify(table)}\n`);
  const index = createResourceSemanticIndex(root);
  const guiUri = pathToFileURL(path.join(root, "main", "hud.gui.ts")).href;

  const shadowedParameter = 'import { gui } from "@deherm/project"; function local(gui: unknown) { gui.getNode("status"); }';
  assert.equal(semanticContextAt(table, shadowedParameter, positionOf(shadowedParameter, "status", 0, 3)), null);
  const shadowedArrow = 'import { gui } from "@deherm/project"; const local = (gui: unknown) => gui.getNode("status");';
  assert.equal(semanticContextAt(table, shadowedArrow, positionOf(shadowedArrow, "status", 0, 3)), null);
  const defaultImport = 'import gui from "unrelated"; gui.getNode("status");';
  assert.equal(semanticContextAt(table, defaultImport, positionOf(defaultImport, "status", 0, 3)), null);
  const semicolonlessImports = [
    'import gui from "unrelated"',
    'import { gui as defoldGui } from "@deherm/project"',
    'gui.getNode("status")',
    'defoldGui.getNode("status")'
  ].join("\n");
  assert.equal(semanticContextAt(table, semicolonlessImports, positionOf(semicolonlessImports, "status", 0, 3)), null);
  assert.equal(semanticContextAt(table, semicolonlessImports, positionOf(semicolonlessImports, "status", 1, 3)).kind, "resource");
  for (const source of [
    'import { gui } from "@deherm/project"; function local({ gui }: { gui: unknown }) { gui.getNode("status"); }',
    'import { gui } from "@deherm/project"; function local({ client: gui }: { client: unknown }) { gui.getNode("status"); }',
    'import { gui } from "@deherm/project"; const { gui } = local; gui.getNode("status");',
    'import { gui } from "@deherm/project"; const { client: gui } = local; gui.getNode("status");',
    'import { gui } from "@deherm/project"; const object = { run(gui: unknown) { gui.getNode("status"); } };',
    'import { gui } from "@deherm/project"; const object = { run<T>({ gui }: { gui: T }) { gui.getNode("status"); } };',
    'import { gui } from "@deherm/project"; class Local { run(gui: unknown) { gui.getNode("status"); } }',
    'import { gui } from "@deherm/project"; class Local { run<T>(gui: T) { gui.getNode("status"); } }',
    'import { gui } from "@deherm/project"; try { fail(); } catch (gui) { gui.getNode("status"); }'
  ]) {
    assert.equal(semanticContextAt(table, source, positionOf(source, "status", 0, 3)), null, source);
  }
  const functionVar = [
    'import { gui } from "@deherm/project";',
    'function local() { if (ready) { var gui = fake; } gui.getNode("status"); }',
    'gui.getNode("status");'
  ].join("\n");
  assert.equal(semanticContextAt(table, functionVar, positionOf(functionVar, "status", 0, 3)), null);
  assert.equal(semanticContextAt(table, functionVar, positionOf(functionVar, "status", 1, 3)).kind, "resource");

  const nestedLocal = [
    'import { gui } from "@deherm/project";',
    'function local() { const gui = fake; gui.getNode("status"); }',
    'gui.getNode("status");'
  ].join("\n");
  assert.equal(semanticContextAt(table, nestedLocal, positionOf(nestedLocal, "status", 0, 3)), null);
  assert.equal(semanticContextAt(table, nestedLocal, positionOf(nestedLocal, "status", 1, 3)).kind, "resource");
  const outsideCompletion = await index.complete(guiUri, nestedLocal, positionOf(nestedLocal, "status", 1, 3));
  assert.deepEqual(outsideCompletion.map(({ label }) => label), ["status"]);

  const nestedCall = 'gui.getNode(helper("status"));';
  assert.equal(semanticContextAt(table, nestedCall, positionOf(nestedCall, "status", 0, 3)).kind, "none");
  assert.deepEqual(await index.complete(guiUri, nestedCall, positionOf(nestedCall, "status", 0, 3)), []);

  const regularExpression = '/gui.getNode("status")/;';
  assert.equal(semanticContextAt(table, regularExpression, positionOf(regularExpression, "status", 0, 3)).kind, "ignored");
  assert.deepEqual(await index.complete(guiUri, regularExpression, positionOf(regularExpression, "status", 0, 3)), []);
  for (const source of [
    'if (ready) /gui.getNode("status")/.test(text);',
    'if (ready) { run(); } /gui.getNode("status")/.test(text);',
    'const matcher = () => /gui.getNode("status")/;',
    'ready && /gui.getNode("status")/.test(text);',
    'async function scan() { for await (const item of items) /gui.getNode("status")/.test(text); }',
    'function matcher() { return /gui.getNode("status")/; }'
  ]) {
    assert.equal(semanticContextAt(table, source, positionOf(source, "status", 0, 3)).kind, "ignored", source);
    assert.deepEqual(await index.complete(guiUri, source, positionOf(source, "status", 0, 3)), [], source);
  }

  const localAlias = 'import { gui as ui } from "@deherm/project"; const localUi: unknown = ui; localUi.getNode("status");';
  assert.equal(semanticContextAt(table, localAlias, positionOf(localAlias, "status", 0, 3)).kind, "resource");
  const staticTemplate = 'gui.getNode(`status`);';
  assert.equal(semanticContextAt(table, staticTemplate, positionOf(staticTemplate, "status", 0, 3)).kind, "resource");
  const dynamicTemplate = 'gui.getNode(`sta${suffix}`);';
  assert.equal(semanticContextAt(table, dynamicTemplate, positionOf(dynamicTemplate, "sta", 0, 2)).kind, "ignored");
  assert.deepEqual(await index.complete(guiUri, dynamicTemplate, positionOf(dynamicTemplate, "sta", 0, 2)), []);

  const scriptUri = pathToFileURL(path.join(root, "main", "player.script.ts")).href;
  const wrapped = 'import { address as addr, hashLiteral as h } from "@deherm/project"; sprite.playFlipbook(addr("#sprite"), h("idle"));';
  const wrappedCompletion = await index.complete(scriptUri, wrapped, positionOf(wrapped, "idle", 0, 2));
  assert.deepEqual(wrappedCompletion.map(({ label }) => label), ["idle"]);
  const wrappedAddress = await index.complete(scriptUri, wrapped, positionOf(wrapped, "#sprite", 0, 3));
  assert.deepEqual(wrappedAddress.map(({ label }) => label), ["#sprite", "/player#sprite"]);
  const locallyAliasedWrappers = 'import { address, hashLiteral } from "@deherm/project"; const addr = address; const h = hashLiteral; sprite.playFlipbook(addr("#sprite"), h("idle"));';
  assert.deepEqual((await index.complete(scriptUri, locallyAliasedWrappers,
    positionOf(locallyAliasedWrappers, "idle", 0, 2))).map(({ label }) => label), ["idle"]);
  const unrelatedWrapper = 'import { address as addr } from "unrelated"; sprite.playFlipbook(addr("#sprite"), "");';
  assert.equal(semanticContextAt(table, unrelatedWrapper, positionOf(unrelatedWrapper, "#sprite", 0, 3)).kind, "none");
  const localWrapper = 'const hashLiteral = helper; sprite.playFlipbook("#sprite", hashLiteral("idle"));';
  assert.equal(semanticContextAt(table, localWrapper, positionOf(localWrapper, "idle", 0, 2)).kind, "none");

  for (const source of [
    'sprite.playFlipbook(address("#sprite") + suffix, "");',
    'sprite.playFlipbook(address("#sprite") as Url, "");',
    'sprite.playFlipbook(address("#sprite")!, "");'
  ]) {
    assert.equal(semanticContextAt(table, source, positionOf(source, "#sprite", 0, 3)).kind, "none", source);
    const unscoped = await index.complete(scriptUri, source, positionOf(source, '""', 0, 1));
    assert.deepEqual(unscoped.map(({ label }) => label), ["enemy-idle", "idle", "run"], source);
  }
});

test("dynamic addressed resources fail open to the route namespace and recognized non-resource arguments stay empty", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".deherm", "generated", "resource-symbols.json"), `${JSON.stringify(symbols())}\n`);
  const index = createResourceSemanticIndex(root);
  const uri = pathToFileURL(path.join(root, "main", "player.script.ts")).href;

  const dynamic = 'sprite.playFlipbook(target, "");';
  const dynamicCompletion = await index.complete(uri, dynamic, { line: 0, character: dynamic.indexOf('""') + 1 });
  assert.deepEqual(dynamicCompletion.map(({ label }) => label), ["enemy-idle", "idle", "run"]);
  assert.ok(dynamicCompletion.every(({ detail }) => detail === "atlas:animation"));
  assert.equal(dynamicCompletion.some(({ label }) => label === "status" || label === "#sprite"), false);
  const unresolvedLiteral = 'sprite.playFlipbook("#missing", "");';
  assert.deepEqual(await index.complete(uri, unresolvedLiteral, {
    line: 0,
    character: unresolvedLiteral.lastIndexOf('""') + 1
  }), []);

  const receiver = 'msg.post("#", "unclassified-message");';
  const receiverCompletion = await index.complete(uri, receiver, { line: 0, character: receiver.indexOf("#") + 1 });
  assert.ok(receiverCompletion.some(({ label }) => label === "#sprite"));
  assert.ok(receiverCompletion.some(({ label }) => label === "/player#sprite"));
  assert.equal(receiverCompletion.some(({ label }) => label === "idle" || label === "status"), false);
  const resolvedReceiver = receiver.replace('"#"', '"#sprite"');
  const receiverPosition = { line: 0, character: resolvedReceiver.indexOf("#sprite") + 3 };
  const receiverHover = await index.hover(uri, resolvedReceiver, receiverPosition);
  assert.match(receiverHover.contents.value, /component · sprite/u);
  const receiverDefinition = await index.definition(uri, resolvedReceiver, receiverPosition);
  assert.equal(receiverDefinition[0].uri, pathToFileURL(path.join(root, "main", "player.go")).href);

  const messagePosition = { line: 0, character: receiver.indexOf("unclassified-message") + 4 };
  assert.deepEqual(await index.complete(uri, receiver, messagePosition), []);
  assert.equal(await index.hover(uri, receiver, messagePosition), null);
  assert.equal(await index.definition(uri, receiver, messagePosition), null);
});

test("optional project-message evidence serves only msg.post message ids", async () => {
  const root = await fixture();
  const table = symbols({
    projectMessages: {
      schemaVersion: 1,
      evidenceBoundary: "static-project-typescript-evidence",
      routes: { "MsgApi.post": { parameter: 1, role: "message-id", names: "projectMessages.names" } },
      names: [{
        name: "add_score",
        senderEvidence: [{ kind: "msg-post-literal", source: "main/player.script.ts", line: 12, column: 25 }],
        receiverEvidence: [{
          kind: "on-message-hash-comparison",
          source: "main/hud.gui.ts",
          line: 15,
          column: 31,
          constant: "ADD_SCORE"
        }]
      }]
    }
  });
  await writeFile(path.join(root, ".deherm", "generated", "resource-symbols.json"), `${JSON.stringify(table)}\n`);
  const index = createResourceSemanticIndex(root);
  const uri = pathToFileURL(path.join(root, "main", "player.script.ts")).href;
  const text = 'msg.post("#sprite", "add_score");';
  const position = { line: 0, character: text.indexOf("add_score") + 3 };
  const completion = await index.complete(uri, text, position);
  assert.deepEqual([...new Set(completion.map(({ label }) => label))], ["add_score"]);
  assert.ok(completion.every(({ detail }) => detail.startsWith("message-id")));
  const hover = await index.hover(uri, text, position);
  assert.match(hover.contents.value, /static TypeScript evidence/u);
  const definition = await index.definition(uri, text, position);
  assert.deepEqual(definition.map(({ uri: definitionUri, range }) => [definitionUri, range.start]), [
    [pathToFileURL(path.join(root, "main", "hud.gui.ts")).href, { line: 14, character: 30 }],
    [pathToFileURL(path.join(root, "main", "player.script.ts")).href, { line: 11, character: 24 }]
  ]);
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
