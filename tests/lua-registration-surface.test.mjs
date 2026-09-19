import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  analyzeFunctionBody,
  buildProject,
  collectBodyDerivedHelpers,
  collectSdkStackHelpers,
  collectUserTypes,
  interpretRegistrations
} from "../scripts/lib/lua-c-registration.mjs";
import { luaRegistrationSurfaceGenerator } from "../scripts/lib/script-generator-pipeline.mjs";
import { materializeIngestionProject } from "./fixtures/defold-extension-ingestion/materialize.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(repositoryRoot, luaRegistrationSurfaceGenerator.artifacts[0]);
const pinnedDefoldRevision = (await readFile(path.join(repositoryRoot, "upstream.lock"), "utf8"))
  .match(/^DEFOLD_REV=(.+)$/m)?.[1];
assert.match(pinnedDefoldRevision, /^[0-9a-f]{40}$/);

async function readReport() {
  return JSON.parse(await readFile(reportPath, "utf8"));
}

function analyze(sources, headers = []) {
  const project = buildProject(sources);
  const declared = collectSdkStackHelpers(headers);
  const helpers = collectBodyDerivedHelpers(project, declared, collectUserTypes(project));
  return { project, helpers, interpretation: interpretRegistrations(project) };
}

test("the lane owns its generator, pinned inputs, and artifact", () => {
  const registry = luaRegistrationSurfaceGenerator;
  for (const group of [registry.sources, registry.pinnedInputs, registry.artifacts, registry.sourceTreeEvidence]) {
    assert.ok(Array.isArray(group) && group.length > 0);
    assert.equal(new Set(group).size, group.length);
    for (const entry of group) {
      assert.equal(path.isAbsolute(entry), false, `${entry} must be repository-relative`);
      assert.equal(entry.split("/").includes(".."), false, `${entry} must not escape the repository`);
    }
  }
  for (const step of registry.steps) {
    assert.equal(step.runtime, "node");
    assert.ok(registry.sources.includes(step.script), `unowned step: ${step.script}`);
  }
  for (const artifact of registry.artifacts) {
    assert.equal(registry.sources.includes(artifact), false);
    assert.equal(registry.pinnedInputs.includes(artifact), false);
  }
});

test("registration namespaces come from the abstract Lua stack, not from a module list", () => {
  const sources = [{
    path: "src/nested.cpp",
    text: `
      #define LIB_NAME "demo"
      static int Root_Ping(lua_State* L) { lua_pushnumber(L, 1); return 1; }
      static int Leaf_Get(lua_State* L) {
        const char* name = luaL_checkstring(L, 1);
        lua_pushstring(L, name);
        return 1;
      }
      static const luaL_reg Root_methods[] = { {"ping", Root_Ping}, {0, 0} };
      static const luaL_reg Leaf_methods[] = {
        {"get", Leaf_Get},
        // {"removed", Leaf_Removed},
        {0, 0}
      };
      static void InitializeLeaf(lua_State* L) {
        lua_newtable(L);
        luaL_register(L, 0, Leaf_methods);
        lua_pushnumber(L, 7);
        lua_setfield(L, -2, "SEVEN");
        lua_setfield(L, -2, "leaf");
      }
      static void Initialize(lua_State* L) {
        luaL_register(L, LIB_NAME, Root_methods);
        InitializeLeaf(L);
        lua_pop(L, 1);
      }
    `
  }];
  const { interpretation } = analyze(sources);
  assert.deepEqual([...interpretation.modules.keys()].sort(), ["demo", "demo.leaf"]);
  assert.deepEqual(interpretation.modules.get("demo").functions.map((item) => item.name), ["ping"]);
  assert.deepEqual(interpretation.modules.get("demo.leaf").functions.map((item) => item.name), ["get"]);
  assert.deepEqual(interpretation.modules.get("demo.leaf").constants.map((item) => item.name), ["SEVEN"]);
  // A commented-out entry is evidence of absence and must be recorded as such.
  assert.deepEqual(
    (interpretation.modules.get("demo.leaf").commentedOut ?? []).map((item) => item.name),
    ["removed"]
  );
  assert.deepEqual(interpretation.blockers, []);
});

