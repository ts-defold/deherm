import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

import {
  applyBundleFingerprint,
  bundleFingerprintBanner,
  createBundleFingerprintPlaceholder
} from "../packages/compiler/src/bundle-fingerprint.mjs";
import {
  BUILD_ARTIFACT_SCHEMA,
  buildArtifactRecord,
  checkBuildArtifacts,
  formatBuildArtifactReport,
  inspectBundleFingerprint,
  sourceBindingDigest
} from "../packages/compiler/src/bundle-freshness.mjs";
import { createIncrementalCompiler } from "../packages/cli/src/dev/compiler.mjs";
import {
  readProjectLock,
  recordBuildArtifact,
  recordBundleBuild,
  verifyProjectBuildArtifacts
} from "../packages/cli/src/build-artifacts.mjs";

async function bundleProject() {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-freshness-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "game.project"), [
    "[project]",
    "custom_resources = /deherm",
    "[defold_hermes]",
    "app = /deherm/app.dehermc",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "deherm.lock"), `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`);
  await writeFile(path.join(root, "src", "constants.ts"), "export const MUZZLE = 384;\n");
  await writeFile(
    path.join(root, "src", "main.ts"),
    'import { MUZZLE } from "./constants.js";\nglobalThis.muzzle = MUZZLE;\n'
  );
  return root;
}

async function buildAndRecord(root) {
  const compiler = await createIncrementalCompiler({
    entryPoint: path.join(root, "src", "main.ts"),
    outputFile: path.join(root, ".deherm", "dev", "app.dehermc"),
    mirrors: [path.join(root, "deherm", "app.dehermc")],
    resourcePath: "/deherm/app.dehermc",
    useTtsc: false,
    sourcemap: false,
    captureDiagnostics: false
  });
  try {
    const build = await compiler.rebuild([]);
    const recorded = await recordBundleBuild({ projectRoot: root, build });
    return { build, recorded };
  } finally {
    await compiler.dispose();
  }
}

test("a bundle's published fingerprint is recoverable from the bundle itself", () => {
  const placeholder = createBundleFingerprintPlaceholder();
  const program = `${bundleFingerprintBanner(placeholder)}\nconsole.log(1);\n`;
  const { fingerprint, source } = applyBundleFingerprint(program, placeholder);
  const inspected = inspectBundleFingerprint(source);
  assert.equal(inspected.declared, fingerprint);
  assert.equal(inspected.computed, fingerprint);
  assert.equal(inspected.consistent, true);
  // An artifact edited after it was built is a different fault from a stale
  // one, and must not be reported as merely out of date.
  const edited = inspectBundleFingerprint(`${source}// appended\n`);
  assert.equal(edited.declared, fingerprint);
  assert.notEqual(edited.computed, fingerprint);
  assert.equal(edited.consistent, false);
  assert.equal(inspectBundleFingerprint("var x = 1;").reason, "no-fingerprint");
});

test("a strict bundle publishes its fingerprint through browser-style indirect eval", () => {
  const placeholder = createBundleFingerprintPlaceholder();
  const { fingerprint, source } = applyBundleFingerprint(
    `${bundleFingerprintBanner(placeholder)}\nglobalThis.loaded = true;\n`,
    placeholder
  );
  const context = createContext({ candidate: source });
  runInContext("(0, eval)(candidate)", context);
  assert.equal(context.__DEFOLD_HERMES_BUILD_FINGERPRINT__, fingerprint);
  assert.equal(context.loaded, true);
});

test("the source binding covers build settings as well as file contents", () => {
  const files = { "src/main.ts": "a".repeat(64) };
  const base = sourceBindingDigest({ build: { entryPoint: "src/main.ts", target: "es2020" }, files });
  assert.notEqual(base, sourceBindingDigest({ build: { entryPoint: "src/main.ts", target: "es2015" }, files }));
  assert.notEqual(base, sourceBindingDigest({ build: { entryPoint: "src/other.ts", target: "es2020" }, files }));
  assert.equal(base, sourceBindingDigest({ build: { entryPoint: "src/main.ts", target: "es2020" }, files }));
  assert.throws(() => sourceBindingDigest({ build: null, files: { "src/main.ts": "nope" } }), /must be a SHA-256/);
});

test("a recorded bundle goes stale when its sources change and fresh again when rebuilt", async (t) => {
  const root = await bundleProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await buildAndRecord(root);
  assert.equal(first.recorded.written, true);
  assert.equal(first.recorded.record.kind, "bundle");
  assert.equal(first.recorded.record.fingerprint, first.build.fingerprint);

  const lock = await readProjectLock(root);
  assert.equal(lock.buildArtifacts.schema, BUILD_ARTIFACT_SCHEMA);
  assert.ok(lock.buildArtifacts.artifacts["deherm/app.dehermc"].sources.files["src/constants.ts"]);
  // Regenerating the lock's other sections must not discard the binding, and
  // recording an unchanged build must not churn the file.
  assert.equal((await buildAndRecord(root)).recorded.written, false);

  const fresh = await verifyProjectBuildArtifacts(root);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.entries[0].status, "fresh");

  await writeFile(path.join(root, "src", "constants.ts"), "export const MUZZLE = 512;\n");
  const stale = await verifyProjectBuildArtifacts(root);
  assert.equal(stale.ok, false);
  assert.equal(stale.entries[0].status, "stale-sources");
  assert.deepEqual(stale.entries[0].sources.changed, ["src/constants.ts"]);
  assert.equal(stale.entries[0].fingerprint.recorded, first.build.fingerprint);
  assert.equal(stale.entries[0].fingerprint.onDisk, first.build.fingerprint);
  // The diagnostic exists to name both sides; a report that omits either one
  // leaves the reader where the black screen did.
  const report = formatBuildArtifactReport(stale).join("\n");
  assert.match(report, /expected fingerprint \(deherm\.lock\)/);
  assert.match(report, /fingerprint on disk/);
  assert.match(report, new RegExp(first.build.fingerprint));
  assert.match(report, /src\/constants\.ts/);

  const second = await buildAndRecord(root);
  assert.notEqual(second.build.fingerprint, first.build.fingerprint);
  const rebuilt = await verifyProjectBuildArtifacts(root);
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.entries[0].fingerprint.onDisk, second.build.fingerprint);
});

