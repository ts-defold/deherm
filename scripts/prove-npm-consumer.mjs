#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRetainedNpmCandidate } from "./lib/npm-candidate.mjs";
import {
  consumerRevisions,
  createProjectArguments,
  parseConsumerProofArguments,
} from "./lib/npm-consumer-revisions.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  revisions: requestedRevisions,
  packOnly,
  mode,
  candidate,
  outputArgument,
} = parseConsumerProofArguments(process.argv.slice(2));
const prepareOnly = mode === "prepare-only";
const generateOnly = mode === "generation-only";
const output = path.resolve(outputArgument ?? path.join(repositoryRoot, "build", "npm-consumer-proof.json"));
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

function assertPackageInventory(manifest, members) {
  const entries = new Set(members);
  const declaredFiles = [
    manifest.types,
    ...Object.values(manifest.bin ?? {}),
    ...Object.values(manifest.exports ?? {}),
  ];
  for (const declared of declaredFiles) {
    const target = typeof declared === "string" ? declared : (declared.import ?? declared.default);
    assert.ok(
      typeof target === "string" && !path.isAbsolute(target) && !target.startsWith("../"),
      `invalid package entry ${JSON.stringify(declared)}`,
    );
    assert.ok(entries.has(`package/${target.replace(/^\.\//u, "")}`), `npm tarball lacks declared entry ${target}`);
    if (typeof declared === "object" && declared.types) {
      assert.ok(
        entries.has(`package/${declared.types.slice(2)}`),
        `npm tarball lacks declared types ${declared.types}`,
      );
    }
  }
}

