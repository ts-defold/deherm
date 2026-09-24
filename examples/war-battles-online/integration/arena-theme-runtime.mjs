import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDefoldBuilder } from "../../../packages/cli/src/dev/defold-builder.mjs";
import { hostDefoldPlatform } from "../../../packages/cli/src/toolchains.mjs";

import { localDevLaunchConfiguration } from "./dev-launch-config.mjs";
import { runPackagedRuntimeEvidence } from "./packaged-runtime-evidence.mjs";

// Defold editor number properties are stored through a float representation.
// Keep this authored integration seed in the exact integer range; full-width
// protocol seeds remain uint32 values after they enter the TypeScript world.
export const REFINERY_THEME_SEED = 1;
export const REFINERY_THEME_MARKER = "INFO:DEFOLD_HERMES: war-battles:arena-theme:refinery:seed=1";

const ENGINE_PATHS = Object.freeze({
  "arm64-macos": ["arm64-osx", "dmengine"],
  "x86_64-macos": ["x86_64-osx", "dmengine"],
  "arm64-linux": ["arm64-linux", "dmengine"],
  "x86_64-linux": ["x86_64-linux", "dmengine"],
  "x86_64-win32": ["x86_64-win32", "dmengine.exe"],
});

/** Replace exactly one authored numeric property without touching its owner file permanently. */
export function setCollectionNumberProperty(source, propertyId, value) {
  if (typeof source !== "string") throw new TypeError("collection source must be text");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(propertyId)) throw new Error(`invalid collection property id: ${propertyId}`);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("collection property value must be a positive integer");
  const pattern = new RegExp(
    `(properties \\{\\n      id: "${propertyId}"\\n      value: ")[^"]+("\\n      type: PROPERTY_TYPE_NUMBER\\n    \\})`,
    "gu",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one numeric '${propertyId}' property, found ${matches.length}`);
  }
  return source.replace(pattern, `$1${value}.0$2`);
}

/**
 * Build and execute one non-default visual theme while restoring the authored
 * collection byte-for-byte. The dedicated Bob output is owned by this gate;
 * canonical build/default resources are never replaced with the temporary map.
 */
export async function runArenaThemeRuntimeGate({ projectRoot, environment = process.env, emit = () => {} }) {
  const collection = path.join(projectRoot, "main", "main.collection");
  const original = await readFile(collection, "utf8");
  const temporary = setCollectionNumberProperty(original, "mapSeed", REFINERY_THEME_SEED);
  const outputRoot = path.join(projectRoot, "build", "deherm-arena-theme-gate");
  const platform = hostDefoldPlatform();
  const engineParts = ENGINE_PATHS[platform];
  if (!engineParts) throw new Error(`arena-theme runtime gate does not support ${platform}`);
  const engine = path.join(projectRoot, "build", ...engineParts);
  const launch = localDevLaunchConfiguration(environment);
  let builder;
  try {
    await writeFile(collection, temporary);
    await rm(outputRoot, { recursive: true, force: true });
    builder = await createDefoldBuilder({
      projectRoot,
      platform,
      outputRoot,
      buildServer: launch.buildServer,
      env: launch.environment,
      emit,
    });
    await builder.build("arena refinery theme runtime gate");
    await builder.close();
    builder = undefined;
    if (process.platform !== "win32") {
      const mode = (await stat(engine)).mode;
      if ((mode & 0o111) === 0) await chmod(engine, mode | 0o755);
    }
    const result = await runPackagedRuntimeEvidence({
      command: engine,
      cwd: outputRoot,
      env: launch.environment,
      requiredMarkers: [
        "INFO:DEFOLD_HERMES: Loaded TypeScript bundle generation 1 from '/deherm/app.dehermc'",
        REFINERY_THEME_MARKER,
        "INFO:DEFOLD_HERMES: war-battles:arena-init:players=8:online=0",
      ],
      shutdownMarkers: ["INFO:DEFOLD_HERMES: war-battles:player-final"],
      timeoutMs: Number.parseInt(environment.DEHERM_WAR_BATTLES_THEME_TIMEOUT_MS ?? "90000", 10),
    });
    return { platform, outputRoot, ...result };
  } finally {
    await builder?.close().catch(() => {});
    await writeFile(collection, original);
    await rm(outputRoot, { recursive: true, force: true });
  }
}
