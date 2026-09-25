#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import {
  buildVisualEvidence,
  buildArenaPropertyProjection,
  hashFile,
  refreshVisualEvidenceSourceContract,
  sha256,
  verifyVisualEvidence,
  VISUAL_EVIDENCE_SOURCE_PATHS,
} from "./vscode-visual-evidence.mjs";

const execFileAsync = promisify(execFile);

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const evidencePath = path.join(exampleRoot, "evidence/vscode-live-values.json");
const screenshotPath = path.join(exampleRoot, "evidence/vscode-live-values.png");
const screenshotRelative = path.relative(repositoryRoot, screenshotPath).replaceAll(path.sep, "/");
const inspectorSessionPath = path.join(exampleRoot, "defold/.deherm/dev/inspector.json");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (
    value === "--record-evidence" ||
    value === "--check-evidence" ||
    value === "--check-sources" ||
    value === "--refresh-source-contract"
  ) {
    options.set(value, true);
  } else if (
    ["--cdp", "--package-tarball", "--vsix", "--previous-evidence-ref", "--previous-arena-ref"].includes(value)
  ) {
    options.set(value, process.argv[++index]);
  } else {
    throw new Error(`Unknown argument: ${value}`);
  }
}

const modes = ["--record-evidence", "--check-evidence", "--check-sources", "--refresh-source-contract"].filter((mode) =>
  options.has(mode),
);
if (modes.length !== 1) throw new Error("Choose exactly one VS Code visual evidence mode");

if (options.has("--refresh-source-contract")) {
  const previousEvidenceRef = options.get("--previous-evidence-ref");
  const previousArenaRef = options.get("--previous-arena-ref");
  if (!previousEvidenceRef || !previousArenaRef) {
    throw new Error("Source-contract refresh requires --previous-evidence-ref and --previous-arena-ref");
  }
  const relativeEvidencePath = path.relative(repositoryRoot, evidencePath).replaceAll(path.sep, "/");
  const [{ stdout: previousEvidence }, { stdout: previousArenaSource }] = await Promise.all([
    execFileAsync("git", ["show", `${previousEvidenceRef}:${relativeEvidencePath}`], { cwd: repositoryRoot }),
    execFileAsync("git", ["show", `${previousArenaRef}:examples/war-battles-online/defold/main/arena.script.ts`], {
      cwd: repositoryRoot,
    }),
  ]);
  const document = JSON.parse(previousEvidence);
  const refreshed = await refreshVisualEvidenceSourceContract(document, repositoryRoot, { previousArenaSource });
  await writeFile(evidencePath, `${JSON.stringify(refreshed, null, 2)}\n`);
  console.log(`war-battles-vscode-visual-evidence:source-contract-refreshed:${refreshed.evidenceKey}`);
  process.exit(0);
}

if (options.has("--check-evidence") || options.has("--check-sources")) {
  const document = JSON.parse(await readFile(evidencePath, "utf8"));
  await verifyVisualEvidence(document, repositoryRoot);
  console.log(`war-battles-vscode-visual-evidence:fresh:${document.evidenceKey}`);
  process.exit(0);
}

const cdp = options.get("--cdp") ?? "http://127.0.0.1:9333";
const inspectorSession = JSON.parse(await readFile(inspectorSessionPath, "utf8"));
const stateResponse = await fetch(inspectorSession.stateUrl, {
  headers: { Authorization: `Bearer ${inspectorSession.authToken}` },
});
if (!stateResponse.ok) throw new Error(`Editor state endpoint returned ${stateResponse.status}`);
const state = await stateResponse.json();

const targetsResponse = await fetch(`${cdp.replace(/\/$/, "")}/json/list`);
if (!targetsResponse.ok) throw new Error(`VS Code CDP discovery returned ${targetsResponse.status}`);
const page = (await targetsResponse.json()).find((target) => target.type === "page");
if (!page?.webSocketDebuggerUrl) throw new Error("VS Code page target is unavailable");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
let nextId = 1;
const pending = new Map();
socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const rendered = await call("Runtime.evaluate", {
  expression: "({text: document.body.innerText, title: document.title, userAgent: navigator.userAgent})",
  returnByValue: true,
});
const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
socket.close();
const screenshotBytes = Buffer.from(screenshot.data, "base64");

const sourceInputs = await Promise.all(
  VISUAL_EVIDENCE_SOURCE_PATHS.map((relativePath) => hashFile(repositoryRoot, relativePath)),
);
const observedArtifact = async (supplied, fallback) => {
  const candidate = supplied ?? fallback;
  if (!candidate) return null;
  const absolute = path.resolve(repositoryRoot, candidate);
  try {
    await access(absolute);
  } catch {
    throw new Error(`Observed artifact does not exist: ${absolute}`);
  }
  const bytes = await readFile(absolute);
  const relative = path.relative(repositoryRoot, absolute);
  const label =
    relative.startsWith("..") || path.isAbsolute(relative)
      ? path.basename(absolute)
      : relative.replaceAll(path.sep, "/");
  return { path: label, bytes: bytes.length, sha256: sha256(bytes) };
};
const document = buildVisualEvidence({
  screenshot: { path: screenshotRelative, bytes: screenshotBytes },
  renderedText: rendered.result.value.text,
  state,
  sourceInputs,
  vscode: rendered.result.value,
  packageArtifact: await observedArtifact(options.get("--package-tarball")),
  vsixArtifact: await observedArtifact(options.get("--vsix"), "editors/vscode/dist/deherm.vsix"),
  arenaPropertyProjection: await buildArenaPropertyProjection(repositoryRoot),
});
await writeFile(screenshotPath, screenshotBytes);
await writeFile(evidencePath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`war-battles-vscode-visual-evidence:recorded:${document.evidenceKey}`);
