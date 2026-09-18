import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildProjectResourceSymbols, writeProjectResourceSymbols } from "../packages/cli/src/resource-symbols.mjs";
import { componentStringLiterals } from "../packages/compiler/src/resource-symbol-table.mjs";
import { parameterValueShape } from "../packages/compiler/src/resource-namespace-classification.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/resource-names");

const schema = JSON.parse(await readFile(
  path.join(root, "packages/bindings/generated/defold-resource-declaration-schema.json"), "utf8"));
const classification = JSON.parse(await readFile(
  path.join(root, "packages/bindings/generated/defold-script-resource-namespaces.json"), "utf8"));

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
});

test("component string literals include the declared id behind an address sigil", () => {
  const literals = componentStringLiterals('msg.post("/level#spawner", "reset");');
  assert.ok(literals.has("/level#spawner"));
  assert.ok(literals.has("level"));
  assert.ok(literals.has("spawner"));
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
  await writeProjectResourceSymbols(fixture, path.join(fixture, ".deherm"));
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
