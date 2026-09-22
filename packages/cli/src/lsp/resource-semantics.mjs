import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function portable(value) {
  return value.split(path.sep).join("/");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function locationForProjectPath(projectRoot, projectPath, line = 1, column = 1) {
  if (typeof projectPath !== "string" || !projectPath) return null;
  if (projectPath.startsWith("/builtins/")) return null;
  const relativePath = projectPath.startsWith("/") ? `.${projectPath}` : projectPath;
  const absolute = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
  const position = {
    line: Math.max(0, Number.isInteger(line) ? line - 1 : 0),
    character: Math.max(0, Number.isInteger(column) ? column - 1 : 0)
  };
  return { uri: pathToFileURL(absolute).href, range: { start: position, end: position } };
}

function declarationLocation(projectRoot, resource, line = 1) {
  if (!resource?.startsWith("/")) return null;
  return locationForProjectPath(projectRoot, resource, line);
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
  if (quote < 0 || cursor <= quote) return null;
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

function positionOffset(text, position) {
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) return text.length;
    offset = newline + 1;
  }
  let end = text.indexOf("\n", offset);
  if (end < 0) end = text.length;
  if (end > offset && text[end - 1] === "\r") end -= 1;
  return Math.min(offset + Math.max(0, position.character), end);
}

function addSymbol(symbols, symbol) {
  const key = `${symbol.insertText}\0${symbol.detail}\0${symbol.location?.uri ?? ""}\0${symbol.location?.range?.start?.line ?? -1}`;
  if (!symbols.has(key)) symbols.set(key, symbol);
}

