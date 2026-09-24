import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildProjectResourceSymbols, writeProjectResourceSymbols } from "../packages/cli/src/resource-symbols.mjs";
import {
  buildProjectMessages,
  buildResourceSymbolTable,
  componentStringLiterals,
  readResource,
  projectMessageEvidence
} from "../packages/compiler/src/resource-symbol-table.mjs";
import { parameterValueShape } from "../packages/compiler/src/resource-namespace-classification.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/resource-names");

const schema = JSON.parse(await readFile(
  path.join(root, "packages/bindings/generated/defold-resource-declaration-schema.json"), "utf8"));
const classification = JSON.parse(await readFile(
  path.join(root, "packages/bindings/generated/defold-script-resource-namespaces.json"), "utf8"));
const componentPolicy = JSON.parse(await readFile(
  path.join(root, "packages/bindings/generated/defold-component-proxy-contract.json"), "utf8"));

function namespacesFor(extension) {
  return schema.resources.find((resource) => resource.extension === extension)?.namespaces.map(({ id }) => id) ?? [];
}

function parameterNamespace(route, position) {
  const entry = classification.routes.find(({ rawName }) => rawName === route);
  return entry?.parameters.find((parameter) => parameter.position === position)?.resourceNamespace ?? null;
}

function compileFixture(project) {
  return execFileSync(path.join(root, "node_modules/.bin/ttsc"), ["-p", path.join(fixture, project)], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

test("the declaration schema is derived from pinned Defold sources without blockers", () => {
  assert.equal(schema.blockerCount, 0);
  assert.deepEqual(namespacesFor(".gui").filter((id) => ["gui:node", "gui:font", "gui:layer", "gui:layout"].includes(id)),
    ["gui:font", "gui:layer", "gui:layout", "gui:node"]);
  assert.deepEqual(namespacesFor(".go"), ["go:component"]);
  assert.deepEqual(namespacesFor(".collection"), ["collection:instance"]);
  assert.deepEqual(namespacesFor(".input_binding"), ["input_binding:action"]);
  assert.deepEqual(namespacesFor(".atlas"), ["atlas:animation"]);
  assert.ok(namespacesFor(".material").includes("material:constant"));
  assert.ok(namespacesFor(".material").includes("material:sampler"));

  // `embedded_components` declares into the same space as `components`, and
  // every input trigger declares into one action space.
  const components = schema.resources.find(({ extension }) => extension === ".go")
    .namespaces.find(({ id }) => id === "go:component");
  assert.deepEqual(components.sites.map(({ fieldPath }) => fieldPath), ["components", "embedded_components"]);
  const actions = schema.resources.find(({ extension }) => extension === ".input_binding").namespaces[0];
  assert.equal(actions.sites.length, 5);
  assert.ok(actions.sites.every(({ identityField }) => identityField === "action"));
});

test("name-shaped parameters carry a namespace and everything else stays unresolved", () => {
  assert.equal(parameterValueShape("string|hash"), "name");
  assert.equal(parameterValueShape("string|hash|url"), "address");
  assert.equal(parameterValueShape("number"), "other");

  assert.deepEqual(parameterNamespace("gui.get_node", 0), { scope: "attached-resource", namespaces: ["gui:node"] });
  assert.deepEqual(parameterNamespace("gui.set_layer", 1), { scope: "attached-resource", namespaces: ["gui:layer"] });
  assert.deepEqual(parameterNamespace("sprite.play_flipbook", 1), {
    scope: "addressed-component-resource",
    namespaces: ["atlas:animation", "tileset:animation", "tilesource:animation"],
    addressParameter: 0
  });
  assert.deepEqual(parameterNamespace("msg.post", 0), {
    scope: "component-address",
    namespaces: ["go:component", "collection:instance"]
  });

  // A message id, a script property, and a dynamically created GUI texture are
  // not closed declaration sets, so none of them is checkable.
  assert.equal(parameterNamespace("msg.post", 1).unresolved, "no-documented-declaration-noun");
  assert.equal(parameterNamespace("go.set", 1).unresolved, "no-documented-declaration-noun");
  assert.equal(parameterNamespace("gui.set_texture", 1).unresolved, "runtime-extensible-namespace");
  assert.deepEqual(classification.runtimeExtensibleNamespaces, ["gui:texture"]);
  // A route that introduces a name resolves nothing.
  assert.equal(parameterNamespace("gui.new_texture", 0).unresolved, "declaring-route-introduces-the-name");
  // GUI flipbook animations come from the node's texture, which no argument
  // names, so the literal is left alone.
  assert.equal(parameterNamespace("gui.play_flipbook", 1).unresolved, "no-address-parameter-to-scope-the-name");
});

test("the project symbol table records declarations, scopes, and attachments", async () => {
  const table = await buildProjectResourceSymbols(fixture);
  assert.deepEqual(table.declarations["/main/hud.gui"]["gui:node"].map(({ name }) => name), ["backdrop", "score"]);
  assert.deepEqual(table.declarations["/main/hud.gui"]["gui:node"].map(({ line }) => line), [19, 26]);
  assert.deepEqual(table.declarations["/input/game.input_binding"]["input_binding:action"].map(({ name }) => name),
    ["fire", "left"]);
  assert.deepEqual(table.declarations["/main/units.atlas"]["atlas:animation"].map(({ name }) => name), ["idle", "walk"]);

  assert.deepEqual(table.components["main/hud.gui.ts"], {
    proxy: "/main/hud.gui_script",
    attachedResource: "/main/hud.gui",
    attachedExtension: ".gui",
    gameObject: "/main/hud.go",
    componentId: "hud",
    collection: "/main/main.collection"
  });
  assert.equal(table.components["main/player.script.ts"].gameObject, "/main/player.go");
  assert.equal(table.gameObjects["/main/player.go"].components.sprite.resources[".atlas"].path, "/main/units.atlas");
  assert.equal(table.collections["/main/main.collection"].instances.player.prototype, "/main/player.go");
  assert.deepEqual(table.diagnostics, []);
  assert.deepEqual(table.projectMessages.names.map(({ name }) => name), ["clear_color", "create", "enable"]);
  assert.ok(!table.projectMessages.names.some(({ name }) => name === "backdrop"));
});

test("component bindings retain every same-extension resource for route projections", () => {
  const source = {
    "/main/player.go": 'components { id: "sprite" component: "/main/player.model" }',
    "/main/player.model": [
      'materials { name: "body" material: "/main/body.material" }',
      'materials { name: "turret" material: "/main/turret.material" }'
    ].join("\n"),
    "/main/body.material": 'vertex_constants { name: "body_tint" }',
    "/main/turret.material": 'vertex_constants { name: "turret_tint" }'
  };
  const resources = Object.entries(source).map(([resourcePath, text]) =>
    readResource({ path: resourcePath.slice(1), source: text, schema }));
  const table = buildResourceSymbolTable({
    schema,
    classification: { routes: [], runtimeExtensibleNamespaces: [] },
    componentPolicy,
    resources,
    componentSources: ["main/player.script.ts"]
  });
  assert.deepEqual(table.gameObjects["/main/player.go"].components.sprite.resources[".material"], {
    path: "/main/body.material",
    line: 1,
    paths: ["/main/body.material", "/main/turret.material"]
  });
});

test("component string literals include the declared id behind an address sigil", () => {
  const literals = componentStringLiterals('msg.post("/level#spawner", "reset");');
  assert.ok(literals.has("/level#spawner"));
  assert.ok(literals.has("level"));
  assert.ok(literals.has("spawner"));
});

test("project message evidence separates send literals from receiver contracts", () => {
  const source = `
    import { hashLiteral as h, msg as messages } from "@deherm/project";
    const DAMAGE: DefoldHash = h("#damage");
    const dynamicMessage = readMessage();
    export default defineComponent({
      onMessage(_self: unknown, messageId: DefoldHash): void {
        if (DAMAGE === messageId) receiveDamage();
      },
      update(): void {
        messages.post("#hud", "damage");
        messages.post("#hud", dynamicMessage);
      }
    });
  `;
  assert.deepEqual(projectMessageEvidence(source, "main/player.script.ts"), {
    sender: [{
      name: "damage",
      evidence: { kind: "msg-post-literal", source: "main/player.script.ts", line: 10, column: 31 }
    }],
    receiver: [{
      name: "damage",
      evidence: {
        kind: "on-message-hash-comparison",
        source: "main/player.script.ts",
        line: 3,
        column: 34,
        constant: "DAMAGE"
      }
    }],
    skipped: null
  });
});

test("project message projection is deterministic, route-scoped, and ignores unrelated globals", () => {
  const componentTexts = new Map([
    ["main/z.script.ts", `
      import { msg } from "@deherm/project";
      const unrelatedPattern = /msg.post(".", "not-source-code")/;
      function localLookalike(msg: { post(receiver: string, message: string): void }): void {
        msg.post(".", "shadowed-import");
      }
      msg.post(".", messageName);
      msg.post(".", "zeta");
    `],
    ["main/a.script.ts", `
      const msg = { post(_receiver: string, _name: string): void {} };
      msg.post(".", "not-a-defold-message");
    `]
  ]);
  const first = buildProjectMessages(componentTexts);
  const second = buildProjectMessages(new Map([...componentTexts].reverse()));
  assert.deepEqual(first, second);
  assert.deepEqual(first.routes, {
    "MsgApi.post": { parameter: 1, role: "message-id", names: "projectMessages.names" }
  });
  assert.deepEqual(first.receiver, {
    role: "message-id",
    names: "projectMessages.names",
    evidence: "receiverEvidence",
    prefix: "#"
  });
  assert.deepEqual(first.names.map(({ name }) => name), ["zeta"]);
  assert.deepEqual(first.names[0].senderEvidence.map(({ source }) => source), ["main/z.script.ts"]);
  assert.deepEqual(first.names[0].receiverEvidence, []);
});

test("expression-bodied arrow parameters shadow imported message APIs", () => {
  const result = projectMessageEvidence(`
    import { msg } from "@deherm/project";
    const arrow = (msg: LocalMessages): void => msg.post(".", "arrow-shadow");
  `, "main/arrow.ts");
  assert.deepEqual(result.sender, []);
});

test("destructured bindings shadow imported message APIs", () => {
  const result = projectMessageEvidence(`
    import { msg } from "@deherm/project";
    function localLookalike(local: { msg: LocalMessages }): void {
      const { msg } = local;
      msg.post(".", "destructured-shadow");
    }
  `, "main/destructured.ts");
  assert.deepEqual(result.sender, []);
});

test("function-scoped var shadows imported message APIs outside its declaring block", () => {
  const result = projectMessageEvidence(`
    import { msg } from "@deherm/project";
    function localLookalike(enabled: boolean): void {
      if (enabled) {
        var msg = localMessages();
      }
      msg.post(".", "var-shadow");
    }
  `, "main/var-shadow.ts");
  assert.deepEqual(result.sender, []);
});

test("regular expressions after yield never become message evidence", () => {
  const result = projectMessageEvidence(`
    import { msg } from "@deherm/project";
    function* regexBody(): Generator<RegExp> {
      yield /msg.post(".", "regex-after-yield")/;
    }
  `, "main/regex.ts");
  assert.deepEqual(result.sender, []);
});

test("regular expressions after control conditions and logical operators never become message evidence", () => {
  const result = projectMessageEvidence(`
    import { msg } from "@deherm/project";
    if (enabled) /msg.post(".", "if-regex")/.test(source);
    const matched = enabled && /msg.post(".", "logical-regex")/.test(source);
    msg.post(".", "real-send");
  `, "main/regex-contexts.ts");
  assert.deepEqual(result.sender.map(({ name }) => name), ["real-send"]);
  assert.equal(result.skipped, null);
});

test("regular expressions after for-await control conditions never become message evidence", () => {
  const result = projectMessageEvidence(`
    import { msg } from "@deherm/project";
    async function consume(stream: AsyncIterable<unknown>): Promise<void> {
      for await (const value of stream) /msg.post(".", "for-await-regex")/.test(String(value));
    }
  `, "main/for-await-regex.ts");
  assert.deepEqual(result.sender, []);
  assert.equal(result.skipped, null);
});

test("semicolonless canonical imports still produce message evidence", () => {
  const result = projectMessageEvidence(`
    import { msg } from "@deherm/project"
    msg.post(".", "semicolonless-ready")
  `, "main/semicolonless.ts");
  assert.deepEqual(result.sender.map(({ name }) => name), ["semicolonless-ready"]);
});

test("receiver evidence rejects shadowed hashes and nested message-id parameters", () => {
  const result = projectMessageEvidence(`
    import { hashLiteral } from "@deherm/project";
    const REAL = hashLiteral("#real-message");
    const SHADOWED = hashLiteral("#shadowed-receiver");
    export default defineComponent({
      onMessage(_self: unknown, messageId: DefoldHash): void {
        if (messageId === REAL) receiveReal();
        {
          const SHADOWED = readHash();
          if (messageId === SHADOWED) receiveShadowed();
        }
        const nested = (messageId: DefoldHash) => messageId === SHADOWED;
      }
    });
  `, "main/receiver.script.ts");
  assert.deepEqual(result.receiver.map(({ name }) => name), ["real-message"]);
  assert.equal(result.receiver[0].evidence.constant, "REAL");
});

test("receiver evidence ignores arbitrary objects and classes named onMessage", () => {
  const result = projectMessageEvidence(`
    import { defineComponent, hashLiteral } from "@deherm/project";
    const REAL = hashLiteral("#real-lifecycle");
    const OBJECT_ONLY = hashLiteral("#object-only");
    const CLASS_ONLY = hashLiteral("#class-only");
    const helper = {
      onMessage(_self: unknown, messageId: DefoldHash): void {
        if (messageId === OBJECT_ONLY) consumeObject();
      }
    };
    class Helper {
      onMessage(_self: unknown, messageId: DefoldHash): void {
        if (messageId === CLASS_ONLY) consumeClass();
      }
    }
    export default defineComponent({
      onMessage(_self: unknown, messageId: DefoldHash): void {
        if (messageId === REAL) consumeLifecycle();
      }
    });
  `, "main/lifecycle.script.ts");
  assert.deepEqual(result.receiver.map(({ name }) => name), ["real-lifecycle"]);
});

test("receiver evidence recognizes exported component class lifecycles", () => {
  const result = projectMessageEvidence(`
    import { component, hashLiteral, ScriptComponent } from "@deherm/project";
    const READY = hashLiteral("#class-ready");
    class Player extends ScriptComponent {
      onMessage(messageId: DefoldHash, _message: unknown, _sender: DefoldUrl): void {
        if (messageId === READY) consumeReady();
      }
    }
    export default component(Player);
  `, "main/class-player.script.ts");
  assert.deepEqual(result.receiver.map(({ name }) => name), ["class-ready"]);
});

test("the War Battles project supplies canonical sender and receiver message evidence", async () => {
  const table = await buildProjectResourceSymbols(path.join(root, "examples/war-battles-online/defold"));
  const messages = new Map(table.projectMessages.names.map((message) => [message.name, message]));
  assert.deepEqual(messages.get("add_score")?.senderEvidence.map(({ source }) => source), ["main/rocket.script.ts"]);
  assert.deepEqual(messages.get("add_score")?.receiverEvidence.map(({ source, constant }) => ({ source, constant })), [
    { source: "main/ui.gui.ts", constant: "ADD_SCORE" }
  ]);
  assert.deepEqual(messages.get("player_at")?.receiverEvidence.map(({ source, constant }) => ({ source, constant })), [
    { source: "main/camera.script.ts", constant: "PLAYER_AT" }
  ]);
  assert.equal(table.projectMessages.skippedSources.length, 0);
});

test("project message evidence includes ordinary imported TypeScript modules", async () => {
  const helper = path.join(fixture, "main", "message-helper.ts");
  await writeFile(helper, `
    import { msg } from "@deherm/project";
    export function announce(): void { msg.post("#hud", "helper-ready"); }
  `);
  try {
    const table = await buildProjectResourceSymbols(fixture, { pinned: { schema, classification, componentPolicy } });
    const message = table.projectMessages.names.find(({ name }) => name === "helper-ready");
    assert.equal(message?.senderEvidence[0]?.source, "main/message-helper.ts");
    assert.equal(table.componentCount, 5);
    assert.equal(table.components["main/message-helper.ts"], undefined);
  } finally {
    await rm(helper, { force: true });
  }
});

test("declared names no component source mentions are reported for review", async () => {
  const table = await buildProjectResourceSymbols(fixture);
  const reported = table.unreferenced.declarations.map(({ namespace, name }) => `${namespace} ${name}`);
  assert.ok(reported.includes("input_binding:action fire"));
  assert.ok(reported.includes("gui:texture sheet"));
  assert.ok(!reported.includes("gui:node backdrop"));
  assert.ok(!reported.includes("atlas:animation walk"));
});

test("the ttsc host resolves literal names and stays silent for dynamic ones", async (t) => {
  await writeProjectResourceSymbols(fixture, path.join(fixture, ".deherm"), { pinned: { schema, classification, componentPolicy } });
  t.after(() => rm(path.join(fixture, ".deherm"), { recursive: true, force: true }));

  compileFixture("tsconfig.json");
  compileFixture("tsconfig.dynamic.json");

  assert.throws(() => compileFixture("tsconfig.typo.json"), (error) => {
    const output = String(error?.stderr) + String(error?.stdout);
    assert.match(output, /main\/typo\.gui\.ts\(6,32\): Defold resource name "backrop" is not declared in gui:node for \/main\/typo\.gui\. Declared names: "backdrop", "score"/);
    assert.match(output, /"overlai" is not declared in gui:layer/);
    assert.match(output, /"hud_fnt" is not declared in gui:font/);
    assert.match(output, /"Portrait" is not declared in gui:layout/);
    return true;
  });

  assert.throws(() => compileFixture("tsconfig.typo-address.json"), (error) => {
    const output = String(error?.stderr) + String(error?.stdout);
    assert.match(output, /"wlak" is not declared in atlas:animation for \/main\/units\.atlas, bound to component "sprite"/);
    assert.match(output, /component "shootr" is not declared in go:component for \/main\/player\.go/);
    assert.match(output, /game object instance "playr" is not declared in collection:instance for \/main\/main\.collection/);
    return true;
  });
});

test("a project without a symbol table compiles exactly as before", async (t) => {
  await rm(path.join(fixture, ".deherm"), { recursive: true, force: true });
  t.after(() => rm(path.join(fixture, ".deherm"), { recursive: true, force: true }));
  compileFixture("tsconfig.typo.json");
});
