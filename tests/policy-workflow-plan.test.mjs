import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planPolicyWorkflow } from "../scripts/plan-policy-workflow.mjs";

const sha = (character) => character.repeat(40);
const digest = (character) => character.repeat(64);

function channelPlan({ observations, indexedRevisions, derive }) {
  return { observations, indexedRevisions, derive };
}

const stable = { channel: "stable", sha1: sha("a"), version: "1.14.0" };
const beta = { channel: "beta", sha1: sha("b"), version: "1.15.0" };
const alpha = { channel: "alpha", sha1: sha("c"), version: null };

test("normal runs retain the authoritative observation scope and hand off only new non-canary derivations", () => {
  const plan = planPolicyWorkflow({
    event: "schedule",
    requestedRevision: "",
    requestedChannel: "",
    refreshOnly: false,
    callbackRevision: "",
    channelPlan: channelPlan({
      observations: [stable, beta, alpha],
      indexedRevisions: [stable.sha1],
      derive: [
        { ...beta, canary: false },
        { ...alpha, canary: true },
      ],
    }),
  });

  assert.deepEqual(plan, {
    derive: [
      { ...beta, canary: false },
      { channel: "alpha", sha1: alpha.sha1, version: "unknown", canary: true },
    ],
    trackedRevisions: [stable, beta, { channel: "alpha", sha1: alpha.sha1, version: "unknown" }],
    authoritative: true,
    consumerRevisions: [
      { channel: "stable", sha1: stable.sha1 },
      { channel: "beta", sha1: beta.sha1 },
      { channel: "alpha", sha1: alpha.sha1 },
    ],
    endToEndCandidates: [{ channel: "beta", sha1: beta.sha1 }],
  });
});

test("manual runs route an observed revision, use an explicit route when needed, and never invent stable", () => {
  const snapshot = channelPlan({ observations: [stable, beta, alpha], indexedRevisions: [stable.sha1], derive: [] });
  const cases = [
    {
      name: "observed alpha revision",
      requestedRevision: alpha.sha1,
      requestedChannel: "",
      expectedRoute: "alpha",
      expectedVersion: "unknown",
      expectedCandidates: [{ channel: "alpha", sha1: alpha.sha1 }],
    },
    {
      name: "unobserved revision with explicit beta route",
      requestedRevision: sha("d"),
      requestedChannel: "beta",
      expectedRoute: "beta",
      expectedVersion: "unknown",
      expectedCandidates: [{ channel: "beta", sha1: sha("d") }],
    },
    {
      name: "unobserved revision with no route",
      requestedRevision: sha("e"),
      requestedChannel: "",
      expectedRoute: null,
      expectedVersion: "unknown",
      expectedCandidates: [],
    },
  ];

  for (const scenario of cases) {
    const plan = planPolicyWorkflow({
      event: "workflow_dispatch",
      requestedRevision: scenario.requestedRevision,
      requestedChannel: scenario.requestedChannel,
      refreshOnly: false,
      callbackRevision: "",
      channelPlan: snapshot,
    });
    assert.deepEqual(
      plan.derive,
      [
        {
          channel: "manual",
          sha1: scenario.requestedRevision,
          version: scenario.expectedVersion,
          canary: false,
        },
      ],
      scenario.name,
    );
    assert.equal(plan.trackedRevisions, null, scenario.name);
    assert.equal(plan.authoritative, false, scenario.name);
    assert.deepEqual(
      plan.consumerRevisions,
      [{ channel: scenario.expectedRoute, sha1: scenario.requestedRevision }],
      scenario.name,
    );
    assert.deepEqual(plan.endToEndCandidates, scenario.expectedCandidates, scenario.name);
  }
});