function declarationSymbols(table, projectRoot, namespaces = null, resources = null) {
  const symbols = new Map();
  const acceptedNamespaces = namespaces ? new Set(namespaces) : null;
  const acceptedResources = resources ? new Set(resources) : null;
  for (const [resource, declarationsByNamespace] of Object.entries(table.declarations ?? {})) {
    if (acceptedResources && !acceptedResources.has(resource)) continue;
    for (const [namespace, declarations] of Object.entries(declarationsByNamespace ?? {})) {
      if (acceptedNamespaces && !acceptedNamespaces.has(namespace)) continue;
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
  return [...symbols.values()];
}

function addressSymbols(table, projectRoot, relativeDocument, namespaces = null) {
  const symbols = new Map();
  const accepted = new Set(namespaces ?? ["go:component", "collection:instance"]);
  const attachment = table.components?.[relativeDocument];
  const gameObjectPath = attachment?.gameObject;
  const gameObject = gameObjectPath ? table.gameObjects?.[gameObjectPath] : null;
  if (accepted.has("go:component")) {
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
  }

  const collectionPath = attachment?.collection;
  const collection = collectionPath ? table.collections?.[collectionPath] : null;
  for (const [name, instance] of Object.entries(collection?.instances ?? {})) {
    if (accepted.has("collection:instance")) {
      addSymbol(symbols, {
        insertText: `/${name}`,
        label: `/${name}`,
        detail: "collection instance",
        documentation: `${name} in ${collectionPath}${instance.prototype ? ` · ${instance.prototype}` : ""}`,
        kind: 18,
        location: declarationLocation(projectRoot, collectionPath, instance.line)
      });
    }
    if (!accepted.has("go:component")) continue;
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
  return [...symbols.values()];
}

function broadSymbols(table, projectRoot, relativeDocument) {
  const symbols = new Map();
  for (const resource of Object.keys(table.declarations ?? {})) {
    addSymbol(symbols, {
      insertText: resource,
      label: resource,
      detail: "Defold resource",
      documentation: `Project resource ${resource}`,
      kind: 17,
      location: declarationLocation(projectRoot, resource)
    });
  }
  for (const symbol of declarationSymbols(table, projectRoot)) addSymbol(symbols, symbol);
  for (const symbol of addressSymbols(table, projectRoot, relativeDocument)) addSymbol(symbols, symbol);
  return [...symbols.values()];
}

function interfaceNamespace(interfaceName) {
  const stem = interfaceName.endsWith("Api") ? interfaceName.slice(0, -3) : interfaceName;
  return stem ? `${stem[0].toLowerCase()}${stem.slice(1)}` : stem;
}

function scanTokens(text) {
  const tokens = [];
  const identifierStart = /[A-Za-z_$]/u;
  const identifierPart = /[A-Za-z0-9_$]/u;
  const expressionPrefixKeywords = new Set([
    "await", "break", "case", "continue", "delete", "do", "else", "in",
    "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield"
  ]);
  const controlParentheses = new Set(["catch", "for", "if", "switch", "while", "with"]);
  const parentheses = [];
  const canEndExpression = (token) => {
    if (!token) return false;
    if (["string", "interpolated-template", "number", "regular-expression"].includes(token.kind)) return true;
    if (token.kind === "identifier") return !expressionPrefixKeywords.has(token.value);
    if (token.value === ")") return !token.controlClose;
    // `}` is syntactically ambiguous between an object expression and a block.
    // Treat a following slash as opaque regex: a false negative is safer than
    // inventing Defold calls out of regex source text.
    return ["]", "++", "--"].includes(token.value);
  };
  let index = 0;
  while (index < text.length) {
    const start = index;
    const character = text[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index = Math.min(text.length, index + 2);
      continue;
    }
    if (character === "/") {
      const previous = tokens.at(-1);
      if (!canEndExpression(previous)) {
        index += 1;
        let characterClass = false;
        while (index < text.length) {
          if (text[index] === "\\") {
            index = Math.min(text.length, index + 2);
            continue;
          }
          if (text[index] === "[") characterClass = true;
          else if (text[index] === "]") characterClass = false;
          else if (text[index] === "/" && !characterClass) {
            index += 1;
            while (index < text.length && /[A-Za-z]/u.test(text[index])) index += 1;
            break;
          }
          index += 1;
        }
        tokens.push({ kind: "regular-expression", value: text.slice(start, index), start, end: index });
        continue;
      }
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      let interpolated = false;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index = Math.min(text.length, index + 2);
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        if (quote === "`" && text[index] === "$" && text[index + 1] === "{") interpolated = true;
        index += 1;
      }
      const closed = text[index - 1] === quote;
      tokens.push({
        kind: interpolated ? "interpolated-template" : "string",
        value: text.slice(start + 1, closed ? index - 1 : index),
        start,
        end: index
      });
      continue;
    }
    if (/[0-9]/u.test(character)) {
      index += 1;
      while (index < text.length && /[A-Za-z0-9_.]/u.test(text[index])) index += 1;
      tokens.push({ kind: "number", value: text.slice(start, index), start, end: index });
      continue;
    }
    if (identifierStart.test(character)) {
      index += 1;
      while (index < text.length && identifierPart.test(text[index])) index += 1;
      tokens.push({ kind: "identifier", value: text.slice(start, index), start, end: index });
      continue;
    }
    if (text.slice(index, index + 3) === "...") {
      tokens.push({ kind: "punctuation", value: "...", start, end: index + 3 });
      index += 3;
      continue;
    }
    const pair = text.slice(index, index + 2);
    if (["=>", "?.", "&&", "||", "??", "++", "--", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="].includes(pair)) {
      tokens.push({ kind: "punctuation", value: text.slice(index, index + 2), start, end: index + 2 });
      index += 2;
      continue;
    }
    const token = { kind: "punctuation", value: character, start, end: ++index };
    if (character === "(") {
      const previous = tokens.at(-1)?.value;
      const control = controlParentheses.has(previous) ||
        (previous === "await" && tokens.at(-2)?.value === "for");
      parentheses.push({ control });
    }
    else if (character === ")") token.controlClose = parentheses.pop()?.control ?? false;
    tokens.push(token);
  }
  return tokens;
}

function delimiterPairs(tokens) {
  const openToClose = new Map();
  const closeToOpen = new Map();
  const stack = [];
  const closes = { ")": "(", "]": "[", "}": "{" };
  for (const [index, token] of tokens.entries()) {
    if (["(", "[", "{"].includes(token.value)) stack.push([token.value, index]);
    else if (Object.hasOwn(closes, token.value)) {
      const open = stack.at(-1);
      if (!open || open[0] !== closes[token.value]) continue;
      stack.pop();
      openToClose.set(open[1], index);
      closeToOpen.set(index, open[1]);
    }
  }
  return { openToClose, closeToOpen };
}

function lexicalScopes(tokens, pairs) {
  const root = { open: -1, close: tokens.length, parent: null, bindings: new Map() };
  const scopes = [root];
  const stack = [root];
  const byOpen = new Map();
  for (const [index, token] of tokens.entries()) {
    if (token.value === "{") {
      const scope = { open: index, close: pairs.openToClose.get(index) ?? tokens.length, parent: stack.at(-1), bindings: new Map() };
      scopes.push(scope);
      byOpen.set(index, scope);
      stack.push(scope);
    } else if (token.value === "}" && stack.length > 1 && stack.at(-1).close === index) stack.pop();
  }
  const scopeAt = (index) => {
    let best = root;
    for (const scope of scopes) {
      if (scope.open < index && index < scope.close && scope.open >= best.open) best = scope;
    }
    return best;
  };
  let bindingOrder = 0;
  const bind = (scope, name, value, start = scope.open) => {
    if (!scope.bindings.has(name)) scope.bindings.set(name, []);
    scope.bindings.get(name).push({ start, value, order: bindingOrder++ });
  };
  const resolve = (name, index) => {
    for (let scope = scopeAt(index); scope; scope = scope.parent) {
      const candidates = (scope.bindings.get(name) ?? []).filter(({ start }) => start <= index);
      if (candidates.length) return candidates.toSorted((left, right) =>
        right.start - left.start || right.order - left.order)[0].value;
    }
    return null;
  };
  const addScope = (open, close, parent = scopeAt(open)) => {
    const scope = { open, close, parent, bindings: new Map() };
    scopes.push(scope);
    return scope;
  };
  const enclosingFunctionScope = (index) => {
    for (let scope = scopeAt(index); scope; scope = scope.parent) {
      if (scope.functionScope) return scope;
    }
    return root;
  };
  return { root, byOpen, scopeAt, addScope, enclosingFunctionScope, bind, resolve };
}

const BLOCKED_BINDING = Object.freeze({ kind: "blocked" });

function topLevelSegments(tokens, start, end) {
  const segments = [];
  let segmentStart = start;
  let depth = 0;
  for (let index = start; index <= end; index += 1) {
    const value = tokens[index]?.value;
    if (index === end || (value === "," && depth === 0)) {
      if (segmentStart < index) segments.push([segmentStart, index]);
      segmentStart = index + 1;
      continue;
    }
    if (["(", "[", "{"].includes(value)) depth += 1;
    else if ([")", "]", "}"].includes(value)) depth -= 1;
  }
  return segments;
}

function bindingNames(tokens, start, end) {
  while (start < end && ["...", "public", "private", "protected", "readonly"].includes(tokens[start]?.value)) start += 1;
  if (start >= end) return [];
  if (tokens[start]?.kind === "identifier") return [tokens[start].value];
  const open = tokens[start]?.value;
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return [];
  let patternEnd = start + 1;
  let depth = 1;
  while (patternEnd < end && depth > 0) {
    if (tokens[patternEnd].value === open) depth += 1;
    else if (tokens[patternEnd].value === close) depth -= 1;
    patternEnd += 1;
  }
  if (depth !== 0) return [];
  const names = [];
  for (const [segmentStart, segmentEnd] of topLevelSegments(tokens, start + 1, patternEnd - 1)) {
    let bindingStart = segmentStart;
    if (tokens[bindingStart]?.value === "...") bindingStart += 1;
    let colon = -1;
    let nested = 0;
    for (let index = bindingStart; index < segmentEnd; index += 1) {
      const value = tokens[index].value;
      if (["(", "[", "{"].includes(value)) nested += 1;
      else if ([")", "]", "}"].includes(value)) nested -= 1;
      else if (value === ":" && nested === 0) {
        colon = index;
        break;
      }
    }
    if (colon >= 0) bindingStart = colon + 1;
    names.push(...bindingNames(tokens, bindingStart, segmentEnd));
  }
  return names;
}

function parameterNames(tokens, open, close) {
  return topLevelSegments(tokens, open + 1, close)
    .flatMap(([start, end]) => bindingNames(tokens, start, end));
}

function methodHeadBefore(tokens, open) {
  const immediate = tokens[open - 1];
  if (immediate?.kind === "identifier" || immediate?.value === "]") return immediate;
  if (immediate?.value !== ">") return null;
  let depth = 1;
  let position = open - 2;
  while (position >= 0 && depth > 0) {
    if (tokens[position].value === ">") depth += 1;
    else if (tokens[position].value === "<") depth -= 1;
    position -= 1;
  }
  return depth === 0 ? tokens[position] ?? null : null;
}

function routeCatalog(table, tokens) {
  const byCall = new Map();
  const knownNamespaces = new Set();
  const routeKeys = new Set([
    ...Object.keys(table.routes ?? {}),
    ...Object.keys(table.projectMessages?.routes ?? {})
  ]);
  for (const routeKey of routeKeys) {
    const dot = routeKey.lastIndexOf(".");
    if (dot < 1) continue;
    const namespace = interfaceNamespace(routeKey.slice(0, dot));
    const member = routeKey.slice(dot + 1);
    knownNamespaces.add(namespace);
    byCall.set(`${namespace}.${member}`, routeKey);
  }

  const pairs = delimiterPairs(tokens);
  const scopes = lexicalScopes(tokens, pairs);
  const generatedSdkModules = new Set(["@deherm/project", "@ts-defold/deherm"]);
  const knownWrappers = new Set(["address", "hashLiteral"]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "import") continue;
    let from = index + 1;
    while (from < tokens.length && tokens[from].value !== "from" && tokens[from].value !== ";") from += 1;
    const moduleIndex = tokens[from]?.value === "from" && tokens[from + 1]?.kind === "string"
      ? from + 1
      : tokens[index + 1]?.kind === "string" ? index + 1 : -1;
    const statementEnd = moduleIndex >= 0 ? moduleIndex + 1 : Math.min(tokens.length, from + 1);
    const moduleName = moduleIndex >= 0 ? tokens[moduleIndex].value : null;
    const canonicalModule = generatedSdkModules.has(moduleName);
    let cursor = index + 1;
    if (tokens[cursor]?.value === "type") cursor += 1;
    if (tokens[cursor]?.kind === "identifier") {
      // Neither public package defines a default SDK namespace. A default
      // import with a Defold-shaped local name must therefore shadow it.
      scopes.bind(scopes.root, tokens[cursor].value, BLOCKED_BINDING);
      cursor += tokens[cursor + 1]?.value === "," ? 2 : 1;
    }
    if (tokens[cursor]?.value === "*" && tokens[cursor + 1]?.value === "as" && tokens[cursor + 2]?.kind === "identifier") {
      scopes.bind(scopes.root, tokens[cursor + 2].value, canonicalModule ? { kind: "sdk-namespace" } : BLOCKED_BINDING);
    }
    if (tokens[cursor]?.value === "{") {
      const close = pairs.openToClose.get(cursor);
      if (close !== undefined && close < statementEnd) {
        for (const [start, end] of topLevelSegments(tokens, cursor + 1, close)) {
          let position = start;
          if (tokens[position]?.value === "type") position += 1;
          const imported = tokens[position];
          if (imported?.kind !== "identifier") continue;
          const local = tokens[position + 1]?.value === "as" && tokens[position + 2]?.kind === "identifier"
            ? tokens[position + 2].value
            : imported.value;
          let binding = BLOCKED_BINDING;
          if (canonicalModule && knownNamespaces.has(imported.value)) {
            binding = { kind: "sdk-module", namespace: imported.value };
          } else if (canonicalModule && knownWrappers.has(imported.value)) {
            binding = { kind: "sdk-wrapper", wrapper: imported.value };
          }
          if (knownNamespaces.has(local) || knownWrappers.has(local) || binding !== BLOCKED_BINDING) {
            scopes.bind(scopes.root, local, binding);
          }
        }
      }
    }
    // Resume at the first token after the module specifier. The loop's own
    // increment performs that step; assigning `statementEnd` here skipped the
    // next token, which is itself `import` in semicolonless source.
    index = statementEnd - 1;
  }

  // Function and arrow parameters are lexical bindings. A Defold-shaped name
  // passed as a parameter is local data, not the generated SDK namespace.
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "function") {
      if (tokens[index + 1]?.kind === "identifier") {
        scopes.bind(scopes.scopeAt(index), tokens[index + 1].value, BLOCKED_BINDING);
      }
      const open = tokens.findIndex((token, position) => position > index && token.value === "(");
      const close = pairs.openToClose.get(open);
      if (open < 0 || close === undefined) continue;
      let body = close + 1;
      while (body < tokens.length && tokens[body].value !== "{" && tokens[body].value !== ";") body += 1;
      const bodyScope = scopes.byOpen.get(body);
      if (bodyScope) {
        bodyScope.functionScope = true;
        for (const name of parameterNames(tokens, open, close)) scopes.bind(bodyScope, name, BLOCKED_BINDING);
      }
      continue;
    }
    if (tokens[index]?.value !== "=>") continue;
    let bodyScope = scopes.byOpen.get(index + 1);
    if (!bodyScope) {
      const parent = scopes.scopeAt(index);
      let end = parent.close;
      let depth = 0;
      for (let position = index + 1; position < parent.close; position += 1) {
        const value = tokens[position]?.value;
        if (["(", "[", "{"].includes(value)) depth += 1;
        else if ([")", "]", "}"].includes(value)) {
          if (depth === 0) {
            end = position;
            break;
          }
          depth -= 1;
        } else if (depth === 0 && [",", ";"].includes(value)) {
          end = position;
          break;
        }
      }
      bodyScope = scopes.addScope(index, end, parent);
    }
    if (!bodyScope) continue;
    bodyScope.functionScope = true;
    if (tokens[index - 1]?.value === ")") {
      const open = pairs.closeToOpen.get(index - 1);
      if (open !== undefined) for (const name of parameterNames(tokens, open, index - 1)) scopes.bind(bodyScope, name, BLOCKED_BINDING);
    } else if (tokens[index - 1]?.kind === "identifier") scopes.bind(bodyScope, tokens[index - 1].value, BLOCKED_BINDING);
  }

  // Object/class methods and catch clauses introduce the same parameter
  // bindings as functions. Recognize the structural `(pattern) { body }`
  // shape, while excluding statement-control parentheses.
  const controlHeads = new Set(["for", "if", "switch", "while", "with"]);
  for (const [open, close] of pairs.openToClose) {
    if (tokens[open]?.value !== "(") continue;
    const head = methodHeadBefore(tokens, open);
    if (!head || controlHeads.has(head.value) || (head.kind !== "identifier" && head.value !== "]")) continue;
    let body = close + 1;
    while (body < tokens.length && tokens[body].value !== "{" && ![";", "=>"].includes(tokens[body].value)) body += 1;
    const bodyScope = scopes.byOpen.get(body);
    if (!bodyScope) continue;
    if (head.value !== "catch") bodyScope.functionScope = true;
    for (const name of parameterNames(tokens, open, close)) scopes.bind(bodyScope, name, BLOCKED_BINDING);
  }

  // Local declarations bind only their lexical scope. Direct aliases retain a
  // canonical module identity; every other initializer blocks route matching.
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (!["const", "let", "var"].includes(tokens[index]?.value)) continue;
    const scope = tokens[index].value === "var" ? scopes.enclosingFunctionScope(index) : scopes.scopeAt(index);
    let cursor = index + 1;
    while (cursor < tokens.length) {
      const patternStart = cursor;
      let depth = 0;
      while (cursor < tokens.length) {
        const value = tokens[cursor].value;
        if (depth === 0 && ["=", ",", ";"].includes(value)) break;
        if (["(", "[", "{"].includes(value)) depth += 1;
        else if ([")", "]", "}"].includes(value)) {
          if (depth === 0) break;
          depth -= 1;
        }
        cursor += 1;
      }
      const patternEnd = cursor;
      const names = bindingNames(tokens, patternStart, patternEnd);
      let initializerStart = -1;
      let initializerEnd = -1;
      if (tokens[cursor]?.value === "=") {
        initializerStart = ++cursor;
        depth = 0;
        while (cursor < tokens.length) {
          const value = tokens[cursor].value;
          if (depth === 0 && [",", ";"].includes(value)) break;
          if (["(", "[", "{"].includes(value)) depth += 1;
          else if ([")", "]", "}"].includes(value)) {
            if (depth === 0) break;
            depth -= 1;
          }
          cursor += 1;
        }
        initializerEnd = cursor;
      }
      let directAlias = BLOCKED_BINDING;
      if (names.length === 1 && tokens[patternStart]?.kind === "identifier" &&
        initializerEnd === initializerStart + 1 && tokens[initializerStart]?.kind === "identifier") {
        directAlias = scopes.resolve(tokens[initializerStart].value, index) ??
          (knownNamespaces.has(tokens[initializerStart].value)
            ? { kind: "sdk-module", namespace: tokens[initializerStart].value }
            : knownWrappers.has(tokens[initializerStart].value)
              ? { kind: "sdk-wrapper", wrapper: tokens[initializerStart].value }
            : BLOCKED_BINDING);
        if (!["sdk-module", "sdk-wrapper"].includes(directAlias.kind)) directAlias = BLOCKED_BINDING;
      }
      for (const name of names) {
        scopes.bind(scope, name, BLOCKED_BINDING);
        if (directAlias !== BLOCKED_BINDING) scopes.bind(scope, name, directAlias, index);
      }
      if (tokens[cursor]?.value !== ",") break;
      cursor += 1;
    }
  }

  const resolve = (name, index) => scopes.resolve(name, index) ??
    (knownNamespaces.has(name)
      ? { kind: "sdk-module", namespace: name }
      : knownWrappers.has(name)
        ? { kind: "sdk-wrapper", wrapper: name }
        : BLOCKED_BINDING);
  return { byCall, knownNamespaces, resolve };
}

