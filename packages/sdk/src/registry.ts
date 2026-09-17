import type { DefoldModuleMap } from "./generated/modules";
import { requireDefoldModule } from "./module-runtime";

/**
 * Dynamic escape hatch. Importing this registry intentionally retains the
 * complete binding surface because a build cannot prove which string names
 * will be requested at runtime.
 */
export interface DefoldModuleRegistry {
  get<K extends keyof DefoldModuleMap>(name: K): DefoldModuleMap[K] | null;
  get<T extends object>(name: string): T | null;
  getEnforcing<K extends keyof DefoldModuleMap>(name: K): DefoldModuleMap[K];
  getEnforcing<T extends object>(name: string): T;
}

export const DefoldModules: DefoldModuleRegistry = {
  get<T extends object>(name: string): T | null {
    return (globalThis.__defoldModulesV1?.[name] as T | undefined) ?? null;
  },

  getEnforcing<T extends object>(name: string): T {
    return requireDefoldModule<T>(name);
  }
};
