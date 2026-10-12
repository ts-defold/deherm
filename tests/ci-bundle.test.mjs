import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bundleProject, planBobBundle, validateBundleRequest } from "../packages/cli/src/ci-bundle.mjs";
import { parseArguments } from "../packages/cli/src/cli.mjs";
import { resolveJava } from "../packages/cli/src/dev/defold-builder.mjs";

test("Java autodetection skips an executable but unusable launcher", async () => {
  const attempted = [];
  const resolved = await resolveJava({
    env: {},
    candidates: ["java-launcher", "real-jdk"],
    probe: (candidate) => {
      attempted.push(candidate);
      return { status: candidate === "real-jdk" ? 0 : 1 };
    },
  });
  assert.equal(resolved, "real-jdk");
  assert.deepEqual(attempted, ["java-launcher", "real-jdk"]);
});

test("bundle CLI takes one exact target and explicit mode", () => {
  const parsed = parseArguments([
    "bundle",
    "--project",
    "game.project",
    "--target",
    "arm64-macos",
    "--variant",
    "release",
    "--application-mode",
    "static",
    "--build-server",
    "http://127.0.0.1:9010",
    "--json",
  ]);
  assert.equal(parsed.command, "bundle");
  assert.equal(parsed.target, "arm64-macos");
  assert.equal(parsed.variant, "release");
  assert.equal(parsed.applicationMode, "static");
  assert.equal(parsed.buildServer, "http://127.0.0.1:9010");
  assert.equal(parsed.json, true);
  assert.throws(
    () => validateBundleRequest({ projectRoot: "/x", target: "wasm-web", variant: "release" }),
    /application-mode/,
  );
  assert.throws(
    () =>
      validateBundleRequest({
        projectRoot: "/x",
        target: "wasm-web",
        variant: "release",
        applicationMode: "dynamic",
        buildServer: "https://user:pass@example.test",
      }),
    /embedded credentials/,
  );
});

test("Bob plan preserves the target, omits absent build server, and includes release settings", () => {
  const base = {
    projectRoot: "/game",
    bob: "/cache/bob.jar",
    java: "java",
    bobPlatform: "arm64-osx",
    variant: "release",
    bundleOutput: "/game/build/bundle",
  };
  const normal = planBobBundle(base);
  assert.equal(normal.args.includes("--build-server"), false);
  assert.deepEqual(normal.args.slice(-3), ["resolve", "build", "bundle"]);
  assert.deepEqual(normal.args.slice(normal.args.indexOf("--platform"), normal.args.indexOf("--platform") + 2), [
    "--platform",
    "arm64-osx",
  ]);
  const privateBuild = planBobBundle({
    ...base,
    buildServer: "http://127.0.0.1:9010",
    settings: "/game/.deherm/bob-release.settings",
  });
  assert.deepEqual(
    privateBuild.args.slice(
      privateBuild.args.indexOf("--build-server"),
      privateBuild.args.indexOf("--build-server") + 2,
    ),
    ["--build-server", "http://127.0.0.1:9010"],
  );
  assert.deepEqual(
    privateBuild.args.slice(privateBuild.args.indexOf("--settings"), privateBuild.args.indexOf("--settings") + 2),
    ["--settings", "/game/.deherm/bob-release.settings"],
  );
});

test("one-shot bundle orders compilation, freshness, target projection, and Bob; reports absolute output", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "deherm-ci-bundle-"));
  try {
    await mkdir(path.join(projectRoot, "src"));
    await writeFile(path.join(projectRoot, "src/main.ts"), "export {};\n");
    await writeFile(path.join(projectRoot, "tsconfig.deherm.bundle.json"), "{}\n");
    await writeFile(path.join(projectRoot, "deherm.lock"), "{}\n");
    const calls = [];
    const result = await bundleProject(
      { projectRoot, target: "arm64-osx", variant: "release", applicationMode: "dynamic" },
      {
        resolvePlatform: async () => ({ bobPlatform: "arm64-osx", extenderTarget: "arm64-macos" }),
        expectedBundle: async () => ({ resource: "/deherm/app.dehermc" }),
        createCompiler: async (options) => ({
          rebuild: async () => {
            calls.push("compile");
            assert.equal(options.resourcePath, "/deherm/app.dehermc");
            return {
              outputFile: options.outputFile,
              mirrors: options.mirrors,
              fingerprint: "a".repeat(64),
              sources: [],
              configuration: { resourcePath: options.resourcePath },
            };
          },
          dispose: async () => {
            calls.push("dispose");
          },
        }),
        recordBundle: async () => {
          calls.push("record");
          return { record: {} };
        },
        verifyBundle: async () => {
          calls.push("verify");
          return { ok: true };
        },
        ensureNativeArtifact: async (_root, target, options) => {
          calls.push("artifact");
          assert.equal(target, "arm64-macos");
          assert.equal(options.variant, "release");
        },
        reconcileTypedNative: async () => {
          calls.push("reconcile");
        },
        prepareProjection: async () => {
          calls.push("project");
          return { representation: "hermes-bytecode", settings: "/game/settings" };
        },
        ensureBob: async () => {
          calls.push("bob-cache");
          return "/cache/bob.jar";
        },
        resolveJava: async () => "java",
        runBob: async (plan) => {
          calls.push("bob-run");
          assert.equal(plan.args.includes("--build-server"), false);
        },
      },
    );
    assert.deepEqual(calls, [
      "compile",
      "dispose",
      "record",
      "verify",
      "artifact",
      "reconcile",
      "project",
      "bob-cache",
      "bob-run",
    ]);
    assert.equal(path.isAbsolute(result.bundleOutput), true);
    assert.equal(result.bundleOutput.startsWith(`${projectRoot}${path.sep}`), false);
    assert.match(result.bundleOutput, /ci-arm64-macos-release-dynamic$/);
    assert.equal(result.bobPlatform, "arm64-osx");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("static mode refuses before claiming a bundle because the authored app unit is not emitted", async () => {
  await assert.rejects(
    bundleProject(
      { projectRoot: "/unused", target: "arm64-macos", variant: "release", applicationMode: "static" },
      { resolvePlatform: async () => ({ bobPlatform: "arm64-osx", extenderTarget: "arm64-macos" }) },
    ),
    /static-application-unavailable/,
  );
});
