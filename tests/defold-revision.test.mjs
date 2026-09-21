import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  DefoldRevisionError,
  assertResolvedDefoldRevision,
  defoldResolutionRecord,
  normalizeDefoldRevision,
  resolveDefoldRevision
} from "../packages/cli/src/defold-revision.mjs";
import {
  buildGenerationMerkle,
  defoldSurfaceCacheHome,
  defoldSurfaceSearchPath,
  resolveDefoldSurface
} from "../packages/cli/src/defold-surface.mjs";
import { inspectDefoldProject } from "../packages/cli/src/project.mjs";
import { writeGeneratedProject } from "../packages/cli/src/generate.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const bundled = JSON.parse(
  await readFile(path.join(packageRoot, "packages", "bindings", "generated", "defold-script-api-ir.json"), "utf8")
).defoldRevision;
const otherRevision = "0123456789abcdef0123456789abcdef01234567";

async function project(gameProject = "[project]\ntitle = Revision fixture\n") {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-revision-"));
  await writeFile(path.join(root, "game.project"), gameProject);
  return root;
}

const emptyEnv = {};

test("a project that names no Defold revision is refused rather than assumed", async () => {
  const root = await project();
  const resolution = await resolveDefoldRevision({ projectRoot: root, env: emptyEnv });
  assert.equal(resolution.revision, null);
  assert.equal(resolution.blocker.code, "defold-revision-unresolved");
  // The refusal has to say what it looked at, or the user has no next move.
  assert.match(resolution.blocker.message, /--defold-sdk/);
  assert.match(resolution.blocker.message, /\[defold_hermes\] defold_sdk/);
  assert.match(resolution.blocker.message, /build\.zip|Extender build log/);
  // And it must never name the revision this package happens to ship.
  assert.doesNotMatch(resolution.blocker.message, new RegExp(bundled));
  assert.throws(() => assertResolvedDefoldRevision(resolution), DefoldRevisionError);
});

test("an explicit --defold-sdk always wins and is recorded as the source", async () => {
  const root = await project(`[project]\ntitle = Fixture\n[defold_hermes]\ndefold_sdk = ${bundled}\n`);
  const resolution = await resolveDefoldRevision({ projectRoot: root, explicit: otherRevision.toUpperCase(), env: emptyEnv });
  assert.equal(resolution.blocker, null);
  assert.equal(resolution.revision, otherRevision);
  assert.equal(resolution.source, "explicit-option");
  assert.deepEqual(defoldResolutionRecord(resolution), {
    schemaVersion: 1,
    revision: otherRevision,
    source: "explicit-option",
    authority: "live",
    evidence: { option: "--defold-sdk" }
  });
  // What it overrode is reported rather than hidden.
  assert.equal(resolution.diagnostics.length, 1);
  assert.match(resolution.diagnostics[0].message, /was overridden/);
});

test("game.project declares the revision and the editor hook overrides it", async () => {
  const root = await project(`[project]\ntitle = Fixture\n[defold_hermes]\ndefold_sdk = ${bundled}\n`);
  const declared = await resolveDefoldRevision({ projectRoot: root, env: emptyEnv });
  assert.equal(declared.revision, bundled);
  assert.equal(declared.source, "game-project");

  // Two live/declared sources that disagree are a contradiction, not a
  // precedence win: one of them is describing a different engine.
  const conflicted = await resolveDefoldRevision({
    projectRoot: root,
    env: { DEHERM_DEFOLD_ENGINE_SHA1: otherRevision }
  });
  assert.equal(conflicted.revision, null);
  assert.equal(conflicted.blocker.code, "defold-revision-conflict");
  assert.match(conflicted.blocker.message, new RegExp(bundled));
  assert.match(conflicted.blocker.message, new RegExp(otherRevision));
});

