// Adds a resource namespace to the name-shaped parameters of the pinned script
// API.
//
// The namespace is read out of the pinned documentation itself: the parameter's
// value shape says it carries a name, the documented noun says which kind of
// name, and the module or a sibling address parameter says which resource the
// name is declared in. Routes that do not satisfy all three carry an explicit
// unresolved marker and are never checked.

const NAME_MEMBERS = new Set(["string", "hash", "nil"]);
const ADDRESS_MEMBERS = new Set(["string", "hash", "url", "nil"]);
const STOP_WORDS = new Set([
  "a", "an", "and", "as", "be", "by", "for", "from", "hashed", "in", "is", "must",
  "of", "on", "optional", "or", "that", "the", "this", "to", "which", "with"
]);

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unionMembers(rawType) {
  return String(rawType ?? "").split("|").map((part) => part.trim()).filter(Boolean);
}

/** Classify a parameter's value shape without consulting its name or route. */
export function parameterValueShape(rawType) {
  const members = unionMembers(rawType);
  if (!members.length) return "other";
  if (members.every((member) => ADDRESS_MEMBERS.has(member)) && members.includes("url") && members.includes("string")) {
    return "address";
  }
  if (members.every((member) => NAME_MEMBERS.has(member)) && members.includes("string")) return "name";
  return "other";
}

function normalize(value) {
  return String(value).toLowerCase().replaceAll(/[^a-z0-9]+/g, "");
}

/**
 * Candidate nouns for a parameter, kept separate by where they came from.
 *
 * The identifier is the parameter's own claim about what it holds; the
 * description is prose about the call. They are not equally strong evidence,
 * so the caller weighs them differently.
 */
