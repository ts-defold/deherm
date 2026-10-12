#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(repositoryRoot, "build", "npm-consumer-proof.json"));
const targets = [
  { target: "wasm-web", representation: "javascript" },
  { target: "x86_64-linux", representation: "hermes-bytecode" },
];

function run(command, args, options = {}) {
  console.error(`[npm-consumer-proof] ${command} ${args.join(" ")}`);
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

async function assertRealInstallation(packageRoot) {
  assert.equal((await lstat(packageRoot)).isSymbolicLink(), false, `${packageRoot} is a workspace link`);
  const resolved = await realpath(packageRoot);
  assert.equal(resolved.startsWith(`${repositoryRoot}${path.sep}`), false, "consumer resolved to this checkout");
  await stat(path.join(resolved, "defold", "defold_hermes", "include", "jsi", "jsi.h"));
  await stat(path.join(resolved, "defold", "defold_hermes", "include", "hermes", "hermes.h"));
  return resolved;
}

const root = await mkdtemp(path.join(tmpdir(), "deherm-npm-consumer-"));
try {
  const npmCache = path.join(root, "npm-cache");
  const toolCache = path.join(root, "deherm-cache");
  const consumer = path.join(root, "consumer");
  const game = path.join(root, "game");
  const environment = { ...process.env, DEHERM_CACHE_HOME: toolCache };
  const revision = /^DEFOLD_REV=([a-f0-9]{40})$/mu.exec(
    await readFile(path.join(repositoryRoot, "upstream.lock"), "utf8"),
  )?.[1];
  assert.ok(revision, "upstream.lock has no pinned Defold revision");

  run("npm", ["pack", "--silent", "--pack-destination", root, "--cache", npmCache]);
  const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "npm pack must produce exactly one tarball");
  const archive = path.join(root, archives[0]);
  const archiveSha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const members = run("tar", ["-tzf", archive]).trim().split("\n");
  for (const member of [
    "package/bin/deherm.mjs",
    "package/packages/cli/src/ci-bundle.mjs",
    "package/defold/defold_hermes/include/jsi/jsi.h",
    "package/defold/defold_hermes/include/hermes/hermes.h",
  ]) {
    assert.ok(members.includes(member), `${archive} lacks ${member}`);
  }
  assert.equal(
    members.some((member) => /\.(?:a|lib)$/u.test(member) || member.includes("packages/bindings/generated/")),
    false,
    "npm tarball contains a target library or pinned Defold binding surface",
  );
  assert.equal(members.includes("package/defold/defold_hermes/include/libhermesvm-config.h"), false);

  run("npm", ["install", "--prefix", consumer, archive, "--no-audit", "--no-fund", "--cache", npmCache]);
  const installed = await assertRealInstallation(path.join(consumer, "node_modules", "@ts-defold", "deherm"));
  const cli = path.join(installed, "bin", "deherm.mjs");
  assert.match(run(process.execPath, [cli, "--help"], { cwd: consumer, env: environment }), /\bbundle\s+Generate/u);
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import assert from "node:assert/strict"; import { materializePolicySurface } from "@ts-defold/deherm/compiler/policy-surface-materializer"; assert.equal(typeof materializePolicySurface, "function");',
    ],
    { cwd: consumer, env: environment },
  );

  const created = JSON.parse(
    run(process.execPath, [cli, "create", game, "--name", "npm consumer proof", "--defold-sdk", revision, "--json"], {
      cwd: consumer,
      env: environment,
    }),
  );
  assert.equal(created.projectRoot, game);
  run("npm", ["install", "--prefix", game, archive, "--no-audit", "--no-fund", "--cache", npmCache]);
  const gamePackage = await assertRealInstallation(path.join(game, "node_modules", "@ts-defold", "deherm"));
  const gameCli = path.join(gamePackage, "bin", "deherm.mjs");
  const checked = JSON.parse(
    run(process.execPath, [gameCli, "typecheck", "--project", game, "--json"], { cwd: game, env: environment }),
  );
  assert.equal(checked.passed, true, "tarball-installed project did not typecheck");
  const verified = JSON.parse(
    run(process.execPath, [gameCli, "verify-generated", "--project", game, "--json"], { cwd: game, env: environment }),
  );
  assert.ok(verified.checkedFiles > 0, "generated SDK verification checked no files");

  const bundles = [];
  for (const { target, representation } of targets) {
    const built = JSON.parse(
      run(
        process.execPath,
        [
          gameCli,
          "bundle",
          "--project",
          game,
          "--entry",
          "src/main.script.ts",
          "--target",
          target,
          "--variant",
          "release",
          "--application-mode",
          "dynamic",
          "--json",
        ],
        { cwd: game, env: environment },
      ),
    );
    assert.equal(built.target, target);
    assert.equal(built.representation, representation);
    assert.ok((await stat(built.bundleOutput)).isDirectory(), `${target} produced no bundle directory`);
    bundles.push({ target, representation, bundleDirectory: path.basename(built.bundleOutput) });
  }

  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  const report = {
    schemaVersion: 1,
    kind: "deherm.npm-clean-consumer-proof",
    package: manifest.name,
    version: manifest.version,
    tarballBytes: (await stat(archive)).size,
    tarballSha256: archiveSha256,
    memberCount: members.length,
    defoldRevision: revision,
    stages: [
      "packed",
      "installed-without-workspace-link",
      "policy-resolved",
      "generated",
      "typechecked",
      "verified",
      "bob-bundled",
    ],
    bundles,
    limitation: "Build and native link only; no packaged-game runtime was executed.",
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
