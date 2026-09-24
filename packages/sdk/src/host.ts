// Stable authoring facade over the host-injected runtime contract.
//
// `__defoldHostV1` is deliberately private to this module. Projects import the
// ordinary `defold` value; native Hermes, browser JavaScript, and tests install
// the same host contract before authored code executes.

export type RuntimeKind = "hermes" | "browser" | "test";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DefoldApiV1 {
  readonly version: 1;
  readonly runtime: RuntimeKind;
  log(level: LogLevel, message: string): void;
  now(): number;
  request(channel: string, payload: string): string;
}

export interface DefoldRuntime {
  log(level: LogLevel, message: string): void;
  now(): number;
  request(channel: string, payload: string): string;
  runtime(): RuntimeKind;
}

declare global {
  // Installed by the selected native/browser/test adapter before user code.
  var __defoldHostV1: DefoldApiV1 | undefined;
}

function host(): DefoldApiV1 {
  const value = globalThis.__defoldHostV1;
  if (!value) throw new Error("Defold Hermes host v1 is not installed");
  if (value.version !== 1) throw new Error(`Unsupported Defold Hermes host version: ${value.version}`);
  return value;
}

export function hostLog(level: LogLevel, message: string): void {
  host().log(level, message);
}

export function hostNow(): number {
  return host().now();
}

export function hostRequest(channel: string, payload: string): string {
  return host().request(channel, payload);
}

export function hostRuntime(): RuntimeKind {
  return host().runtime;
}
