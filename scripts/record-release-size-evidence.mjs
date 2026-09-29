#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repositoryRoot, "docs/site/evidence/release-sizes.json");
const nativeRoot = path.join(repositoryRoot, "build/bundle/War Battles.app");
const webRoot = path.join(repositoryRoot, "build/bundle/War Battles");
const bobJar = path.join(repositoryRoot, "build/tooling/bob.jar");
const args = new Set(process.argv.slice(2));

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function filesBelow(root, relative = "") {
  const rows = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) rows.push(...await filesBelow(root, child));
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(root, child));
      rows.push({ path: child.split(path.sep).join("/"), bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function jarMember(member) {
  const { stdout } = await execFileAsync("unzip", ["-p", bobJar, member], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  return { path: member, bytes: stdout.length, sha256: digest(stdout) };
}

function sum(rows) {
  return rows.reduce((total, row) => total + row.bytes, 0);
}

async function record() {
  const nativeFiles = await filesBelow(nativeRoot);
  const webFiles = await filesBelow(webRoot);
  const nativeEngine = nativeFiles.find((row) => row.path === "Contents/MacOS/WarBattles");
  const webWasm = webFiles.find((row) => row.path === "WarBattles.wasm");
  const webJavaScript = webFiles.find((row) => row.path === "WarBattles_wasm.js");
  if (nativeEngine === undefined || webWasm === undefined || webJavaScript === undefined) throw new Error("release bundle outputs are incomplete");
  const [stockNative, stockWasm, stockWebJavaScript] = await Promise.all([
    jarMember("libexec/arm64-macos/dmengine_release"),
    jarMember("libexec/wasm-web/dmengine_release.wasm"),
    jarMember("libexec/wasm-web/dmengine_release.js")
  ]);
  const applicationBytecode = await readFile(path.join(repositoryRoot, "examples/war-battles-online/defold/build/bob/deherm/app.release.dehermc"));
  const document = {
    schemaVersion: 1,
    kind: "deherm.release-size-evidence",
    observedOn: new Date().toISOString(),
    build: {
      variant: "release",
      nativeCommand: "DEFOLD_HERMES_PROJECT=examples/war-battles-online/defold DEFOLD_HERMES_VARIANT=release pnpm bob:bundle",
      webCommand: "DEFOLD_HERMES_PROJECT=examples/war-battles-online/defold DEFOLD_HERMES_VARIANT=release pnpm bob:web:bundle",
      bobJarSha256: digest(await readFile(bobJar))
    },
    nativeArm64Macos: {
      packageLogicalBytes: sum(nativeFiles),
      engineBytes: nativeEngine.bytes,
      stockDefoldEngineBytes: stockNative.bytes,
      engineOverheadBytes: nativeEngine.bytes - stockNative.bytes,
      applicationBytecodeBytes: applicationBytecode.length,
      applicationBytecodeSha256: digest(applicationBytecode),
      files: nativeFiles,
      baseline: stockNative
    },
    browserWasmWeb: {
      packageLogicalBytes: sum(webFiles),
      engineWasmBytes: webWasm.bytes,
      engineJavaScriptBytes: webJavaScript.bytes,
      stockDefoldEngineWasmBytes: stockWasm.bytes,
      stockDefoldEngineJavaScriptBytes: stockWebJavaScript.bytes,
      engineShellOverheadBytes: webWasm.bytes + webJavaScript.bytes - stockWasm.bytes - stockWebJavaScript.bytes,
      embedsHermes: false,
      files: webFiles,
      baseline: { wasm: stockWasm, javaScript: stockWebJavaScript }
    },
    evidenceBoundary: "Logical file-byte totals from fresh Bob release bundles. Native overhead compares the linked arm64-macOS executable to Bob's stock dmengine_release from the same pinned Bob jar. Browser overhead compares the Wasm and JavaScript engine shell to stock wasm-web release members; HTML5 embeds no Hermes. Signing, compression by a store/CDN, filesystem allocation, and platform packaging outside these bundle directories are excluded."
  };
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`recorded ${path.relative(repositoryRoot, output)}`);
}

async function check() {
  const document = JSON.parse(await readFile(output, "utf8"));
  if (document.schemaVersion !== 1 || document.kind !== "deherm.release-size-evidence") throw new Error("invalid release-size evidence");
  if (document.build?.variant !== "release") throw new Error("size evidence is not from release bundles");
  for (const value of [document.nativeArm64Macos?.packageLogicalBytes, document.nativeArm64Macos?.engineOverheadBytes, document.browserWasmWeb?.packageLogicalBytes, document.browserWasmWeb?.engineShellOverheadBytes]) {
    if (!(value > 0)) throw new Error("release-size evidence contains an invalid size");
  }
  if (document.browserWasmWeb?.embedsHermes !== false) throw new Error("browser size evidence must keep the no-Hermes boundary explicit");
  console.log("release-size evidence is structurally current");
}

if (args.has("--record")) await record();
else if (args.has("--check")) await check();
else throw new Error("Usage: record-release-size-evidence.mjs {--record|--check}");
