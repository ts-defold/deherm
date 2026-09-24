#!/usr/bin/env node
//
// The set gate over War Battles' runtime projections.
//
// The JSON files in `evidence/` are otherwise unrelated documents, and
// a projection nobody ran leaves no trace at all - its absence looks exactly
// like a projection that was never expected. This reads the declared set in
// `projections.mjs` instead, and for every declaration requires an evidence
// document that exists, parses, and carries that declaration's envelope
// unchanged. A projection whose file is missing is therefore a named failure.
//
// Nothing here runs an engine. It checks that the records the runtime gates
// wrote describe the projections they claim to, and that no two of them claim
// the same one; the observations inside each file were made by the gate that
// produced it, and this never promotes or re-interprets them.

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertProjectionEnvelope,
  projectionKey,
  WAR_BATTLES_PROJECTIONS,
} from "./projections.mjs";
import {
  assertWebTransportEvidence,
  buildWebTransportSourceInputs,
} from "./webtransport-evidence.mjs";
import {
  buildWarBattlesStaticHermesProjection,
  assertWarBattlesStaticHermesProjection,
} from "../../../scripts/generate-war-battles-static-hermes-projection.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");

export async function checkProjectionEvidence() {
  const rows = [];
  const failures = [];
  const seenKeys = new Map();
  for (const [id, declaration] of Object.entries(WAR_BATTLES_PROJECTIONS)) {
    const absolute = resolve(exampleRoot, declaration.evidence);
    const displayPath = relative(repositoryRoot, absolute).replaceAll("\\", "/");
    let document;
    try {
      document = JSON.parse(await readFile(absolute, "utf8"));
    } catch (error) {
      failures.push(
        error.code === "ENOENT"
          ? `projection '${id}' has no evidence: ${displayPath} is missing. Produce it with:\n    ${declaration.producer}`
          : `projection '${id}' evidence is unreadable (${displayPath}): ${error.message}`);
      continue;
    }
    try {
      assertProjectionEnvelope(id, document, { source: displayPath });
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    const key = projectionKey(id);
    const collision = seenKeys.get(key);
    if (collision) {
      failures.push(
        `projections '${collision}' and '${id}' select the same runtime, transport, reachable set ` +
        "and profile, so one of them is not a projection of its own");
      continue;
    }
    seenKeys.set(key, id);
    rows.push({
      id,
      evidence: displayPath,
      runtime: declaration.runtime,
      transport: [...declaration.transport],
      reachableSet: declaration.reachableSet,
      profile: declaration.profile,
      projectionKey: key,
    });
  }
  // The network projection has a stronger source/evidence contract than the
  // common envelope. Keep it in the ordinary projection gate so a stale real
  // browser observation cannot hide behind a valid-looking classification.
  try {
    const webtransportDeclaration = WAR_BATTLES_PROJECTIONS["browser-webtransport-loopback"];
    const webtransportEvidence = JSON.parse(await readFile(
      resolve(exampleRoot, webtransportDeclaration.evidence),
      "utf8",
    ));
    assertWebTransportEvidence(webtransportEvidence, {
      sourceInputs: await buildWebTransportSourceInputs(),
    });
  } catch (error) {
    failures.push(`browser-webtransport-loopback evidence is stale or malformed: ${error.message}`);
  }
  try {
    const staticDeclaration = WAR_BATTLES_PROJECTIONS["native-arm64-macos-static-hermes-reachable"];
    const staticEvidencePath = resolve(exampleRoot, staticDeclaration.evidence);
    const staticEvidenceText = await readFile(staticEvidencePath, "utf8");
    const staticEvidence = JSON.parse(staticEvidenceText);
    assertWarBattlesStaticHermesProjection(staticEvidence);
    const regenerated = await buildWarBattlesStaticHermesProjection();
    if (staticEvidenceText !== `${JSON.stringify(regenerated, null, 2)}\n`) {
      throw new Error("checked-in generated evidence differs from current release reachability and adapter inputs");
    }
  } catch (error) {
    failures.push(`native-arm64-macos-static-hermes-reachable evidence is stale or malformed: ${error.message}`);
  }
  if (failures.length) {
    throw new Error(`War Battles projection evidence is incomplete:\n  - ${failures.join("\n  - ")}`);
  }
  return rows;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const rows = await checkProjectionEvidence();
    console.log(`war-battles-projections:complete:${rows.length}`);
    for (const row of rows) {
      console.log(
        `  ${row.id}: runtime=${row.runtime} transport=${row.transport.join("+")} ` +
        `reachable=${row.reachableSet} profile=${row.profile} -> ${row.evidence}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
