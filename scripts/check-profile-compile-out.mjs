// Proves that DEHERM_PROFILE compiles out entirely.
//
// The claim under test is not "the macros look empty". It is that with the
// switch off, no telemetry symbol, no telemetry storage, and no telemetry
// string reaches the linked binary. So this builds the same target twice from
// the same sources and reads the two artifacts with `nm` and `strings`.
//
// The ON build is checked for the *presence* of every marker the OFF build must
// not contain. A proof that cannot fail proves nothing; if the instrumentation
// were accidentally removed from the generators, the ON assertions would fail
// first and the OFF assertions would pass vacuously.

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");

export const benchmarkTarget = "defold-hermes-transport-profile-benchmark";

/// Markers that must be absent from a binary built with DEHERM_PROFILE off and
/// present in one built with it on.
export const telemetrySymbolMarkers = Object.freeze([
  // The producer ring and its span type.
  "defold_hermes::profile::append(",
  "defold_hermes::profile::drain(",
  "defold_hermes::profile::ring()",
  "defold_hermes::profile::nowNanoseconds()",
  // Generated identity resolvers, one per instrumented transport.
  "defold_hermes::script_handle_lowering::profileContractShape(",
  "defold_hermes::script_handle_lowering::profileRouteName(",
  "_deherm_dmsdk_borrowed_profile_name",
  "_deherm_script_universal_profile_name"
]);

export const telemetryStringMarkers = Object.freeze([
  "deherm.lua-stack.",
  "deherm.c-abi-native.",
  "deherm.typed-native."
]);

/// Generated sources whose instrumentation must sit behind the compile switch.
export const instrumentedGeneratedSources = Object.freeze([
  "defold/defold_hermes/src/generated_script_handle_lowering.cpp",
  "defold/defold_hermes/src/generated_dmsdk_borrowed_handle_runtime.cpp",
  "defold/defold_hermes/src/generated_script_universal_value_capi.cpp"
]);

function run(command, argv, options = {}) {
  return execFileSync(command, argv, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options
  });
}

export function configureAndBuild(buildDirectory, { profile }) {
  run("cmake", [
    "-S", ".",
    "-B", buildDirectory,
    "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DDEHERM_CANONICAL_RELEASE_DIR=",
    `-DDEHERM_PROFILE=${profile ? "ON" : "OFF"}`
  ], { stdio: "pipe" });
  run("cmake", ["--build", buildDirectory, "--target", benchmarkTarget, "--parallel"], { stdio: "pipe" });
  return resolve(repositoryRoot, buildDirectory, benchmarkTarget);
}

export function inspect(binaryPath) {
  return {
    // -C demangles, so the C++ markers above are the readable names.
    symbols: run("nm", ["-C", "-a", binaryPath]),
    strings: run("strings", ["-a", binaryPath])
  };
}

function contains(haystack, needle) {
  return haystack.includes(needle);
}

/// Returns a machine-readable report. Throws on the first violated claim.
export async function checkProfileCompileOut({
  offBinary,
  onBinary,
  sources = true
} = {}) {
  const findings = { absentFromOffBuild: [], presentInOnBuild: [], guardedGeneratedSources: [] };

  if (sources) {
    for (const path of instrumentedGeneratedSources) {
      const text = await readFile(resolve(repositoryRoot, path), "utf8");
      const scopes = text.split("DEHERM_PROFILE_TRANSPORT_SCOPE(").length - 1;
      if (scopes < 1) throw new Error(`${path} has no generated transport scope`);
      // Every telemetry identity table must sit inside a compile-switch block.
      const guardOpens = text.split("#if DEHERM_PROFILE_ENABLED").length - 1;
      if (guardOpens < 1) throw new Error(`${path} emits telemetry identity outside a compile switch`);
      for (const table of ["kRouteProfileNames", "kProfileNames"]) {
        if (!text.includes(table)) continue;
        const tableOffset = text.indexOf(`${table}[] = {`);
        const guardOffset = text.lastIndexOf("#if DEHERM_PROFILE_ENABLED", tableOffset);
        const endifOffset = text.lastIndexOf("#endif", tableOffset);
        if (guardOffset < 0 || endifOffset > guardOffset) {
          throw new Error(`${path} defines ${table} outside a DEHERM_PROFILE_ENABLED block`);
        }
      }
      findings.guardedGeneratedSources.push({ path, scopes, guardOpens });
    }
  }

  if (onBinary) {
    const on = inspect(onBinary);
    for (const marker of telemetrySymbolMarkers) {
      if (!contains(on.symbols, marker)) {
        throw new Error(`DEHERM_PROFILE=ON build is missing telemetry symbol ${marker}; the compile-out proof would be vacuous`);
      }
      findings.presentInOnBuild.push(marker);
    }
    for (const marker of telemetryStringMarkers) {
      if (!contains(on.strings, marker)) {
        throw new Error(`DEHERM_PROFILE=ON build is missing telemetry string ${marker}; the compile-out proof would be vacuous`);
      }
      findings.presentInOnBuild.push(marker);
    }
  }

  if (offBinary) {
    const off = inspect(offBinary);
    for (const marker of telemetrySymbolMarkers) {
      if (contains(off.symbols, marker)) {
        throw new Error(`DEHERM_PROFILE=OFF build retained telemetry symbol ${marker}`);
      }
      findings.absentFromOffBuild.push(marker);
    }
    for (const marker of telemetryStringMarkers) {
      if (contains(off.strings, marker)) {
        throw new Error(`DEHERM_PROFILE=OFF build retained telemetry string ${marker}`);
      }
      findings.absentFromOffBuild.push(marker);
    }
  }

  if (offBinary && onBinary) {
    const offSize = (await stat(offBinary)).size;
    const onSize = (await stat(onBinary)).size;
    if (!(offSize < onSize)) {
      throw new Error(`DEHERM_PROFILE=OFF build is not smaller than the ON build: ${offSize} vs ${onSize}`);
    }
    findings.offBytes = offSize;
    findings.onBytes = onSize;
  }

  return findings;
}

export async function run_(argv = process.argv.slice(2)) {
  const offDirectory = argv.includes("--reuse") ? "build/native" : "build/profile-off";
  const onDirectory = argv.includes("--reuse") ? "build/profile" : "build/profile-on";
  const offBinary = configureAndBuild(offDirectory, { profile: false });
  const onBinary = configureAndBuild(onDirectory, { profile: true });
  const findings = await checkProfileCompileOut({ offBinary, onBinary });
  process.stdout.write(
    `DEHERM_PROFILE compile-out verified: ${findings.absentFromOffBuild.length} markers absent with the switch off, ` +
    `${findings.presentInOnBuild.length} present with it on; ${findings.offBytes} vs ${findings.onBytes} bytes.\n`);
  return findings;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run_().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
