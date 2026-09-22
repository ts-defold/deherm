import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

export const inspectorSessionSchemaVersion = 1;

export function defaultInspectorSessionFile(projectRoot) {
  return path.join(path.resolve(projectRoot), ".deherm", "dev", "inspector.json");
}

function assertLoopbackUrl(value, field, protocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Inspector session ${field} is not a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`Inspector session ${field} must use ${protocols.join(" or ")}`);
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]") {
    throw new Error(`Inspector session ${field} must be loopback-only`);
  }
  return parsed;
}

export function validateInspectorSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Inspector session must be a JSON object");
  }
  if (value.schemaVersion !== inspectorSessionSchemaVersion || value.kind !== "deherm-inspector-session") {
    throw new Error(`Unsupported inspector session schema: ${value.schemaVersion ?? "missing"}`);
  }
  if (typeof value.sessionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.sessionId)) {
    throw new Error("Inspector session has no valid sessionId");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error("Inspector session has no valid pid");
  if (typeof value.projectRoot !== "string" || !path.isAbsolute(value.projectRoot)) {
    throw new Error("Inspector session projectRoot must be absolute");
  }
  if (!Number.isSafeInteger(value.enginePort) || value.enginePort < 1 || value.enginePort > 65_535) {
    throw new Error("Inspector session enginePort is invalid");
  }
  if (!Number.isSafeInteger(value.devtoolsPort) || value.devtoolsPort < 1 || value.devtoolsPort > 65_535) {
    throw new Error("Inspector session devtoolsPort is invalid");
  }
  const devtools = assertLoopbackUrl(value.devtoolsUrl, "devtoolsUrl", ["http:"]);
  const websocket = assertLoopbackUrl(value.websocketUrl, "websocketUrl", ["ws:"]);
  if (Number(devtools.port) !== value.devtoolsPort || Number(websocket.port) !== value.devtoolsPort) {
    throw new Error("Inspector session URL ports do not match devtoolsPort");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("Inspector session createdAt is invalid");
  }
  return value;
}

export function createInspectorSession(values) {
  return validateInspectorSession({
    schemaVersion: inspectorSessionSchemaVersion,
    kind: "deherm-inspector-session",
    sessionId: values.sessionId ?? randomUUID(),
    pid: values.pid ?? process.pid,
    projectRoot: path.resolve(values.projectRoot),
    createdAt: values.createdAt ?? new Date().toISOString(),
    enginePort: values.enginePort,
    devtoolsPort: values.devtoolsPort,
    devtoolsUrl: values.devtoolsUrl,
    websocketUrl: values.websocketUrl
  });
}

export async function writeInspectorSession(file, value) {
  const session = validateInspectorSession(value);
  const destination = path.resolve(file);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

export async function readInspectorSession(file) {
  const source = path.resolve(file);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`No live inspector session at ${source}`);
    throw new Error(`Could not read inspector session ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateInspectorSession(parsed);
}

export async function removeOwnedInspectorSession(file, sessionId) {
  const source = path.resolve(file);
  let current;
  try {
    current = await readInspectorSession(source);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("No live inspector session")) return false;
    throw error;
  }
  if (current.sessionId !== sessionId) return false;
  await rm(source, { force: true });
  return true;
}
