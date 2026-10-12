import { appendFileSync, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliRelativePath = path.join("node_modules", "@ts-defold", "deherm", "bin", "deherm.mjs");
const actionDirectory = path.dirname(fileURLToPath(import.meta.url));

export function resolveProject(workspace, project) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error("GITHUB_WORKSPACE must be an absolute path");
  if (!project || path.isAbsolute(project))
    throw new Error("project must be a nonempty path relative to GITHUB_WORKSPACE");
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, project);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("project must stay inside GITHUB_WORKSPACE");
  }
  if (!existsSync(path.join(resolved, "game.project"))) {
    throw new Error(`No game.project found in project directory: ${resolved}`);
  }
  const realRoot = realpathSync(root);
  const realProject = realpathSync(resolved);
  if (realProject !== realRoot && !realProject.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("project must not resolve outside GITHUB_WORKSPACE");
  }
  return resolved;
}

export function resolveInstalledCli(project, workspace) {
  const root = path.resolve(workspace);
  for (let directory = project; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, cliRelativePath);
    if (existsSync(candidate)) return candidate;
    if (directory === root) break;
  }
  throw new Error(
    "@ts-defold/deherm is not installed in the project or workspace; install dependencies before this Action",
  );
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validatedBuildServer(mode, rawUrl, allowInsecureHttp = false) {
  if (!["defold", "local", "external"].includes(mode)) {
    throw new Error("mode must be defold, local, or external");
  }
  if (mode === "defold") {
    if (rawUrl) throw new Error("build-server must be empty in defold mode");
    return null;
  }
  if (!rawUrl) throw new Error(`build-server is required in ${mode} mode`);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("build-server must be a valid URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("build-server must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  if (mode === "local" && !isLoopback(url.hostname)) {
    throw new Error("local mode requires a loopback Extender URL on this runner");
  }
  if (mode === "external" && url.protocol === "http:" && !isLoopback(url.hostname) && !allowInsecureHttp) {
    throw new Error("external HTTP requires allow-insecure-http=true; HTTPS is recommended for source uploads");
  }
  return url.origin;
}

export function bundleArguments(config) {
  const { project, target, variant, applicationMode, entry, mode, buildServer, allowInsecureHttp } = config;
  if (!target || !/^[A-Za-z0-9_-]+$/.test(target)) throw new Error("target must be one Defold target identifier");
  if (!["debug", "release"].includes(variant)) throw new Error("variant must be debug or release");
  if (!["dynamic", "static"].includes(applicationMode)) throw new Error("application-mode must be dynamic or static");
  const url = validatedBuildServer(mode, buildServer, allowInsecureHttp);
  const args = [
    "bundle",
    "--project",
    project,
    "--target",
    target,
    "--variant",
    variant,
    "--application-mode",
    applicationMode,
    "--json",
  ];
  if (entry) args.push("--entry", entry);
  if (url) args.push("--build-server", url);
  return args;
}

export function parseBundleOutput(stdout) {
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new Error("deherm bundle did not return its expected JSON result");
  }
  if (!result || typeof result.bundleOutput !== "string" || !path.isAbsolute(result.bundleOutput)) {
    throw new Error("deherm bundle did not return an absolute bundleOutput path");
  }
  if (/[\r\n]/.test(result.bundleOutput)) throw new Error("deherm bundle output path contains a line break");
  if (!existsSync(result.bundleOutput)) throw new Error("deherm bundle reported an output path that does not exist");
  const output = realpathSync(result.bundleOutput);
  if (!statSync(output).isDirectory()) throw new Error("deherm bundle output must be a directory");
  if (/[\r\n]/.test(output)) throw new Error("deherm bundle output path contains a line break");
  return output;
}

async function runCli(cli, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderrTail = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk).slice(-8192);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      const diagnostic = stderrTail.trim();
      reject(new Error(`deherm bundle exited ${code}${diagnostic ? `: ${diagnostic}` : ""}`));
    });
  });
}

export async function main(env = process.env) {
  if (!env.GITHUB_WORKSPACE) throw new Error("GITHUB_WORKSPACE is not set");
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const project = resolveProject(workspace, env.DEHERM_ACTION_PROJECT ?? ".");
  const cli = resolveInstalledCli(project, workspace);
  const args = bundleArguments({
    project,
    target: env.DEHERM_ACTION_TARGET,
    variant: env.DEHERM_ACTION_VARIANT ?? "release",
    applicationMode: env.DEHERM_ACTION_APPLICATION_MODE ?? "dynamic",
    entry: env.DEHERM_ACTION_ENTRY ?? "",
    mode: env.DEHERM_ACTION_MODE ?? "defold",
    buildServer: env.DEHERM_ACTION_BUILD_SERVER ?? "",
    allowInsecureHttp: parseBooleanInput(env.DEHERM_ACTION_ALLOW_INSECURE_HTTP ?? "false"),
  });
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is not set; this script must run as a GitHub Action");
  const stdout = await runCli(cli, args, project);
  const bundleOutput = parseBundleOutput(stdout);
  appendFileSync(env.GITHUB_OUTPUT, `bundle-path=${bundleOutput}\n`);
  process.stdout.write(`Déherm bundle ready: ${bundleOutput}\n`);
}

function parseBooleanInput(value) {
  if (value !== "true" && value !== "false") throw new Error("allow-insecure-http must be true or false");
  return value === "true";
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(actionDirectory, "run.mjs")) {
  main().catch((error) => {
    process.stderr.write(`Déherm Action: ${error.message}\n`);
    const annotation = `Déherm Action: ${error.message}`
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    process.stdout.write(`::error::${annotation}\n`);
    process.exitCode = 1;
  });
}
