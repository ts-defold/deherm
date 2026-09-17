export type RuntimeKind = "hermes" | "browser" | "test";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type { DefoldModuleMap, ExampleMathSpec, Vec3 } from "./generated/modules";
export { DEFOLD_HERMES_ABI_VERSION } from "./generated/modules";
export { DefoldModules, type DefoldModuleRegistry } from "./registry";

export interface DefoldApiV1 {
  readonly version: 1;
  readonly runtime: RuntimeKind;
  log(level: LogLevel, message: string): void;
  now(): number;
  request(channel: string, payload: string): string;
}

export interface DefoldAppV1 {
  init?(): void;
  update?(dt: number): void;
  onMessage?(message: string): void;
  final?(): void;
}

export type DefoldAppFactory = (api: DefoldApiV1) => DefoldAppV1;

declare global {
  // Installed by the native or browser host before the application bundle runs.
  var __defoldHostV1: DefoldApiV1 | undefined;
  // Installed by defineDefoldApp and driven by the host.
  var __defoldAppV1: DefoldAppV1 | undefined;
  // Runtime-owned module objects. Native functions are JSI host functions;
  // browser functions are ordinary JavaScript adapters with the same shape.
  var __defoldModulesV1: Record<string, object> | undefined;
}

export function defineDefoldApp(factory: DefoldAppFactory): void {
  const host = globalThis.__defoldHostV1;
  if (!host) {
    throw new Error("Defold Hermes host v1 is not installed");
  }
  if (host.version !== 1) {
    throw new Error(`Unsupported Defold Hermes host version: ${host.version}`);
  }
  if (globalThis.__defoldAppV1) {
    throw new Error("A Defold Hermes application is already registered");
  }

  globalThis.__defoldAppV1 = factory(host);
}
