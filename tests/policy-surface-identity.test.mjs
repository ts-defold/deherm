import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import { createPolicySurfaceIdentity, verifyPolicySurfaceIdentity } from "../scripts/policy-surface-identity.mjs";

const sourceSha = "a".repeat(40);
const runId = "38914150945";

test("the handoff rejects a different run, source checkout, or archive byte", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-identity-"));
  try {
    const archive = path.join(directory, "policy-surface.tar.gz");
    await writeFile(archive, "candidate A");
    const identity = await createPolicySurfaceIdentity({ archive, sourceSha, runId });
    assert.equal(
      (await verifyPolicySurfaceIdentity({ archive, identity, sourceSha, runId })).archiveSha256,
      identity.archiveSha256,
    );
    await assert.rejects(
      verifyPolicySurfaceIdentity({ archive, identity, sourceSha: "b".repeat(40), runId }),
      /belongs to/u,
    );
    await assert.rejects(
      verifyPolicySurfaceIdentity({ archive, identity, sourceSha, runId: "38914150946" }),
      /belongs to/u,
    );
    await writeFile(archive, "candidate B");
    await assert.rejects(
      verifyPolicySurfaceIdentity({ archive, identity, sourceSha, runId }),
      /archive digest mismatch/u,
    );
    await assert.rejects(
      verifyPolicySurfaceIdentity({ archive, identity: { ...identity, archiveSha256: "bad" }, sourceSha, runId }),
      /malformed/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native workflow pins every checkout to the policy producer commit", async () => {
  const policy = YAML.parse(await readFile(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8"));
  const native = YAML.parse(
    await readFile(new URL("../.github/workflows/native-artifacts.yml", import.meta.url), "utf8"),
  );
  const dispatch = policy.jobs["request-native-artifacts"].steps.find((step) =>
    step.name?.startsWith("Dispatch artifact"),
  );
  assert.match(dispatch.run, /policy_source_sha=/u);
  assert.ok(native.on.workflow_dispatch.inputs.policy_source_sha);
  for (const [name, job] of Object.entries(native.jobs)) {
    const checkout = job.steps?.find((step) => step.uses === "actions/checkout@v7");
    if (!checkout) continue;
    assert.match(checkout.with.ref, /inputs\.policy_source_sha \|\| github\.sha/u, name);
  }
  const install = native.jobs.plan.steps.find((step) => step.name === "Install policy-derived artifact inputs");
  assert.match(install.run, /policy-surface-identity\.mjs verify[\s\S]*policy-surface\.mjs extract/u);
});
