import assert from "node:assert/strict";
import test from "node:test";

import {
  blockerFromLog,
  planPolicyDerivationIssueReconciliation,
  stageFromLog,
} from "../scripts/reconcile-policy-derivation-issues.mjs";

const stage = "scripts/generate-dmsdk-symbol-evidence.mjs";
const title = "policy derivation: generate-dmsdk-symbol-evidence";
const runUrl = "https://example.test/run/1";
const revision = (character) => character.repeat(40);

function issueBody(rows) {
  return [
    `Automated policy derivation stopped in \`${stage}\` for ${rows.length} tracked revision(s).`,
    "",
    ...rows.flatMap(({ channel, version, revision: sha, blocker }) => [
      `- \`${channel}\` ${version} \`${sha}\``,
      `  - ${blocker}`,
    ]),
    "",
    `Run: ${runUrl}`,
    "",
    "This is one generator/infrastructure blocker shared by the listed revisions, not one unproven API claim per revision.",
  ].join("\n");
}

function existingIssue(number, rows, state = "OPEN") {
  return { number, title, state, body: issueBody(rows) };
}

function failure(channel, sha, blocker = "required LLVM tool 'llvm-nm' is unavailable") {
  return {
    channel,
    revision: sha,
    version: channel === "alpha" ? "1.15.0" : "1.14.0",
    stage,
    blocker,
  };
}

function scope({ trackedRevisions = null, examinedRevisions = [] } = {}) {
  return { trackedRevisions, examinedRevisions };
}

function scopeRevision(channel, sha, version = "1.14.0") {
  return { channel, revision: sha, version };
}

test("derivation log classification keeps generator and compiler failures actionable", () => {
  const realSummary = [
    `Defold ${revision("a")} is NOT derivable from this checkout.`,
    "Error: llvm-nm could not read one archive",
    `  blocked by generator at ${stage}: Command failed`,
    "  committed surface unchanged",
  ].join("\n");
  assert.equal(stageFromLog(realSummary), stage);
  assert.equal(blockerFromLog(realSummary), "llvm-nm could not read one archive");

  const missingSystemHeader = [
    "Error: compile universal-ready production calls failed in /tmp/revision",
    "tests/fixtures/generated_dmsdk_universal_ready_provider.cpp:3:10: fatal error: 'GL/glx.h' file not found",
  ].join("\n");
  assert.equal(stageFromLog(missingSystemHeader), "compile-universal-ready-production-calls");
  assert.match(blockerFromLog(missingSystemHeader), /GL\/glx\.h.*file not found/u);
});

test("a successful alpha replay retains an unrelated stable stage failure", () => {
  const stable = scopeRevision("stable", revision("a"));
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: [existingIssue(140, [{ ...stable, blocker: "LLVM archive tools were unavailable" }])],
    failures: [],
    runUrl,
    scope: scope({
      examinedRevisions: [scopeRevision("alpha", revision("b"), "1.15.0")],
    }),
  });
  assert.deepEqual(actions, []);
});

test("an alpha stage failure adds its row while retaining an unexamined stable row", () => {
  const stable = { ...scopeRevision("stable", revision("a")), blocker: "previous stable blocker" };
  const alpha = failure("alpha", revision("b"));
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: [existingIssue(140, [stable])],
    failures: [alpha],
    runUrl,
    scope: scope({ examinedRevisions: [scopeRevision("alpha", alpha.revision, alpha.version)] }),
  });
  assert.deepEqual(
    actions.map(({ kind, number }) => ({ kind, number })),
    [{ kind: "edit", number: 140 }],
  );
  const body = actions[0].body;
  assert.ok(body.includes("- `stable` 1.14.0 `" + stable.revision + "`"));
  assert.ok(body.includes("- `alpha` 1.15.0 `" + alpha.revision + "`"));
});

