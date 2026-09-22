import { readFile } from "node:fs/promises";
import path from "node:path";

export const liveValuesPollIntervalMs = 1_000;
export const liveValuesMaximumAgeMs = 5_000;
export const inspectorDescriptorRelativePath = path.join(".deherm", "dev", "inspector.json");
const maximumStateBytes = 2 * 1024 * 1024;

export interface InspectorStateDescriptor {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly stateUrl: string;
  readonly authToken: string;
}

export interface LiveValueLens {
  readonly targetId: string;
  readonly componentId: string;
  readonly title: string;
}

interface SnapshotValue {
  readonly kind?: unknown;
  readonly value?: unknown;
  readonly reason?: unknown;
  readonly socket?: unknown;
  readonly reserved?: unknown;
  readonly path?: unknown;
  readonly fragment?: unknown;
}

interface LiveProperty {
  readonly name?: unknown;
  readonly value?: SnapshotValue;
}

interface EnrichedInstance {
  readonly componentId?: unknown;
  readonly source?: unknown;
  readonly schemaStatus?: unknown;
  readonly instanceId?: { readonly slot?: unknown; readonly generation?: unknown };
  readonly properties?: readonly LiveProperty[];
}

interface DevTarget {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly connectionEpoch?: unknown;
  readonly componentSnapshot?: {
    readonly sampledAt?: unknown;
    // Older or malicious peers may still include raw rows here. They are
    // intentionally ignored; only the server-enriched sibling projection is
    // eligible for display.
    readonly instances?: readonly EnrichedInstance[];
  } | null;
  readonly instances?: readonly EnrichedInstance[];
}

export interface DevState {
  readonly schemaVersion: 1;
  readonly kind: "deherm-dev-state";
  readonly modelVersion: number;
  readonly targets: readonly DevTarget[];
}

export type StatePollResult =
  | { readonly kind: "unchanged"; readonly etag?: string }
  | { readonly kind: "updated"; readonly etag?: string; readonly state: DevState };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loopbackStateUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.pathname !== "/deherm/dev/v1/snapshot" || parsed.search || parsed.hash ||
      parsed.username || parsed.password) return undefined;
  return parsed.href;
}

export function parseInspectorStateDescriptor(value: unknown, projectRoot: string): InspectorStateDescriptor | undefined {
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== "deherm-inspector-session" ||
      typeof value.sessionId !== "string" || typeof value.projectRoot !== "string" ||
      path.resolve(value.projectRoot) !== path.resolve(projectRoot) ||
      typeof value.authToken !== "string" || !/^[A-Za-z0-9_-]{43,}$/u.test(value.authToken)) return undefined;
  const stateUrl = loopbackStateUrl(value.stateUrl);
  if (!stateUrl) return undefined;
  return {
    sessionId: value.sessionId,
    projectRoot: path.resolve(value.projectRoot),
    stateUrl,
    authToken: value.authToken
  };
}

export async function readInspectorStateDescriptor(
  projectRoot: string,
  readText: (file: string) => Promise<string> = (file) => readFile(file, "utf8")
): Promise<InspectorStateDescriptor | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readText(path.join(projectRoot, inspectorDescriptorRelativePath)));
    return parseInspectorStateDescriptor(parsed, projectRoot);
  } catch {
    return undefined;
  }
}

function parseDevState(value: unknown): DevState | undefined {
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== "deherm-dev-state" ||
      !Number.isSafeInteger(value.modelVersion) || Number(value.modelVersion) < 0 || !Array.isArray(value.targets)) return undefined;
  return value as unknown as DevState;
}

