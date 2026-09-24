import {
  LOAD_HARNESS_CONFIG,
  runAuthoritativeLoadHarness,
  type AuthoritativeLoadObserver,
} from "./authoritative-load-harness.ts";

export const RUNTIME_MEASUREMENT_SCHEMA_VERSION = 1;
export const RUNTIME_MEASUREMENT_CONFIG = Object.freeze({
  warmupTicks: 60,
  sampleTicks: LOAD_HARNESS_CONFIG.ticks,
});

type RuntimeMemory = {
  readonly rssBytes?: number;
  readonly heapTotalBytes?: number;
  readonly heapUsedBytes?: number;
  readonly externalBytes?: number;
  readonly arrayBuffersBytes?: number;
};

export interface RuntimeMeasurementEvidence {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly runtime: Record<string, unknown>;
  readonly workload: Record<string, unknown>;
  readonly authoritativeServer: Record<string, unknown>;
  readonly memory: Record<string, unknown>;
  readonly allocations: Record<string, unknown>;
}

function runtimeName(): "node" | "deno" | "unknown" {
  if (typeof (globalThis as { Deno?: unknown }).Deno === "object") return "deno";
  if (typeof (globalThis as { process?: unknown }).process === "object") return "node";
  return "unknown";
}

function monotonicNow(): () => number {
  const clock = (globalThis as { performance?: { now?: () => number } }).performance;
  if (typeof clock?.now === "function") return () => clock.now!();
  throw new Error("runtime measurement requires a monotonic performance.now clock");
}

function readMemory(): RuntimeMemory | null {
  const denoLike = (globalThis as unknown as {
    Deno?: { memoryUsage?: () => Record<string, number> };
  }).Deno;
  if (typeof denoLike?.memoryUsage === "function") {
    const value = denoLike.memoryUsage();
    return {
      rssBytes: value.rss,
      heapTotalBytes: value.heapTotal,
      heapUsedBytes: value.heapUsed,
      externalBytes: value.external,
      arrayBuffersBytes: value.arrayBuffers,
    };
  }
  const processLike = (globalThis as unknown as {
    process?: { memoryUsage?: () => Record<string, number> };
  }).process;
  if (typeof processLike?.memoryUsage === "function") {
    const value = processLike.memoryUsage();
    return {
      rssBytes: value.rss,
      heapTotalBytes: value.heapTotal,
      heapUsedBytes: value.heapUsed,
      externalBytes: value.external,
      arrayBuffersBytes: value.arrayBuffers,
    };
  }
  return null;
}

function finiteNumbers(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

function percentile(values: readonly number[], quantile: number): number | null {
  const sorted = finiteNumbers(values).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function summarize(values: readonly number[]): Record<string, number | null> {
  const measured = finiteNumbers(values);
  if (measured.length === 0) {
    return { samples: 0, minimum: null, mean: null, p50: null, p95: null, p99: null, maximum: null };
  }
  return {
    samples: measured.length,
    minimum: Math.min(...measured),
    mean: measured.reduce((sum, value) => sum + value, 0) / measured.length,
    p50: percentile(measured, 0.50),
    p95: percentile(measured, 0.95),
    p99: percentile(measured, 0.99),
    maximum: Math.max(...measured),
  };
}

function memorySummary(samples: readonly RuntimeMemory[]): Record<string, unknown> {
  const fields = ["rssBytes", "heapTotalBytes", "heapUsedBytes", "externalBytes", "arrayBuffersBytes"] as const;
  const summary: Record<string, unknown> = {};
  for (const field of fields) {
    const values = samples
      .map((sample) => sample[field])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    summary[field] = {
      observed: values.length > 0,
      samples: values.length,
      first: values[0] ?? null,
      last: values.length === 0 ? null : values[values.length - 1]!,
      peak: values.length === 0 ? null : Math.max(...values),
      delta: values.length < 2 ? null : values[values.length - 1]! - values[0]!,
    };
  }
  return summary;
}

/**
 * Measures the real host runtime around the existing authoritative load seam.
 * It does not alter the deterministic load evidence and it never interprets a
 * memory snapshot as an allocation count.
 */
export async function runRuntimeMeasurement(): Promise<RuntimeMeasurementEvidence> {
  const now = monotonicNow();
  const stepSamples: number[] = [];
  const memorySamples: RuntimeMemory[] = [];
  const start = now();
  const initialMemory = readMemory();
  if (initialMemory !== null) memorySamples.push(initialMemory);
  const observer: AuthoritativeLoadObserver = {
    now,
    onAuthoritativeStep(sample) {
      stepSamples.push(sample.durationMilliseconds);
      const memory = readMemory();
      if (memory !== null) memorySamples.push(memory);
    },
  };
  const deterministic = await runAuthoritativeLoadHarness(LOAD_HARNESS_CONFIG, observer);
  const elapsedMilliseconds = now() - start;
  const finalMemory = readMemory();
  if (finalMemory !== null) memorySamples.push(finalMemory);
  const measuredSteps = stepSamples.slice(RUNTIME_MEASUREMENT_CONFIG.warmupTicks);
  const memoryAvailable = memorySamples.length > 0;
  return Object.freeze({
    schemaVersion: RUNTIME_MEASUREMENT_SCHEMA_VERSION,
    kind: "war-battles.runtime-performance-measurement",
    runtime: {
      name: runtimeName(),
      clock: "performance.now",
      clockUnit: "milliseconds",
      wallClockObserved: true,
      elapsedMilliseconds,
    },
    workload: {
      sourceKind: deterministic.kind,
      config: LOAD_HARNESS_CONFIG,
      deterministicEvidenceSeparate: true,
      warmupTicks: RUNTIME_MEASUREMENT_CONFIG.warmupTicks,
    },
    authoritativeServer: {
      unit: "wall-clock-milliseconds-per-authoritative-step",
      scope: "MatchServer.step only; transport queue advancement and client update are outside this timer",
      samples: summarize(measuredSteps),
      allSamples: summarize(stepSamples),
    },
    memory: {
      unit: "bytes",
      source: memoryAvailable ? `${runtimeName()}.memoryUsage` : null,
      observed: memoryAvailable,
      samples: memorySamples.length,
      values: memoryAvailable ? memorySummary(memorySamples) : null,
      unavailable: memoryAvailable ? null : "This runtime exposes no process or Deno memoryUsage API.",
    },
    allocations: {
      measured: false,
      perTick: null,
      zeroClaim: false,
      reason: "Runtime memory snapshots show resident/heap state only; they do not count allocations or prove allocation-free execution.",
    },
  });
}
