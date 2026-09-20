// Ingestion evidence for real, published third-party Defold extensions.
//
// Every assertion in this file was written against a defect that synthetic
// fixtures could not expose. The four projection defects recorded in
// .agents/docs/research/defold-extension-candidates.md each have a dedicated
// regression test below, and each of them fails closed rather than degrading to
// `any` or `unknown`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import { buildProjectBindingIr as compileProjectBindingIr, generateExtensionTypes as renderExtensionTypes, writeGeneratedProject } from "../packages/cli/src/generate.mjs";
import { inspectDefoldProject } from "../packages/cli/src/project.mjs";
import { fixtureRoot, materializeIngestionProject, readExtensionLock } from "./fixtures/defold-extension-ingestion/materialize.mjs";

const defoldValueLayouts = JSON.parse(
  await readFile(path.resolve("packages/bindings/generated/defold-value-layouts.json"), "utf8"));
const buildProjectBindingIr = (inventory) => compileProjectBindingIr(inventory, defoldValueLayouts);
const generateExtensionTypes = (inventory) => renderExtensionTypes(inventory, defoldValueLayouts);

/** Builds a binding IR from declarations without touching the filesystem. */
function projectDeclarations(...declarations) {
  return buildProjectBindingIr({
    extensions: [{
      name: "Fixture",
      bindingStatus: "script-api",
      scriptApis: [{ path: "fixture.script_api", declarations }]
    }]
  });
}

function projectModule(members, moduleName = "fixture") {
  return projectDeclarations({ name: moduleName, type: "table", members }).modules[0];
}

function memberNamed(module, rawName) {
  const member = module.members.find((candidate) => candidate.rawName === rawName);
  assert.ok(member, `no member ${rawName}`);
  return member;
}

async function ingestFixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-extension-ingestion-"));
  const materialized = await materializeIngestionProject(directory, options);
  const inventory = await inspectDefoldProject({ project: materialized.root });
  return { ...materialized, inventory };
}

test("vendored third-party extension inputs match their pinned digests and recorded provenance", async () => {
  const lock = await readExtensionLock();
  assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(lock.extensions.map(({ id }) => id).sort(), ["defold-astar", "defold-xmath"]);
  for (const extension of lock.extensions) {
    assert.match(extension.revision, /^[a-f0-9]{40}$/);
    assert.ok(extension.dependencyUrl.includes(extension.revision), "the dependency URL must pin the exact revision");
    for (const file of extension.vendoredFiles) {
      const bytes = await readFile(path.join(fixtureRoot, file.path));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
    }
    const licence = await readFile(path.join(fixtureRoot, extension.licence.recordedAt), "utf8");
    assert.ok(licence.includes(extension.revision), `${extension.licence.recordedAt} must name the pinned revision`);
  }

  // defold-astar's sources disagree about its licence. The house rule is to
  // record what each source says rather than collapse them, so the three facts
  // must each survive in the provenance record.
  const astar = lock.extensions.find(({ id }) => id === "defold-astar");
  assert.equal(astar.licence.repositoryFile, null);
  assert.equal(astar.licence.assetPortalClaim, "MIT License");
  assert.equal(astar.licence.vendoredDependency.claim, "zlib");
  assert.match(astar.licence.agreement, /^unresolved/);
  const provenance = await readFile(path.join(fixtureRoot, astar.licence.recordedAt), "utf8");
  assert.match(provenance, /no\s+LICENSE/);
  assert.match(provenance, /404/);
  assert.match(provenance, /"license": "MIT License"/);
  assert.match(provenance, /zlib/);
  assert.match(provenance, /add a LICENSE file/);
  assert.ok(astar.notVendored.length > 0, "the unvendored upstream files must be listed, not implied");
  assert.ok(astar.bindingStatusDeviation, "a fixture that differs from upstream classification must say so");
  await readFile(path.join(fixtureRoot, astar.licence.vendoredDependency.recordedAt), "utf8");
});

