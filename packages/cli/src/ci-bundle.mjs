import { spawn as spawnProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { expectedBundleArtifact, recordBundleBuild, verifyProjectBuildArtifacts } from "./build-artifacts.mjs";
import { prepareBobBundleProjection } from "./bob-bundle-projection.mjs";
import { createIncrementalCompiler } from "./dev/compiler.mjs";
import { defaultDefoldBundleOutput, ensureBob, resolveJava } from "./dev/defold-builder.mjs";
import { entryTsconfig, resolveEntry } from "./dev/session.mjs";
import { normalizeResourcePaths } from "./dev/protocol.mjs";
import { ensureProjectNativeArtifact, resolveDefoldPlatform } from "./toolchains.mjs";
import { reconcileTypedNativeUpload } from "./typed-native.mjs";

async function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

export function validateBundleRequest(options) {
  if (!options.projectRoot) throw new Error("deherm bundle requires --project <game.project or directory>");
  if (typeof options.target !== "string" || !options.target) {
    throw new Error("deherm bundle requires --target <Defold target>");
  }
  if (!["debug", "release"].includes(options.variant)) {
    throw new Error("deherm bundle requires --variant debug|release");
  }
  if (!["dynamic", "static"].includes(options.applicationMode)) {
    throw new Error("deherm bundle requires --application-mode dynamic|static");
  }
  if (options.buildServer !== undefined) {
    const url = new URL(options.buildServer);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error("--build-server must be an HTTP(S) URL without embedded credentials");
    }
  }
}

export function planBobBundle({ projectRoot, bob, java, bobPlatform, variant, bundleOutput, buildServer, settings }) {
  const output = `build/deherm-ci-${bobPlatform}`;
  const args = [
    "-jar",
    bob,
    "--root",
    projectRoot,
    "--output",
    output,
    "--bundle-output",
    bundleOutput,
    "--platform",
    bobPlatform,
    "--architectures",
    bobPlatform,
    "--variant",
    variant,
    "--archive",
  ];
  if (buildServer) args.push("--build-server", buildServer);
  if (settings) args.push("--settings", settings);
  args.push("resolve", "build", "bundle");
  return { command: java, args, cwd: projectRoot };
}

export async function runBobProcess(plan, options = {}) {
  await new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawnProcess)(plan.command, plan.args, {
      cwd: plan.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data) => options.log?.(String(data)));
    child.stderr?.on("data", (data) => options.log?.(String(data)));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Bob bundle failed: java exited ${code ?? `with ${signal}`}`));
    });
  });
}

/** One target, one project, one Bob invocation. Every build input is refreshed first. */
export async function bundleProject(options, services = {}) {
  validateBundleRequest(options);
  const projectRoot = path.resolve(options.projectRoot);
  const log = services.log ?? ((message) => process.stderr.write(message));
  const resolved = await (services.resolvePlatform ?? resolveDefoldPlatform)(projectRoot, options.target);
  const bobPlatform = resolved.bobPlatform;
  const target = resolved.extenderTarget;
  if (options.applicationMode === "static") {
    throw new Error(
      "static-application-unavailable: déherm bundle cannot yet emit and register the authored Static Hermes application unit; use --application-mode dynamic",
    );
  }
  const expected = await (services.expectedBundle ?? expectedBundleArtifact)(projectRoot);
  if (!expected?.resource) throw new Error("game.project has no [defold_hermes] app resource");
  const [resource] = normalizeResourcePaths([expected.resource]);
  const entryPoint = await (services.resolveEntry ?? resolveEntry)(projectRoot, options.entry);
  if (!(await exists(entryPoint))) throw new Error(`No TypeScript entry exists at ${entryPoint}; pass --entry`);
  const tsconfig = await (services.entryTsconfig ?? entryTsconfig)(projectRoot, entryPoint);
  if (!(await exists(tsconfig))) throw new Error(`Missing generated bundle config ${tsconfig}; run deherm generate`);

  const outputFile = path.join(projectRoot, ".deherm", "build", "ci", "app.dehermc");
  const mirror = path.join(projectRoot, resource.slice(1));
  const compiler = await (services.createCompiler ?? createIncrementalCompiler)({
    entryPoint,
    preludeEntries: [path.join(projectRoot, ".deherm", "generated", "components", "registry.ts")],
    tsconfig,
    outputFile,
    mirrors: [mirror],
    resourcePath: resource,
    sourcemap: options.variant !== "release",
    bytecode: false,
    useTtsc: true,
  });
  let build;
  try {
    build = await compiler.rebuild();
  } finally {
    await compiler.dispose();
  }
  const recorded = await (services.recordBundle ?? recordBundleBuild)({ projectRoot, build });
  if (!recorded.record) throw new Error(`The TypeScript bundle was not recorded: ${recorded.reason}`);
  const verification = await (services.verifyBundle ?? verifyProjectBuildArtifacts)(projectRoot, {
    requireBinding: true,
    requireTransforms: true,
  });
  if (!verification.ok)
    throw new Error(`The TypeScript bundle failed the pre-Bob freshness gate: ${verification.status}`);

  await (services.ensureNativeArtifact ?? ensureProjectNativeArtifact)(projectRoot, target, {
    variant: options.variant,
  });
  await (services.reconcileTypedNative ?? reconcileTypedNativeUpload)({ projectRoot, platform: target });
  const projection = await (services.prepareProjection ?? prepareBobBundleProjection)({
    projectRoot,
    platform: target,
    variant: options.variant,
    applicationMode: options.applicationMode,
  });
  const lock = JSON.parse(await readFile(path.join(projectRoot, "deherm.lock"), "utf8"));
  const bob = await (services.ensureBob ?? ensureBob)(projectRoot, lock, {
    emit: ({ message }) => log(`${message}\n`),
  });
  const bundleOutput = path.join(
    defaultDefoldBundleOutput(projectRoot),
    `ci-${target}-${options.variant}-${options.applicationMode}`,
  );
  const plan = planBobBundle({
    projectRoot,
    bob,
    java: services.java ?? (await (services.resolveJava ?? resolveJava)()),
    bobPlatform,
    variant: options.variant,
    bundleOutput,
    buildServer: options.buildServer,
    settings: projection.settings,
  });
  await (services.runBob ?? runBobProcess)(plan, { log });
  return {
    schemaVersion: 1,
    projectRoot,
    target: options.target,
    bobPlatform,
    variant: options.variant,
    applicationMode: options.applicationMode,
    bundleOutput,
    representation: projection.representation,
  };
}