test("a malformed declared revision is rejected at the point it is read", async () => {
  const root = await project("[project]\ntitle = Fixture\n[defold_hermes]\ndefold_sdk = 1.10.4\n");
  await assert.rejects(resolveDefoldRevision({ projectRoot: root, env: emptyEnv }), /40-character Defold engine SHA/);
});

test("a dependency URL pinning a Defold engine archive is read as a declaration", async () => {
  const root = await project([
    "[project]",
    "title = Fixture",
    `dependencies#0 = https://github.com/defold/defold/archive/${otherRevision}.zip`,
    "dependencies#1 = https://github.com/selimanac/defold-astar/archive/1471c5445b0c0376bd23c377e8ef8d84e52b43bf.zip",
    ""
  ].join("\n"));
  const resolution = await resolveDefoldRevision({ projectRoot: root, env: emptyEnv });
  assert.equal(resolution.revision, otherRevision);
  assert.equal(resolution.source, "dependency-url");
  // A third-party extension archive pinned by its own 40-hex revision is not an
  // engine revision and must not be read as one.
  assert.equal(resolution.observations.length, 1);
});

test("an Extender build log witnesses the engine the project actually compiled against", async () => {
  const root = await project();
  await mkdir(path.join(root, ".internal", "cache", "arm64-osx"), { recursive: true });
  await writeFile(path.join(root, ".internal", "cache", "arm64-osx", "build.zip"), zipSync({
    "log.txt": strToU8(`clang++ -I/var/extender/sdk/${otherRevision}/defoldsdk//sdk/include upload/x.cpp\n`)
  }));
  const resolution = await resolveDefoldRevision({ projectRoot: root, env: emptyEnv });
  assert.equal(resolution.revision, otherRevision);
  assert.equal(resolution.source, "extender-build");
  assert.equal(resolution.selected.evidence.archive, ".internal/cache/arm64-osx/build.zip");
});

test("Bob is asked for its own engine sha1 when the project names none", async () => {
  const root = await project();
  await writeFile(path.join(root, "bob.jar"), "not really a jar");
  const calls = [];
  const resolution = await resolveDefoldRevision({
    projectRoot: root,
    env: emptyEnv,
    runBobVersion: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, message: "", stdout: `bob.jar version: 1.11.0  sha1: ${otherRevision}\n`, stderr: "" };
    }
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 1), ["-jar"]);
  assert.deepEqual(calls[0].args.slice(2), ["--version"]);
  assert.equal(resolution.revision, otherRevision);
  assert.equal(resolution.source, "bob-version");
});

test("a lock is evidence only when it records how it decided", async () => {
  const root = await project();
  await writeFile(path.join(root, "deherm.lock"), `${JSON.stringify({
    schemaVersion: 1,
    defoldRevision: bundled
  }, null, 2)}\n`);
  // A lock written before revisions were resolved carries whatever the package
  // shipped. Trusting it would re-introduce the silent assumption.
  const ignored = await resolveDefoldRevision({ projectRoot: root, env: emptyEnv });
  assert.equal(ignored.revision, null);
  assert.equal(ignored.blocker.code, "defold-revision-unresolved");

  await writeFile(path.join(root, "deherm.lock"), `${JSON.stringify({
    schemaVersion: 1,
    defoldRevision: bundled,
    defoldResolution: { schemaVersion: 1, revision: bundled, source: "bob-version", authority: "live", evidence: {} }
  }, null, 2)}\n`);
  const accepted = await resolveDefoldRevision({ projectRoot: root, env: emptyEnv });
  assert.equal(accepted.revision, bundled);
  assert.equal(accepted.source, "deherm-lock");
  // Re-recording it must name the witness the lock named, not the lock, or the
  // next run rejects its own record and re-derives from scratch every time.
  assert.deepEqual(defoldResolutionRecord(accepted), {
    schemaVersion: 1,
    revision: bundled,
    source: "bob-version",
    authority: "live",
    evidence: {},
    via: "deherm-lock"
  });

  // A live source outranks the lock and the stale record is reported, not
  // silently dropped.
  const upgraded = await resolveDefoldRevision({
    projectRoot: root,
    env: { DEHERM_DEFOLD_ENGINE_SHA1: otherRevision }
  });
  assert.equal(upgraded.revision, otherRevision);
  assert.equal(upgraded.source, "editor-hook");
  assert.equal(upgraded.diagnostics.length, 1);
  assert.match(upgraded.diagnostics[0].message, /out of date/);
});

