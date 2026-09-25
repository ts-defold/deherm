/** Internal runtime lookup used by generated, statically discoverable wrappers. */
export function requireDefoldModule<T extends object>(name: string, moduleAbiVersion?: number): T {
  const modules = globalThis.__defoldModulesV1;
  let module = modules?.[name] as T | undefined;
  if (!module && modules && moduleAbiVersion !== undefined) {
    const resolve = modules.__resolve as ((moduleName: string, abiVersion?: number) => object | undefined) | undefined;
    module = resolve?.(name, moduleAbiVersion) as T | undefined;
    if (module) modules[name] = module;
  }
  if (!module) throw new Error(`Defold module is not registered: ${name}`);
  if (moduleAbiVersion !== undefined) {
    const actual = (module as Record<string, unknown>).__dehermNativeModuleAbiVersionV1;
    if (actual !== moduleAbiVersion) {
      throw new Error(`Defold native module ABI mismatch: ${name} requires ${moduleAbiVersion}, received ${String(actual)}`);
    }
  }
  return module;
}

type NativeModulePump = (dt: number) => void;
const MAX_NATIVE_MODULE_PUMPS = 32;
type NativeModulePumpStateV1 = {
  readonly version: 1;
  readonly pumps: Array<NativeModulePump | undefined>;
  readonly tick: NativeModulePump;
};
const nativePumpGlobal = globalThis as typeof globalThis & {
  __dehermNativeModulePumpStateV1?: NativeModulePumpStateV1;
  __dehermNativeModulesTickV1?: (dt: number) => void;
};

function nativeModulePumpState(): NativeModulePumpStateV1 {
  const existing = nativePumpGlobal.__dehermNativeModulePumpStateV1;
  if (existing) {
    if (existing.version !== 1 || existing.pumps.length !== MAX_NATIVE_MODULE_PUMPS ||
        typeof existing.tick !== "function") throw new Error("Invalid native module pump state v1");
    if (nativePumpGlobal.__dehermNativeModulesTickV1 && nativePumpGlobal.__dehermNativeModulesTickV1 !== existing.tick) {
      throw new Error("Native module pump tick v1 is already owned by an incompatible runtime");
    }
    nativePumpGlobal.__dehermNativeModulesTickV1 ??= existing.tick;
    return existing;
  }
  if (nativePumpGlobal.__dehermNativeModulesTickV1) {
    throw new Error("Native module pump tick v1 exists without its shared state");
  }
  const pumps = new Array<NativeModulePump | undefined>(MAX_NATIVE_MODULE_PUMPS);
  const state: NativeModulePumpStateV1 = {
    version: 1,
    pumps,
    tick(dt: number): void {
      for (let index = 0; index < MAX_NATIVE_MODULE_PUMPS; index += 1) pumps[index]?.(dt);
    },
  };
  nativePumpGlobal.__dehermNativeModulePumpStateV1 = state;
  nativePumpGlobal.__dehermNativeModulesTickV1 = state.tick;
  return state;
}

/** Internal extension-facade hook; the runtime invokes it once per engine frame. */
export function registerNativeModulePump(pump: NativeModulePump): () => void {
  const state = nativeModulePumpState();
  const slot = state.pumps.findIndex((candidate) => candidate === undefined);
  if (slot < 0) throw new Error(`Native module pump capacity exceeded (${MAX_NATIVE_MODULE_PUMPS})`);
  state.pumps[slot] = pump;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    state.pumps[slot] = undefined;
  };
}
