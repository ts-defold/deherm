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
  /** Trusted editor-owned identity; never derived from runtime component data. */
  readonly navigation: LiveValueNavigation;
}

export interface LiveValueHint {
  readonly propertyName: string;
  readonly label: string;
  readonly tooltip: string;
}

export interface PropertyDeclarationAnchor {
  readonly propertyName: string;
  readonly line: number;
}

export interface LiveValueNavigation {
  readonly projectRoot: string;
  readonly documentPath: string;
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

type CurrentEnrichedInstance = EnrichedInstance & { readonly componentId: string };

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

function liveInstances({
  state,
  projectRoot,
  documentPath,
  now,
  maximumAgeMs
}: {
  state: DevState | undefined;
  projectRoot: string;
  documentPath: string;
  now: number;
  maximumAgeMs: number;
}): Array<{ readonly targetId: string; readonly instance: CurrentEnrichedInstance }> {
  if (!state || !/\.(?:script|gui|render)\.ts$/u.test(documentPath)) return [];
  const matches: Array<{ targetId: string; instance: CurrentEnrichedInstance }> = [];
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
      matches.push({ targetId: target.id, instance: instance as CurrentEnrichedInstance });
    }
  }
  return matches;
}

/** Locate authored Defold property declarations without trusting runtime coordinates. */
export function findPropertyDeclarationAnchors(
  sourceText: string,
  propertyNames: ReadonlySet<string>
): PropertyDeclarationAnchor[] {
  let masked = "";
  let state: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" = "code";
  let escaped = false;
  for (let index = 0; index < sourceText.length; index += 1) {
    const current = sourceText[index];
    const next = sourceText[index + 1];
    if (state === "code") {
      if (current === "/" && next === "/") {
        masked += "  ";
        index += 1;
        state = "line-comment";
      } else if (current === "/" && next === "*") {
        masked += "  ";
        index += 1;
        state = "block-comment";
      } else if (current === "'") {
        masked += " ";
        state = "single";
      } else if (current === '"') {
        masked += " ";
        state = "double";
      } else if (current === "`") {
        masked += " ";
        state = "template";
      } else {
        masked += current;
      }
      continue;
    }
    if (current === "\n") {
      masked += "\n";
      if (state === "line-comment" || state === "single" || state === "double") state = "code";
      escaped = false;
      continue;
    }
    masked += " ";
    if (state === "line-comment") continue;
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        masked += " ";
        index += 1;
        state = "code";
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (current === "\\") {
      escaped = true;
      continue;
    }
    if ((state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")) state = "code";
  }

  const anchors: PropertyDeclarationAnchor[] = [];
  const seen = new Set<string>();
  // Defold property declarations are object fields. Requiring the authored key
  // to begin a line avoids treating a regular-expression body as a declaration
  // while still allowing the factory call to wrap onto following lines.
  const declaration = /^[\t ]*([A-Za-z_$][\w$]*)[\t ]*:[\t \r\n]*property[\t ]*\./gmu;
  let scannedOffset = 0;
  let line = 0;
  for (const match of masked.matchAll(declaration)) {
    const propertyName = match[1];
    if (!propertyNames.has(propertyName) || seen.has(propertyName) || match.index === undefined) continue;
    seen.add(propertyName);
    while (scannedOffset < match.index) {
      if (masked.charCodeAt(scannedOffset) === 10) line += 1;
      scannedOffset += 1;
    }
    anchors.push({ propertyName, line });
  }
  return anchors;
}

export function liveValueHints({
  state,
  projectRoot,
  documentPath,
  now = Date.now(),
  maximumAgeMs = liveValuesMaximumAgeMs,
  maximumHints = 24
}: {
  state: DevState | undefined;
  projectRoot: string;
  documentPath: string;
  now?: number;
  maximumAgeMs?: number;
  maximumHints?: number;
}): LiveValueHint[] {
  const values: Array<{
    propertyName: string;
    targetId: string;
    componentId: string;
    identity: string;
    value: string;
  }> = [];
  for (const { targetId, instance } of liveInstances({ state, projectRoot, documentPath, now, maximumAgeMs })) {
    const identity = instanceIdentity(instance);
    const properties = Array.isArray(instance.properties) ? instance.properties : [];
    for (const property of properties) {
      if (typeof property.name !== "string" || !/^[A-Za-z_$][\w$]*$/u.test(property.name)) continue;
      values.push({
        propertyName: property.name,
        targetId: label(targetId),
        componentId: label(instance.componentId),
        identity,
        value: formatSnapshotValue(property.value)
      });
    }
  }
  values.sort((left, right) => left.propertyName.localeCompare(right.propertyName) ||
      left.targetId.localeCompare(right.targetId) || left.componentId.localeCompare(right.componentId));
  const grouped = new Map<string, typeof values>();
  for (const value of values) {
    const group = grouped.get(value.propertyName) ?? [];
    group.push(value);
    grouped.set(value.propertyName, group);
  }
  return [...grouped.entries()].slice(0, Math.max(0, maximumHints)).map(([propertyName, entries]) => {
    const visible = entries.slice(0, 3).map((entry) =>
      `${entry.identity || ` [${entry.targetId}/${entry.componentId}]`} = ${entry.value}`);
    if (entries.length > 3) visible.push(` · +${entries.length - 3}`);
    const tooltipEntries = entries.slice(0, 16).map((entry) =>
      `${entry.targetId} · ${entry.componentId}${entry.identity} · ${label(propertyName, 32)}=${entry.value}`);
    if (entries.length > 16) tooltipEntries.push(`+${entries.length - 16} more live instances`);
    return {
      propertyName,
      label: `live ${label(propertyName, 32)}${visible.join(" ·")}`,
      tooltip: tooltipEntries.join("\n")
    };
  });
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
  const lenses: LiveValueLens[] = [];
  for (const { targetId, instance } of liveInstances({ state, projectRoot, documentPath, now, maximumAgeMs })) {
    lenses.push({
      targetId,
      componentId: instance.componentId,
      title: instanceTitle(targetId, instance),
      navigation: {
        projectRoot: path.resolve(projectRoot),
        documentPath: path.resolve(documentPath)
      }
    });
  }
  return lenses
    .sort((left, right) => left.targetId.localeCompare(right.targetId) || left.title.localeCompare(right.title))
    .slice(0, Math.max(0, maximumLenses));
}
