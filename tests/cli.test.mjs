import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  assert.match(index, /export \{ camera \} from "\.\/modules\/camera\.js"/);
  const manifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  assert.match(manifest.defoldRevision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.coverage.script.functions, 926);
  assert.equal(manifest.coverage.script.typeSurfaceUnresolved, 0);
  assert.equal(manifest.coverage.dmsdk.declarations, 2140);
  assert.equal(manifest.coverage.dmsdk.typeSurfaceUnresolved, 0);
  assert.match(await readFile(path.join(output.root, "sdk", "generated", "script", "types.ts"), "utf8"), /export interface MsgApi/);
  assert.match(await readFile(path.join(output.root, "sdk", "generated", "dmsdk", "types.ts"), "utf8"), /export interface DmSdkCalls/);
  const lock = JSON.parse(await readFile(path.join(project, "defold-hermes.lock"), "utf8"));
  assert.equal(lock.defoldRevision, manifest.defoldRevision);
  assert.deepEqual(lock.inputs, manifest.inputs);

  const config = JSON.parse(await readFile(path.join(project, "tsconfig.defold-hermes.json"), "utf8"));
  assert.equal(config.compilerOptions.plugins[0].transform, "@ts-defold/hermes/ttsc");
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