test("published xMath and defold-astar extensions ingest end to end and the declarations type-check", async () => {
  const { root, inventory } = await ingestFixture();

  assert.equal(inventory.summary.dependencyExtensions, 2);
  assert.equal(inventory.summary.scriptApiFiles, 2);
  assert.deepEqual(
    inventory.extensions.map(({ name, kind, bindingStatus }) => ({ name, kind, bindingStatus })),
    [
      { name: "astar", kind: "dependency", bindingStatus: "script-api" },
      { name: "xMath", kind: "dependency", bindingStatus: "script-api" }
    ]
  );
  assert.deepEqual(inventory.diagnostics, []);

  const types = generateExtensionTypes(inventory);
  // xMath: YAML list unions over named Defold value types, which previously
  // rendered as `unknown` on every one of its in-place vector operations.
  assert.match(types, /add\(vInPlace: Vector3 \| Vector4, v1: Vector3 \| Vector4, v2: Vector3 \| Vector4\): void;/);
  assert.match(types, /cross\(vInPlace: Vector3, v1: Vector3, v2: Vector3\): void;/);
  assert.match(types, /rotate\(vInPlace: Vector3, q: Quaternion, v1: Vector3\): void;/);
  assert.match(types, /matrixInv\(mInPlace: Matrix4, m1: Matrix4\): void;/);
  assert.match(types, /eulerToQuat\(qInPlace: Quaternion, x: number \| Vector3, y: number, z: number\): void;/);
  assert.doesNotMatch(types, /: unknown/, "no real xMath or astar shape may degrade to unknown");
  assert.doesNotMatch(types, /: any\b/);

  // defold-astar: scalar and enum surface, trailing `[optional]` markers, and
  // multi-value Lua returns.
  assert.match(types, /newMapId\(\): number;/);
  assert.match(types, /solve\(startX: number, startY: number, endX: number, endY: number, mapId\?: number\): \[number, number, number, Readonly<Record<string, unknown>>\];/);
  assert.match(types, /resetCache\(mapId\?: number\): void;/);
  assert.match(types, /readonly DIRECTION_EIGHT: number;/);
  assert.match(types, /readonly START_END_SAME: number;/);

  const ir = buildProjectBindingIr(inventory);
  assert.equal(ir.schemaVersion, 2);
  assert.equal(ir.coverage.modules, 2);
  assert.equal(ir.coverage.blocked, ir.blockers.length);
  assert.equal(ir.coverage.projected + ir.coverage.blocked, ir.coverage.members);
  // The only shape in either published extension that cannot be projected.
  assert.deepEqual(ir.blockers.map(({ module, member, code }) => ({ module, member, code })), [
    { module: "astar", member: "use_zero", code: "call-signature-without-function-type" }
  ]);

  const authored = path.join(root, "main");
  await mkdir(authored, { recursive: true });
  await writeFile(path.join(authored, "ingestion.script.ts"), `import { astar, vmath, xmath } from "@deherm/project";

export function ingest(): number {
  const position = vmath.vector3(0, 0, 0);
  xmath.add(position, position, vmath.vector3(1, 0, 0));
  xmath.normalize(position, position);
  xmath.matrixInv(vmath.matrix4(), vmath.matrix4());
  const [result, size, cost] = astar.solve(1, 1, 4, 4);
  // @ts-expect-error astar.use_zero declares a call signature without
  // 'type: function', so the projection fails closed and the member is
  // uninhabited rather than silently typed 'unknown'.
  astar.useZero(true);
  return result + size + cost + astar.DIRECTION_EIGHT;
}
`);

  const output = await writeGeneratedProject(inventory);
  assert.equal(output.moduleCount, 2);
  assert.equal(generateExtensionTypes(inventory), await readFile(path.join(output.root, "extensions.d.ts"), "utf8"));
  assert.deepEqual(JSON.parse(await readFile(path.join(output.root, "bindings.ir.json"), "utf8")), ir);

  const astarModule = await readFile(path.join(output.root, "sdk", "modules", "astar.ts"), "utf8");
  assert.match(astarModule, /callExtension\("astar", "solve", \[startX, startY, endX, endY, mapId\]\)/);
  // Fail closed at runtime too: the blocked member cannot reach the bridge.
  assert.match(astarModule, /get useZero\(\): never \{/);
  assert.match(astarModule, /throw new Error\("deherm: astar\.use_zero is not projectable/);

  const tsc = path.resolve("node_modules/typescript/bin/tsc");
  const checked = spawnSync(process.execPath, [tsc, "--build", path.join(root, "tsconfig.deherm.json"), "--pretty", "false", "--force"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test("defect 1: a YAML sequence type is an alternation, not a silent any", async () => {
  const module = projectModule([{
    name: "add",
    type: "function",
    parameters: [{ name: "target", type: ["vector3", "vector4"] }, { name: "scale", type: ["number", "vector3"] }]
  }]);
  const member = memberNamed(module, "add");
  assert.equal(member.disposition, "projected");
  assert.deepEqual(member.parameters[0].type.types.map(({ name }) => name), ["vector3", "vector4"]);
  assert.equal(member.parameters[0].type.raw, "vector3|vector4");
  assert.deepEqual(member.parameters[1].type.types.map(({ kind }) => kind), ["number", "defold-value"]);
  // The string spelling of the same union must normalize identically.
  const stringForm = projectModule([{
    name: "add",
    type: "function",
    parameters: [{ name: "target", type: "vector3|vector4" }, { name: "scale", type: "number|vector3" }]
  }]);
  assert.deepEqual(memberNamed(stringForm, "add").parameters, member.parameters);
  // An empty sequence has no alternation to project and must fail closed.
  const empty = projectModule([{ name: "empty", type: "function", parameters: [{ name: "value", type: [] }] }]);
  assert.equal(memberNamed(empty, "empty").disposition, "blocked");
  assert.equal(memberNamed(empty, "empty").blockers[0].code, "empty-type-union");
});

test("defect 2: named Defold value types resolve to the generated transparent layouts", async () => {
  const layouts = JSON.parse(await readFile(path.resolve("packages/bindings/generated/defold-value-layouts.json"), "utf8"));
  const expected = { vector3: "Vector3", vector4: "Vector4", quaternion: "Quaternion", matrix4: "Matrix4", hash: "DefoldHash", url: "DefoldUrl" };
  assert.deepEqual(Object.keys(layouts.transparent).sort(), Object.keys(expected).sort(),
    "every transparent value type must have a declared TypeScript projection");

  const module = projectModule(Object.keys(expected).map((name) => ({
    name: `take_${name}`,
    type: "function",
    parameters: [{ name: "value", type: name }]
  })));
  for (const [name, ts] of Object.entries(expected)) {
    const member = memberNamed(module, `take_${name}`);
    assert.equal(member.disposition, "projected", name);
    assert.equal(member.parameters[0].type.kind, "defold-value", name);
    assert.equal(member.parameters[0].type.ts, ts, name);
  }

  const types = generateExtensionTypes({
    extensions: [{
      name: "Fixture",
      bindingStatus: "script-api",
      scriptApis: [{
        path: "fixture.script_api",
        declarations: [{ name: "fixture", type: "table", members: [{ name: "spin", type: "function", parameters: [{ name: "q", type: "quaternion" }] }] }]
      }]
    }]
  });
  assert.match(types, /from "\.\/sdk\/generated\/script\/types\.js"/);
  assert.match(types, /spin\(q: Quaternion\): void;/);

  // A value type the engine keeps opaque has no pinned layout to project.
  const opaqueName = Object.keys(layouts.opaque).find((name) => /^[a-z_]+$/.test(name));
  const opaque = projectModule([{ name: "take", type: "function", parameters: [{ name: "value", type: opaqueName }] }]);
  assert.equal(memberNamed(opaque, "take").disposition, "blocked");
  assert.equal(memberNamed(opaque, "take").blockers[0].code, `opaque-defold-value-type:${opaqueName}`);
});

test("defect 3: nested table fields spelled members: are projected like parameters:", async () => {
  const shape = (key) => ({
    name: "connect",
    type: "function",
    parameters: [{
      name: "params",
      type: "table",
      [key]: [
        { name: "timeout", type: "number" },
        { name: "protocol", type: "string", optional: true },
        { name: "origin", type: "vector3" }
      ]
    }]
  });
  const viaMembers = memberNamed(projectModule([shape("members")]), "connect");
  const viaParameters = memberNamed(projectModule([shape("parameters")]), "connect");
  assert.equal(viaMembers.disposition, "projected");
  assert.deepEqual(viaMembers.parameters[0].type, viaParameters.parameters[0].type);
  assert.deepEqual(viaMembers.parameters[0].type.fields.map(({ name, optional }) => ({ name, optional })), [
    { name: "timeout", optional: false },
    { name: "protocol", optional: true },
    { name: "origin", optional: false }
  ]);
  assert.equal(viaMembers.parameters[0].type.fields[2].type.ts, "Vector3");

  // Defold's own editor resolves `parameters` before `members`; so does this.
  const both = memberNamed(projectModule([{
    name: "connect",
    type: "function",
    parameters: [{
      name: "params",
      type: "table",
      parameters: [{ name: "fromParameters", type: "number" }],
      members: [{ name: "fromMembers", type: "number" }]
    }]
  }]), "connect");
  assert.deepEqual(both.parameters[0].type.fields.map(({ name }) => name), ["fromParameters"]);

  // A nested field that cannot be projected blocks the member that carries it.
  const nested = memberNamed(projectModule([{
    name: "connect",
    type: "function",
    parameters: [{ name: "params", type: "table", members: [{ name: "handle", type: "SomeExtensionHandle" }] }]
  }]), "connect");
  assert.equal(nested.disposition, "blocked");
  assert.deepEqual(nested.blockers.map(({ site, code }) => ({ site, code })), [
    { site: "parameter[0]:params.handle", code: "unresolved-named-type:SomeExtensionHandle" }
  ]);
});

test("defect 4: an unprojectable .script_api shape fails closed with a machine-readable blocker", async () => {
  const ir = projectDeclarations({
    name: "fixture",
    type: "table",
    members: [
      { name: "handle_it", type: "function", parameters: [{ name: "handle", type: "ExtensionHandle" }] },
      { name: "no_type", type: "function", parameters: [{ name: "value" }] },
      { name: "bad_return", type: "function", return: { type: "ExtensionResult" } },
      { name: "call_shaped_value", parameters: [{ name: "toggle", type: "boolean" }] },
      { name: "fine", type: "function", parameters: [{ name: "count", type: "number" }] }
    ]
  });

  assert.equal(ir.coverage.members, 5);
  assert.equal(ir.coverage.projected, 1);
  assert.equal(ir.coverage.blocked, 4);
  assert.deepEqual(ir.coverage.blockerCodes, {
    "call-signature-without-function-type": 1,
    "missing-type": 1,
    "unresolved-named-type:ExtensionHandle": 1,
    "unresolved-named-type:ExtensionResult": 1
  });
  assert.deepEqual(ir.blockers.map(({ id, site, code }) => ({ id, site, code })), [
    { id: "script:fixture.bad_return#return", site: "return", code: "unresolved-named-type:ExtensionResult" },
    { id: "script:fixture.call_shaped_value#value", site: "value", code: "call-signature-without-function-type" },
    { id: "script:fixture.handle_it#parameter[0]:handle", site: "parameter[0]:handle", code: "unresolved-named-type:ExtensionHandle" },
    { id: "script:fixture.no_type#parameter[0]:value", site: "parameter[0]:value", code: "missing-type" }
  ]);
  assert.equal(ir.blockers[0].declared, "ExtensionResult");

  const types = generateExtensionTypes({
    extensions: [{ name: "Fixture", bindingStatus: "script-api", scriptApis: [{ path: "fixture.script_api", declarations: [{
      name: "fixture",
      type: "table",
      members: [
        { name: "handle_it", type: "function", parameters: [{ name: "handle", type: "ExtensionHandle" }] },
        { name: "fine", type: "function", parameters: [{ name: "count", type: "number" }] }
      ]
    }] }] }]
  });
  // The blocked member is uninhabited and carries its reason; nothing about it
  // is spelled `any` or `unknown`.
  assert.match(types, /\/\*\* blocked: parameter\[0\]:handle=unresolved-named-type:ExtensionHandle \*\/\n  readonly handleIt: never;/);
  assert.match(types, /fine\(count: number\): void;/);
  assert.doesNotMatch(types, /handleIt\(/);
  assert.doesNotMatch(types, /: unknown/);
});

test("published extension name spellings project without silent mangling", async () => {
  // defold-astar marks optionality by appending a bracketed marker to the
  // parameter name; Defold's editor documents the fully bracketed form.
  const module = projectModule([
    { name: "reset", type: "function", parameters: [{ name: "map_id[optional]", type: "number" }] },
    { name: "seek", type: "function", parameters: [{ name: "[target]", type: "number" }] },
    { name: "probe", type: "function", parameters: [{ name: "value[range]", type: "number" }] },
    { name: "DIRECTION_EIGHT", type: "number" },
    { name: "count", type: "function", returns: [{ name: "total", type: "number" }] }
  ]);

  const reset = memberNamed(module, "reset");
  assert.equal(reset.disposition, "projected");
  assert.deepEqual(reset.parameters[0], {
    rawName: "map_id",
    jsName: "mapId",
    optional: true,
    type: { kind: "number", raw: "number" },
    nameSpelling: "trailing-optional-marker"
  });

  const seek = memberNamed(module, "seek");
  assert.equal(seek.parameters[0].rawName, "target");
  assert.equal(seek.parameters[0].optional, true);
  assert.equal(seek.parameters[0].nameSpelling, "bracketed-name");

  // An unrecognized marker is not silently folded into an identifier.
  const probe = memberNamed(module, "probe");
  assert.equal(probe.disposition, "blocked");
  assert.equal(probe.blockers[0].code, "unrecognized-name-marker:range");

  // SCREAMING_SNAKE constants keep their exact spelling, as the core SDK does.
  assert.equal(memberNamed(module, "DIRECTION_EIGHT").jsName, "DIRECTION_EIGHT");

  // A single-entry `returns:` sequence is one Lua return value, not a 1-tuple.
  assert.deepEqual(memberNamed(module, "count").returns, { kind: "number", raw: "number" });
});

test("discovery reports resolved dependency archives that declare no ext.manifest", async () => {
  const { inventory } = await ingestFixture({ includeLuaOnlyLibrary: true });
  assert.equal(inventory.summary.dependencyExtensions, 2);
  assert.equal(inventory.summary.dependencyArchivesWithoutManifest, 1);
  assert.equal(inventory.dependencyArchivesWithoutManifest.length, 1);
  assert.deepEqual(
    inventory.dependencyArchivesWithoutManifest.map(({ files, luaModules }) => ({ files, luaModules })),
    [{ files: 3, luaModules: 2 }]
  );
  const [reported] = inventory.diagnostics;
  assert.equal(reported.severity, "warning");
  assert.match(reported.message, /declares no ext\.manifest/);
  assert.match(reported.message, /3 files, 2 Lua modules/);
});

test("an archive that declares no ext.manifest is reported rather than silently dropped", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "deherm-lua-only-"));
  await mkdir(path.join(project, ".internal", "lib"), { recursive: true });
  await writeFile(path.join(project, "game.project"), "[project]\ntitle = Lua only\n");
  await writeFile(path.join(project, ".internal", "lib", "druid.zip"), zipSync({
    "druid/druid.lua": strToU8("return {}\n"),
    "druid/base/button.lua": strToU8("return {}\n"),
    "druid/README.md": strToU8("# Druid\n")
  }));
  const inventory = await inspectDefoldProject({ project });
  assert.deepEqual(inventory.extensions, []);
  assert.deepEqual(inventory.dependencyArchivesWithoutManifest, [
    { archive: ".internal/lib/druid.zip", files: 3, luaModules: 2 }
  ]);
  assert.equal(inventory.diagnostics.length, 1);
  assert.match(inventory.diagnostics[0].message, /no ingestible binding surface/);
});
