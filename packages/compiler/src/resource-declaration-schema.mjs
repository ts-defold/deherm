// Derives Defold's resource declaration namespaces from pinned upstream
// sources. Nothing here is a symbol allowlist: the extension -> message
// binding comes from bob's own builder annotations, and the declaration sites
// come from the shape of the protobuf messages those builders parse.

import { indexProtoMessages, parseProtoSource } from "./protobuf-schema.mjs";

const SCALAR_TYPES = new Set([
  "double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64",
  "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes"
]);

const GENERIC_IDENTITY_FIELDS = new Set(["id", "name"]);

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Split a Java/proto CamelCase simple name into words, keeping acronym runs whole. */
export function camelWords(value) {
  return String(value).match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
}

function singular(value) {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("sses")) return value.slice(0, -2);
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

/** Read `@ProtoParams(srcClass = X.class)` + `@BuilderParams(inExts = ...)` pairs. */
export function parseBuilderAnnotations(source, file) {
  const imports = new Map();
  for (const match of source.matchAll(/^[\t ]*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
    const qualified = match[1];
    imports.set(qualified.split(".").pop(), qualified);
  }
  const results = [];
  const pattern =
    /@ProtoParams\s*\(([^)]*)\)\s*@BuilderParams\s*\(((?:[^()]|\([^()]*\))*)\)\s*public\s+(?:static\s+)?(?:final\s+)?class/g;
  for (const match of source.matchAll(pattern)) {
    const [, protoArguments, builderArguments] = match;
    const srcClass = /srcClass\s*=\s*([\w.]+)\.class/.exec(protoArguments)?.[1];
    if (!srcClass) continue;
    const inExts = /inExts\s*=\s*(\{[^}]*\}|"[^"]*")/.exec(builderArguments)?.[1] ?? "";
    const extensions = [...inExts.matchAll(/"([^"]+)"/g)].map(([, value]) => value);
    if (!extensions.length) continue;
    const head = srcClass.split(".")[0];
    const imported = imports.get(head);
    results.push({
      file,
      srcClass,
      qualifiedSrcClass: imported
        ? [imported, ...srcClass.split(".").slice(1)].join(".")
        : srcClass,
      extensions
    });
  }
  return results;
}

function protoLookupKey(javaPackage, outerClassname, messagePath) {
  return `${javaPackage}.${outerClassname}.${messagePath}`;
}

/** Index parsed proto files by the Java class name bob imports them under. */
export function indexProtoByJavaClass(parsedFiles) {
  const index = new Map();
  for (const parsed of parsedFiles) {
    const javaPackage = parsed.options.java_package;
    const outer = parsed.options.java_outer_classname;
    if (!javaPackage || !outer) continue;
    const messages = indexProtoMessages(parsed);
    for (const [qualified, message] of messages) {
      const relative = parsed.package ? qualified.slice(parsed.package.length + 1) : qualified;
      index.set(protoLookupKey(javaPackage, outer, relative), { parsed, message, qualified, messages });
    }
  }
  return index;
}

function elementMessage(field, owner, messages, parsed) {
  if (SCALAR_TYPES.has(field.type)) return null;
  const candidates = [
    `${owner}.${field.type}`,
    parsed.package && field.type.startsWith(`${parsed.package}.`) ? field.type : null,
    `${parsed.package}.${field.type}`,
    field.type
  ].filter(Boolean);
  for (const candidate of candidates) {
    const message = messages.get(candidate);
    if (message) return { qualified: candidate, message };
  }
  // Walk enclosing scopes the way protobuf name resolution does.
  const parts = owner.split(".");
  while (parts.length > 1) {
    parts.pop();
    const candidate = `${parts.join(".")}.${field.type}`;
    const message = messages.get(candidate);
    if (message) return { qualified: candidate, message };
  }
  return null;
}

function identityField(message) {
  const strings = message.fields.filter((field) =>
    field.type === "string" &&
    field.label !== "repeated" &&
    field.options?.["resource"] !== true &&
    field.options?.["runtime_only"] !== true);
  const named = strings.find((field) => GENERIC_IDENTITY_FIELDS.has(field.name));
  if (named) return named.name;
  if (strings.length === 1) return strings[0].name;
  return null;
}

/**
 * Collect declaration sites of one root message.
 *
 * A declaration site is a repeated sub-message field whose element carries an
 * identity string field. Sites reached through another declaration site are
 * marked nested: their names live inside a declared object, not in the
 * resource's own addressable space.
 */
