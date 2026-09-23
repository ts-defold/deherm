import assert from "node:assert/strict";
import test from "node:test";

import {
  debugAdapterLaunch,
  dehermCliCandidates,
  languageServerLaunch,
  owningDehermProject,
  resolveLiveValueDocument,
  resolveDehermCli,
  selectDehermProject,
  type DehermProject
} from "../src/core.ts";

test("CLI candidates walk from a nested Defold project to the workspace boundary", () => {
  assert.deepEqual(dehermCliCandidates({
    projectRoot: "/work/game/defold",
    workspaceRoot: "/work/game",
    platform: "linux"
  }), [
    "/work/game/defold/node_modules/@ts-defold/deherm/bin/deherm.mjs",
    "/work/game/node_modules/@ts-defold/deherm/bin/deherm.mjs"
  ]);
  assert.deepEqual(dehermCliCandidates({
    projectRoot: "C:\\work\\game\\defold",
    workspaceRoot: "C:\\work\\game",
    platform: "win32"
  }), [
    "C:\\work\\game\\defold\\node_modules\\@ts-defold\\deherm\\bin\\deherm.mjs",
    "C:\\work\\game\\node_modules\\@ts-defold\\deherm\\bin\\deherm.mjs"
  ]);
});

test("CLI resolution uses the nearest workspace package and honors an explicit override", async () => {
  const available = new Set(["/work/game/node_modules/@ts-defold/deherm/bin/deherm.mjs"]);
  assert.equal(await resolveDehermCli({
    projectRoot: "/work/game/defold",
    workspaceRoot: "/work/game",
    platform: "linux",
    isFile: async (file) => available.has(file)
  }), "/work/game/node_modules/@ts-defold/deherm/bin/deherm.mjs");
  assert.equal(await resolveDehermCli({
    projectRoot: "/work/game/defold",
    workspaceRoot: "/work/game",
    configuredPath: "tools/deherm.mjs",
    platform: "linux",
    isFile: async (file) => file === "/work/game/tools/deherm.mjs"
  }), "/work/game/tools/deherm.mjs");
  await assert.rejects(resolveDehermCli({
    projectRoot: "/work/game",
    platform: "linux",
    isFile: async () => false
  }), /pnpm add -D @ts-defold\/deherm/);
});

test("project selection accepts directories and game.project but rejects ambiguity", () => {
  const projects: DehermProject[] = [
    { workspaceRoot: "/work", projectRoot: "/work/alpha" },
    { workspaceRoot: "/work", projectRoot: "/work/beta" }
  ];
  assert.equal(selectDehermProject({
    projects,
    requestedProject: "/work/beta/game.project",
    workspaceRoot: "/work",
    platform: "linux"
  }).projectRoot, "/work/beta");
  assert.throws(() => selectDehermProject({ projects, workspaceRoot: "/work", platform: "linux" }), /contains 2 Defold projects/);
  assert.equal(selectDehermProject({
    projects: [projects[0]],
    requestedProject: "${workspaceFolder}",
    workspaceRoot: "/work",
    platform: "linux"
  }).projectRoot, "/work/alpha");
  assert.throws(() => selectDehermProject({
    projects: [{ workspaceRoot: "/other", projectRoot: "/other/game" }],
    requestedProject: "${workspaceFolder}",
    workspaceRoot: "/work",
    platform: "linux"
  }), /No game\.project was found in workspace folder/);
});

test("the deepest nested Defold project exclusively owns its documents", () => {
  const projects: DehermProject[] = [
    { workspaceRoot: "/work", projectRoot: "/work" },
    { workspaceRoot: "/work", projectRoot: "/work/examples/game" }
  ];
  assert.equal(owningDehermProject(projects, "/work/main/root.script.ts", "linux")?.projectRoot, "/work");
  assert.equal(owningDehermProject(projects, "/work/examples/game/main/player.script.ts", "linux")?.projectRoot, "/work/examples/game");
  assert.equal(owningDehermProject(projects, "/outside/file.ts", "linux"), undefined);
});

test("live-value navigation resolves only an absolute authored resource owned by the named project", () => {
  const projects: DehermProject[] = [
    { workspaceRoot: "/work", projectRoot: "/work/game" },
    { workspaceRoot: "/work", projectRoot: "/work/game/nested" }
  ];
  assert.equal(resolveLiveValueDocument(projects, {
    projectRoot: "/work/game",
    documentPath: "/work/game/main/player.script.ts"
  }, "linux"), "/work/game/main/player.script.ts");
  assert.equal(resolveLiveValueDocument(projects, {
    projectRoot: "/work/game",
    documentPath: "/work/game/main/player.lua"
  }, "linux"), undefined);
  assert.equal(resolveLiveValueDocument(projects, {
    projectRoot: "/work/game",
    documentPath: "/work/game/../foreign/main/player.script.ts"
  }, "linux"), undefined);
  assert.equal(resolveLiveValueDocument(projects, {
    projectRoot: "/work/game",
    documentPath: "/work/game/nested/main/player.script.ts"
  }, "linux"), undefined);
  assert.equal(resolveLiveValueDocument(projects, {
    projectRoot: "/work/game",
    documentPath: "main/player.script.ts"
  }, "linux"), undefined);
  assert.equal(resolveLiveValueDocument([{
    workspaceRoot: "C:\\work",
    projectRoot: "C:\\work\\game"
  }], {
    projectRoot: "c:\\work\\game",
    documentPath: "C:\\work\\game\\main\\hud.gui.ts"
  }, "win32"), "C:\\work\\game\\main\\hud.gui.ts");
});

test("language-server and debug launches use the selected Node executable with exact CLI arguments", () => {
  assert.deepEqual(languageServerLaunch({
    cliPath: "/work/node_modules/@ts-defold/deherm/bin/deherm.mjs",
    projectRoot: "/work/game",
    nodeExecutable: "/Applications/Code/Electron",
    environment: { PATH: "/bin", REMOVE_ME: undefined }
  }), {
    command: "/Applications/Code/Electron",
    args: [
      "/work/node_modules/@ts-defold/deherm/bin/deherm.mjs",
      "language-server",
      "--stdio",
      "--project",
      "/work/game"
    ],
    cwd: "/work/game",
    env: { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" }
  });

  assert.deepEqual(debugAdapterLaunch({
    cliPath: "/work/node_modules/@ts-defold/deherm/bin/deherm.mjs",
    projectRoot: "/work/game",
    inspectorSession: ".deherm/dev/custom.json",
    replaceDebugger: true,
    nodeExecutable: "/Applications/Code/Electron",
    environment: { PATH: "/bin" }
  }), {
    command: "/Applications/Code/Electron",
    args: [
      "/work/node_modules/@ts-defold/deherm/bin/deherm.mjs",
      "debug",
      "--project",
      "/work/game",
      "--inspector-session",
      "/work/game/.deherm/dev/custom.json",
      "--replace-debugger"
    ],
    cwd: "/work/game",
    env: { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" }
  });
});
