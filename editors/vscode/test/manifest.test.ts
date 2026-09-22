import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

test("VS Code manifest is a thin workspace extension with an attach configuration", () => {
  assert.equal(manifest.name, "deherm");
  assert.equal(manifest.publisher, "ts-defold");
  assert.equal(manifest.main, "./dist/extension.cjs");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false,
    "the workspace extension executes the project-local CLI and must stay disabled until trust is granted");
  assert.ok(manifest.activationEvents.includes("workspaceContains:**/game.project"));
  assert.ok(manifest.activationEvents.includes("onDebug:deherm"));
  const debuggerContribution = manifest.contributes.debuggers.find(({ type }: { type: string }) => type === "deherm");
  assert.ok(debuggerContribution);
  assert.equal(debuggerContribution.initialConfigurations[0].request, "attach");
  assert.equal(debuggerContribution.initialConfigurations[0].project, "${workspaceFolder}");
});

test("VSIX client depends on the protocol client but never embeds the deherm compiler package", () => {
  assert.equal(manifest.dependencies["@ts-defold/deherm"], undefined);
  assert.equal(manifest.dependencies["vscode-languageclient"], "9.0.1");
  assert.equal(manifest.contributes.configuration.properties["deherm.cliPath"].scope, "resource");
  assert.equal(manifest.contributes.configuration.properties["deherm.nodePath"].scope, "resource");
});

test("VSIX packaging excludes source, tests, dependencies, and nested VSIX output", async () => {
  const ignored = await readFile(path.join(root, ".vscodeignore"), "utf8");
  for (const pattern of ["src/**", "test/**", "scripts/**", "node_modules/**", "dist/*.vsix"]) {
    assert.match(ignored, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  }
});