test("a full tracked derivation success closes the stage issue", () => {
  const stable = scopeRevision("stable", revision("a"));
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: [existingIssue(140, [{ ...stable, blocker: "previous stable blocker" }])],
    failures: [],
    runUrl,
    scope: scope({ trackedRevisions: [stable], examinedRevisions: [stable] }),
  });
  assert.deepEqual(actions, [{ kind: "close", number: 140, stale: true }]);
});

test("a failure at another stage does not count as a successful derivation", () => {
  const stable = scopeRevision("stable", revision("a"));
  const otherStageFailure = {
    ...failure("stable", stable.revision, "downstream generator failed"),
    stage: "scripts/generate-api-policy.mjs",
  };
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: [existingIssue(140, [{ ...stable, blocker: "previous stable blocker" }])],
    failures: [otherStageFailure],
    runUrl,
    scope: scope({
      trackedRevisions: [stable],
      examinedRevisions: [stable],
    }),
  });
  assert.deepEqual(
    actions.map(({ kind, title: actionTitle, number }) => ({ kind, title: actionTitle, number })),
    [{ kind: "create", title: "policy derivation: generate-api-policy", number: undefined }],
  );
});

test("a revision is pruned only when the tracked set is authoritative", () => {
  const stable = scopeRevision("stable", revision("a"));
  const currentAlpha = scopeRevision("alpha", revision("b"), "1.15.0");
  const existingIssues = [existingIssue(140, [{ ...stable, blocker: "previous stable blocker" }])];

  assert.deepEqual(
    planPolicyDerivationIssueReconciliation({
      existingIssues,
      failures: [],
      runUrl,
      scope: scope({ trackedRevisions: null }),
    }),
    [],
  );
  assert.deepEqual(
    planPolicyDerivationIssueReconciliation({
      existingIssues,
      failures: [],
      runUrl,
      scope: scope({ trackedRevisions: [currentAlpha] }),
    }),
    [{ kind: "close", number: 140, stale: true }],
  );
});

test("duplicate stage issues merge in issue-number order before closing duplicates", () => {
  const alpha = { ...scopeRevision("alpha", revision("a"), "1.15.0"), blocker: "alpha blocker" };
  const stable = { ...scopeRevision("stable", revision("b")), blocker: "stable blocker" };
  const beta = failure("beta", revision("c"), "beta blocker");
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: [existingIssue(110, [alpha]), existingIssue(105, [stable])],
    failures: [beta],
    runUrl,
    scope: scope({ examinedRevisions: [scopeRevision("beta", beta.revision)] }),
  });
  assert.deepEqual(
    actions.map(({ kind, number, stale }) => ({ kind, number, stale })),
    [
      { kind: "edit", number: 105, stale: undefined },
      { kind: "close", number: 110, stale: true },
    ],
  );
  assert.ok(actions[0].body.includes("- `stable` 1.14.0 `" + stable.revision + "`"));
  assert.ok(actions[0].body.includes("- `alpha` 1.15.0 `" + alpha.revision + "`"));
  assert.ok(actions[0].body.includes("- `beta` 1.14.0 `" + beta.revision + "`"));
  assert.equal(actions[1].mergedInto, 105);
});

test("an opaque same-title legacy issue does not create a new issue on every run", () => {
  const unknown = {
    number: 140,
    title,
    state: "OPEN",
    body: "Legacy generated body without parseable revision rows.",
  };
  const alpha = failure("alpha", revision("c"));
  const args = {
    failures: [alpha],
    runUrl,
    scope: scope({ examinedRevisions: [scopeRevision("alpha", alpha.revision, alpha.version)] }),
  };

  const firstRun = planPolicyDerivationIssueReconciliation({ existingIssues: [unknown], ...args });
  assert.equal(firstRun.length, 1);
  assert.equal(firstRun[0].kind, "create");

  const secondRun = planPolicyDerivationIssueReconciliation({
    existingIssues: [unknown, { number: 141, title, state: "OPEN", body: firstRun[0].body }],
    ...args,
  });
  assert.deepEqual(
    secondRun.map(({ kind, number }) => ({ kind, number })),
    [{ kind: "edit", number: 141 }],
  );
});

