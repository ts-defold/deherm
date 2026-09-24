#!/usr/bin/env -S deno run --allow-read

/**
 * Deno owner for the same runtime measurement lane as
 * check-runtime-measurement.mjs. This is intentionally a separate command:
 * Node and Deno memory/GC implementations are different observations and are
 * never merged into one cross-runtime number.
 */
import { runRuntimeMeasurement } from "./runtime-measurement-harness.ts";

const evidence = await runRuntimeMeasurement();
console.log(JSON.stringify({
  ...evidence,
  owner: "examples/war-battles-online/integration/runtime-measurement-deno.ts",
  generator: "examples/war-battles-online/integration/runtime-measurement-deno.ts",
  evidenceBoundary: "Deno-observed wall-clock authoritative step and Deno.memoryUsage snapshots; not comparable to Node samples and not an allocation count.",
}, null, 2));