test("an artifact that disagrees with its record or its own fingerprint is named", async (t) => {
  const root = await bundleProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { build } = await buildAndRecord(root);
  const bundle = path.join(root, "deherm", "app.dehermc");
  const original = await readFile(bundle, "utf8");

  await writeFile(bundle, `${original}// appended after the build\n`);
  const corrupt = await verifyProjectBuildArtifacts(root);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.entries[0].status, "artifact-corrupt");
  assert.equal(corrupt.entries[0].fingerprint.onDisk, build.fingerprint);
  assert.notEqual(corrupt.entries[0].fingerprint.recomputed, build.fingerprint);

  // A bundle someone rebuilt without recording it is self-consistent but is not
  // the artifact the lock describes.
  const placeholder = createBundleFingerprintPlaceholder();
  const other = applyBundleFingerprint(`${bundleFingerprintBanner(placeholder)}\nconsole.log(2);\n`, placeholder);
  await writeFile(bundle, other.source);
  const replaced = await verifyProjectBuildArtifacts(root);
  assert.equal(replaced.ok, false);
  assert.equal(replaced.entries[0].status, "artifact-replaced");
  assert.equal(replaced.entries[0].fingerprint.recorded, build.fingerprint);
  assert.equal(replaced.entries[0].fingerprint.onDisk, other.fingerprint);

  await rm(bundle);
  const missing = await verifyProjectBuildArtifacts(root);
  assert.equal(missing.ok, false);
  assert.equal(missing.entries[0].status, "artifact-missing");
});

test("an unrecorded or absent bundle is a report by default and a blocker before Bob", async (t) => {
  const root = await bundleProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Nothing has been built: Bob would archive nothing for the declared resource.
  const absent = await verifyProjectBuildArtifacts(root);
  assert.equal(absent.entries[0].status, "artifact-absent");
  assert.equal(absent.ok, true);
  assert.equal((await verifyProjectBuildArtifacts(root, { requireBinding: true })).ok, false);

  await buildAndRecord(root);
  const lock = await readProjectLock(root);
  delete lock.buildArtifacts;
  await writeFile(path.join(root, "deherm.lock"), `${JSON.stringify(lock, null, 2)}\n`);
  const unbound = await verifyProjectBuildArtifacts(root);
  assert.equal(unbound.entries[0].status, "unbound");
  assert.equal(unbound.ok, true);
  assert.equal(unbound.status, "unverified");
  const gated = await verifyProjectBuildArtifacts(root, { requireBinding: true });
  assert.equal(gated.ok, false);
  assert.match(formatBuildArtifactReport(gated).join("\n"), /binds it to no sources/);
});

test("generated extension sources bind to their inputs the way a bundle does", async (t) => {
  // The assembler that writes `shermes -emit-c` output into the extension does
  // not exist yet. The freshness relation it will need is the same one, and is
  // recorded and checked through the same lock section.
  const root = await bundleProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = path.join(root, "defold_hermes", "src", "generated_app.c");
  await mkdir(path.dirname(generated), { recursive: true });
  await writeFile(generated, "/* emitted from src/main.ts */\nint deherm_app(void) { return 0; }\n");
  const recorded = await recordBuildArtifact({
    projectRoot: root,
    kind: "generated-sources",
    artifacts: [generated],
    sources: [path.join(root, "src", "main.ts"), path.join(root, "src", "constants.ts")],
    build: { emitter: "shermes -typed -emit-c", reachableRoutes: 1 }
  });
  assert.equal(recorded.record.kind, "generated-sources");
  assert.equal(recorded.record.sources.fileCount, 2);

  const fresh = await checkBuildArtifacts({ projectRoot: root, lock: await readProjectLock(root) });
  assert.equal(fresh.entries[0].status, "fresh");

  await writeFile(path.join(root, "src", "constants.ts"), "export const MUZZLE = 512;\n");
  const stale = await checkBuildArtifacts({ projectRoot: root, lock: await readProjectLock(root) });
  assert.equal(stale.entries[0].status, "stale-sources");
  assert.equal(stale.ok, false);

  assert.throws(() => buildArtifactRecord({ kind: "mystery", artifacts: { "a.c": "0".repeat(64) } }), /Unknown build artifact kind/);
  assert.throws(
    () => buildArtifactRecord({ kind: "bundle", artifacts: { "a.js": "0".repeat(64) } }),
    /requires its published fingerprint/
  );
});

test("a toolchain the artifact was not built with is reported without failing", async (t) => {
  const root = await bundleProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await buildAndRecord(root);
  const lock = await readProjectLock(root);
  const result = await checkBuildArtifacts({
    projectRoot: root,
    lock,
    toolchain: { esbuild: "0.0.0-not-the-recorded-one" }
  });
  assert.equal(result.entries[0].status, "toolchain-drift");
  assert.equal(result.ok, true);
  assert.match(formatBuildArtifactReport(result).join("\n"), /different toolchain/);
});