test("argument arity, types, and optionality are read out of the C function body", () => {
  const sources = [{
    path: "src/shape.cpp",
    text: `
      static MapData* get_map(lua_State* L, int nArg) {
        const uint16_t id = luaL_optinteger(L, nArg, 0);
        return maps.Get(id);
      }
      static int demo_use(lua_State* L) {
        DM_LUA_STACK_CHECK(L, 0);
        bool toggle = lua_toboolean(L, 1);
        MapData* map = get_map(L, 2);
        (void) toggle; (void) map;
        return 0;
      }
      static int demo_at(lua_State* L) {
        int x = luaL_checkint(L, 1);
        MapData* map = get_map(L, 2);
        (void) x; (void) map;
        lua_pushinteger(L, 1);
        return 1;
      }
      static const luaL_reg Module_methods[] = {
        {"use", demo_use}, {"at", demo_at}, {0, 0}
      };
      static void Initialize(lua_State* L) { luaL_register(L, "demo", Module_methods); lua_pop(L, 1); }
    `
  }];
  const { project, helpers } = analyze(sources);
  const use = analyzeFunctionBody(project.functionsByName.get("demo_use")[0], helpers, project);
  assert.deepEqual(use.arity, { min: 0, max: 2, variadic: false, branchDependent: false });
  // `lua_toboolean` never raises, so slot 1 is optional in the C body whatever
  // the documentation claims.
  assert.deepEqual(use.parameters[0], {
    index: 1,
    optional: true,
    types: ["boolean"],
    accessors: ["lua_toboolean"],
    evidence: "probed",
    requirementUnconditional: false
  });
  // The optional slot is typed through a helper whose own body reads it.
  assert.deepEqual(use.parameters[1].types, ["number"]);
  assert.equal(use.parameters[1].optional, true);
  assert.equal(use.parameters[1].evidence, "defaulted");
  assert.deepEqual(use.results.min, 0);

  const at = analyzeFunctionBody(project.functionsByName.get("demo_at")[0], helpers, project);
  assert.deepEqual(at.arity, { min: 1, max: 2, variadic: false, branchDependent: false });
  assert.equal(at.parameters[0].optional, false);
  assert.deepEqual(at.results.resultTypes, ["number"]);
});

