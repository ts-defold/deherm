// Builds the project symbol table: every name a Defold resource declares, the
// scope it is declared in, and which component source each scope belongs to.
//
// The table is derived, never authored. The declaration schema says which
// fields declare names; the project's own resources supply the names; the
// component proxy paths supply the attachment that scopes a literal.

import { computeLineStarts, createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

import { componentProxyConstants } from "./component-proxy-contract.mjs";
import { messagesAt, parseProtobufText, stringField } from "./protobuf-text.mjs";

const { sourceKinds } = componentProxyConstants;
const messageScanLimits = Object.freeze({ maxSourceBytes: 2 * 1024 * 1024, maxTokens: 250_000 });
const messageApiModules = new Set(["@deherm/project", "@ts-defold/deherm"]);
const expressionEndingTokens = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken
]);
const controlConditionTokens = new Set([
  SyntaxKind.IfKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.SwitchKeyword,
  SyntaxKind.WithKeyword,
  SyntaxKind.CatchKeyword
]);

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
    if (!extension) return;
    const existing = bound[extension];
    if (!existing) {
      bound[extension] = { path: value, line };
      return;
    }
    // A model, particle effect, or other component may bind several resources
    // of the same extension. Keep the historical singleton shape for the
    // common case, but retain a deterministic path list when the engine can
    // address more than one resource through the same component. Route-aware
    // editor projections (for example material constants) must not silently
    // narrow to whichever resource happened to be visited first.
    const paths = existing.paths ?? [existing.path];
    if (!paths.includes(value)) paths.push(value);
    if (paths.length > 1) existing.paths = paths;
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

function sourceLocation(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = low + ((high - low) >> 1);
    if (lineStarts[middle] > offset) high = middle;
    else low = middle;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

function slashDisposition(tokens) {
  const previous = tokens.at(-1);
  if (!previous) return "regex";
  if (previous.kind === SyntaxKind.CloseBraceToken) return "ambiguous";
  if (previous.kind === SyntaxKind.CloseParenToken) {
    const open = matchingTokenBackward(tokens, tokens.length - 1, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    if (open < 0) return "ambiguous";
    const controlCondition = controlConditionTokens.has(tokens[open - 1]?.kind) ||
      (tokens[open - 1]?.kind === SyntaxKind.AwaitKeyword && tokens[open - 2]?.kind === SyntaxKind.ForKeyword);
    return controlCondition ? "regex" : "division";
  }
  return expressionEndingTokens.has(previous.kind) ? "division" : "regex";
}

function scanTypeScript(source) {
  if (Buffer.byteLength(source, "utf8") > messageScanLimits.maxSourceBytes) {
    return { tokens: [], skipped: "source-byte-limit" };
  }
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens = [];
  const templateExpressionDepths = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) {
      const disposition = slashDisposition(tokens);
      if (disposition === "ambiguous") return { tokens: [], skipped: "ambiguous-slash-context" };
      if (disposition === "regex") kind = scanner.reScanSlashToken();
    }
    if (kind === SyntaxKind.TemplateHead) templateExpressionDepths.push(0);
    else if (templateExpressionDepths.length && kind === SyntaxKind.OpenBraceToken) {
      templateExpressionDepths[templateExpressionDepths.length - 1] += 1;
    } else if (templateExpressionDepths.length && kind === SyntaxKind.CloseBraceToken) {
      const last = templateExpressionDepths.length - 1;
      if (templateExpressionDepths[last] > 0) templateExpressionDepths[last] -= 1;
      else {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) templateExpressionDepths.pop();
      }
    }
    if (tokens.length === messageScanLimits.maxTokens) return { tokens: [], skipped: "token-count-limit" };
    tokens.push({
      kind,
      value: scanner.getTokenValue(),
      start: scanner.getTokenStart()
    });
  }
  return { tokens, skipped: null };
}

