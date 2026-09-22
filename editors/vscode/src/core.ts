import { stat } from "node:fs/promises";
import path from "node:path";

export interface DehermProject {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
}

export interface ProcessLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

interface PathApi {
  readonly sep: string;
  resolve(...paths: string[]): string;
  dirname(value: string): string;
  basename(value: string): string;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(value: string): boolean;
}

function pathsFor(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

function contains(parent: string, child: string, paths: PathApi): boolean {
  const relative = paths.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative));
}

/** Return the deepest Defold project that owns a document path. */
export function owningDehermProject(
  projects: readonly DehermProject[],
  documentPath: string,
  platform: NodeJS.Platform = process.platform
): DehermProject | undefined {
  const paths = pathsFor(platform);
  const document = paths.resolve(documentPath);
  return projects
    .filter((project) => contains(paths.resolve(project.projectRoot), document, paths))
    .sort((left, right) => paths.resolve(right.projectRoot).length - paths.resolve(left.projectRoot).length)[0];
}

/**
 * Return the deterministic Node-style search for the project-local CLI.
 *
 * The search stops at the workspace boundary when that boundary contains the
 * Defold project. This supports the common `package/game.project` layout while
 * refusing to fall through to an unrelated global or home-directory install.
 */
export function dehermCliCandidates({
  projectRoot,
  workspaceRoot = projectRoot,
  platform = process.platform
}: {
  projectRoot: string;
  workspaceRoot?: string;
  platform?: NodeJS.Platform;
}): string[] {
  const paths = pathsFor(platform);
  let current = paths.resolve(projectRoot);
  const workspace = paths.resolve(workspaceRoot);
  const boundary = contains(workspace, current, paths) ? workspace : current;
  const candidates: string[] = [];
  for (;;) {
    candidates.push(paths.join(current, "node_modules", "@ts-defold", "deherm", "bin", "deherm.mjs"));
    if (samePath(current, boundary, platform)) break;
    const parent = paths.dirname(current);
    if (samePath(parent, current, platform) || !contains(boundary, parent, paths)) break;
    current = parent;
  }
  return candidates;
}

async function regularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveDehermCli({
  projectRoot,
  workspaceRoot = projectRoot,
  configuredPath,
  platform = process.platform,
  isFile = regularFile
}: {
  projectRoot: string;
  workspaceRoot?: string;
  configuredPath?: string;
  platform?: NodeJS.Platform;
  isFile?: (file: string) => Promise<boolean>;
}): Promise<string> {
  const paths = pathsFor(platform);
  if (configuredPath?.trim()) {
    const configured = paths.isAbsolute(configuredPath)
      ? paths.resolve(configuredPath)
      : paths.resolve(workspaceRoot, configuredPath);
    if (await isFile(configured)) return configured;
    throw new Error(`Configured deherm.cliPath does not name a file: ${configured}`);
  }

  const candidates = dehermCliCandidates({ projectRoot, workspaceRoot, platform });
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error(
    `No workspace-local @ts-defold/deherm CLI was found for ${paths.resolve(projectRoot)}. ` +
    `Install it with 'pnpm add -D @ts-defold/deherm' and run 'pnpm deherm generate'. ` +
    `Searched: ${candidates.join(", ")}`
  );
}

function normalizedProjectPath(value: string, workspaceRoot: string, platform: NodeJS.Platform): string {
  const paths = pathsFor(platform);
  const substituted = value.replaceAll("${workspaceFolder}", workspaceRoot);
  const resolved = paths.isAbsolute(substituted)
    ? paths.resolve(substituted)
    : paths.resolve(workspaceRoot, substituted);
  return paths.basename(resolved).toLowerCase() === "game.project" ? paths.dirname(resolved) : resolved;
}

/** Select a discovered Defold project without guessing when a workspace is ambiguous. */
export function selectDehermProject({
  projects,
  requestedProject,
  workspaceRoot,
  platform = process.platform
}: {
  projects: readonly DehermProject[];
  requestedProject?: string;
  workspaceRoot?: string;
  platform?: NodeJS.Platform;
}): DehermProject {
  if (projects.length === 0) throw new Error("No game.project was found in the selected workspace");
  const scoped = workspaceRoot
    ? projects.filter((project) => samePath(
        pathsFor(platform).resolve(project.workspaceRoot),
        pathsFor(platform).resolve(workspaceRoot),
        platform
      ))
    : [...projects];
  if (workspaceRoot && scoped.length === 0) {
    throw new Error(`No game.project was found in workspace folder ${pathsFor(platform).resolve(workspaceRoot)}`);
  }
  const candidates = [...scoped];

  if (requestedProject?.trim()) {
    const base = workspaceRoot ?? candidates[0].workspaceRoot;
    const requested = normalizedProjectPath(requestedProject, base, platform);
    const exact = candidates.find((project) => samePath(
      pathsFor(platform).resolve(project.projectRoot), requested, platform
    ));
    if (exact) return exact;

    // `${workspaceFolder}` is intentionally a convenient initial config. It
    // selects the one Defold project inside that folder, but never picks one of
    // several nested projects by accident.
    if (workspaceRoot && samePath(requested, pathsFor(platform).resolve(workspaceRoot), platform) && candidates.length === 1) {
      return candidates[0];
    }
    throw new Error(`The debug project '${requestedProject}' does not resolve to a discovered game.project`);
  }

  if (candidates.length === 1) return candidates[0];
  throw new Error(
    `The workspace contains ${candidates.length} Defold projects; set 'project' to the intended game.project directory`
  );
}

function processEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value === "string") result[name] = value;
  }
  result.ELECTRON_RUN_AS_NODE = "1";
  return result;
}

export function languageServerLaunch({
  cliPath,
  projectRoot,
  nodeExecutable = process.platform === "win32" ? "node.exe" : "node",
  environment = process.env
}: {
  cliPath: string;
  projectRoot: string;
  nodeExecutable?: string;
  environment?: NodeJS.ProcessEnv;
}): ProcessLaunch {
  const root = path.resolve(projectRoot);
  return {
    command: nodeExecutable,
    args: [path.resolve(cliPath), "language-server", "--stdio", "--project", root],
    cwd: root,
    env: processEnvironment(environment)
  };
}

export function debugAdapterLaunch({
  cliPath,
  projectRoot,
  inspectorSession,
  replaceDebugger = false,
  nodeExecutable = process.platform === "win32" ? "node.exe" : "node",
  environment = process.env
}: {
  cliPath: string;
  projectRoot: string;
  inspectorSession?: string;
  replaceDebugger?: boolean;
  nodeExecutable?: string;
  environment?: NodeJS.ProcessEnv;
}): ProcessLaunch {
  const root = path.resolve(projectRoot);
  const args = [path.resolve(cliPath), "debug", "--project", root];
  if (inspectorSession?.trim()) {
    args.push("--inspector-session", path.isAbsolute(inspectorSession)
      ? path.resolve(inspectorSession)
      : path.resolve(root, inspectorSession));
  }
  if (replaceDebugger) args.push("--replace-debugger");
  return {
    command: nodeExecutable,
    args,
    cwd: root,
    env: processEnvironment(environment)
  };
}