test("no layer-0 surface exists for an unknown revision and generation refuses to substitute one", async () => {
  const root = await project();
  const surface = await resolveDefoldSurface(otherRevision, {
    packageRoot,
    projectRoot: root,
    env: { DEHERM_CACHE_HOME: path.join(root, "cache") }
  });
  assert.equal(surface.layer, null);
  assert.equal(surface.blocker.code, "defold-surface-not-cached");
  assert.match(surface.blocker.message, new RegExp(otherRevision));
  assert.match(surface.blocker.message, /deherm policy/);
  assert.match(surface.blocker.message, /No Defold source checkout/);
  assert.deepEqual(surface.searched.map(({ layer }) => layer), ["user-cache", "project-cache", "repository-checkout"]);
  assert.equal(surface.searched[2].reason, `holds Defold ${bundled}`);

  const bundledSurface = await resolveDefoldSurface(bundled, { packageRoot, projectRoot: root });
  assert.equal(bundledSurface.layer, "repository-checkout");
  assert.equal(bundledSurface.blocker, null);
});

test("the surface search path prefers caches and uses a repository checkout only for dogfooding", () => {
  const layers = defoldSurfaceSearchPath(bundled, {
    packageRoot: "/pkg",
    projectRoot: "/proj",
    env: { DEHERM_CACHE_HOME: "/cache" }
  });
  assert.deepEqual(layers.map(({ layer }) => layer), ["user-cache", "project-cache", "repository-checkout"]);
  assert.equal(layers[0].root, path.join("/cache", "surfaces", bundled));
  assert.equal(layers[1].root, path.join("/proj", ".deherm", "cache", "surfaces", bundled));
  assert.equal(layers[2].root, "/pkg");
});