function matchingToken(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].kind === open) depth += 1;
    else if (tokens[index].kind === close && --depth === 0) return index;
  }
  return -1;
}

function matchingTokenBackward(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index >= 0; index -= 1) {
    if (tokens[index].kind === close) depth += 1;
    else if (tokens[index].kind === open && --depth === 0) return index;
  }
  return -1;
}

function lexicalScopes(tokens) {
  const scopes = [{ parent: -1, start: -1, end: tokens.length, shadows: new Set(), functionScope: true }];
  const stack = [0];
  const at = new Array(tokens.length).fill(0);
  for (let index = 0; index < tokens.length; index += 1) {
    at[index] = stack.at(-1);
    if (tokens[index].kind === SyntaxKind.OpenBraceToken) {
      const scope = scopes.length;
      scopes.push({ parent: stack.at(-1), start: index, end: tokens.length, shadows: new Set(), functionScope: false });
      stack.push(scope);
    } else if (tokens[index].kind === SyntaxKind.CloseBraceToken && stack.length > 1) {
      scopes[stack.pop()].end = index;
    }
  }
  const controlParameters = new Set([
    SyntaxKind.IfKeyword,
    SyntaxKind.ForKeyword,
    SyntaxKind.WhileKeyword,
    SyntaxKind.SwitchKeyword,
    SyntaxKind.WithKeyword,
    SyntaxKind.CatchKeyword
  ]);
  for (let scope = 1; scope < scopes.length; scope += 1) {
    const entry = scopes[scope];
    let close = entry.start - 1;
    while (close >= 0 && tokens[close].kind !== SyntaxKind.CloseParenToken &&
           tokens[close].kind !== SyntaxKind.SemicolonToken && tokens[close].kind !== SyntaxKind.OpenBraceToken &&
           tokens[close].kind !== SyntaxKind.CloseBraceToken) close -= 1;
    if (tokens[close]?.kind === SyntaxKind.CloseParenToken) {
      const open = matchingTokenBackward(tokens, close, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
      if (open >= 0 && !controlParameters.has(tokens[open - 1]?.kind)) {
        entry.functionScope = true;
        for (let index = open + 1; index < close; index += 1) {
          if (tokens[index].kind === SyntaxKind.Identifier) entry.shadows.add(tokens[index].value);
        }
      }
    } else if (tokens[entry.start - 1]?.kind === SyntaxKind.EqualsGreaterThanToken &&
               tokens[entry.start - 2]?.kind === SyntaxKind.Identifier) {
      entry.functionScope = true;
      entry.shadows.add(tokens[entry.start - 2].value);
    }
  }
  const declarationKinds = new Set([
    SyntaxKind.ConstKeyword,
    SyntaxKind.LetKeyword,
    SyntaxKind.VarKeyword,
    SyntaxKind.FunctionKeyword,
    SyntaxKind.ClassKeyword
  ]);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (!declarationKinds.has(tokens[index].kind)) continue;
    let declarationScope = at[index];
    if (tokens[index].kind === SyntaxKind.VarKeyword) {
      while (declarationScope > 0 && !scopes[declarationScope].functionScope) {
        declarationScope = scopes[declarationScope].parent;
      }
    }
    if (tokens[index + 1].kind === SyntaxKind.Identifier) {
      scopes[declarationScope].shadows.add(tokens[index + 1].value);
    } else if (tokens[index + 1].kind === SyntaxKind.OpenBraceToken ||
               tokens[index + 1].kind === SyntaxKind.OpenBracketToken) {
      const open = tokens[index + 1].kind;
      const close = open === SyntaxKind.OpenBraceToken ? SyntaxKind.CloseBraceToken : SyntaxKind.CloseBracketToken;
      const end = matchingToken(tokens, index + 1, open, close);
      if (end >= 0) {
        // Conservative binding-pattern projection: every identifier in a
        // destructuring pattern may bind. False negatives are preferable to
        // attributing a local lookalike to an imported Defold API.
        for (let cursor = index + 2; cursor < end; cursor += 1) {
          if (tokens[cursor].kind === SyntaxKind.Identifier) scopes[declarationScope].shadows.add(tokens[cursor].value);
        }
      }
    }
  }
  const expressionShadows = [];
  for (let arrow = 0; arrow < tokens.length; arrow += 1) {
    if (tokens[arrow].kind !== SyntaxKind.EqualsGreaterThanToken ||
        tokens[arrow + 1]?.kind === SyntaxKind.OpenBraceToken) continue;
    const names = new Set();
    let parameterClose = arrow - 1;
    while (parameterClose >= 0 && tokens[parameterClose].kind !== SyntaxKind.CloseParenToken &&
           tokens[parameterClose].kind !== SyntaxKind.EqualsToken &&
           tokens[parameterClose].kind !== SyntaxKind.SemicolonToken &&
           tokens[parameterClose].kind !== SyntaxKind.OpenBraceToken &&
           tokens[parameterClose].kind !== SyntaxKind.CloseBraceToken) parameterClose -= 1;
    if (tokens[parameterClose]?.kind === SyntaxKind.CloseParenToken) {
      const open = matchingTokenBackward(tokens, parameterClose, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
      if (open >= 0) {
        for (let cursor = open + 1; cursor < parameterClose; cursor += 1) {
          if (tokens[cursor].kind === SyntaxKind.Identifier) names.add(tokens[cursor].value);
        }
      }
    } else if (tokens[arrow - 1]?.kind === SyntaxKind.Identifier) {
      names.add(tokens[arrow - 1].value);
    }
    if (!names.size) continue;
    let parens = 0;
    let brackets = 0;
    let braces = 0;
    let end = tokens.length;
    for (let cursor = arrow + 1; cursor < tokens.length; cursor += 1) {
      const kind = tokens[cursor].kind;
      if (kind === SyntaxKind.OpenParenToken) parens += 1;
      else if (kind === SyntaxKind.OpenBracketToken) brackets += 1;
      else if (kind === SyntaxKind.OpenBraceToken) braces += 1;
      else if (kind === SyntaxKind.CloseParenToken) {
        if (parens === 0 && brackets === 0 && braces === 0) { end = cursor; break; }
        parens -= 1;
      } else if (kind === SyntaxKind.CloseBracketToken) {
        if (parens === 0 && brackets === 0 && braces === 0) { end = cursor; break; }
        brackets -= 1;
      } else if (kind === SyntaxKind.CloseBraceToken) {
        if (parens === 0 && brackets === 0 && braces === 0) { end = cursor; break; }
        braces -= 1;
      } else if ((kind === SyntaxKind.CommaToken || kind === SyntaxKind.SemicolonToken) &&
                 parens === 0 && brackets === 0 && braces === 0) {
        end = cursor;
        break;
      }
    }
    expressionShadows.push({ start: arrow + 1, end, names });
  }
  return { scopes, at, expressionShadows };
}

function isShadowed(tokenIndex, name, lexical, stopScope = 0) {
  for (const expression of lexical.expressionShadows) {
    if (tokenIndex >= expression.start && tokenIndex < expression.end && expression.names.has(name)) return true;
  }
  for (let current = lexical.at[tokenIndex]; current > stopScope; current = lexical.scopes[current].parent) {
    if (lexical.scopes[current].shadows.has(name)) return true;
  }
  return false;
}

function importedBindings(tokens) {
  const bindings = { msg: new Set(), hashLiteral: new Set() };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== SyntaxKind.ImportKeyword || tokens[index + 1]?.kind !== SyntaxKind.OpenBraceToken) continue;
    const close = matchingToken(tokens, index + 1, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
    if (close < 0 || tokens[close + 1]?.kind !== SyntaxKind.FromKeyword ||
        tokens[close + 2]?.kind !== SyntaxKind.StringLiteral ||
        !messageApiModules.has(tokens[close + 2].value)) continue;
    for (let cursor = index + 2; cursor < close;) {
      const imported = tokens[cursor];
      if (imported.kind === SyntaxKind.TypeKeyword) {
        while (cursor < close && tokens[cursor].kind !== SyntaxKind.CommaToken) cursor += 1;
        continue;
      }
      if (imported.kind !== SyntaxKind.Identifier) {
        cursor += 1;
        continue;
      }
      const alias = tokens[cursor + 1]?.kind === SyntaxKind.AsKeyword && tokens[cursor + 2]?.kind === SyntaxKind.Identifier
        ? tokens[cursor + 2]
        : imported;
      if (bindings[imported.value]) bindings[imported.value].add(alias.value);
      cursor += alias === imported ? 1 : 3;
    }
    index = close + 2;
  }
  return bindings;
}

