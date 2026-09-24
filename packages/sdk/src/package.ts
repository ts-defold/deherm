// Revision-neutral package entry point.
//
// Defold modules, dmSDK declarations, component value shapes, and generated
// runtime adapters live in the selected project's `@deherm/project` surface.
// This package entry deliberately exposes only stable authoring/runtime
// primitives whose meaning does not depend on a Defold revision.
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

export interface DefoldAppV1 {
  init?(): void;
  update?(dt: number): void;
  onMessage?(message: string): void;
  final?(): void;
}

export type DefoldAppFactory = (api: DefoldApiV1) => DefoldAppV1;

declare global {
  var __defoldAppV1: DefoldAppV1 | undefined;
  var __defoldModulesV1: Record<string, object> | undefined;
}

export function defineDefoldApp(factory: DefoldAppFactory): void {
  const host = globalThis.__defoldHostV1;
  if (!host) throw new Error("Defold Hermes host v1 is not installed");
  if (host.version !== 1) throw new Error(`Unsupported Defold Hermes host version: ${host.version}`);
  if (globalThis.__defoldAppV1) throw new Error("A Defold Hermes application is already registered");
  globalThis.__defoldAppV1 = factory(host);
}
