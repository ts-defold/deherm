import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { repositoryRoot } from "../scripts/package-defold-webtransport.mjs";

const matrixPath = path.join(
  repositoryRoot,
  "extensions/defold-webtransport/defold_webtransport/webtransport/public-api-compatibility.json"
);

async function loadMatrix() {
  return JSON.parse(await readFile(matrixPath, "utf8"));
}

test("public compatibility matrix has one explicit disposition per surface", async () => {
  const matrix = await loadMatrix();
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.contractVersion, "0.1.0");
  assert.equal(matrix.authority.w3c.status, "Candidate Recommendation Snapshot");
  assert.equal(matrix.authority.w3c.published, "2026-07-30");
  assert.equal(matrix.authority.deno.version, "2.9.7");

  const ids = matrix.families.map((family) => family.id);
  assert.equal(new Set(ids).size, ids.length, "surface family ids must be unique");
  const seen = new Map();
  for (const family of matrix.families) {
    for (const disposition of ["requiredNow", "compatibilityRequired", "forwardCompatible"]) {
      for (const surface of family[disposition] ?? []) {
        assert.equal(typeof surface, "string");
        assert.ok(surface.length > 0);
        assert.equal(seen.has(surface), false, `${surface} has more than one public disposition`);
        seen.set(surface, `${family.id}:${disposition}`);
      }
    }
  }

  for (const internalName of ["poll", "sendReliable", "trySendDatagram", "maxDatagramBytes", "provider", "handle"]) {
    assert.equal(
      [...seen.keys()].some((surface) => surface === internalName || surface.startsWith(`${internalName}(`)),
      false,
      `${internalName} is an internal bridge concept, not public WebTransport shape`
    );
  }
});

test("0.1 core remains the exact War Battles browser and Deno interoperability waist", async () => {
  const matrix = await loadMatrix();
  const required = new Set(matrix.families.flatMap((family) => [
    ...(family.requiredNow ?? []),
    ...(family.compatibilityRequired ?? [])
  ]));
  const expected = [
    "constructor(url, options?)",
    "ready",
    "closed",
    "close(closeInfo?)",
    "WebTransportCloseInfo.closeCode",
    "WebTransportCloseInfo.reason",
    "datagrams.readable",
    "datagrams.writable",
    "datagrams.maxDatagramSize",
    "createUnidirectionalStream(options?)",
    "incomingUnidirectionalStreams",
    "WebTransportSendStream",
    "WebTransportReceiveStream",
    "createBidirectionalStream(options?)",
    "incomingBidirectionalStreams",
    "WebTransportBidirectionalStream.readable",
    "WebTransportBidirectionalStream.writable",
    "WebTransportOptions.serverCertificateHashes",
    "WebTransportHash.algorithm",
    "WebTransportHash.value",
    "WebTransportOptions.anticipatedConcurrentIncomingUnidirectionalStreams",
    "WebTransportOptions.anticipatedConcurrentIncomingBidirectionalStreams"
  ];
  assert.deepEqual([...required].sort(), expected.sort());
  assert.deepEqual(matrix.warBattlesExercise.symbols, [
    "ready",
    "closed",
    "close",
    "datagrams.readable",
    "datagrams.writable",
    "datagrams.maxDatagramSize",
    "createUnidirectionalStream",
    "incomingUnidirectionalStreams",
    "createBidirectionalStream",
    "incomingBidirectionalStreams",
    "serverCertificateHashes",
    "anticipatedConcurrentIncomingUnidirectionalStreams",
    "anticipatedConcurrentIncomingBidirectionalStreams"
  ]);
});

test("War Battles adapter and packaged runtime evidence still back every claimed exercised surface", async () => {
  const matrix = await loadMatrix();
  const adapter = await readFile(path.join(repositoryRoot, matrix.warBattlesExercise.source), "utf8");
  for (const symbol of matrix.warBattlesExercise.symbols) {
    const leaf = symbol.split(".").at(-1);
    assert.match(adapter, new RegExp(`\\b${leaf}\\b`, "u"), `${symbol} is no longer present in the exercised adapter`);
  }

  const evidence = JSON.parse(await readFile(path.join(repositoryRoot, matrix.authority.runtimeEvidence), "utf8"));
  assert.match(evidence.runtime.deno, /^deno 2\.9\.7\b/u);
  assert.match(evidence.runtime.chrome, /^Google Chrome 154\./u);
  assert.equal(evidence.transport.protocol, "webtransport-h3");
  assert.equal(evidence.transport.reliableStreams, true);
  assert.equal(evidence.transport.datagrams, true);
  assert.ok(evidence.transport.maxDatagramBytes > 0);
});

test("CR datagram factory and legacy writable compatibility cannot silently replace each other", async () => {
  const matrix = await loadMatrix();
  const datagrams = matrix.families.find((family) => family.id === "datagrams");
  assert.deepEqual(datagrams.compatibilityRequired, ["datagrams.writable"]);
  assert.ok(datagrams.forwardCompatible.includes("datagrams.createWritable(options?)"));
});
