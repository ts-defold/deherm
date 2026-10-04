import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  projectStaticHermesTypedNativeBridgeFacts,
  renderTypescript,
} from "../packages/compiler/src/static-hermes-typed-native-bridge-output-emitter.mjs";

const report = JSON.parse(
  await readFile(new URL("../packages/bindings/generated/defold-typed-native-bridge.json", import.meta.url), "utf8"),
);
const sourcePath = "../packages/static-hermes/src/generated/script-typed-native-bridge.ts";
const selection = { claimed: report.claimedRoutes, maximumArgumentCount: report.maximumArgumentCount };
const facts = projectStaticHermesTypedNativeBridgeFacts(selection);

test("typed-native bridge recipe facts are the compact selected ID table", () => {
  assert.deepEqual(facts, {
    schemaVersion: 1,
    claimedStableIds: report.claimedRoutes.map(({ stableId }) => stableId),
    maximumArgumentCount: report.maximumArgumentCount,
  });
  assert.deepEqual(projectStaticHermesTypedNativeBridgeFacts(report), facts);
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) < Buffer.byteLength(JSON.stringify(report)));
});

test("typed-native generator persists only compact recipe facts for policy consumption", async () => {
  const persisted = await readFile(
    new URL("../packages/bindings/generated/defold-typed-native-bridge-recipe-facts.json", import.meta.url),
    "utf8",
  );
  assert.deepEqual(JSON.parse(persisted), facts);
  assert.ok(Buffer.byteLength(persisted) < Buffer.byteLength(JSON.stringify(report)));
});

test("typed-native emitter preserves checked-in bridge bytes and report digest", async () => {
  const rendered = renderTypescript(facts);
  const checkedIn = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  assert.equal(rendered, checkedIn);
  assert.equal(createHash("sha256").update(rendered).digest("hex"), report.generatedSha256.typescript);
});

test("typed-native recipe facts reject unsorted or invalid route identities", () => {
  assert.throws(
    () =>
      projectStaticHermesTypedNativeBridgeFacts({
        claimed: [{ stableId: 2 }, { stableId: 1 }],
        maximumArgumentCount: 0,
      }),
    /unique and sorted/u,
  );
  assert.throws(
    () => renderTypescript({ schemaVersion: 1, claimedStableIds: [0x1_0000_0000], maximumArgumentCount: 0 }),
    /invalid stable ID/u,
  );
});
