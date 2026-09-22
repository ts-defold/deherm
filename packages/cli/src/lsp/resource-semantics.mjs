import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function portable(value) {
  return value.split(path.sep).join("/");
}

function declarationLocation(projectRoot, resource, line = 1) {
  if (!resource?.startsWith("/") || resource.startsWith("/builtins/")) return null;
  const absolute = path.resolve(projectRoot, `.${resource}`);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
  return {
    uri: pathToFileURL(absolute).href,
    range: {
      start: { line: Math.max(0, line - 1), character: 0 },
      end: { line: Math.max(0, line - 1), character: 0 }
    }
  };
}

function literalAt(text, position) {
  const lines = text.split(/\r?\n/u);
  const line = lines[position.line] ?? "";
  const cursor = Math.min(position.character, line.length);
  let quote = -1;
  let quoteCharacter = "";
  let closing = -1;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    let escapes = 0;
    for (let before = index - 1; before >= 0 && line[before] === "\\"; before -= 1) escapes += 1;
    if (escapes % 2 === 1) continue;
    if (!quoteCharacter) {
      if (character !== '"' && character !== "'" && character !== "`") continue;
      quote = index;
      quoteCharacter = character;
      continue;
    }
    if (character !== quoteCharacter) continue;
    if (cursor > quote && cursor <= index) {
      closing = index;
      break;
    }
    quote = -1;
    quoteCharacter = "";
  }
  if (quote < 0) return null;
  if (cursor <= quote) return null;
  const end = closing >= cursor ? closing : cursor;
  return {
    value: line.slice(quote + 1, end),
    prefix: line.slice(quote + 1, cursor),
    range: {
      start: { line: position.line, character: quote + 1 },
      end: { line: position.line, character: end }
    }
  };
}

function addSymbol(symbols, symbol) {
  const key = `${symbol.insertText}\0${symbol.detail}\0${symbol.location?.uri ?? ""}\0${symbol.location?.range?.start?.line ?? -1}`;
  if (!symbols.has(key)) symbols.set(key, symbol);
}

function symbolsForDocument(table, projectRoot, relativeDocument) {
  const symbols = new Map();
  for (const [resource, namespaces] of Object.entries(table.declarations ?? {})) {
    addSymbol(symbols, {
      insertText: resource,
      label: resource,
      detail: `Defold resource`,
      documentation: `Project resource ${resource}`,
      kind: 17,
      location: declarationLocation(projectRoot, resource)
    });
    for (const [namespace, declarations] of Object.entries(namespaces ?? {})) {
      for (const declaration of declarations ?? []) {
        addSymbol(symbols, {
          insertText: declaration.name,
          label: declaration.name,
          detail: namespace,
          documentation: `${namespace} declared by ${resource}`,
          kind: 12,
          location: declarationLocation(projectRoot, resource, declaration.line)
        });
      }
    }
  }

  const attachment = table.components?.[relativeDocument];
  const gameObjectPath = attachment?.gameObject;
  const gameObject = gameObjectPath ? table.gameObjects?.[gameObjectPath] : null;
  for (const [name, component] of Object.entries(gameObject?.components ?? {})) {
    addSymbol(symbols, {
      insertText: `#${name}`,
      label: `#${name}`,
      detail: `component · ${component.type || "unknown"}`,
      documentation: `${name} on ${gameObjectPath}`,
      kind: 18,
      location: declarationLocation(projectRoot, gameObjectPath, component.line)
    });
  }

  const collectionPath = attachment?.collection;
  const collection = collectionPath ? table.collections?.[collectionPath] : null;
  for (const [name, instance] of Object.entries(collection?.instances ?? {})) {
    addSymbol(symbols, {
      insertText: `/${name}`,
      label: `/${name}`,
      detail: "collection instance",
      documentation: `${name} in ${collectionPath}${instance.prototype ? ` · ${instance.prototype}` : ""}`,
      kind: 18,
      location: declarationLocation(projectRoot, collectionPath, instance.line)
    });
    for (const [componentName, component] of Object.entries(table.gameObjects?.[instance.prototype]?.components ?? {})) {
      addSymbol(symbols, {
        insertText: `/${name}#${componentName}`,
        label: `/${name}#${componentName}`,
        detail: `component address · ${component.type || "unknown"}`,
        documentation: `${componentName} on ${instance.prototype}, instance ${name}`,
        kind: 18,
        location: declarationLocation(projectRoot, instance.prototype, component.line)
      });
    }
  }

  return [...symbols.values()].sort((left, right) => left.label.localeCompare(right.label));
}

/** A content-keyed view over the generated Defold project symbol table. */
export function createResourceSemanticIndex(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const symbolFile = path.resolve(options.symbolFile ?? path.join(root, ".deherm", "generated", "resource-symbols.json"));
  let cached = null;
  let cachedIdentity = "";

  async function load() {
    let information;
    try {
      information = await stat(symbolFile);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`generated Defold resource symbols are missing at ${symbolFile}; run 'deherm generate'`);
      }
      throw error;
    }
    const identity = `${information.size}:${information.mtimeMs}`;
    if (cached && cachedIdentity === identity) return cached;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(symbolFile, "utf8"));
    } catch (error) {
      throw new Error(`generated Defold resource symbols are malformed at ${symbolFile}; run 'deherm generate': ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.schemaVersion !== 1 || typeof parsed.declarations !== "object" || typeof parsed.components !== "object") {
      throw new Error(`unsupported resource symbol table at ${symbolFile}; run 'deherm generate'`);
    }
    cached = parsed;
    cachedIdentity = identity;
    return cached;
  }

  function relativeDocument(uri) {
    if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
    let absolute;
    try {
      absolute = fileURLToPath(uri);
    } catch {
      return null;
    }
    const relative = portable(path.relative(root, absolute));
    if (relative.startsWith("../") || path.isAbsolute(relative)) return null;
    return relative;
  }

  return {
    symbolFile,
    invalidate() {
      cached = null;
      cachedIdentity = "";
    },
    async complete(uri, text, position) {
      const literal = literalAt(text, position);
      const relative = relativeDocument(uri);
      if (!literal || !relative) return [];
      const symbols = symbolsForDocument(await load(), root, relative);
      return symbols
        .filter(({ insertText }) => !literal.prefix || insertText.startsWith(literal.prefix) || insertText.includes(literal.prefix))
        .map((symbol) => ({
          label: symbol.label,
          kind: symbol.kind,
          detail: symbol.detail,
          documentation: { kind: "markdown", value: symbol.documentation },
          textEdit: { range: literal.range, newText: symbol.insertText },
          data: { deherm: true, insertText: symbol.insertText }
        }));
    },
    async hover(uri, text, position) {
      const literal = literalAt(text, position);
      const relative = relativeDocument(uri);
      if (!literal || !relative) return null;
      const matches = symbolsForDocument(await load(), root, relative).filter(({ insertText }) => insertText === literal.value);
      if (!matches.length) return null;
      return {
        contents: {
          kind: "markdown",
          value: matches.map(({ label, detail, documentation }) => `**${label}** — ${detail}\n\n${documentation}`).join("\n\n---\n\n")
        },
        range: literal.range
      };
    },
    async definition(uri, text, position) {
      const literal = literalAt(text, position);
      const relative = relativeDocument(uri);
      if (!literal || !relative) return null;
      const locations = symbolsForDocument(await load(), root, relative)
        .filter(({ insertText, location }) => insertText === literal.value && location)
        .map(({ location }) => location);
      return locations.length ? locations : null;
    }
  };
}

export { literalAt };