export function collectDeclarationSites(root, messages, parsed) {
  const sites = [];
  const seen = new Set();
  function visit(qualified, message, fieldPath, nested, depth) {
    if (depth > 4 || seen.has(`${qualified}\0${fieldPath.join(".")}`)) return;
    seen.add(`${qualified}\0${fieldPath.join(".")}`);
    for (const field of message.fields) {
      if (field.label !== "repeated") continue;
      const element = elementMessage(field, qualified, messages, parsed);
      if (!element) continue;
      const identity = identityField(element.message);
      const nextPath = [...fieldPath, field.name];
      if (identity) {
        sites.push({
          fieldPath: nextPath.join("."),
          field: field.name,
          elementMessage: element.qualified.split(".").pop(),
          identityField: identity,
          nested
        });
      }
      visit(element.qualified, element.message, nextPath, nested || Boolean(identity), depth + 1);
    }
  }
  visit(root.qualified, root.message, [], false, 0);
  return sites;
}

/**
 * Name a merged group by the words its fields already share.
 *
 * `vertex_constants` and `fragment_constants` declare into one space, and the
 * shared tail `constant` is the name Defold's own documentation uses for it.
 * A single-site group keeps its whole field name, so `particlefxs` stays
 * `particlefx` instead of decomposing into an acronym.
 */
function commonFieldKind(fields) {
  if (fields.length === 1) return fields[0];
  const parts = fields.map((field) => field.split("_"));
  let tail = [];
  for (let index = 1; index <= Math.min(...parts.map(({ length }) => length)); index += 1) {
    const candidate = parts[0].slice(-index);
    if (!parts.every((words) => words.slice(-index).join("_") === candidate.join("_"))) break;
    tail = candidate;
  }
  return tail.length ? tail.join("_") : fields[0];
}

/** Group a resource's declaration sites into addressable namespaces. */
export function groupNamespaces(extension, sites) {
  const groups = new Map();
  for (const site of sites) {
    if (site.nested) continue;
    const words = camelWords(site.elementMessage.replace(/Desc$/, ""));
    const key = `${site.identityField}\0${(words.at(-1) ?? site.elementMessage).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(site);
  }
  const namespaces = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) =>
      left.field.length - right.field.length || compare(left.field, right.field));
    const primary = ordered[0];
    const kind = GENERIC_IDENTITY_FIELDS.has(primary.identityField)
      ? commonFieldKind(ordered.map(({ field }) => singular(field)))
      : primary.identityField;
    namespaces.push({
      id: `${extension.replace(/^\./, "")}:${kind}`,
      kind,
      identityField: primary.identityField,
      sites: ordered.map(({ fieldPath, elementMessage, identityField: field }) =>
        ({ fieldPath, elementMessage, identityField: field }))
    });
  }
  return namespaces.sort((left, right) => compare(left.id, right.id));
}

/**
 * Build the complete schema from pinned builder annotations and proto sources.
 *
 * `builders` is the parsed annotation list; `protoFiles` the parsed `.proto`
 * sources. Extensions whose message cannot be resolved become blockers rather
 * than silently disappearing.
 */
export function buildResourceDeclarationSchema({ builders, protoFiles }) {
  const parsedFiles = protoFiles.map(({ file, source }) => parseProtoSource(source, file));
  const javaIndex = indexProtoByJavaClass(parsedFiles);
  const resources = [];
  const blockers = [];
  for (const builder of builders) {
    const resolved = javaIndex.get(builder.qualifiedSrcClass);
    if (!resolved) {
      blockers.push({
        reason: "unresolved-src-class",
        srcClass: builder.qualifiedSrcClass,
        builder: builder.file,
        extensions: builder.extensions
      });
      continue;
    }
    const sites = collectDeclarationSites(
      { qualified: resolved.qualified, message: resolved.message },
      resolved.messages,
      resolved.parsed
    );
    for (const extension of builder.extensions) {
      const namespaces = groupNamespaces(extension, sites);
      if (!namespaces.length) continue;
      resources.push({
        extension,
        rootMessage: resolved.qualified,
        proto: resolved.parsed.file,
        namespaces
      });
    }
  }
  resources.sort((left, right) => compare(left.extension, right.extension));
  blockers.sort((left, right) => compare(left.srcClass, right.srcClass));
  return { resources, blockers };
}
