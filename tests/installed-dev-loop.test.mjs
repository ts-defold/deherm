import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}\n${stdout}\n${stderr}`));
    });
  });
}

test("installed package drives the bounded incremental dev loop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-installed-dev-loop-"));
  const packedOutput = run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--cache", path.join(root, "npm-cache"),
    "--pack-destination", root
  ]).stdout;
  const packed = JSON.parse(packedOutput)[0];
  const installRoot = path.join(root, "install");
  await mkdir(installRoot, { recursive: true });
  run("tar", ["-xzf", path.join(root, packed.filename), "-C", installRoot]);
  await symlink(path.join(repositoryRoot, "node_modules"), path.join(installRoot, "node_modules"), "dir");
  const packageRoot = path.join(installRoot, "package");

  const project = path.join(root, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "main"), { recursive: true });
  await writeFile(path.join(project, "game.project"), "[project]\ntitle = Installed dev loop\n");
  await writeFile(path.join(project, "src", "main.ts"), 'import { value } from "./feature.ts";\nconsole.log("dev-loop", value);\n');
  await writeFile(path.join(project, "src", "feature.ts"), 'export const value = "first";\n');
  await writeFile(path.join(project, "main", "battle.gui.ts"), [
    "function defineComponent<T>(definition: T): T { return definition; }",
    "export default defineComponent({ update(_dt: number) {} });",
    ""
  ].join("\n"));
  await writeFile(path.join(project, "main", "tiles.atlas"), 'images { image: "/main/tile.png" }\n');

  const runner = path.join(repositoryRoot, "tests", "fixtures", "installed-dev-loop-runner.mjs");
  const execution = await runAsync(process.execPath, [runner, packageRoot, project]);
  const line = execution.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith("DEV_LOOP_RESULT "));
  assert.ok(line, execution.stdout);
  const result = JSON.parse(line.slice("DEV_LOOP_RESULT ".length));
  assert.equal(result.launches, 1);
  assert.equal(result.stops, 1);
  assert.equal(result.builds.length, 3);
  assert.equal(result.builds[0], "initial dev startup");
  assert.ok(result.builds.slice(1).every((reason) => /^changed [12] file\(s\)$/.test(reason)));
  assert.deepEqual(result.bundleGenerations, [1, 2, 3, 4, 5]);
  assert.notEqual(result.bundleFingerprints[0], result.bundleFingerprints[1]);
  assert.ok(result.lifecycle > 0);
  // `p` relaunches an already-ready build instead of rerunning Bob, so the only
  // Bob builds are the startup one plus the two asset/component edits. Derive
  // the compiled-resource names from that exact build sequence rather than
  // hard-coding the fixture's counter.
  const compiledNames = result.builds
    .map((reason, index) => (reason.startsWith("changed ") ? `/compiled/change-${index + 1}.resourcec` : undefined))
    .filter((name) => name !== undefined);
  assert.deepEqual(compiledNames, ["/compiled/change-2.resourcec", "/compiled/change-3.resourcec"]);
  assert.deepEqual(result.reloadBatches, [
    ["/deherm/app.dehermc"],
    ["/deherm/app.dehermc"],
    [compiledNames[0]],
    ["/deherm/app.dehermc"],
    ["/deherm/app.dehermc"],
    [compiledNames[1]]
  ]);
});