function callPathBefore(tokens, open) {
  const path = [];
  let index = open - 1;
  if (tokens[index]?.kind !== "identifier") return null;
  path.unshift(tokens[index].value);
  index -= 1;
  while (tokens[index]?.value === "." && tokens[index - 1]?.kind === "identifier") {
    path.unshift(tokens[index - 1].value);
    index -= 2;
    if (tokens[index]?.value === "?") index -= 1;
  }
  return path;
}

function argumentRanges(tokens, open) {
  const ranges = [];
  let start = open + 1;
  let depth = 0;
  for (let index = open + 1; index <= tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (["(", "[", "{"].includes(value)) depth += 1;
    else if (["]", "}"].includes(value)) depth -= 1;
    else if (value === ")") {
      if (depth === 0) {
        ranges.push([start, index]);
        return ranges;
      }
      depth -= 1;
    } else if (value === "," && depth === 0) {
      ranges.push([start, index]);
      start = index + 1;
    }
  }
  ranges.push([start, tokens.length]);
  return ranges;
}

function staticStringFromRange(tokens, range, resolve) {
  if (!range) return null;
  const selected = tokens.slice(range[0], range[1]);
  if (selected.length === 1 && selected[0].kind === "string") return selected[0].value;
  const wrapper = selected[0]?.kind === "identifier" ? resolve(selected[0].value, range[0]) : BLOCKED_BINDING;
  if (selected.length === 4 && wrapper.kind === "sdk-wrapper" && selected[1].value === "(" &&
    selected[2].kind === "string" && selected[3].value === ")") return selected[2].value;
  return null;
}