test("a `.script_api` member without `type: function` and a trailing [optional] marker are both reported", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-lua-registration-"));
  try {
    const root = path.join(workspace, "demo");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "api"), { recursive: true });
    await writeFile(path.join(root, "ext.manifest"), "name: demo\n");
    await writeFile(path.join(root, "api", "demo.script_api"), [
      "- name: demo",
      "  type: table",
      "  members:",
      "    - name: use_zero",
      "      desc: no type key at all",
      "      parameters:",
      "        - name: toggle",
      "          type: boolean",
      "        - name: map_id[optional]",
      "          type: number",
      "    - name: hidden_only_in_c",
      "      type: function",
      "      parameters: []"
    ].join("\n"));
    await writeFile(path.join(root, "src", "demo.cpp"), `
      static int demo_use_zero(lua_State* L) {
        DM_LUA_STACK_CHECK(L, 0);
        bool toggle = lua_toboolean(L, 1);
        int map_id = luaL_optinteger(L, 2, 0);
        (void) toggle; (void) map_id;
        return 0;
      }
      static int demo_extra(lua_State* L) { return 0; }
      static const luaL_reg Module_methods[] = {
        {"use_zero", demo_use_zero}, {"extra", demo_extra}, {0, 0}
      };
      static void Initialize(lua_State* L) { luaL_register(L, "demo", Module_methods); lua_pop(L, 1); }
    `);
    const policy = path.join(workspace, "policy.json");
    await writeFile(policy, JSON.stringify({
      schemaVersion: 1,
      defoldRevision: pinnedDefoldRevision,
      targets: [{ id: "demo", kind: "extension-root", root, declared: { kind: "script-api" } }]
    }));
    await execFileAsync("node", [
      path.join(repositoryRoot, "scripts/generate-lua-registration-surface.mjs"),
      "--policy", policy,
      "--out-root", workspace
    ], { cwd: repositoryRoot });
    const report = JSON.parse(await readFile(
      path.join(workspace, luaRegistrationSurfaceGenerator.artifacts[0]), "utf8"));
    const target = report.targets.demo;
    assert.equal(target.status, "verified");

    const useZero = target.routes.find((route) => route.name === "demo.use_zero");
    // The declaration omits `type: function` while the C source proves the
    // member is a registered Lua C function.
    assert.equal(useZero.declaration.missingFunctionType, true);
    // `map_id[optional]` is decoded, and the non-standard spelling stays visible.
    assert.equal(useZero.parameters[1].declared.optionalitySpelling, "trailing-optional-marker");
    assert.equal(useZero.parameters[1].verdict, "agree");
    // The first slot is declared required but the C body reads it with a
    // non-raising accessor.
    assert.equal(useZero.parameters[0].optionality.verdict, "disagree");
    assert.match(useZero.parameters[0].optionality.reason, /lua_toboolean/);

    assert.deepEqual(target.registeredButUndeclared.map((item) => item.name), ["demo.extra"]);
    assert.deepEqual(target.declaredButUnregistered.map((item) => item.name), ["demo.hidden_only_in_c"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a dependency archive is read without unpacking, and a declaration with no implementation fails closed", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "deherm-lua-registration-archive-"));
  try {
    const { root: project } = await materializeIngestionProject(path.join(workspace, "project"));
    const { readdir, writeFile } = await import("node:fs/promises");
    const names = (await readdir(path.join(project, ".internal", "lib"))).filter((name) => name.endsWith(".zip")).sort();
    assert.equal(names.length, 2);
    const policy = path.join(workspace, "policy.json");
    await writeFile(policy, JSON.stringify({
      schemaVersion: 1,
      defoldRevision: pinnedDefoldRevision,
      targets: names.map((name, index) => ({
        id: `archive-${index}`,
        kind: "dependency-archive",
        archive: path.join(project, ".internal", "lib", name),
        declared: { kind: "script-api" }
      }))
    }));
    await execFileAsync("node", [
      path.join(repositoryRoot, "scripts/generate-lua-registration-surface.mjs"),
      "--policy", policy,
      "--out-root", workspace
    ], { cwd: repositoryRoot });
    const report = JSON.parse(await readFile(
      path.join(workspace, luaRegistrationSurfaceGenerator.artifacts[0]), "utf8"));
    for (const target of Object.values(report.targets)) {
      // The fixture archives carry interface description only. The verifier must
      // say so rather than let an unchecked declaration read as agreement.
      assert.equal(target.status, "unverifiable");
      assert.ok(target.inputs.archiveEntries > 0, "the archive's full entry listing is kept");
      assert.match(target.inputs.archiveSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(target.blockers.map((item) => item.code), ["no-native-source-in-target"]);
      assert.ok(target.summary.declaredRoutes > 0);
      assert.equal(target.summary.registeredRoutes, null);
      assert.equal(target.summary.verified, false);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the committed engine report is fail-closed and complete", async () => {
  const report = await readReport();
  assert.equal(report.schemaVersion, 1);
  const engine = report.targets["defold-engine-box2d-v3"];
  assert.equal(engine.status, "verified");
  assert.equal(engine.summary.declaredRoutes, 926);
  assert.ok(engine.summary.registeredRoutes > 800);

  // ResolveURL's stack-index overload defaults an absent slot to the current
  // URL. Its same-arity string overload must not hide that body-derived
  // contract and turn documented optional URLs into required parameters.
  for (const targetId of ["defold-engine-box2d-v2", "defold-engine-box2d-v3"]) {
    const setParent = report.targets[targetId].routes.find((route) => route.name === "go.set_parent");
    assert.ok(setParent, `${targetId} must register go.set_parent`);
    assert.equal(setParent.arity.derived.min, 0);
    assert.equal(setParent.parameters[0].derived.optional, true);
    assert.equal(setParent.parameters[0].derived.evidence, "presence-guarded");
  }

  // Nothing is silently passed: every undecided route carries a blocker, and
  // every blocker names a code, a location, and a reason.
  for (const blocker of engine.blockers) {
    assert.ok(blocker.code && blocker.detail, JSON.stringify(blocker));
    assert.equal(typeof blocker.path, "string");
  }
  assert.equal(
    engine.summary.blockers,
    Object.values(engine.blockerHistogram).reduce((total, count) => total + count, 0)
  );
  const verdicts = new Set(engine.routes.map((route) => route.verdict));
  for (const verdict of verdicts) {
    assert.ok(["agree", "agree-partially", "partially-undecided", "disagree", "undecided"].includes(verdict), verdict);
  }
  assert.equal(
    engine.summary.agreeing + engine.summary.partiallyUndecided + engine.summary.disagreeing + engine.summary.undecided,
    engine.summary.registeredAndDeclared
  );

  // The fixture extension targets vendor no native source, so they must report
  // as unverifiable rather than as agreement.
  for (const id of ["extension-defold-xmath", "extension-defold-astar"]) {
    assert.equal(report.targets[id].status, "unverifiable");
    assert.deepEqual(report.targets[id].blockers.map((item) => item.code), ["no-native-source-in-target"]);
  }
});

test("the committed engine report is regenerable byte for byte", async () => {
  await execFileAsync("node", ["scripts/generate-lua-registration-surface.mjs", "--check"], { cwd: repositoryRoot });
});

test("a file-scope macro that expands to a Lua C function is read like any other body", () => {
  const sources = [{
    path: "src/macro.cpp",
    text: `
      #define BIT_OP(func, opr) \\
          static int func(lua_State *L) { \\
              lua_Number b = luaL_checknumber(L, 1); \\
              lua_Number n = luaL_checknumber(L, 2); \\
              lua_pushnumber(L, b opr n); return 1; }
      BIT_OP(demo_band, &)
      #define GETTER(name, reader) \\
          static int Demo_Get##name(lua_State* L) { \\
              reader(L, luaL_checkinteger(L, 1)); \\
              return 1; }
      GETTER(Width, lua_pushnumber)
      static const luaL_reg Demo_methods[] = {
        {"band", demo_band}, {"get_width", Demo_GetWidth}, {0, 0}
      };
      static void Initialize(lua_State* L) { luaL_register(L, "demo", Demo_methods); lua_pop(L, 1); }
    `
  }];
  const { project, helpers, interpretation } = analyze(sources);
  // The registration array names symbols that exist only as macro expansions;
  // token pasting must produce `Demo_GetWidth`, not a stringified `Demo_Get#`.
  assert.deepEqual(
    interpretation.modules.get("demo").functions.map((item) => item.cFunction).sort(),
    ["Demo_GetWidth", "demo_band"]
  );
  const band = analyzeFunctionBody(project.functionsByName.get("demo_band")[0], helpers, project);
  assert.deepEqual(band.arity, { min: 2, max: 2, variadic: false, branchDependent: false });
  assert.deepEqual(band.parameters.map((item) => item.types), [["number"], ["number"]]);
  assert.equal(band.results.min, 1);
});

test("an overload that addresses no stack index is decided, not blocked", () => {
  const sources = [{
    path: "src/overload.cpp",
    text: `
      static Scene* Instance_Check(lua_State* L, int index) {
        return (Scene*) lua_touserdata(L, index);
      }
      static Scene* Instance_Check(lua_State* L) {
        lua_rawgeti(L, LUA_REGISTRYINDEX, g_instance);
        Scene* scene = Instance_Check(L, -1);
        lua_pop(L, 1);
        return scene;
      }
      static int demo_here(lua_State* L) {
        Scene* scene = Instance_Check(L);
        lua_pushnumber(L, scene->value);
        return 1;
      }
      static const luaL_reg Demo_methods[] = { {"here", demo_here}, {0, 0} };
      static void Initialize(lua_State* L) { luaL_register(L, "demo", Demo_methods); lua_pop(L, 1); }
    `
  }];
  const { project, helpers } = analyze(sources);
  const here = analyzeFunctionBody(project.functionsByName.get("demo_here")[0], helpers, project);
  // The one-argument overload reads the registry, not an argument, so the route
  // takes no arguments and nothing is left unparseable.
  assert.deepEqual(here.arity, { min: 0, max: 0, variadic: false, branchDependent: false });
  assert.deepEqual(here.undecided, []);
});

test("a presence test on a slot outranks a check below it", () => {
  const sources = [{
    path: "src/guarded.cpp",
    text: `
      static int CheckMaxResults(lua_State* L, int index) {
        if (lua_isnoneornil(L, index)) { return 0; }
        int max_results = luaL_checkinteger(L, index);
        return max_results;
      }
      static dmhash_t CheckName(lua_State* L, int index) {
        if (lua_type(L, index) == LUA_TSTRING) { return dmHashString64(lua_tostring(L, index)); }
        luaL_typerror(L, index, "string expected");
        return 0;
      }
      static int demo_query(lua_State* L) {
        dmhash_t name = CheckName(L, 1);
        int limit = CheckMaxResults(L, 2);
        lua_pushnumber(L, limit);
        return 1;
      }
      static const luaL_reg Demo_methods[] = { {"query", demo_query}, {0, 0} };
      static void Initialize(lua_State* L) { luaL_register(L, "demo", Demo_methods); lua_pop(L, 1); }
    `
  }];
  const { project, helpers } = analyze(sources);
  const query = analyzeFunctionBody(project.functionsByName.get("demo_query")[0], helpers, project);
  // `CheckMaxResults` returns early when the slot is absent, so its `luaL_check*`
  // sits on the else-path and the slot is optional whatever the helper is named.
  assert.equal(query.parameters[1].optional, true);
  assert.equal(query.parameters[1].evidence, "presence-guarded");
  // `CheckName` falls through to an argument-raising call, so its slot is
  // required even though every accessor it used on the way is non-raising.
  assert.equal(query.parameters[0].optional, false);
  assert.equal(query.parameters[0].evidence, "checked");
  assert.equal(query.parameters[0].requirementUnconditional, true);
  assert.deepEqual(query.undecided, []);
});

test("a same-arity non-slot overload does not hide a public helper's body contract", () => {
  const sources = [
    {
      path: "src/url.cpp",
      text: `
        int ResolveURL(lua_State* L, const char* url, URL* out, URL* defaults) {
          return 0;
        }
        int ResolveURL(lua_State* L, int index, URL* out, URL* defaults) {
          if (lua_gettop(L) < index || lua_isnil(L, index)) {
            return 0;
          }
          luaL_argerror(L, index, "url expected");
          return 0;
        }
      `
    },
    {
      path: "src/caller.cpp",
      text: `
        static int demo_resolve(lua_State* L) {
          ResolveURL(L, 1, 0, 0);
          return 0;
        }
      `
    }
  ];
  const headers = [{
    path: "include/url.h",
    text: "int ResolveURL(lua_State* L, int index, URL* out, URL* defaults);"
  }];
  const { project, helpers } = analyze(sources, headers);
  const route = analyzeFunctionBody(project.functionsByName.get("demo_resolve")[0], helpers, project);

  assert.deepEqual(route.arity, { min: 0, max: 1, variadic: false, branchDependent: false });
  assert.equal(route.parameters[0].optional, true);
  assert.equal(route.parameters[0].evidence, "presence-guarded");
  assert.deepEqual(route.parameters[0].accessors, ["ResolveURL"]);
});

test("the gate carries only findings with positive source evidence in every engine variant", async () => {
  const report = await readReport();
  const gate = JSON.parse(await readFile(
    path.join(repositoryRoot, luaRegistrationSurfaceGenerator.artifacts[1]), "utf8"));
  assert.equal(gate.schemaVersion, 1);
  assert.equal(gate.sourceReport, luaRegistrationSurfaceGenerator.artifacts[0]);
  assert.deepEqual(gate.engineTargets, ["defold-engine-box2d-v2", "defold-engine-box2d-v3"]);
  assert.ok(gate.findings.length > 0);
  assert.equal(gate.findings.some((finding) => finding.route === "go.set_parent"), false,
    "go.set_parent must not be narrowed after real-engine zero-argument evidence");

  const gatedKinds = new Set([
    "registered-under-a-different-name",
    "registration-commented-out",
    "documented-optional-slot-required-by-c"
  ]);
  const declaredNames = new Set(gate.engineTargets.flatMap((id) =>
    report.targets[id].declaredButUnregistered.map((row) => row.name)));
  for (const finding of gate.findings) {
    assert.ok(gatedKinds.has(finding.kind), finding.kind);
    assert.ok(["block-emission", "require-parameter"].includes(finding.action), finding.action);
    // Every finding must be witnessed independently by each engine variant, so a
    // route that differs only between mutually exclusive builds never gates.
    assert.equal(finding.evidence.length, gate.engineTargets.length, finding.route);
    assert.deepEqual([...finding.evidence].map((item) => item.target).sort(), gate.engineTargets);
    if (finding.action === "block-emission") {
      assert.ok(declaredNames.has(finding.route), `${finding.route} must be documented but unregistered`);
    } else {
      assert.ok(finding.parameter?.index > 0);
    }
  }

  // Absence of a registration is not positive evidence and must never gate: the
  // luasocket Lua modules and the `go.property` declaration tokens are reported
  // as unregistered but carry no finding.
  const gated = new Set(gate.findings.map((finding) => finding.route));
  const v3 = report.targets["defold-engine-box2d-v3"];
  const unexplained = v3.declaredButUnregistered
    .filter((row) => !row.commentedOutRegistration)
    .filter((row) => gated.has(row.name));
  assert.deepEqual(
    unexplained.map((row) => row.name).filter((name) => name !== "sys.set_render_enable"),
    []
  );
});
