#!/usr/bin/env node

// A real game consumer, intentionally outside the pnpm workspace and without
// any copied generated SDK, native extension, or contributor dependency tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = path.resolve(
  process.argv[2] ?? path.join(repositoryRoot, "build", "npm-release-candidate", "ts-defold-deherm-0.1.0.tgz"),
);
const output = path.resolve(process.argv[3] ?? path.join(repositoryRoot, "build", "npm-snake-proof.json"));
const example = path.join(repositoryRoot, "examples", "snake");
const authoredFiles = [
  ".defignore",
  ".gitignore",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  "README.md",
  "assets/body.png",
  "assets/food.png",
  "assets/head.png",
  "game.project",
  "input/game.input_binding",
  "main/body.go",
  "main/controller.go",
  "main/food.go",
  "main/head.go",
  "main/hud.go",
  "main/hud.gui.ts",
  "main/main.collection",
  "main/snake.atlas",
  "main/snake.gui",
  "main/snake.script.ts",
  "package.json",
  "scripts/generate-art.mjs",
  "src/snake.ts",
  "test/snake.test.mjs",
];

function run(command, args, options = {}) {
  console.error(`[npm-snake-proof] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? result.signal}\n${(result.stdout + result.stderr).slice(-8192)}`,
    );
  }
  return result.stdout;
}

const archiveBytes = await readFile(archive);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const root = await mkdtemp(path.join(tmpdir(), "deherm-npm-snake-"));
try {
  const game = path.join(root, "snake");
  const cacheRoot = path.join(root, "deherm-cache");
  const environment = {
    ...process.env,
    DEHERM_CACHE_HOME: cacheRoot,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
  };
  delete environment.DEHERM_OFFLINE;
  delete environment.DEHERM_TOOL_CACHE;
  for (const relative of authoredFiles) {
    const destination = path.join(game, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(example, relative), destination);
  }
  const manifestFile = path.join(game, "package.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifest.devDependencies["@ts-defold/deherm"], "workspace:*");
  manifest.devDependencies["@ts-defold/deherm"] = archive;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  run("npm", ["install", "--prefix", game, "--no-audit", "--no-fund", "--cache", path.join(root, "npm-cache")]);
  const installed = path.join(game, "node_modules", "@ts-defold", "deherm");
  assert.equal((await lstat(installed)).isSymbolicLink(), false, "Snake used a workspace package link");
  assert.equal((await realpath(installed)).startsWith(repositoryRoot), false, "Snake resolved to this checkout");
  const cli = path.join(installed, "bin", "deherm.mjs");

  run(process.execPath, ["--experimental-strip-types", "--test", "test/snake.test.mjs"], {
    cwd: game,
    env: environment,
  });
  await assert.rejects(stat(cacheRoot), { code: "ENOENT" }, "Snake did not begin with a cold déherm cache");
  const generated = JSON.parse(
    run(process.execPath, [cli, "generate", "--project", game, "--json"], { cwd: game, env: environment }),
  );
  assert.equal(
    generated.defoldRevision,
    /defold_sdk\s*=\s*([a-f0-9]{40})/u.exec(await readFile(path.join(game, "game.project"), "utf8"))?.[1],
  );
  assert.equal(generated.componentCount, 2, "Snake script and HUD GUI proxies were not generated");
  assert.ok((await stat(cacheRoot)).isDirectory(), "generation did not populate the isolated déherm cache");
  await stat(path.join(game, "main", "snake.script"));
  await stat(path.join(game, "main", "hud.gui_script"));
  const checked = JSON.parse(
    run(process.execPath, [cli, "typecheck", "--project", game, "--release", "--json"], {
      cwd: game,
      env: environment,
    }),
  );
  assert.equal(checked.passed, true, "tarball-installed Snake did not typecheck");
  const build = run(
    process.execPath,
    [cli, "dev", "--project", game, "--entry", "main/snake.script.ts", "--once", "--headless", "--no-launch", "--json"],
    { cwd: game, env: environment },
  );
  assert.match(build, /"type":"build-succeeded"/u, "tarball-installed Snake did not compile");
  for (const route of ["factory.create", "go.set_position", "msg.post", "gui.set_text"]) {
    assert.ok(build.includes(`"id":"script:${route}"`), `Snake did not reach the real ${route} route`);
  }
  const resource = await stat(path.join(game, "deherm", "app.dehermc"));
  assert.ok(resource.size > 0, "Snake produced an empty runtime bundle");
  const native = JSON.parse(
    run(
      process.execPath,
      [cli, "prepare-bob", "--project", game, "--target", "x86_64-linux", "--variant", "release", "--json"],
      { cwd: game, env: environment },
    ),
  );
  assert.equal(native.representation, "hermes-bytecode");
  assert.ok(native.compilation.outputBytes > 0, "Hermes compiler emitted no Snake bytecode");
  assert.equal(native.compilation.compiler.startsWith(repositoryRoot), false, "Snake used a checkout Hermes compiler");
  await stat(path.join(game, "deherm", "app.release.dehermc"));
  const browser = JSON.parse(
    run(
      process.execPath,
      [cli, "prepare-bob", "--project", game, "--target", "wasm-web", "--variant", "release", "--json"],
      { cwd: game, env: environment },
    ),
  );
  assert.equal(browser.representation, "javascript");
  const verified = JSON.parse(
    run(process.execPath, [cli, "verify-generated", "--project", game, "--json"], { cwd: game, env: environment }),
  );
  assert.ok(verified.checkedFiles > 0, "Snake generated SDK verification checked no files");

  const report = {
    schemaVersion: 1,
    kind: "deherm.npm-snake-consumer-proof",
    tarballSha256: archiveSha256,
    defoldRevision: generated.defoldRevision,
    surfaceLayer: generated.defoldSurfaceLayer,
    isolatedCacheStartedEmpty: true,
    componentCount: generated.componentCount,
    bundleBytes: resource.size,
    nativeBytecodeBytes: native.compilation.outputBytes,
    stages: [
      "tarball-installed",
      "rules-tested",
      "policy-resolved",
      "script-and-hud-proxies-generated",
      "release-typechecked",
      "game-compiled",
      "native-hermes-bytecode-compiled",
      "browser-javascript-projected",
      "generated-verified",
    ],
    limitation: "Compiler and resource proof only; no Defold engine or Bob runtime was executed.",
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
