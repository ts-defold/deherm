import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  benchmarkTarget,
  checkProfileCompileOut,
  configureAndBuild,
  instrumentedGeneratedSources,
  repositoryRoot,
  telemetryStringMarkers,
  telemetrySymbolMarkers
} from "../scripts/check-profile-compile-out.mjs";

// The source-level claim needs no toolchain: every generated transport scope
// must exist and every telemetry identity table must sit behind the switch.
test("generated transport instrumentation is emitted behind the compile switch", async () => {
  const findings = await checkProfileCompileOut({ sources: true });
  assert.equal(findings.guardedGeneratedSources.length, instrumentedGeneratedSources.length);
  for (const source of findings.guardedGeneratedSources) {
    assert.ok(source.scopes >= 1, `${source.path} has no generated transport scope`);
    assert.ok(source.guardOpens >= 1, `${source.path} has no compile switch`);
  }
});

// The binary-level claim. Builds the same target twice and reads the artifacts,
// rather than asserting that the macros "look empty".
const offBinary = resolve(repositoryRoot, "build/profile-off", benchmarkTarget);
const onBinary = resolve(repositoryRoot, "build/profile-on", benchmarkTarget);
const toolchainAvailable = existsSync(resolve(repositoryRoot, "upstream/defold/engine/lua/src/lua/lapi.c"));

test(
  "DEHERM_PROFILE off leaves no telemetry symbol, storage, or string in the linked binary",
  { skip: toolchainAvailable ? false : "pinned Defold Lua sources are not bootstrapped", timeout: 1800000 },
  async () => {
    configureAndBuild("build/profile-off", { profile: false });
    configureAndBuild("build/profile-on", { profile: true });
    const findings = await checkProfileCompileOut({ offBinary, onBinary, sources: false });
    assert.equal(
      findings.absentFromOffBuild.length,
      telemetrySymbolMarkers.length + telemetryStringMarkers.length
    );
    assert.equal(
      findings.presentInOnBuild.length,
      telemetrySymbolMarkers.length + telemetryStringMarkers.length
    );
    assert.ok(findings.offBytes < findings.onBytes);
  }
);
