import type { DefoldApiV1 } from "./host";

export type { DefoldApiV1, DefoldRuntime, LogLevel, RuntimeKind } from "./host";
export {
  address,
  defoldUrl,
  hashLiteral,
  relativeAddress,
  type DefoldAbsolutePath,
  type DefoldAddress,
  type DefoldAddressLiteral,
  type DefoldAddressShorthand,
  type DefoldFragmentAddress,
  type DefoldHash,
  type DefoldHashLiteral,
  type DefoldRelativeAddress,
  type DefoldSocketAddress,
  type DefoldUrl,
} from "./address";
export { hmrPersistentState, type HmrPersistentCell } from "./hmr-state";
export type { DefoldModuleMap, ExampleMathSpec, Vec3 } from "./generated/modules";
export { DEFOLD_HERMES_ABI_VERSION } from "./generated/modules";
export { DefoldModules, type DefoldModuleRegistry } from "./registry";
export * from "./generated/script/index";
export * from "./generated/dmsdk/index";

export interface DefoldAppV1 {
  init?(): void;
  update?(dt: number): void;
  onMessage?(message: string): void;
  final?(): void;
}

export type DefoldAppFactory = (api: DefoldApiV1) => DefoldAppV1;

declare global {
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
