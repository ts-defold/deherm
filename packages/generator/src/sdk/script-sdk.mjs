import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { safeParameterIdentifier } from "../../../compiler/src/names.mjs";
import { hexBindingId, stableBindingId } from "../../../compiler/src/binding-identity.mjs";
import {
  assertUniquePublicScriptRoots,
  publicScriptModulePath,
  rawScriptRootName
} from "../../../compiler/src/script-public-api-policy.mjs";
import { componentLifecycleRecipes } from "../../../compiler/src/component-proxy-contract.mjs";

import {
  buildApiTrees,
  createTypeRenderer,
  generateIndex,
  generateModules,
  generateRuntime,
  generateTypes
} from "../../../compiler/src/sdk/script-sdk.mjs";

export {
  buildApiTrees,
  createTypeRenderer,
  generateIndex,
  generateModules,
  generateRuntime,
  generateTypes
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const archivePath = path.join(root, "upstream", "ref-doc.zip");
const generatedRoot = path.join(root, "packages", "sdk", "src", "generated", "script");
const irPath = path.join(root, "packages", "bindings", "generated", "defold-script-api-ir.json");
const documentationPath = path.join(root, "packages", "bindings", "generated", "defold-script-sdk-documentation.json");
const registrationSurfacePath = path.join(root, "packages", "bindings", "generated", "defold-lua-registration-surface.json");
const runtimeProfileCatalogPath = path.join(root, "packages", "bindings", "generated", "defold-script-route-availability-profiles.json");
const constantLoweringReportPath = path.join(root, "packages", "bindings", "generated", "defold-script-constant-lowering.json");
const handleClassificationPath = path.join(root, "packages", "bindings", "overrides", "script-borrowed-handle-classification.json");
const check = process.argv.includes("--check");
let loadScriptSemanticOverrides;
let assertReviewedRevision;
let observeReviewedSource;
let VOID;
let recordAudit;
let classifyGlobalDeclaration;
let readLifecycleCallbacks;
let documentedSurface;
let resolveDocumentedDuplication;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function loadSemanticHandleTypes(defoldRevision) {
  const policy = JSON.parse(await readFile(handleClassificationPath, "utf8"));
  assert.equal(policy.schemaVersion, 2, "borrowed-handle classification schema is unsupported");
  // The reviewed revision, compared against the revision BEING GENERATED. The
  // byte-level evidence below - every cited source file's SHA-256 and anchors,
  // read from the checkout of that revision - is what actually establishes that
  // the review still holds, and runs whether or not the revisions are equal.
  assertReviewedRevision({
    input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
    reviewed: policy.defoldRevision,
    derived: defoldRevision,
    detail: "the semantic handle kinds the generated script types are built from"
  });

  // Each cited source is OBSERVED, not asserted. A file whose bytes moved while
  // every reviewed anchor survived still carries its evidence, so its handle
  // kinds are emitted for this revision and the audit carries the new hash. A
  // file that lost an anchor has no evidence left, so its handle kinds are
  // withdrawn FOR THIS REVISION - the raw types they covered fall back to
  // unreviewed and are emitted as opaque rather than as a semantic kind we can
  // no longer justify. Withdrawal is a per-revision policy difference and a
  // queued review, reported in the CI summary; it is not a failure.
  const evidenceById = new Map();
  const withdrawn = new Set();
  for (const evidence of policy.sourceEvidence) {
    assert.ok(!evidenceById.has(evidence.id), `duplicate borrowed-handle evidence id: ${evidence.id}`);
    const sourcePath = path.join(root, "upstream", "defold", evidence.source);
    const source = await readFile(sourcePath, "utf8").catch(() => null);
    const verdict = observeReviewedSource({
      input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
      id: `${evidence.id}: borrowed-handle`,
      source,
      evidence,
      reviewed: policy.defoldRevision,
      derived: defoldRevision
    });
    if (verdict.status === VOID) withdrawn.add(evidence.id);
    evidenceById.set(evidence.id, evidence);
  }

  const rawTypeToKind = new Map();
  for (const kind of policy.handleKinds) {
    if (kind.representation === "declaration-only-token") continue;
    for (const evidenceId of kind.sourceEvidence) {
      assert.ok(evidenceById.has(evidenceId), `${kind.id}: unknown borrowed-handle source evidence: ${evidenceId}`);
    }
    // A kind rests on all of its cited evidence. If any of it went void at this
    // revision, the kind is not claimed here.
    if (kind.sourceEvidence.some((evidenceId) => withdrawn.has(evidenceId))) continue;
    for (const rawType of kind.rawTypes) {
      assert.ok(!rawTypeToKind.has(rawType), `${rawType}: assigned to multiple semantic handle kinds`);
      rawTypeToKind.set(rawType, kind.id);
    }
  }
  return rawTypeToKind;
}

function splitTopLevel(value, delimiter) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if ("<({[".includes(character)) depth += 1;
    else if (">)}]".includes(character)) depth -= 1;
    else if (character === delimiter && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function takeType(value) {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if ("<({[".includes(character)) depth += 1;
    else if (">)}]".includes(character)) depth -= 1;
    else if (/\s/.test(character) && depth === 0) return value.slice(0, index);
  }
  return value;
}

// Defold 1.13.1 HTML-escapes seven `@param`/`@return` type expressions, so
// `table<string,string>` arrives as `table&lt;string,string&gt;` and classifies
// as an undeclared type rather than a table. 1.14.0 escapes none, so unescaping
// changes nothing there. Only the TYPE is unescaped: descriptions are markup on
// purpose and are rendered as documentation.
const ENTITIES = new Map([["&lt;", "<"], ["&gt;", ">"], ["&amp;", "&"], ["&quot;", '"'], ["&#39;", "'"]]);

function unescapeType(value) {
  return value.replace(/&(?:lt|gt|amp|quot|#39);/g, (entity) => ENTITIES.get(entity) ?? entity);
}

function typeAndDescription(value) {
  const rawType = takeType(value);
  return { rawType: unescapeType(rawType), description: value.slice(rawType.length).trim() };
}

function cleanDocumentation(lines) {
  const trimmed = [...lines];
  while (trimmed.length && !trimmed[0].trim()) trimmed.shift();
  while (trimmed.length && !trimmed.at(-1).trim()) trimmed.pop();
  return trimmed.join("\n").replaceAll("*/", "* /");
}

function deprecationNotice(...values) {
  for (const value of values.flat(Infinity)) {
    if (typeof value !== "string") continue;
    const line = value.split(/\r?\n/u).map((item) => item.trim()).find((item) => /\bdeprecated\b/iu.test(item));
    if (line) return line.replace(/^\[[^\]]+\]\s*/u, "");
  }
  return undefined;
}

function documentation(value, indent = "") {
  if (!value) return [];
  return [
    `${indent}/**`,
    ...value.split("\n").map((line) => `${indent} *${line ? ` ${line}` : ""}`),
    `${indent} */`
  ];
}

function balancedOuter(value, open, close) {
  if (!value.startsWith(open) || !value.endsWith(close)) return false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === open) depth += 1;
    if (value[index] === close) depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

function pascal(value) {
  const words = value.replace(/^defold_(?:api|enum)\./, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("") || "Anonymous";
  return /^[A-Za-z_$]/.test(joined) ? joined : `_${joined}`;
}

function camel(value) {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
  return value.replace(/_([a-zA-Z0-9])/g, (_, character) => character.toUpperCase());
}

function property(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function fieldDeclaration(field, renderType) {
  const index = field.rawName.match(/^\[(string|integer|number)\]$/);
  if (index) {
    const keyType = index[1] === "string" ? "string" : "number";
    return `readonly [key: ${keyType}]: ${renderType(field.rawType)};`;
  }
  return `readonly ${property(camel(field.rawName))}${field.optional ? "?" : ""}: ${renderType(field.rawType)};`;
}

function parameterName(value, index) {
  const candidate = camel(value.replace(/\?$/, ""));
  return safeParameterIdentifier(candidate, index);
}

// Every named type mentioned by a raw type expression: `b2Body`, `b2Body|nil`,
// `table<string, b2Shape>` and `b2Joint[]` all mention handle types, and a
// presence test that only matched a bare name would miss them.
function typeNames(rawType) {
  return typeof rawType === "string" ? rawType.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [] : [];
}

function parseArchive(lifecycleNames) {
  const archive = unzipSync(new Uint8Array(requireBuffer));
  const classes = new Map();
  const aliases = new Map();
  const enums = new Map();
  const functions = [];
  // Every namespace-less declaration the archive carries, classified. Only
  // `defold-global` becomes a route; the rest are the explicit statement of
  // what we do not bind and why. See `scripts/lib/script-lifecycle-callbacks.mjs`.
  const globals = [];
  // Only the game runtime's stubs. The archive also documents the editor's own
  // LuaJIT runtime and the Lua 5.1 standard library, which are different
  // runtimes' APIs rather than parts of ours - see `documentedSurface`.
  const files = Object.keys(archive)
    .filter((name) => name.startsWith("doc/") && name.endsWith(".lua"))
    .filter((name) => documentedSurface(name) === "game-runtime")
    .sort();
  for (const source of files) {
    const lines = strFromU8(archive[source]).split(/\r?\n/);
    let currentClass;
    let pending = [];
    let docs = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line.startsWith("---") && !line.startsWith("---@")) {
        docs.push(line.slice(3));
        continue;
      }
      const annotation = line.match(/^---@([\w-]+)\s*(.*)$/);
      if (annotation) {
        const [, kind, body] = annotation;
        if (kind === "class") {
          const name = body.split(/[:\s]/, 1)[0];
          currentClass = name;
          if (!classes.has(name)) classes.set(name, { name, fields: [], source, line: lineIndex + 1, description: cleanDocumentation(docs) });
          docs = [];
        } else if (kind === "field" && currentClass) {
          const fieldMatch = body.match(/^(\S+)\s+(.+)$/);
          if (fieldMatch) {
            const rawName = fieldMatch[1];
            const parsed = typeAndDescription(fieldMatch[2]);
            classes.get(currentClass).fields.push({
              rawName: rawName.replace(/\?$/, ""),
              optional: rawName.endsWith("?"),
              rawType: parsed.rawType,
              description: cleanDocumentation([...docs, parsed.description]),
              source,
              line: lineIndex + 1
            });
            docs = [];
          }
        } else if (kind === "alias") {
          const aliasMatch = body.match(/^(\S+)\s+(.+)$/);
          if (aliasMatch) aliases.set(aliasMatch[1], { name: aliasMatch[1], rawType: aliasMatch[2], source, line: lineIndex + 1, description: cleanDocumentation(docs) });
          docs = [];
        } else if (kind === "enum") {
          const enumMatch = body.match(/^(\S+?)(?::\s*(\S+))?$/);
          if (enumMatch) enums.set(enumMatch[1], { name: enumMatch[1], rawType: enumMatch[2] ?? "integer", source, line: lineIndex + 1, description: cleanDocumentation(docs) });
          docs = [];
        }
        if (["param", "return", "overload", "generic"].includes(kind)) pending.push({ kind, body, line: lineIndex + 1 });
        continue;
      }
      const fn = line.match(/^function\s+([\w.:]+)\(([^)]*)\)\s+end\s*$/);
      if (fn) {
        const rawParameters = fn[2].split(",").map((item) => item.trim()).filter(Boolean);
        const params = pending.filter((item) => item.kind === "param").map((item, index) => {
          const match = item.body.match(/^(\S+)\s+(.+)$/);
          const rawName = match?.[1] ?? rawParameters[index] ?? `arg${index + 1}`;
          const parsed = match ? typeAndDescription(match[2]) : { rawType: "any", description: "" };
          return { rawName: rawName.replace(/\?$/, ""), optional: rawName.endsWith("?") || splitTopLevel(parsed.rawType, "|").includes("nil"), rawType: parsed.rawType, description: parsed.description };
        });
        for (const [index, rawName] of rawParameters.entries()) {
          if (!params.some((param) => param.rawName === rawName.replace(/\?$/, ""))) params.push({ rawName, optional: false, rawType: "any", source: "implicit" });
        }
        const returnItems = pending.filter((item) => item.kind === "return").map((item) => typeAndDescription(item.body));
        const parts = fn[1].split(/[.:]/);
        const member = parts.pop();
        const modulePath = parts.length ? parts : ["builtins"];
        const description = cleanDocumentation(docs);
        const deprecated = deprecationNotice(description);
        if (!parts.length) {
          // A namespace-less declaration. Defold documents three different
          // things this way and only one of them is callable API, so classify
          // before deciding whether it is a route.
          const kind = classifyGlobalDeclaration({ name: member, source, lifecycleNames });
          globals.push({ name: member, source, line: lineIndex + 1, kind });
          if (kind !== "defold-global") {
            pending = [];
            docs = [];
            continue;
          }
        }
        functions.push({
          id: `script:${fn[1]}`,
          rawName: fn[1],
          modulePath,
          member,
          jsName: camel(member),
          parameters: params,
          returns: returnItems.map((item) => item.rawType),
          returnDescriptions: returnItems.map((item) => item.description),
          overloads: pending.filter((item) => item.kind === "overload").map((item) => item.body),
          generics: pending.filter((item) => item.kind === "generic").map((item) => item.body),
          source,
          line: lineIndex + 1,
          description,
          ...(deprecated ? { deprecated } : {}),
          disposition: "generated-lua-bridge"
        });
        pending = [];
        docs = [];
      } else if (!line.startsWith("---") && line.trim()) {
        pending = [];
        docs = [];
      }
    }
  }
  // One Lua name can legitimately be documented more than once - the archive is
  // a set of per-source stub files. Resolve every such group into one route,
  // with the reason recorded, rather than emitting duplicate route ids or
  // letting the first declaration silently win. See
  // `scripts/lib/documented-route-duplication.mjs`.
  const byName = new Map();
  for (const fn of functions) {
    if (!byName.has(fn.rawName)) byName.set(fn.rawName, []);
    byName.get(fn.rawName).push(fn);
  }
  const resolved = [];
  const duplication = [];
  for (const [name, declarations] of byName) {
    const outcome = resolveDocumentedDuplication(name, declarations);
    if (declarations.length > 1 || outcome.route === null) {
      duplication.push({
        name,
        reason: outcome.reason,
        declared: declarations.length,
        variants: outcome.variants,
        sources: [...new Set(declarations.map((row) => row.source))]
      });
    }
    if (outcome.route === null) continue;
    resolved.push(outcome.variants.length || outcome.overloads.length
      ? {
          ...outcome.route,
          ...(outcome.variants.length ? { documentedVariants: outcome.variants } : {}),
          // Additional documented signatures, kept as the archive's own overload
          // spelling so `generate-script-overload-dispatch.mjs` sees them the
          // same way it sees an `---@overload` tag.
          overloads: [
            ...outcome.route.overloads,
            ...outcome.overloads.map((row) =>
              `fun(${row.parameters.map((parameter) => parameter.rawName).join(", ")})`)
          ]
        }
      : outcome.route);
  }
  return {
    files,
    classes: [...classes.values()],
    aliases: [...aliases.values()],
    enums: [...enums.values()],
    functions: resolved,
    globals,
    duplication
  };
}

function constantLiteral(entry) {
  if (entry.valueKind === "number" && typeof entry.value === "number" && Number.isFinite(entry.value)) {
    return Object.is(entry.value, -0) ? "-0" : String(entry.value);
  }
  if (entry.valueKind === "string" && typeof entry.value === "string") return JSON.stringify(entry.value);
  if (entry.valueKind === "hash" && typeof entry.value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(entry.value)) {
    return `${entry.value}n`;
  }
  return null;
}

let requireBuffer;

export function registrationScopeForSource(source) {
  if (typeof source !== "string") return { kind: "unknown", features: [] };
  const normalized = source.replaceAll("\\", "/");
  if (/\/box2d\/v2\//u.test(normalized)) return { kind: "feature-gated", features: ["box2d-v2"] };
  if (/\/box2d\/v3\//u.test(normalized)) return { kind: "feature-gated", features: ["box2d-v3"] };
  if (/\/bullet3d\//u.test(normalized)) return { kind: "feature-gated", features: ["bullet3d"] };
  const coreSources = [
    /^script\//u,
    /^render\//u,
    /^gameobject\//u,
    /^gui\//u,
    /^crash\//u,
    /^profiler\//u,
    /^timer\//u,
    /^gamesys\/src\/gamesys\/scripts\/script_/u,
    /^gamesys\/src\/gamesys\/scripts\/script\w/u
  ];
  if (coreSources.some((pattern) => pattern.test(normalized))) return { kind: "core-unconditional", features: ["core"] };
  return { kind: "unknown", features: [] };
}

export function registrationScopeForConstant(name, source, moduleFeatureRequirements = new Map()) {
  const sourceScope = registrationScopeForSource(source);
  if (sourceScope.kind === "feature-gated") return sourceScope;
  const segments = typeof name === "string" ? name.split(".") : [];
  let scope;
  for (let length = Math.max(0, segments.length - 1); length > 0; length -= 1) {
    const features = moduleFeatureRequirements.get(segments.slice(0, length).join("."));
    if (features && ((Array.isArray(features) && features.length > 0) || features.size > 0)) {
      scope = { kind: "feature-gated", features: [...features].sort() };
      break;
    }
  }
  return scope ?? sourceScope;
}
async function loadScriptConstantPolicy(defoldRevision, trees) {
  const registration = JSON.parse(await readFile(registrationSurfacePath, "utf8"));
  const profileCatalog = JSON.parse(await readFile(runtimeProfileCatalogPath, "utf8"));
  assert.equal(registration.defoldRevision, defoldRevision,
    "Lua registration surface targets a different Defold revision");
  assert.equal(profileCatalog.defoldRevision, defoldRevision,
    "Runtime profile catalog targets a different Defold revision");
  const runtimeProfiles = Object.entries(profileCatalog.profiles ?? {})
    .map(([id, profile]) => ({ id, features: new Set(profile.features ?? []) }));
  assert.ok(runtimeProfiles.length > 0, "Runtime profile catalog has no selected profiles");
  const moduleFeatureRequirements = new Map();
  for (const [feature, descriptor] of Object.entries(profileCatalog.features ?? {})) {
    if (feature === "core") continue;
    for (const route of descriptor.documentedRoutes ?? []) {
      const segments = String(route.rawName ?? "").split(".").filter(Boolean);
      for (let length = 1; length < segments.length; length += 1) {
        const module = segments.slice(0, length).join(".");
        const features = moduleFeatureRequirements.get(module) ?? new Set();
        features.add(feature);
        moduleFeatureRequirements.set(module, features);
      }
    }
  }
  const targetIds = ["defold-engine-box2d-v3", "defold-engine-box2d-v2"];
  const targetEntries = targetIds.map((id) => registration.targets?.[id]?.registeredConstants ?? []);
  assert.ok(targetEntries.every((entries) => entries.length), "Lua registration surface has no pinned Defold engine targets");
  const byTarget = targetEntries.map((entries) => new Map(entries.map((entry) => [entry.name, entry])));
  const entries = [];
  function visit(node, segments) {
    for (const field of node.fields) {
      const name = `${segments.join(".")}.${field.rawName}`;
      const candidates = byTarget.map((map) => map.get(name) ?? null);
      const first = candidates.find(Boolean);
      const sameLiteral = first && candidates.every((candidate) => candidate && candidate.valueKind === first.valueKind && candidate.value === first.value);
      const registrationScopes = candidates.flatMap((candidate, index) => candidate ? [{
        target: targetIds[index],
        ...registrationScopeForConstant(name, candidate.path, moduleFeatureRequirements)
      }] : []);
      const coreUnconditional = registrationScopes.length > 0 && registrationScopes.every(({ kind }) => kind === "core-unconditional");
      const stableId = stableBindingId(`script:constant.${name}`);
      const profiles = targetIds.map((id, index) => ({ id, registered: Boolean(candidates[index]), valueKind: candidates[index]?.valueKind ?? null, value: candidates[index]?.value ?? null }));
      const profileAvailability = sameLiteral && constantLiteral(first) && coreUnconditional
        ? {
            kind: "compile-time-intrinsic",
            profileIndependent: true,
            runtimeProfiles: runtimeProfiles.map(({ id }) => id),
            reason: "source-derived literal is registered by an unconditional core Lua table"
          }
        : first
          ? {
              kind: "runtime-profile-gated",
              profileIndependent: false,
              registrationScopes,
              runtimeProfiles: runtimeProfiles
                .filter(({ features }) => candidates.some((candidate) => candidate && (() => {
                  const scope = registrationScopeForConstant(name, candidate.path, moduleFeatureRequirements);
                  return scope.kind === "core-unconditional" ||
                    (scope.kind === "feature-gated" && scope.features.every((feature) => features.has(feature)));
                })()))
                .map(({ id }) => id)
            }
          : {
              kind: "unavailable",
              profileIndependent: false,
              runtimeProfiles: []
            };
      const entry = sameLiteral && constantLiteral(first) && coreUnconditional
        ? { name, state: "inlined", valueKind: first.valueKind, value: first.value, source: first.path, line: first.line, expression: first.expression, stableId, profiles, registrationScopes, profileAvailability }
        : first
          ? { name, state: "runtime-backed", valueKind: first.valueKind ?? "runtime", source: first.path, line: first.line, expression: first.expression, stableId, profiles, registrationScopes, profileAvailability }
          : { name, state: "profile-unavailable", valueKind: "runtime", stableId, profiles, registrationScopes, profileAvailability, blocker: { code: "constant-not-registered", reason: "not-registered-in-selected-runtime-profile" }, source: field.source, line: field.line };
      entries.push(entry);
    }
    for (const [childName, child] of node.children) visit(child, [...segments, childName]);
  }
  for (const [rootName, node] of trees) visit(node, [rawScriptRootName(rootName)]);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const profileMatrix = Object.fromEntries(targetIds.map((id) => [id, {
    registered: entries.filter((entry) => entry.profiles.find((profile) => profile.id === id)?.registered).length,
    sourceLiteral: entries.filter((entry) => entry.profiles.find((profile) => profile.id === id)?.value !== null && entry.profiles.find((profile) => profile.id === id)?.value !== undefined).length,
    inlined: entries.filter((entry) => entry.state === "inlined" && entry.profiles.find((profile) => profile.id === id)?.registered).length,
    runtimeBacked: entries.filter((entry) => entry.state === "runtime-backed" && entry.profiles.find((profile) => profile.id === id)?.registered).length,
    profileUnavailable: entries.filter((entry) => entry.state === "profile-unavailable").length,
    impossible: 0
  }]));
  return {
    schemaVersion: 1,
    kind: "deherm.script-constant-lowering",
    defoldRevision,
    policy: "packages/bindings/generated/defold-lua-registration-surface.json",
    targets: targetIds,
    entries,
    profileMatrix,
    counts: {
      total: entries.length,
      inlined: entries.filter((entry) => entry.state === "inlined").length,
      runtimeBacked: entries.filter((entry) => entry.state === "runtime-backed").length,
      profileUnavailable: entries.filter((entry) => entry.state === "profile-unavailable").length,
      impossible: entries.filter((entry) => entry.state === "impossible").length
    },
    contract: "Source-derived finite numbers, strings, and hashes are inlined only when identical across selected engine profiles and registered by an unconditional core Lua table. Equal literals from feature-gated or unknown registration scopes use a generated stable-ID universal call through the Lua adapter with mechanically derived runtime-profile availability; profile-unavailable declarations retain that route and carry a machine-readable availability blocker, while truly impossible declarations fail closed."
  };
}

async function output(file, contents) {
  if (check) {
    let current;
    try { current = await readFile(file, "utf8"); } catch { current = undefined; }
    assert.equal(current, contents, `${path.relative(root, file)} is stale; run npm run generate:script-sdk`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

export async function runScriptSdkGenerator({ semanticOnly = false } = {}) {
({ loadScriptSemanticOverrides } = await import(pathToFileURL(path.join(root, "scripts/lib/script-semantic-overrides.mjs"))));
({ assertReviewedRevision, observeReviewedSource } = await import(pathToFileURL(path.join(root, "scripts/lib/reviewed-revision.mjs"))));
({ VOID, recordAudit } = await import(pathToFileURL(path.join(root, "scripts/lib/revision-audit.mjs"))));
({ classifyGlobalDeclaration, readLifecycleCallbacks } = await import(pathToFileURL(path.join(root, "scripts/lib/script-lifecycle-callbacks.mjs"))));
({ documentedSurface, resolveDocumentedDuplication } = await import(pathToFileURL(path.join(root, "scripts/lib/documented-route-duplication.mjs"))));
requireBuffer = await readFile(archivePath);
const defoldRevision = (await readFile(path.join(root, "upstream.lock"), "utf8")).match(/^DEFOLD_REV=(\w+)$/m)?.[1] ?? "unknown";
const semanticHandleTypes = await loadSemanticHandleTypes(defoldRevision);

// Read from the engine, not assumed: which documented globals are callbacks the
// user implements rather than API the user calls. See
// `scripts/lib/script-lifecycle-callbacks.mjs` for why this is read per
// revision and what it catches.
const lifecycle = await readLifecycleCallbacks(path.join(root, "upstream", "defold"));
const model = parseArchive(lifecycle.names);

// Account for every namespace-less declaration, exhaustively. "We do not bind
// this" and "we did not notice this" must never look the same, so the classes
// have to partition the set with nothing left over.
const globalsByKind = new Map();
for (const row of model.globals) {
  if (!globalsByKind.has(row.kind)) globalsByKind.set(row.kind, []);
  globalsByKind.get(row.kind).push(row);
}
{
  const classified = [...globalsByKind.values()].reduce((total, rows) => total + rows.length, 0);
  assert.equal(classified, model.globals.length,
    "documented globals were classified into overlapping or missing classes");
  const unknown = [...globalsByKind.keys()].filter((kind) => ![
    "defold-global", "lifecycle-callback", "lua-standard-library", "editor-scripting"
  ].includes(kind));
  assert.deepEqual(unknown, [], `unaccounted documented-global classes: ${unknown.join(", ")}`);
}

// A lifecycle callback the engine declares but the component proxy contract does
// not support is a real gap in what a TypeScript author can write, and naming it
// here is what keeps it from being invisible. It is reported, not fatal: Defold
// adding a callback must not stop a revision from being derived.
const supportedLifecycle = new Set(Object.values(componentLifecycleRecipes).map(({ engineName }) => engineName));
const unsupportedLifecycle = [...lifecycle.byProxyKind].flatMap(([proxyKind, names]) =>
  names.filter((name) => !supportedLifecycle.has(name)).map((name) => `${proxyKind}.${name}`));
const semanticOverrides = await loadScriptSemanticOverrides(pathToFileURL(`${root}${path.sep}`));
const functionsById = new Map(model.functions.map((fn) => [fn.id, fn]));
for (const [id, override] of semanticOverrides) {
  const fn = functionsById.get(id);
  if (!fn) throw new Error(`Script semantic override does not match an imported function: ${id}`);
  for (const [rawName, optional] of Object.entries(override.parameterOptional)) {
    const parameter = fn.parameters.find((candidate) => candidate.rawName === rawName);
    if (!parameter) throw new Error(`Script semantic override does not match ${id} parameter ${rawName}`);
    if (typeof optional !== "boolean") throw new Error(`Script semantic override optionality must be boolean: ${id}.${rawName}`);
    parameter.optional = optional;
  }
  fn.semanticOverride = override;
}
const stableIds = new Map();
for (const fn of model.functions) {
  fn.stableId = stableBindingId(fn.id);
  const collision = stableIds.get(fn.stableId);
  // Two different ids hashing alike and one id arriving twice are different
  // faults with different fixes, and reporting a duplicate as a hash collision
  // sends a reader looking at the hash function. The archive really can declare
  // one name twice - Defold documents each script type in its own file.
  if (collision === fn.id) {
    throw new Error(
      `Duplicate script route id ${fn.id}, declared at ${fn.source}:${fn.line}. ` +
      "The reference archive documents this name more than once, so it is not a " +
      "single callable route. Classify it in scripts/lib/script-lifecycle-callbacks.mjs.");
  }
  if (collision) throw new Error(`Stable script binding ID collision ${hexBindingId(fn.stableId)}: ${collision} and ${fn.id}`);
  stableIds.set(fn.stableId, fn.id);
}
const luaCompatibility = JSON.parse(await readFile(path.join(root, "packages", "bindings", "lua-compat.json"), "utf8"));
const implementedLuaFunctions = new Set(luaCompatibility.modules.flatMap((module) =>
  module.functions.map((fn) => `${module.luaModule}.${fn.luaFunction}`)
));
for (const fn of model.functions) {
  fn.runtimeStatus = implementedLuaFunctions.has(fn.rawName)
    ? "implemented-generated-lua-bridge"
    : "requires-universal-lua-bridge";
}
const renderer = createTypeRenderer(model);
assertUniquePublicScriptRoots(new Set([
  ...model.functions.map(({ modulePath }) => modulePath[0]),
  ...model.classes
    .filter(({ name }) => name.startsWith("defold_api."))
    .map(({ name }) => name.slice("defold_api.".length).split(".")[0])
]));
const trees = buildApiTrees(model);

// Is a reviewed semantic handle type present at this revision?
//
// The test used to be "the archive declares an `---@alias` for it". That is not
// the same question, and at Defold 1.13.1 it answers wrongly for every handle
// type at once: 1.13.1 declares ZERO aliases while 1.14.0 declares 98, yet both
// annotate the very same parameters `---@param body b2Body`. The alias
// declarations are documentation Defold added later; the type was always there.
// Testing for them withdrew all sixteen handle kinds from a revision that has
// them, which then surfaced downstream as "Unknown codec 'unknown'".
//
// What establishes that a type exists at a revision is that the archive USES
// it - as a parameter type, a return type or a field type - whether or not it
// also declares it. A type that is neither declared nor mentioned anywhere is
// genuinely not part of this revision's surface: a backend that was not shipped,
// or a spelling that changed. That is a policy difference, so the kind is
// withdrawn and the raw type falls back to opaque, the same outcome as evidence
// going void. Refusing instead would mean no revision that dropped a handle type
// could ever be derived.
const referencedTypeNames = new Set();
for (const fn of model.functions) {
  for (const parameter of fn.parameters) for (const name of typeNames(parameter.rawType)) referencedTypeNames.add(name);
  for (const rawType of fn.returns) for (const name of typeNames(rawType)) referencedTypeNames.add(name);
}
for (const entry of model.classes) {
  for (const field of entry.fields) for (const name of typeNames(field.rawType)) referencedTypeNames.add(name);
}
for (const entry of model.aliases) referencedTypeNames.add(entry.name);
const absentHandleTypes = [...semanticHandleTypes.keys()]
  .filter((rawType) => !referencedTypeNames.has(rawType));
for (const rawType of absentHandleTypes) {
  semanticHandleTypes.delete(rawType);
  recordAudit({
    input: "packages/bindings/overrides/script-borrowed-handle-classification.json",
    id: `${rawType}: semantic-handle-type`,
    source: null,
    status: VOID,
    reason: "absent",
    derived: defoldRevision
  });
}
if (absentHandleTypes.length) {
  console.log(`semantic handle types withdrawn at ${defoldRevision} (absent from the archive): ${absentHandleTypes.sort().join(", ")}`);
}
const typesSource = generateTypes(model, renderer, trees, semanticHandleTypes);
const constantLowering = semanticOnly ? null : await loadScriptConstantPolicy(defoldRevision, trees);
const unresolvedTypes = [...renderer.unresolved].sort();
const ir = {
  schemaVersion: 1,
  defoldRevision,
  sourceFileCount: model.files.length,
  counts: { functions: model.functions.length, classes: model.classes.length, aliases: model.aliases.length, enums: model.enums.length },
  typeSurfaceUnresolvedCount: unresolvedTypes.length,
  unresolvedTypes,
  runtimeImplementedCount: model.functions.filter(({ runtimeStatus }) => runtimeStatus.startsWith("implemented-")).length,
  runtimeUnimplementedCount: model.functions.filter(({ runtimeStatus }) => runtimeStatus.startsWith("requires-")).length,
  // Documentation-only tags drive the generated TypeScript surface, but stay
  // out of the runtime IR so comment changes cannot invalidate bridge evidence.
  functions: model.functions.map(({ stableId: _stableId, deprecated: _deprecated, ...fn }) => fn),
  types: [...model.classes.map((item) => ({ ...item, kind: "class", disposition: "generated-type" })), ...model.aliases.map((item) => ({ ...item, kind: "alias", disposition: "generated-type" })), ...model.enums.map((item) => ({ ...item, kind: "enum", disposition: "generated-type" }))]
};
const sdkDocumentation = {
  schemaVersion: 1,
  kind: "deherm.script-sdk-documentation",
  defoldRevision,
  functions: model.functions
    .filter(({ deprecated }) => deprecated)
    .map(({ id, deprecated }) => ({ id, deprecated }))
    .sort((left, right) => left.id.localeCompare(right.id))
};
await output(irPath, `${JSON.stringify(ir, null, 2)}\n`);
await output(documentationPath, `${JSON.stringify(sdkDocumentation, null, 2)}\n`);
await output(path.join(generatedRoot, "types.ts"), typesSource);
await output(path.join(generatedRoot, "runtime.ts"), generateRuntime());
await output(path.join(generatedRoot, "index.ts"), generateIndex(trees));
if (!semanticOnly) {
  await output(path.join(generatedRoot, "modules.ts"), generateModules(trees, new Map(
    constantLowering.entries.map((entry) => [entry.name, entry])
  )));
  await output(constantLoweringReportPath, `${JSON.stringify(constantLowering, null, 2)}\n`);
}
console.log(`${check ? "checked" : "generated"} ${model.functions.length} script functions, ${model.classes.length + model.aliases.length + model.enums.length} types, ${ir.typeSurfaceUnresolvedCount} type-surface unresolved, ${ir.runtimeUnimplementedCount} runtime bindings pending`);

// The census of documented globals, always printed, so what we did not bind is
// visible rather than inferable from a count that did not move.
console.log(`documented globals: ${[...globalsByKind]
  .map(([kind, rows]) => `${rows.length} ${kind}`)
  .sort()
  .join(", ")} (${model.globals.length} total)`);
if (model.duplication.length) {
  const byReason = new Map();
  for (const row of model.duplication) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1);
  console.log(`documented duplications resolved: ${[...byReason]
    .map(([reason, count]) => `${count} ${reason}`).sort().join(", ")}`);
}
if (unsupportedLifecycle.length) {
  console.log(`engine lifecycle callbacks the component contract does not support: ${unsupportedLifecycle.join(", ")}`);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runScriptSdkGenerator();
