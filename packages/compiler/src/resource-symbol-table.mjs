// Builds the project symbol table: every name a Defold resource declares, the
// scope it is declared in, and which component source each scope belongs to.
//
// The table is derived, never authored. The declaration schema says which
// fields declare names; the project's own resources supply the names; the
// component proxy paths supply the attachment that scopes a literal.

import { componentProxyConstants } from "./component-proxy-contract.mjs";
import { messagesAt, parseProtobufText, stringField } from "./protobuf-text.mjs";

const { sourceKinds } = componentProxyConstants;

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Project-absolute Defold spelling of a project-relative path. */
export function resourcePath(relative) {
  return `/${String(relative).replaceAll("\\", "/").replace(/^\/+/, "")}`;
}

function extensionOf(value) {
  const base = String(value).split("/").pop() ?? "";
  const dot = base.indexOf(".");
  return dot < 0 ? "" : base.slice(dot);
}

/** The longest schema extension that matches, so `.a.texturesetc` style names work. */
function schemaExtension(schema, value) {
  const name = String(value).split("/").pop() ?? "";
  let best = "";
  for (const { extension } of schema.resources) {
    if (name.endsWith(extension) && extension.length > best.length) best = extension;
  }
  return best;
}

/** Proxy resource path a component source compiles to. */
export function componentProxyPath(relativeSource) {
  const kind = [...sourceKinds]
    .sort((left, right) => right.suffix.length - left.suffix.length)
    .find(({ suffix }) => relativeSource.endsWith(suffix));
  if (!kind) return null;
  return resourcePath(`${relativeSource.slice(0, -kind.suffix.length)}${kind.proxySuffix}`);
}

function everyStringField(fields, path = [], out = []) {
  for (const field of fields) {
    if (field.kind === "string") out.push({ path: [...path, field.name].join("."), value: field.value, line: field.line });
    else if (field.kind === "message") everyStringField(field.message, [...path, field.name], out);
  }
  return out;
}

/**
 * Read one resource: its declared names per namespace, plus every string field
 * so attachment and resource binding can be resolved without a second parse.
 */
export function readResource({ path: relative, source, schema }) {
  const extension = schemaExtension(schema, relative);
  const parsed = parseProtobufText(source);
  const resource = schema.resources.find((entry) => entry.extension === extension);
  const namespaces = {};
  if (resource) {
    for (const namespace of resource.namespaces) {
      const declarations = [];
      for (const site of namespace.sites) {
        for (const message of messagesAt(parsed, site.fieldPath)) {
          const identity = stringField(message.message, site.identityField);
          if (!identity) continue;
          declarations.push({ name: identity.value, line: identity.line, field: site.fieldPath });
        }
      }
      declarations.sort((left, right) => compare(left.name, right.name) || left.line - right.line);
      if (declarations.length) namespaces[namespace.id] = declarations;
    }
  }
  return {
    path: resourcePath(relative),
    extension,
    fields: parsed,
    strings: everyStringField(parsed),
    namespaces
  };
}

/** Resource paths a `.go` component binds, keyed by resource extension. */
function boundResources(schema, componentMessage, resourcesByPath) {
  const bound = {};
  const record = (value, line) => {
    if (typeof value !== "string" || !value.startsWith("/")) return;
    const extension = schemaExtension(schema, value);
    if (!extension || bound[extension]) return;
    bound[extension] = { path: value, line };
  };
  const data = componentMessage.find((field) => field.name === "data" && field.kind === "string");
  if (data) {
    for (const field of everyStringField(parseProtobufText(data.value))) {
      record(field.value, data.line);
    }
  }
  const component = stringField(componentMessage, "component");
  if (component) {
    record(component.value, component.line);
    const referenced = resourcesByPath.get(component.value);
    if (referenced) for (const field of referenced.strings) record(field.value, component.line);
  }
  return bound;
}

/**
 * Assemble the project symbol table.
 *
 * `resources` is the list produced by {@link readResource}; `componentSources`
 * the project-relative component source paths the proxy generator owns.
 */
/**
 * Every string literal spelled in a component source.
 *
 * This is deliberately textual. It supports the inverse report — declared
 * names no code mentions — and nothing else: a name a program assembles at
 * runtime is invisible here, so the report is a starting point for a human,
 * never a diagnostic.
 */