function directLiteralFromRange(tokens, range, literalIndex, resolve) {
  if (!range) return null;
  const selected = tokens.slice(range[0], range[1]);
  if (selected.length === 1 && range[0] === literalIndex && selected[0].kind === "string") return selected[0].value;
  const wrapper = selected[0]?.kind === "identifier" ? resolve(selected[0].value, range[0]) : BLOCKED_BINDING;
  if (selected.length === 4 && range[0] + 2 === literalIndex && wrapper.kind === "sdk-wrapper" && selected[1].value === "(" &&
    selected[2].kind === "string" && selected[3].value === ")") return selected[2].value;
  return null;
}

function semanticContextAt(table, text, position) {
  const offset = positionOffset(text, position);
  const tokens = scanTokens(text);
  const literalIndex = tokens.findIndex((token) => token.kind === "string" && offset > token.start && offset <= token.end);
  if (literalIndex < 0) return { kind: "ignored" };
  const { byCall, knownNamespaces, resolve } = routeCatalog(table, tokens);
  const opens = [];
  for (let index = 0; index < literalIndex; index += 1) {
    if (tokens[index].value === "(") opens.push(index);
    else if (tokens[index].value === ")") opens.pop();
  }
  for (const open of opens.toReversed()) {
    const ranges = argumentRanges(tokens, open);
    const argumentIndex = ranges.findIndex(([start, end]) => literalIndex >= start && literalIndex < end);
    if (argumentIndex < 0) continue;
    const callPath = callPathBefore(tokens, open);
    if (!callPath || callPath.length < 2) continue;
    const member = callPath.at(-1);
    let namespace = null;
    if (callPath.length === 2) {
      const binding = resolve(callPath[0], open);
      if (binding.kind === "sdk-module") namespace = binding.namespace;
    } else if (callPath.length === 3) {
      const binding = resolve(callPath[0], open);
      if (binding.kind === "sdk-namespace" && knownNamespaces.has(callPath[1])) namespace = callPath[1];
    }
    if (!namespace) continue;
    const routeKey = byCall.get(`${namespace}.${member}`);
    if (!routeKey) continue;
    if (directLiteralFromRange(tokens, ranges[argumentIndex], literalIndex, resolve) === null) {
      return { kind: "none", routeKey, argumentIndex };
    }
    const parameter = table.routes?.[routeKey]?.[argumentIndex] ?? null;
    const messageRoute = table.projectMessages?.routes?.[routeKey];
    if (messageRoute?.parameter === argumentIndex && messageRoute.names === "projectMessages.names") {
      return { kind: "project-message", routeKey, argumentIndex, descriptor: messageRoute };
    }
    return {
      kind: parameter ? "resource" : "none",
      routeKey,
      argumentIndex,
      parameter,
      addressValue: parameter?.scope === "addressed-component-resource"
        ? staticStringFromRange(tokens, ranges[parameter.addressParameter], resolve)
        : null
    };
  }
  return null;
}

