// A `shermes -emit-c` unit belongs to the Hermes runtime, and the build must
// make that true of what Bob uploads rather than hoping the link notices.
//
// These assertions are about the decision and its application: which runtime a
// Defold bundle target executes game code on, whether a typed-native unit may
// travel with it, and whether the project on disk matches that answer before
// Bob walks it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TYPED_NATIVE_EXTENSION,
  TYPED_NATIVE_IGNORE_ENTRY,
  TYPED_NATIVE_REFUSAL_CODE,
  defoldTargetRuntime,
  reconcileTypedNativeUpload,
  typedNativeDisposition
} from "../packages/cli/src/typed-native.mjs";

async function project({ materialised = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-typed-native."));
  if (materialised) await mkdir(path.join(root, TYPED_NATIVE_EXTENSION, "src"), { recursive: true });
  return root;
}

test("every web bundle target runs the browser runtime and every other one runs Hermes", async () => {
  for (const platform of ["wasm-web", "wasm_pthread-web"]) {
    assert.equal((await defoldTargetRuntime(platform)).runtimeId, "browser", platform);
  }
  // Bob names macOS differently from Extender; the mapping is the package's
  // own and must not change the answer.
  for (const platform of ["arm64-macos", "x86_64-macos", "arm64-ios", "arm64-android", "x86_64-linux", "x86_64-win32"]) {
    assert.equal((await defoldTargetRuntime(platform)).runtimeId, "hermes", platform);
  }
});

test("an unknown platform fails closed instead of guessing a runtime", async () => {
  await assert.rejects(() => defoldTargetRuntime("sparc-solaris"), /not a Defold bundle target/);
});

test("a browser-runtime target is refused with a machine-readable code", async () => {
  const disposition = await typedNativeDisposition("wasm-web");
  assert.equal(disposition.eligible, false);
  assert.equal(disposition.code, TYPED_NATIVE_REFUSAL_CODE);
  assert.match(disposition.reason, /embeds no Hermes/);
  const hermes = await typedNativeDisposition("arm64-macos");
  assert.equal(hermes.eligible, true);
  assert.equal(hermes.code, null);
});

test("a web build hides an already materialised unit and a Hermes build reveals it again", async () => {
  const root = await project();
  try {
    const defignore = path.join(root, ".defignore");

    const excluded = await reconcileTypedNativeUpload({ projectRoot: root, platform: "wasm-web" });
    assert.equal(excluded.ignored, true);
    assert.equal(excluded.changed, true);
    assert.equal((await readFile(defignore, "utf8")).trim(), TYPED_NATIVE_IGNORE_ENTRY);

    // Idempotent: a second web build changes nothing and says so.
    const again = await reconcileTypedNativeUpload({ projectRoot: root, platform: "wasm-web" });
    assert.equal(again.changed, false);
    assert.equal(again.ignored, true);

    const restored = await reconcileTypedNativeUpload({ projectRoot: root, platform: "arm64-macos" });
    assert.equal(restored.ignored, false);
    assert.equal(restored.changed, true);
    // The default state of a project is no file at all, not an empty one.
    await assert.rejects(() => readFile(defignore, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project with no materialised unit is left exactly as it was", async () => {
  // There is nothing to hide, so a web build must not invent a .defignore in a
  // project that never assembled a unit.
  const root = await project({ materialised: false });
  try {
    const result = await reconcileTypedNativeUpload({ projectRoot: root, platform: "wasm-web" });
    assert.equal(result.materialised, false);
    assert.equal(result.ignored, false);
    assert.equal(result.changed, false);
    await assert.rejects(() => readFile(path.join(root, ".defignore"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project's own .defignore entries survive both directions", async () => {
  const root = await project();
  try {
    const defignore = path.join(root, ".defignore");
    await writeFile(defignore, "/reference\n/notes\n");

    await reconcileTypedNativeUpload({ projectRoot: root, platform: "wasm-web" });
    const hidden = (await readFile(defignore, "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(hidden, ["/reference", "/notes", TYPED_NATIVE_IGNORE_ENTRY]);

    await reconcileTypedNativeUpload({ projectRoot: root, platform: "arm64-macos" });
    const revealed = (await readFile(defignore, "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(revealed, ["/reference", "/notes"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the materialised unit fails closed at compile time if it ever reaches an Emscripten toolchain", async () => {
  // The upload gate is .defignore; this is the backstop for anything that
  // bypasses it, and it must name the reason rather than produce a pile of
  // undefined _sh_* symbols at link time.
  const { renderRuntimeGuard } = await import("../scripts/assemble-typed-native-extension.mjs");
  const unit = path.join(
    path.dirname(new URL(import.meta.url).pathname), "..",
    "examples/war-battles-online/defold/defold_hermes_typed_native/src/deherm_typed_native_unit.cpp");
  assert.match(renderRuntimeGuard(), /typed-native-requires-hermes-runtime/);
  let source;
  try {
    source = await readFile(unit, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // A checkout without a materialised unit has nothing to assert about one.
    return;
  }
  assert.match(source, /#if defined\(__EMSCRIPTEN__\) \|\| defined\(DM_PLATFORM_HTML5\)/);
  assert.match(source, /#error "deherm typed-native-requires-hermes-runtime/);
});
