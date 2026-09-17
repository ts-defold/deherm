/** Internal runtime lookup used by generated, statically discoverable wrappers. */
export function requireDefoldModule<T extends object>(name: string): T {
  const module = globalThis.__defoldModulesV1?.[name] as T | undefined;
  if (!module) throw new Error(`Defold module is not registered: ${name}`);
  return module;
}