function componentAtAddress(table, relativeDocument, addressValue) {
  if (typeof addressValue !== "string") return null;
  const attachment = table.components?.[relativeDocument];
  if (!attachment) return null;
  if (addressValue.startsWith("#") && addressValue.length > 1) {
    return table.gameObjects?.[attachment.gameObject]?.components?.[addressValue.slice(1)] ?? null;
  }
  const match = /^\/([^#:/]+)#([^#]+)$/u.exec(addressValue);
  if (!match || !attachment.collection) return null;
  const instance = table.collections?.[attachment.collection]?.instances?.[match[1]];
  return table.gameObjects?.[instance?.prototype]?.components?.[match[2]] ?? null;
}

function resourceSymbolsForContext(table, projectRoot, relativeDocument, context) {
  const parameter = context.parameter;
  const namespaces = parameter.namespaces ?? [];
  if (parameter.scope === "component-address") {
    return addressSymbols(table, projectRoot, relativeDocument, namespaces);
  }
  if (parameter.scope === "attached-resource") {
    const resource = table.components?.[relativeDocument]?.attachedResource;
    return resource
      ? declarationSymbols(table, projectRoot, namespaces, [resource])
      : declarationSymbols(table, projectRoot, namespaces);
  }
  if (parameter.scope === "addressed-component-resource") {
    // A dynamic address cannot select one bound resource. It deliberately
    // fails open to the route's namespaces, never to unrelated project names.
    if (context.addressValue === null) return declarationSymbols(table, projectRoot, namespaces);
    const component = componentAtAddress(table, relativeDocument, context.addressValue);
    if (!component) return [];
    const resources = new Set();
    for (const namespace of namespaces) {
      const extension = table.namespaceKinds?.[namespace]?.extension;
      const resource = extension ? component.resources?.[extension]?.path : null;
      if (resource) resources.add(resource);
    }
    return resources.size ? declarationSymbols(table, projectRoot, namespaces, resources) : [];
  }
  return [];
}

function projectMessageSymbols(table, projectRoot, descriptor) {
  const symbols = new Map();
  for (const entry of table.projectMessages?.names ?? []) {
    const evidence = [...(entry.receiverEvidence ?? []), ...(entry.senderEvidence ?? [])];
    const receiverCount = entry.receiverEvidence?.length ?? 0;
    const senderCount = entry.senderEvidence?.length ?? 0;
    const documentation = `Project message identifier from static TypeScript evidence (${receiverCount} receiver${receiverCount === 1 ? "" : "s"}, ${senderCount} sender${senderCount === 1 ? "" : "s"}).`;
    if (!evidence.length) {
      addSymbol(symbols, { insertText: entry.name, label: entry.name, detail: descriptor.role, documentation, kind: 18, location: null });
      continue;
    }
    for (const site of evidence) {
      addSymbol(symbols, {
        insertText: entry.name,
        label: entry.name,
        detail: descriptor.role,
        documentation,
        kind: 18,
        location: locationForProjectPath(projectRoot, site.source, site.line, site.column)
      });
    }
  }
  return [...symbols.values()];
}

function symbolsAt(table, projectRoot, relativeDocument, text, position) {
  const context = semanticContextAt(table, text, position);
  const symbols = context?.kind === "resource"
    ? resourceSymbolsForContext(table, projectRoot, relativeDocument, context)
    : context?.kind === "project-message"
      ? projectMessageSymbols(table, projectRoot, context.descriptor)
      : context?.kind === "none" || context?.kind === "ignored"
        ? []
        : broadSymbols(table, projectRoot, relativeDocument);
  return [...symbols].sort((left, right) =>
    compare(left.label, right.label) || compare(left.detail, right.detail) ||
    compare(String(left.location?.uri ?? ""), String(right.location?.uri ?? "")) ||
    (left.location?.range?.start?.line ?? -1) - (right.location?.range?.start?.line ?? -1));
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
      const symbols = symbolsAt(await load(), root, relative, text, position);
      const matching = symbols.filter(({ insertText }) =>
        !literal.prefix || insertText.startsWith(literal.prefix) || insertText.includes(literal.prefix));
      const unique = new Map();
      for (const symbol of matching) {
        const key = `${symbol.insertText}\0${symbol.detail}\0${symbol.documentation}`;
        if (!unique.has(key)) unique.set(key, symbol);
      }
      return [...unique.values()]
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
      const matches = symbolsAt(await load(), root, relative, text, position)
        .filter(({ insertText }) => insertText === literal.value);
      if (!matches.length) return null;
      const descriptions = [...new Set(matches.map(({ label, detail, documentation }) =>
        `**${label}** — ${detail}\n\n${documentation}`))];
      return {
        contents: {
          kind: "markdown",
          value: descriptions.join("\n\n---\n\n")
        },
        range: literal.range
      };
    },
    async definition(uri, text, position) {
      const literal = literalAt(text, position);
      const relative = relativeDocument(uri);
      if (!literal || !relative) return null;
      const locations = symbolsAt(await load(), root, relative, text, position)
        .filter(({ insertText, location }) => insertText === literal.value && location)
        .map(({ location }) => location);
      return locations.length ? locations : null;
    }
  };
}

export { literalAt, semanticContextAt };