export async function pollInspectorState({
  descriptor,
  etag,
  fetchState = globalThis.fetch,
  signal
}: {
  descriptor: InspectorStateDescriptor;
  etag?: string;
  fetchState?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<StatePollResult> {
  const response = await fetchState(descriptor.stateUrl, {
    method: "GET",
    headers: {
      authorization: `Bearer ${descriptor.authToken}`,
      ...(etag ? { "if-none-match": etag } : {})
    },
    cache: "no-store",
    redirect: "error",
    signal
  });
  const nextEtag = response.headers.get("etag") ?? undefined;
  if (response.status === 304) return { kind: "unchanged", etag: nextEtag ?? etag };
  if (!response.ok) throw new Error(`déherm dev state request failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumStateBytes) {
    throw new Error("déherm dev state response exceeds the 2 MiB limit");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maximumStateBytes) {
    throw new Error("déherm dev state response exceeds the 2 MiB limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("déherm dev state response is invalid JSON");
  }
  const state = parseDevState(parsed);
  if (!state) throw new Error("déherm dev state response is invalid");
  return { kind: "updated", state, etag: nextEtag };
}

function sameSource(projectRoot: string, source: unknown, documentPath: string): boolean {
  if (typeof source !== "string" || path.isAbsolute(source)) return false;
  const resolved = path.resolve(projectRoot, source);
  const relative = path.relative(path.resolve(projectRoot), resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return resolved === path.resolve(documentPath);
}

function finiteNumber(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

export function formatSnapshotValue(value: SnapshotValue | undefined): string {
  if (!value || typeof value.kind !== "string") return "unavailable";
  switch (value.kind) {
    case "nil": return "nil";
    case "boolean": return typeof value.value === "boolean" ? String(value.value) : "unavailable";
    case "number": return finiteNumber(value.value) ?? "unavailable";
    case "string": {
      if (typeof value.value !== "string") return "unavailable";
      const compact = value.value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
      const clipped = compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
      return JSON.stringify(clipped);
    }
    case "hash": return typeof value.value === "string" ? `#${value.value}` : "unavailable";
    case "vector3":
    case "vector4":
    case "quaternion": {
      if (!Array.isArray(value.value) || value.value.some((lane) => finiteNumber(lane) === undefined)) return "unavailable";
      return `(${value.value.map(String).join(", ")})`;
    }
    case "url": {
      const lanes = [value.socket, value.reserved, value.path, value.fragment];
      return lanes.every((lane) => typeof lane === "string") ? `url(${lanes.join(":")})` : "unavailable";
    }
    case "unavailable": return typeof value.reason === "string" ? `‹${value.reason}›` : "unavailable";
    default: return "unavailable";
  }
}

function instanceIdentity(instance: EnrichedInstance): string {
  const slot = instance.instanceId?.slot;
  const generation = instance.instanceId?.generation;
  return Number.isSafeInteger(slot) && Number.isSafeInteger(generation) ? ` [${slot}:${generation}]` : "";
}

function label(value: unknown, maximum = 48): string {
  const singleLine = String(value).replace(/[\u0000-\u001f\u007f]/gu, "�");
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

function instanceTitle(targetId: string, instance: EnrichedInstance): string {
  const properties = Array.isArray(instance.properties) ? instance.properties : [];
  const rendered = properties.slice(0, 3).map((property) =>
    `${typeof property.name === "string" ? label(property.name, 32) : "?"}=${formatSnapshotValue(property.value)}`);
  if (properties.length > 3) rendered.push(`+${properties.length - 3}`);
  const componentId = label(instance.componentId);
  return `$(pulse) ${label(targetId)} · ${componentId}${instanceIdentity(instance)}${rendered.length ? ` · ${rendered.join(", ")}` : ""}`;
}

export function liveValueLenses({
  state,
  projectRoot,
  documentPath,
  now = Date.now(),
  maximumAgeMs = liveValuesMaximumAgeMs,
  maximumLenses = 6
}: {
  state: DevState | undefined;
  projectRoot: string;
  documentPath: string;
  now?: number;
  maximumAgeMs?: number;
  maximumLenses?: number;
}): LiveValueLens[] {
  if (!state || !/\.(?:script|gui|render)\.ts$/u.test(documentPath)) return [];
  const lenses: LiveValueLens[] = [];
  for (const target of state.targets) {
    if (typeof target.id !== "string" || target.status === "disconnected" ||
        !Number.isSafeInteger(target.connectionEpoch) || !target.componentSnapshot) continue;
    const sampledAt = target.componentSnapshot.sampledAt;
    if (typeof sampledAt !== "number" || !Number.isFinite(sampledAt) ||
        sampledAt > now + maximumAgeMs || now - sampledAt > maximumAgeMs) continue;
    const instances = Array.isArray(target.instances) ? target.instances : [];
    for (const instance of instances) {
      // Source ownership and schema status are server-enriched fields. Their
      // absence is not guessed from component ids or filenames here.
      if (!instance || instance.schemaStatus !== "current" || typeof instance.componentId !== "string" ||
          !sameSource(projectRoot, instance.source, documentPath)) continue;
      lenses.push({
        targetId: target.id,
        componentId: instance.componentId,
        title: instanceTitle(target.id, instance)
      });
    }
  }
  return lenses
    .sort((left, right) => left.targetId.localeCompare(right.targetId) || left.title.localeCompare(right.title))
    .slice(0, Math.max(0, maximumLenses));
}