test("refresh callbacks smoke indexed revisions only and require an exact known route for Bob", () => {
  const oldIndexed = sha("d");
  const snapshot = channelPlan({
    observations: [stable, beta, alpha],
    indexedRevisions: [stable.sha1, beta.sha1, oldIndexed],
    derive: [{ ...alpha, canary: false }],
  });
  const indexedCurrentRows = [
    { channel: "stable", sha1: stable.sha1 },
    { channel: "beta", sha1: beta.sha1 },
  ];
  const cases = [
    {
      name: "indexed current callback reuses its observation route",
      callbackRevision: beta.sha1,
      requestedChannel: "",
      expectedRows: indexedCurrentRows,
      expectedCandidates: [{ channel: "beta", sha1: beta.sha1 }],
    },
    {
      name: "indexed old callback has no inferred route",
      callbackRevision: oldIndexed,
      requestedChannel: "",
      expectedRows: [...indexedCurrentRows, { channel: null, sha1: oldIndexed }],
      expectedCandidates: [],
    },
    {
      name: "indexed old callback uses explicit route",
      callbackRevision: oldIndexed,
      requestedChannel: "alpha",
      expectedRows: [...indexedCurrentRows, { channel: "alpha", sha1: oldIndexed }],
      expectedCandidates: [{ channel: "alpha", sha1: oldIndexed }],
    },
    {
      name: "unindexed callback does not enter consumer or Bob scope",
      callbackRevision: sha("e"),
      requestedChannel: "stable",
      expectedRows: indexedCurrentRows,
      expectedCandidates: [],
    },
  ];

  for (const scenario of cases) {
    const plan = planPolicyWorkflow({
      event: "workflow_dispatch",
      requestedRevision: "",
      requestedChannel: scenario.requestedChannel,
      refreshOnly: true,
      callbackRevision: scenario.callbackRevision,
      channelPlan: snapshot,
    });
    assert.deepEqual(plan.derive, [], scenario.name);
    assert.equal(plan.trackedRevisions, null, scenario.name);
    assert.equal(plan.authoritative, false, scenario.name);
    assert.deepEqual(plan.consumerRevisions, scenario.expectedRows, scenario.name);
    assert.deepEqual(plan.endToEndCandidates, scenario.expectedCandidates, scenario.name);
  }

  const noIndexedBaseline = planPolicyWorkflow({
    event: "workflow_dispatch",
    requestedRevision: "",
    requestedChannel: "",
    refreshOnly: true,
    callbackRevision: sha("f"),
    channelPlan: channelPlan({ observations: [alpha], indexedRevisions: [], derive: [] }),
  });
  assert.deepEqual(noIndexedBaseline.consumerRevisions, []);
  assert.deepEqual(noIndexedBaseline.endToEndCandidates, []);
});