test("the shared surface cache follows host conventions with explicit overrides first", () => {
  assert.equal(defoldSurfaceCacheHome({ DEHERM_CACHE_HOME: "/explicit" }, "darwin", "/Users/test"), "/explicit");
  assert.equal(defoldSurfaceCacheHome({ XDG_CACHE_HOME: "/xdg" }, "darwin", "/Users/test"), "/xdg/deherm");
  assert.equal(defoldSurfaceCacheHome({}, "darwin", "/Users/test"), "/Users/test/Library/Caches/deherm");
  assert.equal(defoldSurfaceCacheHome({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "win32", "C:\\Users\\test"), path.join(path.resolve("C:\\Users\\test\\AppData\\Local"), "deherm"));
  assert.equal(defoldSurfaceCacheHome({}, "linux", "/home/test"), "/home/test/.cache/deherm");
});

test("the generation Merkle root keys the Defold revision and the native input set independently", () => {
  const extensions = [
    { name: "Camera", manifestPath: "camera/ext.manifest", root: "camera", scriptApis: [{ path: "camera/camera.script_api", declarations: [{ name: "camera" }] }], publicHeaders: ["camera/include/camera.h"], sourceFiles: [] },
    { name: "XMath", manifestPath: "math.zip:math/ext.manifest", archive: ".internal/lib/math.zip", scriptApis: [], publicHeaders: [], sourceFiles: ["math.zip:math/src/xmath.cpp"] }
  ];
  const base = buildGenerationMerkle({ defoldRevision: bundled, surface: { layer: "packaged", inputs: { a: "1" } }, extensions });

  const engineMoved = buildGenerationMerkle({ defoldRevision: otherRevision, surface: { layer: "user-cache", inputs: { a: "2" } }, extensions });
  assert.notEqual(engineMoved.engineRoot, base.engineRoot);
  assert.equal(engineMoved.nativeRoot, base.nativeRoot, "an engine upgrade must not invalidate extension policies");
  assert.notEqual(engineMoved.root, base.root);

  const nativeMoved = buildGenerationMerkle({
    defoldRevision: bundled,
    surface: { layer: "packaged", inputs: { a: "1" } },
    extensions: [...extensions, { name: "New", manifestPath: "new/ext.manifest", root: "new", scriptApis: [], publicHeaders: [], sourceFiles: [] }]
  });
  assert.equal(nativeMoved.engineRoot, base.engineRoot, "adding an extension must not invalidate the engine surface");
  assert.notEqual(nativeMoved.nativeRoot, base.nativeRoot);
  // Localised invalidation: the untouched extensions keep their own digests, so
  // a root mismatch resolves down to the leaf that moved.
  assert.deepEqual(
    nativeMoved.nodes.native.children.filter(({ name }) => name !== "New").map(({ digest }) => digest),
    base.nodes.native.children.map(({ digest }) => digest)
  );
  // Ordering is by content and structure, never by discovery order.
  const reordered = buildGenerationMerkle({ defoldRevision: bundled, surface: { layer: "packaged", inputs: { a: "1" } }, extensions: [...extensions].reverse() });
  assert.equal(reordered.root, base.root);
});

test("generation refuses a project whose revision cannot be resolved, and records it when it can", async () => {
  const unresolved = await project("[project]\ntitle = Unresolved\n");
  await assert.rejects(
    writeGeneratedProject(await inspectDefoldProject({ project: unresolved }), ".deherm", { env: emptyEnv }),
    (error) => error.code === "defold-revision-unresolved"
  );

  const mismatched = await project(`[project]\ntitle = Mismatched\n[defold_hermes]\ndefold_sdk = ${otherRevision}\n`);
  await assert.rejects(
    writeGeneratedProject(await inspectDefoldProject({ project: mismatched }), ".deherm", {
      env: { ...emptyEnv, DEHERM_OFFLINE: "1" }
    }),
    (error) => error.code === "defold-surface-not-cached" && new RegExp(otherRevision).test(error.message)
  );

  const resolved = await project(`[project]\ntitle = Resolved\n[defold_hermes]\ndefold_sdk = ${bundled}\n`);
  const output = await writeGeneratedProject(await inspectDefoldProject({ project: resolved }), ".deherm", { env: emptyEnv });
  assert.equal(output.defoldRevision, bundled);
  assert.equal(output.defoldResolution.source, "game-project");
  assert.equal(output.defoldSurfaceLayer, "repository-checkout");
  const manifest = JSON.parse(await readFile(path.join(output.root, "manifest.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(resolved, "deherm.lock"), "utf8"));
  assert.deepEqual(lock.defoldResolution, manifest.defoldResolution);
  assert.deepEqual(lock.generationMerkle, manifest.generationMerkle);
  assert.equal(manifest.generationMerkle.engineRoot.length, 64);
  assert.notEqual(manifest.generationMerkle.engineRoot, manifest.generationMerkle.nativeRoot);

  // The recorded resolution makes the next generation cheap without making it
  // an assumption: the lock now says how it was decided.
  const reused = await resolveDefoldRevision({ projectRoot: resolved, env: emptyEnv });
  assert.equal(reused.revision, bundled);
});

test("normalizeDefoldRevision accepts only a 40-character SHA", () => {
  assert.equal(normalizeDefoldRevision(`  ${bundled.toUpperCase()}  `, "x"), bundled);
  assert.throws(() => normalizeDefoldRevision("", "x"), /40-character/);
  assert.throws(() => normalizeDefoldRevision("1.10.4", "x"), /40-character/);
  assert.throws(() => normalizeDefoldRevision(undefined, "x"), /40-character/);
});