function literalMessageName(token) {
  if (token?.kind !== SyntaxKind.StringLiteral && token?.kind !== SyntaxKind.NoSubstitutionTemplateLiteral) return null;
  const value = token.value;
  if (typeof value !== "string" || value.length === 0) return null;
  const name = value.startsWith("#") ? value.slice(1) : value;
  return name.length ? name : null;
}

function callArguments(tokens, open) {
  const close = matchingToken(tokens, open, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
  if (close < 0) return null;
  const arguments_ = [];
  let start = open + 1;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = start; index <= close; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === SyntaxKind.OpenParenToken) parens += 1;
    else if (kind === SyntaxKind.CloseParenToken && index !== close) parens -= 1;
    else if (kind === SyntaxKind.OpenBracketToken) brackets += 1;
    else if (kind === SyntaxKind.CloseBracketToken) brackets -= 1;
    else if (kind === SyntaxKind.OpenBraceToken) braces += 1;
    else if (kind === SyntaxKind.CloseBraceToken) braces -= 1;
    if (index === close || (kind === SyntaxKind.CommaToken && parens === 0 && brackets === 0 && braces === 0)) {
      arguments_.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  return { close, arguments: arguments_ };
}

function lifecycleCallable(tokens, member, limit) {
  let cursor = member + 1;
  if (tokens[cursor]?.kind === SyntaxKind.QuestionToken) cursor += 1;
  let parameters;
  let arrow = false;
  if (tokens[cursor]?.kind === SyntaxKind.OpenParenToken) {
    parameters = callArguments(tokens, cursor);
  } else if (tokens[cursor]?.kind === SyntaxKind.ColonToken || tokens[cursor]?.kind === SyntaxKind.EqualsToken) {
    cursor += 1;
    if (tokens[cursor]?.kind === SyntaxKind.FunctionKeyword) {
      cursor += 1;
      if (tokens[cursor]?.kind === SyntaxKind.Identifier) cursor += 1;
      if (tokens[cursor]?.kind !== SyntaxKind.OpenParenToken) return null;
      parameters = callArguments(tokens, cursor);
    } else {
      if (tokens[cursor]?.kind !== SyntaxKind.OpenParenToken) return null;
      parameters = callArguments(tokens, cursor);
      arrow = true;
    }
  }
  if (!parameters) return null;
  cursor = parameters.close + 1;
  if (arrow) {
    while (cursor < limit && tokens[cursor].kind !== SyntaxKind.EqualsGreaterThanToken &&
           tokens[cursor].kind !== SyntaxKind.SemicolonToken && tokens[cursor].kind !== SyntaxKind.CommaToken) cursor += 1;
    if (tokens[cursor]?.kind !== SyntaxKind.EqualsGreaterThanToken) return null;
    cursor += 1;
  }
  while (cursor < limit && tokens[cursor].kind !== SyntaxKind.OpenBraceToken &&
         tokens[cursor].kind !== SyntaxKind.SemicolonToken && tokens[cursor].kind !== SyntaxKind.CommaToken) cursor += 1;
  if (tokens[cursor]?.kind !== SyntaxKind.OpenBraceToken) return null;
  let bodyOpen = cursor;
  let bodyClose = matchingToken(tokens, bodyOpen, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
  if (bodyClose < 0 || bodyClose > limit) return null;
  // An explicit object return type can precede the implementation body. It is
  // not a lifecycle body and must not widen the evidence range.
  if (tokens[bodyClose + 1]?.kind === SyntaxKind.OpenBraceToken) {
    bodyOpen = bodyClose + 1;
    bodyClose = matchingToken(tokens, bodyOpen, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
    if (bodyClose < 0 || bodyClose > limit) return null;
  }
  return { parameters, bodyOpen, bodyClose };
}

function directLifecycleCallables(tokens, containerOpen, containerClose, messageParameter) {
  const callables = [];
  const unsupportedPrecedingModifiers = new Set([
    SyntaxKind.AsyncKeyword,
    SyntaxKind.GetKeyword,
    SyntaxKind.SetKeyword,
    SyntaxKind.AsteriskToken
  ]);
  let nestedBraces = 0;
  for (let index = containerOpen + 1; index < containerClose; index += 1) {
    if (tokens[index].kind === SyntaxKind.OpenBraceToken) {
      nestedBraces += 1;
      continue;
    }
    if (tokens[index].kind === SyntaxKind.CloseBraceToken) {
      nestedBraces -= 1;
      continue;
    }
    if (nestedBraces !== 0 || tokens[index].value !== "onMessage" ||
        unsupportedPrecedingModifiers.has(tokens[index - 1]?.kind)) continue;
    const callable = lifecycleCallable(tokens, index, containerClose);
    if (callable) callables.push({ ...callable, messageParameter });
  }
  return callables;
}

function recognizedOnMessageCallables(tokens, lexical) {
  const callables = [];
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if (lexical.at[index] !== 0 || tokens[index].kind !== SyntaxKind.ExportKeyword ||
        tokens[index + 1]?.kind !== SyntaxKind.DefaultKeyword || tokens[index + 2]?.kind !== SyntaxKind.Identifier) continue;
    const factory = tokens[index + 2].value;
    if (factory !== "defineComponent" && factory !== "component") continue;
    let open = index + 3;
    while (open < tokens.length && tokens[open].kind !== SyntaxKind.OpenParenToken &&
           tokens[open].kind !== SyntaxKind.SemicolonToken) open += 1;
    if (tokens[open]?.kind !== SyntaxKind.OpenParenToken) continue;
    const invocation = callArguments(tokens, open);
    if (!invocation || invocation.arguments.length !== 1) continue;
    if (factory === "defineComponent") {
      const argument = invocation.arguments[0];
      const objectOpen = open + 1;
      if (argument[0]?.kind !== SyntaxKind.OpenBraceToken || tokens[objectOpen]?.kind !== SyntaxKind.OpenBraceToken) continue;
      const objectClose = matchingToken(tokens, objectOpen, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
      if (objectClose >= 0 && objectClose < invocation.close) {
        callables.push(...directLifecycleCallables(tokens, objectOpen, objectClose, 1));
      }
      continue;
    }
    const className = invocation.arguments[0]?.length === 1 && invocation.arguments[0][0].kind === SyntaxKind.Identifier
      ? invocation.arguments[0][0].value
      : null;
    if (!className) continue;
    for (let declaration = 0; declaration < tokens.length; declaration += 1) {
      if (lexical.at[declaration] !== 0 || tokens[declaration].kind !== SyntaxKind.ClassKeyword ||
          tokens[declaration + 1]?.value !== className) continue;
      let classOpen = declaration + 2;
      let validBase = false;
      while (classOpen < tokens.length && tokens[classOpen].kind !== SyntaxKind.OpenBraceToken) {
        if (tokens[classOpen].kind === SyntaxKind.ExtendsKeyword &&
            ["ScriptComponent", "GuiComponent", "RenderComponent"].includes(tokens[classOpen + 1]?.value)) validBase = true;
        classOpen += 1;
      }
      if (!validBase || tokens[classOpen]?.kind !== SyntaxKind.OpenBraceToken) continue;
      const classClose = matchingToken(tokens, classOpen, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
      if (classClose >= 0) callables.push(...directLifecycleCallables(tokens, classOpen, classClose, 0));
    }
  }
  return callables;
}

function evidence(kind, sourcePath, lineStarts, token, extra = {}) {
  return { kind, source: sourcePath, ...sourceLocation(lineStarts, token.start), ...extra };
}

function compareEvidence(left, right) {
  return compare(left.source, right.source) || left.line - right.line || left.column - right.column ||
    compare(left.kind, right.kind) || compare(left.constant ?? "", right.constant ?? "");
}

/**
 * Project-authored message identifiers visible in static TypeScript evidence.
 *
 * A send literal is evidence that a name is used, not that a receiver declares
 * it. A hash constant only becomes receiver-contract evidence when an
 * `onMessage` implementation compares its message-id parameter with that exact
 * constant. Dynamic expressions are intentionally absent rather than diagnosed.
 */
export function projectMessageEvidence(sourceText, sourcePath) {
  const source = String(sourceText);
  const scanned = scanTypeScript(source);
  if (scanned.skipped) return { sender: [], receiver: [], skipped: scanned.skipped };
  const { tokens } = scanned;
  const lineStarts = computeLineStarts(source);
  const bindings = importedBindings(tokens);
  const lexical = lexicalScopes(tokens);
  const sender = [];

  for (let index = 0; index + 5 < tokens.length; index += 1) {
    if (!bindings.msg.has(tokens[index].value) || isShadowed(index, tokens[index].value, lexical) ||
        tokens[index + 1].kind !== SyntaxKind.DotToken ||
        tokens[index + 2].value !== "post" || tokens[index + 3].kind !== SyntaxKind.OpenParenToken) continue;
    const call = callArguments(tokens, index + 3);
    const argument = call?.arguments[1];
    if (!call || argument?.length !== 1) continue;
    const name = literalMessageName(argument[0]);
    if (name) sender.push({ name, evidence: evidence("msg-post-literal", sourcePath, lineStarts, argument[0]) });
    index = call.close;
  }

  const constants = new Map();
  for (let index = 0; index + 4 < tokens.length; index += 1) {
    if (lexical.at[index] !== 0 || tokens[index].kind !== SyntaxKind.ConstKeyword ||
        tokens[index + 1].kind !== SyntaxKind.Identifier) continue;
    const identifier = tokens[index + 1];
    let equals = index + 2;
    while (equals < tokens.length && tokens[equals].kind !== SyntaxKind.EqualsToken &&
           tokens[equals].kind !== SyntaxKind.CommaToken && tokens[equals].kind !== SyntaxKind.SemicolonToken) equals += 1;
    if (tokens[equals]?.kind !== SyntaxKind.EqualsToken) continue;
    const callee = tokens[equals + 1];
    if (!bindings.hashLiteral.has(callee?.value) || tokens[equals + 2]?.kind !== SyntaxKind.OpenParenToken) continue;
    const call = callArguments(tokens, equals + 2);
    const argument = call?.arguments[0];
    if (!call || argument?.length !== 1) continue;
    const name = literalMessageName(argument[0]);
    if (!name || !argument[0].value.startsWith("#")) continue;
    constants.set(identifier.value, {
      name,
      evidence: evidence("on-message-hash-comparison", sourcePath, lineStarts, argument[0], { constant: identifier.value })
    });
  }

  const receiver = [];
  const seenReceiver = new Set();
  for (const { parameters, bodyOpen, bodyClose, messageParameter } of recognizedOnMessageCallables(tokens, lexical)) {
    if (parameters.arguments.length <= messageParameter) continue;
    const messageId = parameters.arguments[messageParameter].find(({ kind }) => kind === SyntaxKind.Identifier)?.value;
    if (!messageId) continue;
    const bodyScope = lexical.at[bodyOpen + 1] ?? 0;
    for (let cursor = bodyOpen + 1; cursor + 2 < bodyClose; cursor += 1) {
      const operator = tokens[cursor + 1].kind;
      if (operator !== SyntaxKind.EqualsEqualsEqualsToken && operator !== SyntaxKind.ExclamationEqualsEqualsToken) continue;
      let constant = null;
      let messageIndex = -1;
      let constantIndex = -1;
      if (tokens[cursor].value === messageId) {
        messageIndex = cursor;
        constantIndex = cursor + 2;
        constant = constants.get(tokens[constantIndex].value);
      } else if (tokens[cursor + 2].value === messageId) {
        messageIndex = cursor + 2;
        constantIndex = cursor;
        constant = constants.get(tokens[constantIndex].value);
      }
      if (!constant) continue;
      if (isShadowed(messageIndex, messageId, lexical, bodyScope) ||
          isShadowed(constantIndex, tokens[constantIndex].value, lexical)) continue;
      const key = `${constant.name}\0${constant.evidence.source}\0${constant.evidence.line}\0${constant.evidence.column}`;
      if (seenReceiver.has(key)) continue;
      seenReceiver.add(key);
      receiver.push(constant);
    }
  }
  sender.sort((left, right) => compare(left.name, right.name) || compareEvidence(left.evidence, right.evidence));
  receiver.sort((left, right) => compare(left.name, right.name) || compareEvidence(left.evidence, right.evidence));
  return { sender, receiver, skipped: null };
}

/** Versioned project message view merged across project TypeScript sources. */
export function buildProjectMessages(sourceTexts) {
  const names = new Map();
  const skippedSources = [];
  const row = (name) => {
    let value = names.get(name);
    if (!value) {
      value = { name, senderEvidence: [], receiverEvidence: [] };
      names.set(name, value);
    }
    return value;
  };
  for (const [source, text] of [...sourceTexts].sort(([left], [right]) => compare(left, right))) {
    const scanned = projectMessageEvidence(text, source);
    if (scanned.skipped) {
      skippedSources.push({ source, reason: scanned.skipped });
      continue;
    }
    for (const item of scanned.sender) row(item.name).senderEvidence.push(item.evidence);
    for (const item of scanned.receiver) row(item.name).receiverEvidence.push(item.evidence);
  }
  const merged = [...names.values()].sort((left, right) => compare(left.name, right.name));
  for (const item of merged) {
    item.senderEvidence.sort(compareEvidence);
    item.receiverEvidence.sort(compareEvidence);
  }
  return {
    schemaVersion: 1,
    generator: "@ts-defold/deherm project-message-symbols/v1",
    evidenceBoundary: "static-project-typescript-evidence",
    dynamicExpressions: "ignored-without-diagnostic",
    limits: messageScanLimits,
    routes: {
      "MsgApi.post": { parameter: 1, role: "message-id", names: "projectMessages.names" }
    },
    names: merged,
    skippedSources
  };
}

/** Declared names no project TypeScript source mentions as a literal. */
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

export function buildResourceSymbolTable({ schema, classification, resources, componentSources, sourceTexts = new Map() }) {
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
  for (const text of sourceTexts.values()) {
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
    projectMessages: buildProjectMessages(sourceTexts),
    attachmentConflicts,
    unreferenced: {
      evidence: "literal-occurrence-in-project-typescript-sources",
      caveat: "A name a program assembles or computes at runtime is reported here; this is a review aid, never a diagnostic.",
      declarations: sourceTexts.size ? unreferencedDeclarations(declarations, literals) : []
    }
  };
}
