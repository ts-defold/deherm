export const DEFAULT_LOCAL_DEV_BUILD_SERVER = "http://127.0.0.1:9010";

/**
 * Configuration shared by the installed native and browser HMR gates.
 *
 * The repository pins a Defold development SDK whose Extender schema can be
 * newer than production. Local development therefore uses the matching pinned
 * Extender by default while preserving the same explicit environment override
 * accepted by the public CLI.
 */
export function localDevLaunchConfiguration(environment = process.env) {
  return {
    buildServer:
      environment.DEHERM_BUILD_SERVER || environment.DEFOLD_HERMES_BUILD_SERVER || DEFAULT_LOCAL_DEV_BUILD_SERVER,
    environment: { ...environment },
  };
}
