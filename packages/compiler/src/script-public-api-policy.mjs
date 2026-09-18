// Public TypeScript names for raw Defold Lua modules. The source module path
// remains unchanged so stable binding IDs and Lua bridge lookup paths do not
// drift when the TypeScript spelling is improved.
const rootAliases = new Map([
  ["builtins", "defold"]
]);
const rawRootByPublicName = new Map([...rootAliases].map(([raw, publicName]) => [publicName, raw]));

export function publicScriptRootName(rawRootName) {
  return rootAliases.get(rawRootName) ?? rawRootName;
}

export function rawScriptRootName(publicRootName) {
  return rawRootByPublicName.get(publicRootName) ?? publicRootName;
}

export function publicScriptModulePath(rawModulePath) {
  if (!Array.isArray(rawModulePath) || rawModulePath.length === 0) {
    throw new TypeError("rawModulePath must be a non-empty array");
  }
  return [publicScriptRootName(rawModulePath[0]), ...rawModulePath.slice(1)];
}

export function assertUniquePublicScriptRoots(rawRootNames) {
  const sourceByPublicName = new Map();
  for (const rawRootName of rawRootNames) {
    const publicRootName = publicScriptRootName(rawRootName);
    const prior = sourceByPublicName.get(publicRootName);
    if (prior && prior !== rawRootName) {
      throw new Error(
        `Public Defold script root ${JSON.stringify(publicRootName)} collides between ` +
        `${JSON.stringify(prior)} and ${JSON.stringify(rawRootName)}`
      );
    }
    sourceByPublicName.set(publicRootName, rawRootName);
  }
  return sourceByPublicName;
}
