#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { postResourceReload } from "../packages/cli/src/dev/protocol.mjs";
import { startResourceServer } from "../packages/cli/src/dev/resource-server.mjs";
import {
  createRejectedCandidate,
  createValidCandidate,
  rejectedCandidateMarker
} from "./lib/native-hot-reload-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(root, "defold", "build", "bob");
const bundleFile = path.join(buildRoot, "deherm", "app.dehermc");
const executable = path.join(root, "build", "bundle", "Defold Hermes Spike.app", "Contents", "MacOS", "DefoldHermesSpike");
const resources = path.join(root, "build", "bundle", "Defold Hermes Spike.app", "Contents", "Resources");
const timeoutMs = Number.parseInt(process.env.DEHERM_HOT_RELOAD_TIMEOUT_MS ?? "15000", 10);

if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error("DEHERM_HOT_RELOAD_TIMEOUT_MS must be a positive integer");
}

const original = await readFile(bundleFile);
const source = original.toString("utf8");
const rejectedCandidate = createRejectedCandidate(source);
const validCandidate = createValidCandidate(source);

let temporarySequence = 0;
async function publish(contents) {
  const temporary = `${bundleFile}.hot-reload-${process.pid}-${temporarySequence += 1}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, bundleFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function reserveServicePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") {
    socket.close();
    throw new Error("Unable to allocate an isolated Defold engine-service port");
  }
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function waitUntil(transcript, description, predicate, timeout, child) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (predicate(transcript.text)) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - startedAt >= timeout) {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for ${description}:\n${transcript.text}`));
      } else if (child.exitCode !== null) {
        clearInterval(poll);
        reject(new Error(`Defold exited before ${description}:\n${transcript.text}`));
      }
    }, 25);
  });
}

function waitFor(transcript, marker, timeout, child, offset = 0) {
  return waitUntil(
      transcript,
      JSON.stringify(marker),
      (text) => text.indexOf(marker, offset) !== -1,
      timeout,
      child);
}

const servicePort = await reserveServicePort();
const engineServiceUrl = `http://127.0.0.1:${servicePort}`;
const server = await startResourceServer({ root: buildRoot });
const child = spawn(executable, [`--config=resource.uri=${server.baseUrl}`], {
  cwd: resources,
  env: { ...process.env, DM_SERVICE_PORT: String(servicePort) },
  stdio: ["ignore", "pipe", "pipe"]
});
const transcript = { text: "" };
const append = (chunk) => { transcript.text += chunk.toString("utf8").replaceAll("\r", ""); };
child.stdout.on("data", append);
child.stderr.on("data", append);

try {
  await waitFor(transcript, "INFO:DEFOLD_HERMES: lifecycle:update:1", timeoutMs, child);

  const rejectedOffset = transcript.text.length;
  await publish(rejectedCandidate);
  await postResourceReload(engineServiceUrl, ["/deherm/app.dehermc"], { timeoutMs: 2_000 });
  const rejectedGeneration = "TypeScript bundle generation 2 was rejected:";
  await waitFor(transcript, rejectedGeneration, timeoutMs, child, rejectedOffset);
  await waitFor(transcript, rejectedCandidateMarker, timeoutMs, child, rejectedOffset);
  const retainedGeneration = "TypeScript bundle generation 1 remained active after rejecting generation 2";
  await waitFor(transcript, retainedGeneration, timeoutMs, child, rejectedOffset);
  const rejectedWindow = transcript.text.slice(rejectedOffset);
  if (rejectedWindow.includes("INFO:DEFOLD_HERMES: final:ok")) {
    throw new Error(`Rejected candidate finalized the active generation:\n${rejectedWindow}`);
  }
  if (rejectedWindow.includes("Activated TypeScript bundle generation 2")) {
    throw new Error(`Rejected candidate was reported as active:\n${rejectedWindow}`);
  }

  const validOffset = transcript.text.length;
  await publish(validCandidate);
  await postResourceReload(engineServiceUrl, ["/deherm/app.dehermc"], { timeoutMs: 2_000 });
  await waitFor(transcript, "INFO:DEFOLD_HERMES: module:84", timeoutMs, child, validOffset);
  await waitFor(
      transcript,
      "INFO:DEFOLD_HERMES: Activated TypeScript bundle generation 3 from '/deherm/app.dehermc'",
      timeoutMs,
      child,
      validOffset);
  await waitFor(transcript, "INFO:DEFOLD_HERMES: lifecycle:update:1", timeoutMs, child, validOffset);
  const validWindow = transcript.text.slice(validOffset);
  if (!validWindow.includes("INFO:DEFOLD_HERMES: final:ok")) {
    throw new Error(`Successful activation did not finalize generation 1:\n${validWindow}`);
  }

  console.log("native-defold-hot-reload:transaction-ok");
  console.log("INFO:DEFOLD_HERMES: lifecycle:update:1");
  console.log(`ERROR:DEFOLD_HERMES: ${rejectedGeneration} ${rejectedCandidateMarker}`);
  console.log(`INFO:DEFOLD_HERMES: ${retainedGeneration}`);
  console.log("INFO:DEFOLD_HERMES: module:84");
  console.log("INFO:DEFOLD_HERMES: Activated TypeScript bundle generation 3 from '/deherm/app.dehermc'");
} finally {
  await publish(original);
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000))
  ]);
  await server.close();
}