test("a compatibility callback recovers current indexed aliases without widening to unrelated or unindexed channels", () => {
  const oldLexicalRepresentative = sha("d");
  const unrelatedRevision = sha("e");
  const callbackCompatibility = digest("1");
  const compatibilityIndex = [
    {
      compatibility: { kind: "deherm.native-artifact-compatibility", sha256: callbackCompatibility },
      revisions: [oldLexicalRepresentative, beta.sha1],
    },
    {
      compatibility: { kind: "deherm.native-artifact-compatibility", sha256: digest("2") },
      revisions: [stable.sha1, unrelatedRevision],
    },
  ];
  const plan = planPolicyWorkflow({
    event: "workflow_dispatch",
    requestedRevision: "",
    requestedChannel: "",
    refreshOnly: true,
    callbackRevision: oldLexicalRepresentative,
    callbackCompatibility,
    compatibilityIndex,
    channelPlan: channelPlan({
      observations: [stable, beta, alpha],
      indexedRevisions: [stable.sha1, beta.sha1, oldLexicalRepresentative, unrelatedRevision],
      derive: [{ ...alpha, canary: false }],
    }),
  });

  assert.deepEqual(plan.endToEndCandidates, [{ channel: "beta", sha1: beta.sha1 }]);
  assert.deepEqual(plan.consumerRevisions, [
    { channel: "stable", sha1: stable.sha1 },
    { channel: "beta", sha1: beta.sha1 },
    { channel: null, sha1: oldLexicalRepresentative },
  ]);

  assert.throws(
    () =>
      planPolicyWorkflow({
        event: "workflow_dispatch",
        requestedRevision: "",
        requestedChannel: "",
        refreshOnly: true,
        callbackRevision: oldLexicalRepresentative,
        callbackCompatibility,
        channelPlan: channelPlan({
          observations: [stable, beta, alpha],
          indexedRevisions: [stable.sha1, beta.sha1, oldLexicalRepresentative],
          derive: [],
        }),
      }),
    /must be supplied together/u,
  );

  assert.throws(
    () =>
      planPolicyWorkflow({
        event: "workflow_dispatch",
        requestedRevision: "",
        requestedChannel: "",
        refreshOnly: true,
        callbackRevision: oldLexicalRepresentative,
        callbackCompatibility,
        compatibilityIndex: [compatibilityIndex[1]],
        channelPlan: channelPlan({
          observations: [stable, beta, alpha],
          indexedRevisions: [stable.sha1, beta.sha1, oldLexicalRepresentative],
          derive: [],
        }),
      }),
    /missing from its native compatibility group/u,
  );
});

test("CLI consumes the single serialized channel-plan snapshot and emits the planner contract", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "policy-workflow-plan-"));
  const snapshotPath = path.join(tempDirectory, "channel-plan.json");
  const compatibilityPath = path.join(tempDirectory, "compatibility-index.json");
  const scriptPath = fileURLToPath(new URL("../scripts/plan-policy-workflow.mjs", import.meta.url));
  try {
    await writeFile(
      snapshotPath,
      JSON.stringify(
        channelPlan({
          observations: [stable, beta, alpha],
          indexedRevisions: [stable.sha1, beta.sha1, sha("d")],
          derive: [{ ...alpha, canary: false }],
        }),
      ),
    );
    await writeFile(
      compatibilityPath,
      JSON.stringify([
        {
          compatibility: { kind: "deherm.native-artifact-compatibility", sha256: digest("1") },
          revisions: [sha("d"), beta.sha1],
        },
      ]),
    );
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--event",
        "schedule",
        "--requested-revision",
        "",
        "--requested-channel",
        "",
        "--refresh-only",
        "false",
        "--callback-revision",
        "",
        "--channel-plan",
        snapshotPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      derive: [{ channel: "alpha", sha1: alpha.sha1, version: "unknown", canary: false }],
      trackedRevisions: [stable, beta, { channel: "alpha", sha1: alpha.sha1, version: "unknown" }],
      authoritative: true,
      consumerRevisions: [
        { channel: "stable", sha1: stable.sha1 },
        { channel: "beta", sha1: beta.sha1 },
        { channel: "alpha", sha1: alpha.sha1 },
      ],
      endToEndCandidates: [{ channel: "alpha", sha1: alpha.sha1 }],
    });

    const refreshResult = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--event",
        "workflow_dispatch",
        "--requested-revision",
        "",
        "--requested-channel",
        "",
        "--refresh-only",
        "true",
        "--callback-revision",
        sha("d"),
        "--callback-compatibility",
        digest("1"),
        "--channel-plan",
        snapshotPath,
        "--compatibility-index",
        compatibilityPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(refreshResult.status, 0, refreshResult.stderr);
    assert.deepEqual(JSON.parse(refreshResult.stdout), {
      derive: [],
      trackedRevisions: null,
      authoritative: false,
      consumerRevisions: [
        { channel: "stable", sha1: stable.sha1 },
        { channel: "beta", sha1: beta.sha1 },
        { channel: null, sha1: sha("d") },
      ],
      endToEndCandidates: [{ channel: "beta", sha1: beta.sha1 }],
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