test("closed issues reopen on a renewed same-stage failure and new failures create an issue", () => {
  const alpha = failure("alpha", revision("c"));
  const closed = existingIssue(142, [{ ...alpha, blocker: "old blocker" }], "CLOSED");
  const scopeForFailure = scope({ examinedRevisions: [scopeRevision("alpha", alpha.revision, alpha.version)] });
  const reopened = planPolicyDerivationIssueReconciliation({
    existingIssues: [closed],
    failures: [alpha],
    runUrl,
    scope: scopeForFailure,
  });
  assert.deepEqual(
    reopened.map(({ kind, number }) => ({ kind, number })),
    [
      { kind: "reopen", number: 142 },
      { kind: "edit", number: 142 },
    ],
  );

  const created = planPolicyDerivationIssueReconciliation({
    existingIssues: [],
    failures: [alpha],
    runUrl,
    scope: scopeForFailure,
  });
  assert.equal(created[0].kind, "create");
  assert.equal(created[0].title, title);
  assert.match(created[0].body, new RegExp(alpha.revision));
});

test("closed issue history does not return when a new revision fails", () => {
  const stable = { ...scopeRevision("stable", revision("a")), blocker: "resolved stable blocker" };
  const alpha = failure("alpha", revision("c"));
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: [existingIssue(100, [stable], "CLOSED")],
    failures: [alpha],
    runUrl,
    scope: scope({ examinedRevisions: [scopeRevision("alpha", alpha.revision, alpha.version)] }),
  });
  assert.deepEqual(
    actions.map(({ kind, number }) => ({ kind, number })),
    [
      { kind: "reopen", number: 100 },
      { kind: "edit", number: 100 },
    ],
  );
  assert.ok(actions[1].body.includes(alpha.revision));
  assert.equal(actions[1].body.includes(stable.revision), false);
});

test("partial success edits the open aggregate instead of reopening a lower-number closed issue", () => {
  const alpha = { ...scopeRevision("alpha", revision("a"), "1.15.0"), blocker: "resolved alpha blocker" };
  const stable = { ...scopeRevision("stable", revision("b")), blocker: "unresolved stable blocker" };
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: [existingIssue(100, [alpha, stable], "CLOSED"), existingIssue(110, [alpha, stable])],
    failures: [],
    runUrl,
    scope: scope({
      examinedRevisions: [scopeRevision("alpha", alpha.revision, alpha.version)],
    }),
  });
  assert.deepEqual(
    actions.map(({ kind, number }) => ({ kind, number })),
    [{ kind: "edit", number: 110 }],
  );
  assert.ok(actions[0].body.includes(stable.revision));
  assert.equal(actions[0].body.includes(alpha.revision), false);
});

test("legacy issues without a parseable revision identity remain open without matching evidence", () => {
  const legacy = {
    number: 160,
    title: "policy: unproven Defold old-version",
    state: "OPEN",
    body: "Old generated issue format without a revision row.",
  };
  const actions = planPolicyDerivationIssueReconciliation({
    existingIssues: [legacy],
    failures: [],
    runUrl,
    scope: scope({ examinedRevisions: [scopeRevision("manual", revision("b"), "unknown")] }),
  });
  assert.deepEqual(actions, []);

  const identifiedLegacy = {
    ...legacy,
    number: 161,
    title: `policy: unproven Defold ${revision("a")}`,
  };
  const removedRevision = planPolicyDerivationIssueReconciliation({
    existingIssues: [identifiedLegacy],
    failures: [],
    runUrl,
    scope: scope({ trackedRevisions: [scopeRevision("alpha", revision("b"), "1.15.0")] }),
  });
  assert.deepEqual(removedRevision, [{ kind: "close", number: 161, stale: true }]);
});

test("malformed scope objects fail closed instead of enabling broad issue closure", () => {
  assert.throws(
    () =>
      planPolicyDerivationIssueReconciliation({
        existingIssues: [],
        failures: [],
        runUrl,
        scope: { examinedRevisions: [] },
      }),
    /trackedRevisions must be an array or null/u,
  );
});