export function documentedNouns(parameter) {
  const identifier = new Set();
  const name = String(parameter.rawName ?? "");
  if (name) {
    identifier.add(normalize(name));
    const segments = name.split("_").filter(Boolean);
    for (const segment of segments) identifier.add(normalize(segment));
    for (let index = 1; index < segments.length; index += 1) {
      identifier.add(normalize(`${segments[index - 1]}${segments[index]}`));
    }
  }
  const words = String(parameter.description ?? "")
    .toLowerCase()
    .replaceAll(/`[^`]*`/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOP_WORDS.has(word));
  const described = new Set(words.map(normalize));
  const pairs = new Set();
  for (let index = 1; index < words.length; index += 1) {
    pairs.add(normalize(`${words[index - 1]}${words[index]}`));
    described.add(normalize(`${words[index - 1]}${words[index]}`));
  }
  identifier.delete("");
  described.delete("");
  pairs.delete("");
  return { identifier, described, pairs };
}

/**
 * Decide whether a parameter really carries a name of `kind`.
 *
 * The identifier naming the kind outright is enough. Prose alone is not: the
 * description of `gui.new_text_node`'s text argument mentions a node without
 * carrying a node id, so a documented kind is accepted only where the prose
 * also pairs it with an identity word.
 */
function carriesKind(nouns, kind) {
  const normalized = normalize(kind);
  if (nouns.identifier.has(normalized)) return true;
  if (!nouns.described.has(normalized)) return false;
  return ["id", "name"].some((identity) =>
    nouns.pairs.has(`${normalized}${identity}`) || nouns.pairs.has(`${identity}${normalized}`));
}

function namespaceIndex(schema) {
  const byExtension = new Map();
  const byKind = new Map();
  for (const resource of schema.resources) {
    byExtension.set(resource.extension.replace(/^\./, ""), resource);
    for (const namespace of resource.namespaces) {
      const key = normalize(namespace.kind);
      if (!byKind.has(key)) byKind.set(key, []);
      byKind.get(key).push(namespace.id);
    }
  }
  return { byExtension, byKind };
}

/**
 * Derive the resource namespace classification for one pinned script route.
 *
 * `scope` says where a literal resolves:
 *  - `attached-resource`: the resource the compiled component is attached to.
 *  - `addressed-component-resource`: the resource bound to the component the
 *    sibling address parameter names.
 *  - `component-address`: a Defold address literal, resolved against the
 *    owning game object and its collection.
 */
export function classifyRouteResourceNamespaces(fn, index) {
  const parameters = fn.parameters ?? [];
  const addressParameter = parameters.findIndex(({ rawType }) => parameterValueShape(rawType) === "address");
  const moduleName = (fn.modulePath ?? []).join(".");
  const moduleResource = index.byExtension.get(moduleName);
  // A route whose member introduces a resource names it rather than resolving
  // it, so a miss against the declared set would be the normal case.
  const declaringMember = /^(?:new|create|add)(?:_|$)/.test(String(fn.member ?? ""));
  const rows = [];
  for (const [position, parameter] of parameters.entries()) {
    const shape = parameterValueShape(parameter.rawType);
    const base = { position, parameter: parameter.rawName, rawType: parameter.rawType, valueShape: shape };
    if (shape === "address") {
      rows.push({
        ...base,
        resourceNamespace: {
          scope: "component-address",
          namespaces: ["go:component", "collection:instance"]
        }
      });
      continue;
    }
    if (shape !== "name") {
      rows.push({ ...base, resourceNamespace: null });
      continue;
    }
    const nouns = documentedNouns(parameter);
    const moduleMatches = (moduleResource?.namespaces ?? [])
      .filter((namespace) => carriesKind(nouns, namespace.kind))
      .map(({ id }) => id);
    if (moduleMatches.length === 1) {
      rows.push({
        ...base,
        resourceNamespace: declaringMember
          ? { unresolved: "declaring-route-introduces-the-name", declares: moduleMatches }
          : addressParameter >= 0
            ? { scope: "addressed-component-resource", namespaces: moduleMatches, addressParameter }
            : { scope: "attached-resource", namespaces: moduleMatches }
      });
      continue;
    }
    if (moduleMatches.length > 1) {
      rows.push({ ...base, resourceNamespace: { unresolved: "ambiguous-module-namespace" } });
      continue;
    }
    const kindMatches = [...index.byKind.entries()]
      .filter(([kind]) => carriesKind(nouns, kind))
      .flatMap(([, ids]) => ids)
      .sort(compare);
    if (!kindMatches.length) {
      rows.push({ ...base, resourceNamespace: { unresolved: "no-documented-declaration-noun" } });
      continue;
    }
    if (addressParameter < 0) {
      rows.push({ ...base, resourceNamespace: { unresolved: "no-address-parameter-to-scope-the-name" } });
      continue;
    }
    rows.push({
      ...base,
      resourceNamespace: declaringMember
        ? { unresolved: "declaring-route-introduces-the-name", declares: kindMatches }
        : { scope: "addressed-component-resource", namespaces: kindMatches, addressParameter }
    });
  }
  return rows;
}

/** Build the full classification over the pinned script API IR. */
export function buildResourceNamespaceClassification({ ir, schema, interfaceNameFor, parameterIdentifier }) {
  const index = namespaceIndex(schema);
  const routes = [];
  for (const fn of [...ir.functions].sort((left, right) => compare(left.id, right.id))) {
    const rows = classifyRouteResourceNamespaces(fn, index);
    const classified = rows.filter(({ resourceNamespace }) => resourceNamespace !== null);
    if (!classified.length) continue;
    routes.push({
      id: fn.id,
      rawName: fn.rawName,
      modulePath: fn.modulePath,
      member: fn.member,
      jsName: fn.jsName,
      declaringInterface: interfaceNameFor(fn),
      parameters: classified.map((row) => ({
        ...row,
        jsParameter: parameterIdentifier(row.parameter, row.position)
      }))
    });
  }
  // A namespace whose names can also be introduced at runtime is not a closed
  // set, so a literal that misses the declared names is not a typo. The pinned
  // API decides this for itself: a declaring route naming the kind is the
  // evidence that the namespace stays open.
  const runtimeExtensible = new Set();
  for (const route of routes) {
    for (const { resourceNamespace } of route.parameters) {
      for (const id of resourceNamespace.declares ?? []) runtimeExtensible.add(id);
    }
  }
  for (const route of routes) {
    for (const row of route.parameters) {
      const namespace = row.resourceNamespace;
      if (namespace.unresolved || namespace.scope === "component-address") continue;
      const remaining = namespace.namespaces.filter((id) => !runtimeExtensible.has(id));
      if (remaining.length === namespace.namespaces.length) continue;
      row.resourceNamespace = remaining.length
        ? { ...namespace, namespaces: remaining }
        : { unresolved: "runtime-extensible-namespace" };
    }
  }
  const counts = { resolved: 0, unresolved: 0, address: 0 };
  const unresolvedReasons = {};
  const namespaceCounts = {};
  for (const route of routes) {
    for (const { resourceNamespace } of route.parameters) {
      if (resourceNamespace.unresolved) {
        counts.unresolved += 1;
        unresolvedReasons[resourceNamespace.unresolved] = (unresolvedReasons[resourceNamespace.unresolved] ?? 0) + 1;
        continue;
      }
      if (resourceNamespace.scope === "component-address") counts.address += 1;
      else counts.resolved += 1;
      for (const id of resourceNamespace.namespaces) {
        namespaceCounts[id] = (namespaceCounts[id] ?? 0) + 1;
      }
    }
  }
  return {
    counts,
    runtimeExtensibleNamespaces: [...runtimeExtensible].sort(compare),
    unresolvedReasons: Object.fromEntries(Object.entries(unresolvedReasons).sort(([a], [b]) => compare(a, b))),
    namespaceCounts: Object.fromEntries(Object.entries(namespaceCounts).sort(([a], [b]) => compare(a, b))),
    routes
  };
}
