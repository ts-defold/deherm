import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateNativeValueProbeReport } from "../scripts/lib/native-runtime-probe-report.mjs";

const root = new URL("../", import.meta.url);
const report = JSON.parse(await readFile(
  new URL("packages/bindings/generated/defold-script-value-real-engine-probes.json", root),
  "utf8"
));
const bindings = JSON.parse(await readFile(
  new URL("packages/bindings/generated/defold-script-value-bindings.json", root),
  "utf8"
));

test("native runtime accepts complete emitted and planned-only value dispositions", () => {
  const instrumented = validateNativeValueProbeReport(report, bindings);
  assert.equal(instrumented.length, report.instrumentedProbeCount);
  assert.ok(instrumented.every(({ state, expectedMarker }) =>
    state === "instrumented" && typeof expectedMarker === "string"));
  assert.equal(report.routeDispositionCount, report.probeCount + report.plannedFamilyProbeCount);
  // Dispositions cover every binding; a binding with several implemented call
  // shapes legitimately carries several probes.
  assert.equal(new Set([...report.probes, ...report.plannedProbes].map(({ id }) => id)).size,
    bindings.bindingCount);
});

test("native runtime rejects missing, duplicate, and promoted dispositions", () => {
  assert.throws(
    () => validateNativeValueProbeReport({ ...report, routeDispositionCount: report.routeDispositionCount - 1 }, bindings),
    /account for every generated binding/
  );
  const duplicate = structuredClone(report);
  duplicate.plannedProbes[0].id = duplicate.probes[0].id;
  assert.throws(
    () => validateNativeValueProbeReport(duplicate, bindings),
    /cover each binding at least once/
  );
  const promoted = structuredClone(report);
  promoted.plannedProbes[0].state = "instrumented";
  assert.throws(
    () => validateNativeValueProbeReport(promoted, bindings),
    /Unknown non-emitted probe state/
  );
});
