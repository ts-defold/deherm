#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function assertIdentityFields({ sourceSha, runId }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha ?? "")) throw new Error("Policy surface source SHA must be a full Git commit");
  if (!/^[1-9][0-9]*$/u.test(String(runId ?? ""))) throw new Error("Policy surface run ID must be positive");
}

export async function createPolicySurfaceIdentity({ archive, sourceSha, runId }) {
  assertIdentityFields({ sourceSha, runId });
  return {
    schemaVersion: 1,
    kind: "deherm.policy-surface-identity",
    sourceSha,
    runId: String(runId),
    archiveSha256: await sha256(archive),
  };
}

export async function verifyPolicySurfaceIdentity({ archive, identity, sourceSha, runId }) {
  assertIdentityFields({ sourceSha, runId });
  if (
    identity?.schemaVersion !== 1 ||
    identity.kind !== "deherm.policy-surface-identity" ||
    !/^[a-f0-9]{64}$/u.test(identity.archiveSha256 ?? "")
  ) {
    throw new Error("Policy surface identity is malformed");
  }
  if (identity.sourceSha !== sourceSha || identity.runId !== String(runId)) {
    throw new Error(`Policy surface belongs to ${identity.sourceSha}/${identity.runId}, not ${sourceSha}/${runId}`);
  }
  const actual = await sha256(archive);
  if (actual !== identity.archiveSha256) {
    throw new Error(`Policy surface archive digest mismatch: expected ${identity.archiveSha256}, got ${actual}`);
  }
  return identity;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "create" && command !== "verify") throw new Error("Expected create or verify");
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || !["--archive", "--identity", "--source-sha", "--run-id"].includes(flag)) {
      throw new Error(`Invalid policy surface identity argument: ${flag ?? "<missing>"}`);
    }
    options[flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const required of ["archive", "identity", "sourceSha", "runId"]) {
    if (!options[required])
      throw new Error(
        `Policy surface identity requires --${required.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
      );
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.command === "create") {
    const identity = await createPolicySurfaceIdentity(options);
    await writeFile(options.identity, `${JSON.stringify(identity, null, 2)}\n`);
  } else {
    const identity = JSON.parse(await readFile(options.identity, "utf8"));
    await verifyPolicySurfaceIdentity({ ...options, identity });
  }
  console.log(`policy-surface-identity:${options.command}:passed`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
