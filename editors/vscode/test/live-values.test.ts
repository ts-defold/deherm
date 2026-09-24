import assert from "node:assert/strict";
import test from "node:test";

import {
  findPropertyDeclarationAnchors,
  formatSnapshotValue,
  liveValueHints,
  liveValueLenses,
  parseInspectorStateDescriptor,
  pollInspectorState,
  type DevState,
  type InspectorStateDescriptor
} from "../src/live-values.ts";

const descriptor: InspectorStateDescriptor = {
  sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  projectRoot: "/work/game",
  stateUrl: "http://127.0.0.1:9333/deherm/dev/v1/snapshot",
  authToken: "a".repeat(43)
};

test("inspector state discovery accepts only the matching project and authenticated loopback endpoint", () => {
  assert.deepEqual(parseInspectorStateDescriptor({
    schemaVersion: 1,
    kind: "deherm-inspector-session",
    ...descriptor
  }, "/work/game"), descriptor);
  assert.equal(parseInspectorStateDescriptor({
    schemaVersion: 1,
    kind: "deherm-inspector-session",
    ...descriptor,
    stateUrl: "https://example.com/deherm/dev/v1/snapshot"
  }, "/work/game"), undefined);
  assert.equal(parseInspectorStateDescriptor({
    schemaVersion: 1,
    kind: "deherm-inspector-session",
    ...descriptor,
    projectRoot: "/work/other"
  }, "/work/game"), undefined);
  assert.equal(parseInspectorStateDescriptor({
    schemaVersion: 1,
    kind: "deherm-inspector-session",
    ...descriptor,
    authToken: "weak"
  }, "/work/game"), undefined);
});

test("state polling sends bearer and ETag headers without caching", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const state = { schemaVersion: 1, kind: "deherm-dev-state", modelVersion: 4, targets: [] };
  const updated = await pollInspectorState({
    descriptor,
    etag: '"old"',
    fetchState: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify(state), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"new"' }
      });
    }
  });
  assert.deepEqual(updated, { kind: "updated", state, etag: '"new"' });
  assert.equal(calls[0].input, descriptor.stateUrl);
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), `Bearer ${descriptor.authToken}`);
  assert.equal(new Headers(calls[0].init?.headers).get("if-none-match"), '"old"');
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[0].init?.redirect, "error");

  assert.deepEqual(await pollInspectorState({
    descriptor,
    etag: '"new"',
    fetchState: async () => new Response(null, { status: 304, headers: { etag: '"new"' } })
  }), { kind: "unchanged", etag: '"new"' });

  await assert.rejects(() => pollInspectorState({
    descriptor,
    fetchState: async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 1) }
    })
  }), /exceeds the 2 MiB limit/u);
});

function fixtureState(sampledAt = 10_000): DevState {
  return {
    schemaVersion: 1,
    kind: "deherm-dev-state",
    modelVersion: 7,
    targets: [{
      id: "local-engine",
      status: "connected",
      connectionEpoch: 2,
      componentSnapshot: { sampledAt, instances: [{
        componentId: "raw-must-not-render",
        properties: []
      }] },
      instances: [{
        instanceId: { slot: 3, generation: 1 },
        componentId: "player",
        source: "main/player.script.ts",
        schemaStatus: "current",
        properties: [
          { name: "health", value: { kind: "number", value: 100 } },
          { name: "label", value: { kind: "string", value: "ready" } }
        ]
      }, {
        componentId: "old-player",
        source: "main/player.script.ts",
        schemaStatus: "stale",
        properties: [{ name: "health", value: { kind: "number", value: -1 } }]
      }, {
        componentId: "other",
        source: "main/other.script.ts",
        schemaStatus: "current",
        properties: []
      }]
    }]
  };
}

test("live lenses consume only server-enriched current schemas for the exact authored source", () => {
  assert.deepEqual(liveValueLenses({
    state: fixtureState(),
    projectRoot: "/work/game",
    documentPath: "/work/game/main/player.script.ts",
    now: 10_500
  }), [{
    targetId: "local-engine",
    componentId: "player",
    title: "$(pulse) local-engine · player [3:1] · health=100, label=\"ready\"",
    navigation: {
      projectRoot: "/work/game",
      documentPath: "/work/game/main/player.script.ts"
    }
  }]);
  assert.deepEqual(liveValueLenses({
    state: fixtureState(),
    projectRoot: "/work/game",
    documentPath: "/work/game/main/player.ts",
    now: 10_500
  }), []);
});

test("live hints project each authenticated runtime value onto its authored property", () => {
  assert.deepEqual(liveValueHints({
    state: fixtureState(),
    projectRoot: "/work/game",
    documentPath: "/work/game/main/player.script.ts",
    now: 10_500
  }), [{
    propertyName: "health",
    label: "= 100",
    tooltip: "local-engine · player [3:1] · health=100"
  }, {
    propertyName: "label",
    label: "= \"ready\"",
    tooltip: "local-engine · player [3:1] · label=\"ready\""
  }]);
});

test("property anchors match property factory declarations and ignore comments, strings, and type fields", () => {
  const source = [
    "interface Self { health: number; label: string }",
    "// health: property.number(999)",
    "const decoy = 'label: property.string(\"wrong\")';",
    "const pattern = /health: property.number/;",
    "export default defineComponent({",
    "  properties: {",
    "    health: property.number(100),",
    "    label:",
    "      property.string(\"ready\"),",
    "  },",
    "});"
  ].join("\n");
  assert.deepEqual(findPropertyDeclarationAnchors(source, new Set(["health", "label"])), [
    { propertyName: "health", line: 6 },
    { propertyName: "label", line: 7 }
  ]);
});

test("raw component snapshot rows are never joined locally even if they mimic enrichment fields", () => {
  const state = fixtureState();
  const target = state.targets[0] as {
    instances?: unknown;
    componentSnapshot: { instances: unknown[] };
  };
  target.instances = undefined;
  target.componentSnapshot.instances = [{
    componentId: "forged",
    source: "main/player.script.ts",
    schemaStatus: "current",
    properties: [{ name: "health", value: { kind: "number", value: 999 } }]
  }];
  assert.deepEqual(liveValueLenses({
    state,
    projectRoot: "/work/game",
    documentPath: "/work/game/main/player.script.ts",
    now: 10_500
  }), []);
});

test("live lenses clear disconnected and aged snapshots instead of retaining stale values", () => {
  const disconnected = fixtureState();
  (disconnected.targets[0] as { status: string }).status = "disconnected";
  assert.deepEqual(liveValueLenses({
    state: disconnected,
    projectRoot: "/work/game",
    documentPath: "/work/game/main/player.script.ts",
    now: 10_500
  }), []);
  assert.deepEqual(liveValueLenses({
    state: fixtureState(),
    projectRoot: "/work/game",
    documentPath: "/work/game/main/player.script.ts",
    now: 20_000
  }), []);
});

test("snapshot values render bounded scalar, vector, URL, and unavailable forms", () => {
  assert.equal(formatSnapshotValue({ kind: "nil" }), "nil");
  assert.equal(formatSnapshotValue({ kind: "vector3", value: [1, 2, 3] }), "(1, 2, 3)");
  assert.equal(formatSnapshotValue({
    kind: "url",
    socket: "01",
    reserved: "00",
    path: "02",
    fragment: "03"
  }), "url(01:00:02:03)");
  assert.equal(formatSnapshotValue({ kind: "unavailable", reason: "accessor-property" }), "‹accessor-property›");
  assert.equal(formatSnapshotValue({ kind: "string", value: `${"x".repeat(60)}\nsecret` }), `"${"x".repeat(47)}…"`);
});
