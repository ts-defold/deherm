import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArguments } from "../packages/cli/src/cli.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test("command-specific target parsing keeps dev endpoints separate from conformance targets", () => {
  assert.equal(parseArguments([]).command, "ui");
  const creation = parseArguments(["create", "my-game", "--name", "My Game"]);
  assert.deepEqual(
    { command: creation.command, directory: creation.directory, name: creation.name },
    { command: "create", directory: "my-game", name: "My Game" }
  );

  const development = parseArguments([
    "dev",
    "--target", "http://127.0.0.1:8001",
    "--target", "http://127.0.0.1:8002"
  ]);
  assert.deepEqual(development.targets, ["http://127.0.0.1:8001", "http://127.0.0.1:8002"]);
  assert.equal(development.target, undefined);
  if (!process.stdin.isTTY || !process.stdout.isTTY) assert.equal(development.headless, true);

  const conformance = parseArguments(["conformance", "generate", "--target", "js-web"]);
  assert.equal(conformance.target, "js-web");
  assert.deepEqual(conformance.targets, []);
});

test("packed npm artifact loads its CLI and one-shot dev compiler", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-package-smoke-"));
  const cache = path.join(root, "npm-cache");
  const packed = JSON.parse(run("npm", [
    "pack",
    "--json",
    "--cache", cache,
    "--pack-destination", root
  ]).stdout)[0];
  const archive = path.join(root, packed.filename);
  const installRoot = path.join(root, "install");
  await mkdir(installRoot, { recursive: true });
  run("tar", ["-xzf", archive, "-C", installRoot]);

  const packageRoot = path.join(installRoot, "package");
  await symlink(path.join(repositoryRoot, "node_modules"), path.join(installRoot, "node_modules"), "dir");
  await readFile(path.join(packageRoot, "packages", "compiler", "src", "binding-identity.mjs"), "utf8");
  await readFile(path.join(packageRoot, "packages", "compiler", "src", "component-proxy-generator.mjs"), "utf8");
  await readFile(path.join(packageRoot, "bindings", "generated", "defold-script-real-engine-probes.json"), "utf8");

  const help = run(process.execPath, [path.join(packageRoot, "bin", "deherm.mjs"), "--help"]);
  assert.match(help.stdout, /deherm <command>/);

  const conformanceRoot = path.join(root, "conformance");
  const conformance = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "conformance", "generate",
    "--output", conformanceRoot,
    "--surface", "script",
    "--target", "js-web",
    "--shard", "0/32",
    "--json"
  ], { cwd: root });
  const conformanceSummary = JSON.parse(conformance.stdout);
  assert.ok(conformanceSummary.selectedCaseCount > 0);
  const conformancePlan = path.join(conformanceRoot, "plan.json");
  await readFile(conformancePlan, "utf8");
  const conformanceObservation = path.join(conformanceRoot, "compile-observation.json");
  const compiledConformance = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "conformance", "compile",
    "--plan", conformancePlan,
    "--output", conformanceObservation,
    "--json"
  ], { cwd: root });
  assert.equal(JSON.parse(compiledConformance.stdout).passed, true);
  await readFile(conformanceObservation, "utf8");

  const consumer = path.join(root, "consumer");
  const installedPackage = path.join(consumer, "node_modules", "@ts-defold", "deherm");
  await mkdir(path.dirname(installedPackage), { recursive: true });
  await symlink(packageRoot, installedPackage, "dir");
  await writeFile(path.join(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true
    },
    include: ["component.script.ts"]
  }, null, 2)}\n`);
  await writeFile(path.join(consumer, "component.script.ts"), [
    'import { builtins, type DefoldHash } from "@ts-defold/deherm";',
    'import { defineComponent, property } from "@ts-defold/deherm/component";',
    'const id: DefoldHash = builtins.hash("packed-component");',
    'export default defineComponent({ properties: { speed: property.number(1) }, init() { void id; } });',
    ""
  ].join("\n"));
  run(process.execPath, [
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "--project", path.join(consumer, "tsconfig.json"),
    "--pretty", "false"
  ], { cwd: consumer });

  const project = path.join(root, "project");
  const created = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "create", project,
    "--name", "Packed smoke test",
    "--json"
  ], { cwd: root });
  assert.equal(JSON.parse(created.stdout).projectRoot, project);
  assert.match(await readFile(path.join(project, "game.project"), "utf8"), /title = Packed smoke test/);
  assert.match(await readFile(path.join(project, "src", "main.script.ts"), "utf8"), /defineComponent/);

  const verified = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "verify-generated",
    "--project", project,
    "--json"
  ], { cwd: project });
  assert.ok(JSON.parse(verified.stdout).checkedFiles > 0);

  const checked = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "typecheck",
    "--project", project,
    "--json"
  ], { cwd: project });
  assert.equal(JSON.parse(checked.stdout).passed, true);

  const development = run(process.execPath, [
    path.join(packageRoot, "bin", "deherm.mjs"),
    "dev",
    "--project", project,
    "--once",
    "--headless"
  ], { cwd: project });
  assert.match(development.stdout, /\[deherm\] build-succeeded generation=1/);
  await readFile(path.join(project, ".deherm", "dev", "app.dehermc"), "utf8");
});
