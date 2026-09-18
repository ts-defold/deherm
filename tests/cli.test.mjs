import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import { buildProjectBindingIr, generateExtensionTypes, writeGeneratedProject } from "../packages/cli/src/generate.mjs";
import { inspectDefoldProject, parseGameProject } from "../packages/cli/src/project.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "defold-hermes-cli-"));
  await mkdir(path.join(root, "camera", "src"), { recursive: true });
  await mkdir(path.join(root, "camera", "include"), { recursive: true });
  await mkdir(path.join(root, ".internal", "lib"), { recursive: true });
  await writeFile(path.join(root, "game.project"), `[project]\ntitle = Fixture\ndependencies#0 = https://token:secret@example.com/math.zip?signature=private#fragment\n`);
  await writeFile(path.join(root, "camera", "ext.manifest"), `name: Camera\nplatforms:\n  arm64-osx: {}\n`);
  await writeFile(path.join(root, "camera", "include", "camera.h"), "bool CameraStart(void);\n");
  await writeFile(path.join(root, "camera", "src", "camera.cpp"), "// fixture\n");
  await writeFile(path.join(root, "camera", "camera.script_api"), `
- name: camera
  type: table
  desc: Camera access.
  members:
    - name: start
      type: function
      parameters:
        - name: facing
          type: string
      return:
        type: boolean
    - name: focus_target
      type: function
      parameters:
        - name: target
          type: string|hash|url
`);
  const archive = zipSync({
    "math/ext.manifest": strToU8("name: XMath\n"),
    "math/include/xmath.h": strToU8("double XMathDot(double left, double right);\n"),
    "math/src/xmath.cpp": strToU8("// fixture\n"),
    "math/xmath.script_api": strToU8(`
- name: xmath
  type: table
  members:
    - name: dot
      type: function
      parameters:
        - name: left
          type: number
        - name: right
          type: number
      return:
        type: number
`)
  });
  await writeFile(path.join(root, ".internal", "lib", "math.zip"), archive);
  return root;
}

test("game.project parser preserves indexed dependency keys", () => {
  const parsed = parseGameProject("[project]\ndependencies#0 = a\ndependencies#1 = b\n");
  assert.equal(parsed.project["dependencies#0"], "a");
  assert.equal(parsed.project["dependencies#1"], "b");
});

test("project inspection finds local and resolved dependency extensions", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  assert.deepEqual(inventory.summary, {
    localExtensions: 1,
    dependencyExtensions: 1,
    scriptApiFiles: 2,
    scriptModules: 2,
    publicHeaders: 2,
    extensionsRequiringNativeSchema: 2,
    extensionsWithoutApiMetadata: 0
  });
  assert.deepEqual(inventory.extensions.map(({ kind, name }) => [kind, name]), [
    ["local", "Camera"],
    ["dependency", "XMath"]
  ]);
  assert.deepEqual(inventory.dependencyUrls, ["https://example.com/math.zip"]);
  assert.deepEqual(inventory.extensions[0].publicHeaders, ["camera/include/camera.h"]);
  assert.deepEqual(inventory.extensions[0].sourceFiles, ["camera/src/camera.cpp"]);
  assert.deepEqual(inventory.extensions[1].publicHeaders, ["math.zip:math/include/xmath.h"]);
  assert.deepEqual(inventory.extensions.map(({ bindingStatus: status }) => status), [
    "script-api+native-schema-required",
    "script-api+native-schema-required"
  ]);
  assert.deepEqual(inventory.diagnostics, []);
});

test("project inspection follows symlinked extensions without duplicate traversal", async () => {
  const project = await fixture();
  const external = await mkdtemp(path.join(tmpdir(), "defold-hermes-linked-extension-"));
  await writeFile(path.join(external, "ext.manifest"), "name: LinkedPhysics\n");
  await writeFile(path.join(external, "physics.script_api"), `
- name: linked_physics
  type: table
  members:
    - name: step
      type: function
      parameters:
        - name: dt
          type: number
`);
  await symlink(external, path.join(project, "linked-physics"), "dir");

  const inventory = await inspectDefoldProject({ project });
  const linked = inventory.extensions.find(({ name }) => name === "LinkedPhysics");
  assert.ok(linked);
  assert.equal(linked.root, "linked-physics");
  assert.equal(linked.scriptApis[0].path, "linked-physics/physics.script_api");
  assert.deepEqual(inventory.diagnostics, []);
});

