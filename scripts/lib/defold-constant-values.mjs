// Conservative, source-derived evaluator for Lua registration constants.
//
// This is intentionally not a C++ parser.  It accepts only the literal and
// integral-expression subset used by Defold's SETCONSTANT registrations.  A
// value outside that subset remains runtime-backed (or impossible) instead of
// being guessed from documentation.

function stripComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

function matchingBrace(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(value) {
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
    else if ("([{<".includes(character)) depth += 1;
    else if (")]}>".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function sourceScopes(code, position) {
  const scopes = [];
  const stack = [];
  for (let index = 0; index < position; index += 1) {
    if (code[index] === "{") {
      const prefix = code.slice(Math.max(0, index - 192), index);
      const match = prefix.match(/(?:namespace|class|struct)\s+([A-Za-z_]\w*)\s*(?::[^{}]*)?$/);
      stack.push(match ? match[1] : null);
    } else if (code[index] === "}") stack.pop();
  }
  for (const name of stack) if (name) scopes.push(name);
  return scopes;
}

function numberLiteral(value) {
  const normalized = value.trim()
    .replace(/\b0[bB]([01]+)(?:u|U|l|L|ll|LL|ul|UL|ull|ULL)?\b/g, (_, bits) => String(parseInt(bits, 2)))
    .replace(/\b(0[xX][0-9a-fA-F]+|[0-9]+)(?:u|U|l|L|ll|LL|ul|UL|ull|ULL|f|F)\b/g, "$1")
    .replace(/\b(?:lua_Number|int(?:8|16|32|64)_t|uint(?:8|16|32|64)_t|size_t|float|double|long|short|unsigned|signed|char)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^[0-9a-fA-FxX.+\-*/%<>&|^~() \t]+$/.test(normalized)) return undefined;
  try {
    const result = Function(`"use strict"; return (${normalized});`)();
    return typeof result === "number" && Number.isFinite(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

function stringLiteral(value) {
  const trimmed = value.trim();
  if (!/^"(?:[^"\\]|\\.)*"(?:\s*"(?:[^"\\]|\\.)*")*$/.test(trimmed)) return undefined;
  let joined = "";
  for (const match of trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try { joined += JSON.parse(`"${match[1]}"`); } catch { return undefined; }
  }
  return joined;
}

function collectSymbols(files) {
  const symbols = new Map();
  const bare = new Map();
  const macros = new Map();
  const add = (name, value) => {
    if (value === undefined) return;
    symbols.set(name, value);
    const simple = name.split("::").at(-1);
    if (!bare.has(simple)) bare.set(simple, []);
    bare.get(simple).push(value);
  };
  for (const file of files) {
    const code = stripComments(file.text);
    for (const match of code.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)(?!\s*\()\s+(.+)$/gm)) {
      const body = match[2].trim();
      macros.set(match[1], body);
      add(match[1], stringLiteral(body) ?? numberLiteral(body));
    }
    for (const match of code.matchAll(/\benum(?:\s+(?:class|struct))?\s*([A-Za-z_]\w*(?:::\w+)*)?\s*(?::\s*[^\{]+)?\s*\{/g)) {
      const open = match.index + match[0].lastIndexOf("{");
      const close = matchingBrace(code, open);
      if (close < 0) continue;
      const scopes = sourceScopes(code, match.index);
      const enumName = match[1];
      const members = splitTopLevel(code.slice(open + 1, close));
      let previous = null;
      for (const member of members) {
        const parsed = member.match(/^([A-Za-z_]\w*)\s*(?:=\s*([\s\S]*))?$/);
        if (!parsed) continue;
        const qualified = [...scopes, ...(enumName ? [enumName] : []), parsed[1]].join("::");
        // Keep the expression for a second pass.  Enum members frequently
        // refer to a macro or a member declared in another header.
        const expression = parsed[2] ?? (previous ? `(${previous}) + 1` : "0");
        if (!symbols.has(qualified)) symbols.set(qualified, { expression });
        previous = qualified;
        const simple = parsed[1];
        if (!bare.has(simple)) bare.set(simple, []);
        bare.get(simple).push(symbols.get(qualified));
      }
    }
    // Integral static/constexpr declarations cover the private engine enums
    // that are exposed by registration but are not SDK header enums.
    for (const match of code.matchAll(/\b(?:static\s+)?(?:constexpr|const)\s+(?:unsigned\s+|signed\s+)?(?:long\s+long|long|short|int|uint\d*_t|int\d*_t|size_t|[A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) {
      const value = stringLiteral(match[2]) ?? numberLiteral(match[2]);
      const scopes = sourceScopes(code, match.index);
      const qualified = [...scopes, match[1]].join("::");
      if (value !== undefined) {
        add(qualified, value);
        add(match[1], value);
      } else if (!symbols.has(qualified)) {
        symbols.set(qualified, { expression: match[2] });
        if (!symbols.has(match[1])) symbols.set(match[1], { expression: match[2] });
      }
    }
  }
  return { symbols, bare, macros };
}

export function deriveConstantValues(files, registrations) {
  const collected = collectSymbols(files);
  const { symbols, bare, macros } = collected;
  const resolving = new Set();
  const resolveName = (name, preferredScopes = []) => {
    const normalized = name.replace(/\s+/g, "");
    const value = symbols.get(normalized);
    if (typeof value === "number" || typeof value === "string") return value;
    if (resolving.has(normalized)) return undefined;
    resolving.add(normalized);
    let expression = value?.expression ?? macros.get(normalized);
    if (expression === undefined && macros.has(name)) expression = macros.get(name);
    if (expression !== undefined) {
      const resolved = resolveExpression(expression);
      if (resolved !== undefined) symbols.set(normalized, resolved);
      resolving.delete(normalized);
      return resolved;
    }
    const simple = normalized.split("::").at(-1);
    for (let index = preferredScopes.length; index >= 0; index -= 1) {
      const qualified = [...preferredScopes.slice(0, index), simple].join("::");
      if (qualified === normalized) continue;
      const scoped = symbols.get(qualified);
      if (scoped !== undefined) {
        const resolved = typeof scoped === "object" ? resolveExpression(scoped.expression, preferredScopes) : scoped;
        if (resolved !== undefined) return resolved;
      }
    }
    // Scoped enum members are referred to without the enum type in C++ (for
    // example TextureImage::COMPRESSION_TYPE_DEFAULT).  Match the terminal
    // identity inside the preferred namespace, retaining ambiguity as a
    // blocker when two declarations disagree.
    const scopePrefixes = preferredScopes.map((scope) => `${scope}::`);
    const scopedCandidates = [...symbols.entries()]
      .filter(([key]) => key.endsWith(`::${simple}`) && (
        key.startsWith(`${normalized}::`) || key === normalized || scopePrefixes.some((scope) => key.startsWith(scope))))
      .map(([, candidate]) => typeof candidate === "object" ? resolveExpression(candidate.expression, preferredScopes) : candidate)
      .filter((candidate) => candidate !== undefined);
    if (scopedCandidates.length && scopedCandidates.every((candidate) => candidate === scopedCandidates[0])) return scopedCandidates[0];
    const candidates = bare.get(simple) ?? [];
    const values = candidates
      .map((candidate) => typeof candidate === "object" ? resolveExpression(candidate.expression) : candidate)
      .filter((candidate) => candidate !== undefined);
    const resolved = values.length && values.every((candidate) => candidate === values[0]) ? values[0] : undefined;
    resolving.delete(normalized);
    return resolved;
  };
  const resolveExpression = (expression, preferredScopes = []) => {
    const directString = stringLiteral(expression);
    if (directString !== undefined) return directString;
    let value = expression.trim()
      .replace(/\(\s*(?:lua_Number|int(?:8|16|32|64)_t|uint(?:8|16|32|64)_t|size_t|float|double|long|short|unsigned|signed|char)\s*\)/g, "")
      .replace(/\bstatic_cast\s*<[^>]+>\s*\(/g, "(")
      .replace(/\s*::\s*/g, "::");
    const identifier = value.match(/^([A-Za-z_]\w*(?:::\s*[A-Za-z_]\w*)*)$/);
    if (identifier) {
      const resolved = resolveName(identifier[1], preferredScopes);
      if (resolved !== undefined) return resolved;
    }
    let undecided = false;
    value = value.replace(/\b[A-Za-z_]\w*(?:::\s*[A-Za-z_]\w*)*/g, (token) => {
      const resolved = resolveName(token, preferredScopes);
      if (typeof resolved !== "number") { undecided = true; return token; }
      return `(${resolved})`;
    });
    if (undecided) return undefined;
    return numberLiteral(value);
  };
  const result = new Map();
  const filesBySuffix = new Map(files.map((file) => [file.path.replaceAll("\\", "/"), file]));
  for (const registration of registrations) {
    const source = [...filesBySuffix.entries()].find(([filePath]) => filePath.endsWith(registration.path))?.[1];
    const preferredScopes = source
      ? sourceScopes(stripComments(source.text), source.text.split("\n").slice(0, registration.line).join("\n").length)
      : [];
    const value = resolveExpression(registration.expression, preferredScopes);
    if (value !== undefined && (registration.valueKind === "number" || registration.valueKind === "string")) result.set(registration.name, {
      valueKind: registration.valueKind,
      value,
      expression: registration.expression,
      source: registration.path,
      line: registration.line
    });
  }
  return result;
}