const root = await mkdtemp(path.join(tmpdir(), "deherm-npm-consumer-"));
try {
  const npmCache = path.join(root, "npm-cache");
  const toolCache = path.join(root, "deherm-cache");
  const consumer = path.join(root, "consumer");
  const environment = { ...process.env, DEHERM_CACHE_HOME: toolCache };
  const baselineRevision = /^DEFOLD_REV=([a-f0-9]{40})$/mu.exec(
    await readFile(path.join(repositoryRoot, "upstream.lock"), "utf8"),
  )?.[1];
  assert.ok(baselineRevision, "upstream.lock has no pinned Defold revision");
  const revisions = consumerRevisions(requestedRevisions, baselineRevision);
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  const sourceClean = run("git", ["status", "--porcelain"]).trim() === "";
  if (!packOnly) {
    assert.equal(sourceClean, true, "release-candidate proof requires a clean checkout");
  }

  if (!candidate) run("npm", ["pack", "--silent", "--pack-destination", root, "--cache", npmCache]);
  const archives = candidate
    ? [path.basename(candidate)]
    : (await readdir(root)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "npm pack must produce exactly one tarball");
  const archive = candidate ? path.resolve(candidate) : path.join(root, archives[0]);
  if (candidate) {
    const packed = JSON.parse(await readFile(output, "utf8"));
    assertRetainedNpmCandidate(packed, {
      archive,
      commit,
      digest: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
      repositoryRoot,
    });
  }
  const manifest = JSON.parse(run("tar", ["-xOzf", archive, "package/package.json"]));
  assert.equal(manifest.name, "@ts-defold/deherm");
  const archiveSha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const members = run("tar", ["-tzf", archive]).trim().split("\n");
  assertPackageInventory(manifest, members);
  for (const member of [
    "package/LICENSE",
    "package/README.md",
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

  const retainedArchive = candidate ?? path.join(path.dirname(output), "npm-release-candidate", archives[0]);
  await mkdir(path.dirname(retainedArchive), { recursive: true });
  try {
    const previousSha256 = createHash("sha256")
      .update(await readFile(retainedArchive))
      .digest("hex");
    if (!packOnly)
      assert.equal(previousSha256, archiveSha256, "repacked candidate differs from the archive tested by Snake");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!candidate) await copyFile(archive, retainedArchive);
  assert.equal(
    createHash("sha256")
      .update(await readFile(retainedArchive))
      .digest("hex"),
    archiveSha256,
    "retained candidate differs from tested npm tarball",
  );
  const report = {
    schemaVersion: 1,
    kind: "deherm.npm-clean-consumer-proof",
    package: manifest.name,
    version: manifest.version,
    commit,
    sourceClean,
    tarball: path.relative(repositoryRoot, retainedArchive),
    tarballBytes: (await stat(archive)).size,
    tarballSha256: archiveSha256,
    memberCount: members.length,
    defoldRevision: revisions.length === 1 ? revisions[0] : null,
    defoldRevisions: revisions,
    stages: ["packed", "inventory-verified", "archive-retained"],
    bundles: [],
    limitation: "Pack-only inventory check; no clean installation or Defold build was executed.",
  };
  if (!packOnly) {
    run("npm", ["install", "--prefix", consumer, archive, "--no-audit", "--no-fund", "--cache", npmCache]);
    const installed = await assertRealInstallation(path.join(consumer, "node_modules", "@ts-defold", "deherm"));
    const cli = path.join(installed, "bin", "deherm.mjs");
    assert.match(run(process.execPath, [cli, "--help"], { cwd: consumer, env: environment }), /\bbundle\s+Generate/u);
    const executableExports = Object.entries(manifest.exports)
      .filter(([, entry]) => (entry.import ?? entry.default)?.endsWith(".mjs"))
      .map(([name]) => `${manifest.name}${name === "." ? "" : name.slice(1)}`);
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await Promise.all(${JSON.stringify(executableExports)}.map((specifier) => import(specifier)));`,
      ],
      { cwd: consumer, env: environment },
    );

    const bundles = [];
    const projections = [];
    const revisionProofs = [];
    for (const revision of revisions) {
      const game = path.join(root, `game-${revision}`);
      const policyCache = path.join(root, `deherm-cache-${revision}`);
      const revisionEnvironment = { ...process.env, DEHERM_CACHE_HOME: policyCache };
      delete revisionEnvironment.DEHERM_DEFOLD_ENGINE_SHA1;
      await assert.rejects(stat(policyCache), (error) => error?.code === "ENOENT");

      const created = JSON.parse(
        run(process.execPath, [cli, ...createProjectArguments({ project: game, revision })], {
          cwd: consumer,
          env: revisionEnvironment,
        }),
      );
      assert.equal(created.projectRoot, game);
      assert.equal(created.defoldRevision, revision, "installed package scaffold selected a different revision");
      const lock = JSON.parse(await readFile(path.join(game, "deherm.lock"), "utf8"));
      assert.equal(lock.defoldRevision, revision, "generated project lock selected a different revision");
      assert.equal(
        lock.defoldSurface?.layer,
        "user-cache",
        "packed consumer did not materialize this revision into its isolated published-policy cache",
      );

      run("npm", ["install", "--prefix", game, archive, "--no-audit", "--no-fund", "--cache", npmCache]);
      const gamePackage = await assertRealInstallation(path.join(game, "node_modules", "@ts-defold", "deherm"));
      const gameCli = path.join(gamePackage, "bin", "deherm.mjs");
      const checked = JSON.parse(
        run(process.execPath, [gameCli, "typecheck", "--project", game, "--json"], {
          cwd: game,
          env: revisionEnvironment,
        }),
      );
      assert.equal(checked.passed, true, "tarball-installed project did not typecheck");
      const verified = JSON.parse(
        run(process.execPath, [gameCli, "verify-generated", "--project", game, "--json"], {
          cwd: game,
          env: revisionEnvironment,
        }),
      );
      assert.ok(verified.checkedFiles > 0, "generated SDK verification checked no files");

      const revisionBundles = [];
      const revisionProjections = [];
      if (prepareOnly || generateOnly) {
        // dev's JSON mode is an event stream, not one JSON document. Its exit
        // status proves compilation completed; verify-bundle checks the result.
        run(
          process.execPath,
          [gameCli, "dev", "--project", game, "--entry", "src/main.script.ts", "--once", "--no-launch", "--headless"],
          { cwd: game, env: revisionEnvironment },
        );
        const verifiedBundle = JSON.parse(
          run(process.execPath, [gameCli, "verify-bundle", "--project", game, "--json"], {
            cwd: game,
            env: revisionEnvironment,
          }),
        );
        assert.equal(verifiedBundle.ok, true, "installed package produced a stale or unbound pre-Bob bundle");
        if (prepareOnly) {
          for (const { target, representation } of targets) {
            const prepared = JSON.parse(
              run(
                process.execPath,
                [
                  gameCli,
                  "prepare-bob",
                  "--project",
                  game,
                  "--target",
                  target,
                  "--variant",
                  "release",
                  "--application-mode",
                  "dynamic",
                  "--json",
                ],
                { cwd: game, env: revisionEnvironment },
              ),
            );
            assert.equal(prepared.representation, representation);
            assert.equal(prepared.platform, target);
            if (representation === "hermes-bytecode") {
              assert.ok(prepared.compilation?.outputBytes > 0, `${target} produced no release Hermes bytecode`);
            }
            revisionProjections.push({ target, representation });
          }
        }
      } else {
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
              { cwd: game, env: revisionEnvironment },
            ),
          );
          assert.equal(built.target, target);
          assert.equal(built.representation, representation);
          assert.ok((await stat(built.bundleOutput)).isDirectory(), `${target} produced no bundle directory`);
          revisionBundles.push({ target, representation, bundleDirectory: path.basename(built.bundleOutput) });
        }
      }
      revisionProofs.push({
        defoldRevision: revision,
        lockDefoldRevision: lock.defoldRevision,
        surfaceLayer: lock.defoldSurface.layer,
        policyCacheInitiallyEmpty: true,
        bundles: revisionBundles,
        ...(prepareOnly ? { projections: revisionProjections } : {}),
      });
      bundles.push(...revisionBundles.map((bundle) => ({ defoldRevision: revision, ...bundle })));
      projections.push(...revisionProjections.map((projection) => ({ defoldRevision: revision, ...projection })));
    }

    assert.deepEqual(
      JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")).version,
      manifest.version,
    );
    Object.assign(report, {
      importedEsmExports: executableExports.length,
      stages: [
        "packed",
        "inventory-verified",
        "archive-retained",
        "installed-without-workspace-link",
        "esm-exports-imported",
        "policy-resolved",
        "generated",
        "typechecked",
        "verified",
        generateOnly ? "generated-and-bundle-verified" : prepareOnly ? "pre-bob-bundle-prepared" : "bob-bundled",
      ],
      revisionProofs,
      bundles,
      ...(prepareOnly ? { projections } : {}),
      limitation: prepareOnly
        ? "Locally compiled and projected; Bob, native link, and packaged-game runtime were not executed."
        : generateOnly
          ? "Published-policy generation, typecheck, and JS bundle were verified; native target preparation, Bob, native link, and packaged-game runtime were not executed."
          : "Build and native link only; no packaged-game runtime was executed.",
    });
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