test("extension script APIs produce deterministic TypeScript declarations", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  const types = generateExtensionTypes(inventory);
  assert.match(types, /from "\.\/sdk\/address\.js"/);
  assert.match(types, /export interface CameraExtension/);
  assert.match(types, /start\(facing: string\): boolean/);
  assert.match(types, /focusTarget\(target: DefoldAddressLiteral \| DefoldRelativeAddress \| DefoldHash \| DefoldUrl\): void/);
  assert.match(types, /export interface XmathExtension/);
  assert.match(types, /dot\(left: number, right: number\): number/);

  const ir = buildProjectBindingIr(inventory);
  assert.equal(ir.modules[0].id, "script:camera");
  assert.equal(ir.modules[0].members[0].id, "script:camera.start");
  assert.equal(ir.modules[0].members[0].lowering.dynamicHermes, "lua-compatibility");
  assert.equal(ir.modules[0].members[1].rawName, "focus_target");
  assert.equal(ir.modules[0].members[1].jsName, "focusTarget");

  const output = await writeGeneratedProject(inventory);
  const saved = await readFile(path.join(output.root, "extensions.d.ts"), "utf8");
  assert.equal(saved, types);
  assert.deepEqual(JSON.parse(await readFile(path.join(output.root, "bindings.ir.json"), "utf8")), ir);
  const camera = await readFile(path.join(output.root, "sdk", "modules", "camera.ts"), "utf8");
  assert.match(camera, /export const camera: CameraExtension/);
  assert.match(camera, /callExtension\("camera", "start", \[facing\]\)/);
  assert.match(camera, /focusTarget\(target: DefoldAddressLiteral \| DefoldRelativeAddress \| DefoldHash \| DefoldUrl\)/);
  const index = await readFile(path.join(output.root, "sdk", "index.ts"), "utf8");
  assert.match(index, /export \* from "\.\/generated\/script\/index\.js"/);
  assert.match(index, /export \* from "\.\/generated\/dmsdk\/index\.js"/);
  assert.match(index, /export \* from "\.\/generated\/dmsdk\/scalar\.js"/);
  assert.match(index, /export \{ camera \} from "\.\/modules\/camera\.js"/);
  const manifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  assert.match(manifest.defoldRevision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.coverage.script.functions, 926);
  assert.equal(manifest.coverage.script.typeSurfaceUnresolved, 0);
  assert.equal(manifest.coverage.script.runtimeImplemented, 93);
  assert.equal(manifest.coverage.script.runtimePending, 833);
  assert.deepEqual(manifest.coverage.script.runtimeLanes, {
    specializedLuaCompatibility: 3,
    generatedScalarDispatch: 90
  });
  assert.equal(manifest.coverage.dmsdk.declarations, 2140);
  assert.equal(manifest.coverage.dmsdk.typeSurfaceUnresolved, 0);
  assert.equal(manifest.coverage.dmsdk.runtimeImplemented, 26);
  assert.equal(manifest.coverage.dmsdk.runtimePending, 1335);
  assert.deepEqual(manifest.coverage.dmsdk.runtimeLanes, { generatedScalarThunks: 26 });
  assert.equal(manifest.platform, "arm64-macos");
  assert.equal(manifest.coverage.dmsdk.diagnosticHeaders, 35);
  assert.match(await readFile(path.join(output.root, "sdk", "generated", "script", "types.ts"), "utf8"), /export interface MsgApi/);
  assert.match(await readFile(path.join(output.root, "sdk", "generated", "dmsdk", "types.ts"), "utf8"), /export interface DmSdkCalls/);
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "script-scalar-dispatch.json"), "utf8")).bindingCount, 90);
  assert.equal(JSON.parse(await readFile(path.join(output.root, "ir", "dmsdk-scalar-thunks.json"), "utf8")).coverage.generated, 26);
  const lock = JSON.parse(await readFile(path.join(project, "deherm.lock"), "utf8"));
  assert.equal(lock.defoldRevision, manifest.defoldRevision);
  assert.equal(lock.platform, manifest.platform);
  assert.deepEqual(lock.inputs, manifest.inputs);

  await writeFile(path.join(output.root, "sdk", "modules", "stale.ts"), "export {};\n");
  await writeFile(path.join(output.root, "sdk", "generated", "stale.ts"), "export {};\n");
  await writeGeneratedProject(inventory);
  await assert.rejects(readFile(path.join(output.root, "sdk", "modules", "stale.ts"), "utf8"));
  await assert.rejects(readFile(path.join(output.root, "sdk", "generated", "stale.ts"), "utf8"));

  const config = JSON.parse(await readFile(path.join(project, "tsconfig.deherm.json"), "utf8"));
  assert.equal(config.compilerOptions.plugins[0].transform, "@ts-defold/deherm/ttsc");
  assert.equal(config.compilerOptions.plugins[0].enabled, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(project, ".vscode", "extensions.json"), "utf8")), {
    recommendations: ["samchon.ttsc"]
  });

  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const checked = spawnSync(process.execPath, [tsc, "--project", path.join(project, "tsconfig.json"), "--noEmit"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test("project binding identities survive normalized-name collisions and reserved parameters", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  inventory.extensions[0].scriptApis[0].declarations.push(
    {
      name: "my_ext",
      type: "table",
      members: [{
        name: "invoke",
        type: "function",
        parameters: [
          { name: "function", type: "function" },
          { name: "default", type: "number" },
          { name: "var", type: "string" }
        ]
      }]
    },
    { name: "myExt", type: "table", members: [{ name: "ping", type: "function" }] }
  );

  const ir = buildProjectBindingIr(inventory);
  const colliding = ir.modules.filter(({ runtimeName }) => runtimeName === "my_ext" || runtimeName === "myExt");
  assert.equal(colliding.length, 2);
  assert.equal(new Set(colliding.map(({ jsName }) => jsName)).size, 2);
  assert.equal(new Set(colliding.map(({ typeName }) => typeName)).size, 2);
  assert.ok(colliding.every(({ jsName }) => /^myExt_[a-f0-9]{8}$/.test(jsName)));
  assert.deepEqual(
    colliding.find(({ runtimeName }) => runtimeName === "my_ext").members[0].parameters.map(({ jsName }) => jsName),
    ["callback", "defaultValue", "value"]
  );

  const output = await writeGeneratedProject(inventory);
  const index = await readFile(path.join(output.root, "sdk", "index.ts"), "utf8");
  for (const module of colliding) {
    assert.match(index, new RegExp(`export \\{ ${module.jsName} \\} from "\\./modules/${module.fileName}\\.js"`));
    await readFile(path.join(output.root, "sdk", "modules", `${module.fileName}.ts`), "utf8");
  }
});

test("project generation rejects output outside the project", async () => {
  const project = await fixture();
  const inventory = await inspectDefoldProject({ project });
  await assert.rejects(
    writeGeneratedProject(inventory, "../outside"),
    /subdirectory of the Defold project/
  );
});