export function componentStringLiterals(sourceText) {
  const literals = new Set();
  const pattern = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`/g;
  for (const match of String(sourceText).matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (typeof value !== "string") continue;
    const unescaped = value.replaceAll(/\\(.)/g, "$1");
    literals.add(unescaped);
    // An address literal spells the declared id with a Defold sigil in front.
    for (const part of unescaped.split(/[#/:]/)) if (part) literals.add(part);
  }
  return literals;
}

/** Declared names no component source mentions as a literal. */
export function unreferencedDeclarations(declarations, literals) {
  const report = [];
  for (const [resource, namespaces] of Object.entries(declarations)) {
    for (const [namespace, names] of Object.entries(namespaces)) {
      for (const declaration of names) {
        if (literals.has(declaration.name)) continue;
        report.push({ resource, namespace, name: declaration.name, line: declaration.line });
      }
    }
  }
  return report.sort((left, right) =>
    compare(left.resource, right.resource) || compare(left.namespace, right.namespace) ||
    compare(left.name, right.name));
}

export function buildResourceSymbolTable({ schema, classification, resources, componentSources, componentTexts = new Map() }) {
  const byPath = new Map(resources.map((resource) => [resource.path, resource]));
  const namespaceKinds = {};
  for (const resource of schema.resources) {
    for (const namespace of resource.namespaces) {
      namespaceKinds[namespace.id] = { kind: namespace.kind, extension: resource.extension };
    }
  }

  const gameObjects = {};
  for (const resource of resources) {
    if (resource.extension !== ".go") continue;
    const components = {};
    for (const field of ["components", "embedded_components"]) {
      for (const message of messagesAt(resource.fields, field)) {
        const identity = stringField(message.message, "id");
        if (!identity) continue;
        const type = stringField(message.message, "type");
        const component = stringField(message.message, "component");
        components[identity.value] = {
          line: identity.line,
          type: type ? type.value : extensionOf(component?.value ?? "").replace(/^\./, ""),
          component: component ? component.value : null,
          resources: boundResources(schema, message.message, byPath)
        };
      }
    }
    gameObjects[resource.path] = { components };
  }

  const collections = {};
  for (const resource of resources) {
    if (resource.extension !== ".collection") continue;
    const instances = {};
    for (const field of ["instances", "embedded_instances", "collection_instances"]) {
      for (const message of messagesAt(resource.fields, field)) {
        const identity = stringField(message.message, "id");
        if (!identity) continue;
        instances[identity.value] = {
          line: identity.line,
          prototype: stringField(message.message, "prototype")?.value ?? null
        };
      }
    }
    collections[resource.path] = { instances };
  }

  const components = {};
  const attachmentConflicts = [];
  for (const relativeSource of [...componentSources].sort(compare)) {
    const proxy = componentProxyPath(relativeSource);
    if (!proxy) continue;
    const references = [];
    for (const resource of resources) {
      for (const field of resource.strings) {
        if (field.value === proxy) references.push({ resource, field });
      }
    }
    if (references.length !== 1) {
      components[relativeSource] = { proxy, unresolved: references.length ? "ambiguous-attachment" : "no-attachment" };
      if (references.length > 1) {
        attachmentConflicts.push({ source: relativeSource, proxy, resources: references.map(({ resource }) => resource.path) });
      }
      continue;
    }
    const [{ resource, field }] = references;
    const entry = { proxy, attachedResource: resource.path, attachedExtension: resource.extension };
    if (resource.extension === ".go") {
      entry.gameObject = resource.path;
      const owner = Object.entries(gameObjects[resource.path]?.components ?? {})
        .find(([, component]) => component.component === proxy);
      if (owner) [entry.componentId] = owner;
      else entry.componentField = field.path;
    } else {
      // A GUI or render script addresses messages from the game object that
      // instantiates its component, so the owning object is the one whose
      // component points at the attached resource.
      const hosts = Object.entries(gameObjects).filter(([, gameObject]) =>
        Object.values(gameObject.components).some((component) => component.component === resource.path));
      if (hosts.length === 1) {
        const [[hostPath, gameObject]] = hosts;
        entry.gameObject = hostPath;
        const owner = Object.entries(gameObject.components)
          .find(([, component]) => component.component === resource.path);
        if (owner) [entry.componentId] = owner;
      } else entry.gameObjectUnresolved = hosts.length ? "ambiguous-game-object" : "no-game-object";
    }
    if (entry.gameObject) {
      const owners = Object.entries(collections)
        .filter(([, collection]) => Object.values(collection.instances).some(({ prototype }) => prototype === entry.gameObject))
        .map(([path]) => path);
      if (owners.length === 1) [entry.collection] = owners;
      else entry.collectionUnresolved = owners.length ? "ambiguous-collection" : "no-collection";
    }
    components[relativeSource] = entry;
  }

  const declarations = {};
  for (const resource of resources) {
    if (Object.keys(resource.namespaces).length) declarations[resource.path] = resource.namespaces;
  }

  const routes = {};
  for (const route of classification.routes) {
    const parameters = {};
    for (const { position, parameter, jsParameter, resourceNamespace } of route.parameters) {
      if (!resourceNamespace || resourceNamespace.unresolved) continue;
      parameters[position] = { parameter, jsParameter, ...resourceNamespace };
    }
    if (!Object.keys(parameters).length) continue;
    routes[`${route.declaringInterface}.${route.jsName}`] = parameters;
  }

  const literals = new Set();
  for (const text of componentTexts.values()) {
    for (const literal of componentStringLiterals(text)) literals.add(literal);
  }

  return {
    schemaVersion: 1,
    generator: "@ts-defold/deherm resource-symbol-table/v1",
    namespaceKinds,
    runtimeExtensibleNamespaces: classification.runtimeExtensibleNamespaces ?? [],
    declarations,
    gameObjects,
    collections,
    components,
    routes,
    attachmentConflicts,
    unreferenced: {
      evidence: "literal-occurrence-in-component-sources",
      caveat: "A name a program assembles or computes at runtime is reported here; this is a review aid, never a diagnostic.",
      declarations: componentTexts.size ? unreferencedDeclarations(declarations, literals) : []
    }
  };
}
