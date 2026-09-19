// Derive the REGISTERED Lua surface of a Defold engine tree or native extension
// from its C/C++ sources. Nothing here consults documentation, `.script_api`,
// or any per-route or per-module list: every name, argument, and constant is
// read out of the registration arrays and the C function bodies that use the
// Lua stack. A construct the parser cannot decide becomes a recorded blocker.

const KEYWORDS = new Set([
  "if", "else", "for", "while", "switch", "case", "do", "return", "catch", "try",
  "sizeof", "typeof", "static_assert", "new", "delete", "and", "or", "not"
]);

const LUA_TYPE_TOKENS = Object.freeze({
  LUA_TNUMBER: "number",
  LUA_TSTRING: "string",
  LUA_TBOOLEAN: "boolean",
  LUA_TTABLE: "table",
  LUA_TFUNCTION: "function",
  LUA_TUSERDATA: "userdata",
  LUA_TLIGHTUSERDATA: "userdata",
  LUA_TNIL: "nil",
  LUA_TTHREAD: "thread"
});

// Structural accessor families. The family decides what the call proves about
// an argument slot; it never decides which routes exist.
const CORE_ACCESSORS = Object.freeze({
  // luaL_check* raise on a missing or wrong argument: the slot is required.
  luaL_checknumber: { family: "required", type: "number" },
  luaL_checkinteger: { family: "required", type: "number" },
  luaL_checkint: { family: "required", type: "number" },
  luaL_checklong: { family: "required", type: "number" },
  luaL_checkstring: { family: "required", type: "string" },
  luaL_checklstring: { family: "required", type: "string" },
  luaL_checkudata: { family: "required", type: "userdata" },
  luaL_checkany: { family: "required", type: null },
  luaL_checktable: { family: "required", type: "table" },
  luaL_checkfunction: { family: "required", type: "function" },
  luaL_checkboolean: { family: "required", type: "boolean" },
  // luaL_opt* default a missing argument: the slot is optional.
  luaL_optnumber: { family: "optional", type: "number" },
  luaL_optinteger: { family: "optional", type: "number" },
  luaL_optint: { family: "optional", type: "number" },
  luaL_optlong: { family: "optional", type: "number" },
  luaL_optstring: { family: "optional", type: "string" },
  luaL_optlstring: { family: "optional", type: "string" },
  luaL_optboolean: { family: "optional", type: "boolean" },
  // lua_to*/lua_is* never raise: they observe a slot that may be absent.
  lua_tonumber: { family: "probe", type: "number" },
  lua_tointeger: { family: "probe", type: "number" },
  lua_tostring: { family: "probe", type: "string" },
  lua_tolstring: { family: "probe", type: "string" },
  lua_toboolean: { family: "probe", type: "boolean" },
  lua_touserdata: { family: "probe", type: "userdata" },
  lua_topointer: { family: "probe", type: null },
  lua_tothread: { family: "probe", type: "thread" },
  lua_isnumber: { family: "probe", type: "number" },
  lua_isstring: { family: "probe", type: "string" },
  lua_isboolean: { family: "probe", type: "boolean" },
  lua_istable: { family: "probe", type: "table" },
  lua_isfunction: { family: "probe", type: "function" },
  lua_isuserdata: { family: "probe", type: "userdata" },
  lua_islightuserdata: { family: "probe", type: "userdata" },
  lua_isnil: { family: "probe", type: "nil" },
  lua_isnone: { family: "presence", type: null },
  lua_isnoneornil: { family: "presence", type: null },
  lua_type: { family: "probe", type: null },
  lua_objlen: { family: "probe", type: null },
  lua_next: { family: "probe", type: "table" },
  lua_rawget: { family: "probe", type: "table" },
  lua_rawgeti: { family: "probe", type: "table" },
  lua_getfield: { family: "probe", type: "table" },
  lua_gettable: { family: "probe", type: "table" }
});

const PUSH_TYPES = Object.freeze({
  lua_pushnumber: "number",
  lua_pushinteger: "number",
  lua_pushstring: "string",
  lua_pushlstring: "string",
  lua_pushliteral: "string",
  lua_pushboolean: "boolean",
  lua_pushnil: "nil",
  lua_pushcfunction: "function",
  lua_pushcclosure: "function",
  lua_pushlightuserdata: "userdata",
  lua_pushvalue: null,
  lua_newtable: "table",
  lua_createtable: "table",
  lua_newuserdata: "userdata"
});

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Lexing helpers. Comments and string bodies are masked so every structural
// regex below reads code only, while the raw comment spans stay available as
// absence evidence.

function lex(text) {
  const code = text.split("");
  const comments = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (character === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      comments.push({ start: index, end: stop, text: text.slice(index, stop) });
      for (let at = index; at < stop; at += 1) code[at] = " ";
      index = stop;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      comments.push({ start: index, end: stop, text: text.slice(index, stop) });
      for (let at = index; at < stop; at += 1) if (text[at] !== "\n") code[at] = " ";
      index = stop;
      continue;
    }
    if (character === '"' || character === "'") {
      let at = index + 1;
      while (at < text.length) {
        if (text[at] === "\\") { at += 2; continue; }
        if (text[at] === character) { at += 1; break; }
        if (text[at] === "\n") break;
        at += 1;
      }
      index = at;
      continue;
    }
    index += 1;
  }
  return { code: code.join(""), comments };
}

function lineIndex(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") offsets.push(index + 1);
  return offsets;
}

function lineAt(offsets, position) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle] <= position) low = middle; else high = middle - 1;
  }
  return low + 1;
}

function matchBrace(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function matchParen(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitArguments(text) {
  // Angle brackets are deliberately not treated as nesting: `params->m_L` would
  // otherwise unbalance every argument list the engine writes.
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (character === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += character;
  }
  if (current.trim() || parts.length) parts.push(current.trim());
  return parts;
}

// ---------------------------------------------------------------------------
// Preprocessor-lite: object and function macros, and the `#if` guard stack.

function collectMacros(text) {
  const object = new Map();
  const functionLike = new Map();
  // A translation unit may `#undef` a function macro and define the same name
  // again. Keeping every definition with its offset lets an invocation be
  // expanded with the definition that was in effect where it appears, rather
  // than with whichever one happened to come last in the file.
  const functionLikeHistory = new Map();
  const expression = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\(([^)]*)\))?[ \t]*([\s\S]*?)(?<!\\)\n/gm;
  for (const match of text.matchAll(expression)) {
    const [, name, parenthesised, parameterText, body] = match;
    const value = body.replace(/\\\r?\n/g, "\n");
    if (parenthesised) {
      const record = {
        name,
        at: match.index,
        parameters: parameterText.split(",").map((item) => item.trim()).filter(Boolean),
        body: value
      };
      functionLike.set(name, record);
      functionLikeHistory.set(name, [...(functionLikeHistory.get(name) ?? []), record]);
    } else {
      object.set(name, value.trim());
    }
  }
  return { object, functionLike, functionLikeHistory };
}

function stringLiteral(value) {
  // C concatenates adjacent string literals, which is how the engine's
  // registration macros build a name out of a prefix and a stringified
  // parameter: `{"get_"#luaname, ...}`.
  const trimmed = String(value ?? "").trim();
  if (!/^"(?:[^"\\]|\\.)*"(?:\s*"(?:[^"\\]|\\.)*")*$/.test(trimmed)) return null;
  let joined = "";
  for (const match of trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)) joined += match[1].replace(/\\(.)/g, "$1");
  return joined;
}

function resolveStringValue(value, macros, depth = 0) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const direct = stringLiteral(trimmed);
  if (direct !== null) return direct;
  if (depth > 8) return null;
  if (/^[A-Za-z_]\w*$/.test(trimmed) && macros.object.has(trimmed)) {
    return resolveStringValue(macros.object.get(trimmed), macros, depth + 1);
  }
  return null;
}

function isNullExpression(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed === "0" || trimmed === "0x0" || trimmed === "NULL" || trimmed === "nullptr";
}

// Preprocessor directives are not executable code. Blanking them keeps a
// `#define SETCONSTANT(name) ... lua_setfield(L, -2, #name);` that sits inside a
// function body from being read as a call that registers a constant literally
// named "name".
function stripDirectives(code) {
  const lines = code.split("\n");
  let continuing = false;
  return lines.map((line) => {
    const directive = continuing || /^[ \t]*#/.test(line);
    continuing = directive && /\\\s*$/.test(line);
    return directive ? " ".repeat(line.length) : line;
  }).join("\n");
}

// `String.prototype.replace` reads `$` sequences in the replacement text. A
// macro argument is literal source, so its dollars are escaped before it is
// substituted.
function literalReplacement(value) {
  return value.replace(/\$/g, "$$$$");
}

// Substitute one function-macro invocation's arguments into its body with C's
// own operator precedence: `#param` stringifies, but the second `#` of a `##`
// token paste does not, so `LuaGet##name` pastes to `LuaGetPosition` instead of
// degrading to `LuaGet#"Position"`.
export function substituteMacroArguments(macro, rawArguments) {
  let expansion = macro.body;
  macro.parameters.forEach((parameter, position) => {
    const argument = (rawArguments[position] ?? "").trim();
    expansion = expansion
      .replace(new RegExp(`(^|[^#])#\\s*${parameter}\\b`, "g"), `$1${literalReplacement(JSON.stringify(argument))}`)
      .replace(new RegExp(`\\b${parameter}\\b`, "g"), literalReplacement(argument));
  });
  // Token paste joins the two sides into one identifier, so it is removed only
  // after every parameter has been substituted.
  return expansion.replace(/\s*##\s*/g, "");
}

// Expand function-like macro invocations inside one function body so the
// SET_CONSTANT / SETCONSTANT idioms the engine uses become ordinary calls.
function expandFunctionMacros(body, macros) {
  let text = stripDirectives(body);
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const [name, macro] of macros.functionLike) {
      const expression = new RegExp(`(^|[^\\w#])${name}\\s*\\(`, "g");
      let match;
      while ((match = expression.exec(text)) !== null) {
        const open = match.index + match[0].length - 1;
        const close = matchParen(text, open);
        if (close < 0) break;
        const rawArguments = splitArguments(text.slice(open + 1, close));
        if (macro.parameters.length && rawArguments.length !== macro.parameters.length) break;
        const expansion = substituteMacroArguments(macro, rawArguments);
        text = `${text.slice(0, match.index + (match[1] ? 1 : 0))}${expansion}${text.slice(close + 1)}`;
        changed = true;
        expression.lastIndex = 0;
      }
    }
    if (!changed) break;
  }
  return text;
}

function guardRegions(text) {
  // Returns the conditional-compilation guard covering each offset, so an entry
  // that only exists under `#if` is reported as conditional rather than
  // silently promoted to unconditional evidence.
  const regions = [];
  const stack = [];
  const expression = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|else|endif)\b[ \t]*(.*)$/gm;
  for (const match of text.matchAll(expression)) {
    const [whole, directive, condition] = match;
    const start = match.index;
    const end = start + whole.length;
    if (directive === "if" || directive === "ifdef" || directive === "ifndef") {
      stack.push({ condition: `${directive} ${condition}`.trim(), start: end });
    } else if (directive === "elif" || directive === "else") {
      const top = stack.pop();
      if (top) regions.push({ ...top, end: start });
      stack.push({ condition: `${directive} ${condition}`.trim(), start: end });
    } else {
      const top = stack.pop();
      if (top) regions.push({ ...top, end: start });
    }
  }
  for (const open of stack) regions.push({ ...open, end: text.length });
  return regions;
}

function guardAt(regions, position) {
  const covering = regions.filter((region) => position >= region.start && position < region.end);
  if (!covering.length) return null;
  return covering.map((region) => region.condition).join(" && ");
}

// ---------------------------------------------------------------------------
// File-level structural parse.

// An entry name is a string literal, a run of adjacent string literals that C
// concatenates, or a macro that resolves to one.
const ENTRY_EXPRESSION =
  /\{\s*("(?:[^"\\]|\\.)*"(?:\s*"(?:[^"\\]|\\.)*")*|[A-Za-z_]\w*)\s*,\s*([^,{}]*?)\s*\}/g;

function parseRegistrationArrays(file) {
  const arrays = new Map();
  const expression = /\bluaL_(?:reg|Reg)\s+([A-Za-z_]\w*)\s*\[\s*\]\s*=\s*\{/g;
  for (const match of file.code.matchAll(expression)) {
    const open = file.code.indexOf("{", match.index + match[0].length - 1);
    const close = matchBrace(file.code, open);
    if (close < 0) {
      file.blockers.push({
        code: "unterminated-registration-array",
        path: file.path,
        line: lineAt(file.lines, match.index),
        detail: `registration array '${match[1]}' has no closing brace`
      });
      continue;
    }
    const arrayBodyStart = open + 1;
    const bodyCode = file.code.slice(arrayBodyStart, close);
    const entries = [];
    ENTRY_EXPRESSION.lastIndex = 0;
    for (const entry of bodyCode.matchAll(ENTRY_EXPRESSION)) {
      const nameToken = entry[1];
      const target = entry[2];
      if (isNullExpression(nameToken) && isNullExpression(target)) continue;
      const position = open + 1 + entry.index;
      const name = resolveStringValue(nameToken, file.macros);
      if (name === null) {
        file.blockers.push({
          code: "unresolved-registration-name",
          path: file.path,
          line: lineAt(file.lines, position),
          detail: `registration array '${match[1]}' entry name '${nameToken}' is not a resolvable string literal`
        });
        continue;
      }
      entries.push({
        name,
        cFunction: target,
        path: file.path,
        line: lineAt(file.lines, position),
        guard: guardAt(file.guards, position)
      });
    }
    // An entry can also be produced by a function-like macro: gui builds its
    // paired getters and setters with `REGGETSET(Position, position)`. Expand
    // each invocation in place so the generated names are read from the macro
    // rather than assumed away, and attribute them to the invocation's line.
    for (const [macroName, macro] of file.macros.functionLike) {
      if (!macro.body.includes("{")) continue;
      const invocation = new RegExp(`(^|[^\\w#])${macroName}\\s*\\(`, "g");
      let hit;
      while ((hit = invocation.exec(bodyCode)) !== null) {
        const open = hit.index + hit[0].length - 1;
        const close = matchParen(bodyCode, open);
        if (close < 0) break;
        const expansion = expandFunctionMacros(bodyCode.slice(hit.index, close + 1), file.macros);
        ENTRY_EXPRESSION.lastIndex = 0;
        for (const entry of expansion.matchAll(ENTRY_EXPRESSION)) {
          const name = resolveStringValue(entry[1], file.macros);
          if (name === null || isNullExpression(entry[2])) continue;
          if (entries.some((existing) => existing.name === name)) continue;
          entries.push({
            name,
            cFunction: entry[2],
            path: file.path,
            line: lineAt(file.lines, arrayBodyStart + open),
            guard: guardAt(file.guards, arrayBodyStart + open),
            expandedFrom: macroName
          });
        }
        invocation.lastIndex = close;
      }
    }
    // A commented-out entry is evidence of ABSENCE and is recorded as such.
    const commented = [];
    for (const comment of file.comments) {
      if (comment.start < open || comment.end > close + 1) continue;
      ENTRY_EXPRESSION.lastIndex = 0;
      for (const entry of comment.text.matchAll(ENTRY_EXPRESSION)) {
        const name = resolveStringValue(entry[1], file.macros);
        if (name === null || isNullExpression(entry[2])) continue;
        commented.push({
          name,
          cFunction: entry[2],
          path: file.path,
          line: lineAt(file.lines, comment.start + entry.index),
          evidence: comment.text.trim().slice(0, 200)
        });
      }
    }
    const record = {
      array: match[1],
      path: file.path,
      line: lineAt(file.lines, match.index),
      entries,
      commented
    };
    const existing = arrays.get(match[1]);
    if (existing) existing.push(record); else arrays.set(match[1], [record]);
  }
  return arrays;
}

const FUNCTION_DEFINITION =
  /(^|[\s*&>])([A-Za-z_]\w*)\s*\(([^;{}()]*(?:\([^()]*\)[^;{}()]*)*)\)\s*(?:const\s*)?\{/g;

// Read every function definition out of one span of code. `origin` describes
// where that span came from, so a definition produced by expanding a file-scope
// macro invocation carries the invocation's own file and line rather than a
// position inside a synthesised string.
function collectFunctionDefinitions(code, origin, into) {
  const expression = new RegExp(FUNCTION_DEFINITION.source, "g");
  for (const match of code.matchAll(expression)) {
    const name = match[2];
    if (KEYWORDS.has(name)) continue;
    const before = code.slice(Math.max(0, match.index - 200), match.index + match[1].length);
    if (!/[\w*&>\]]\s*$/.test(before)) continue;
    const previousToken = /([A-Za-z_]\w*)\s*[\s*&]*$/.exec(before);
    if (previousToken && KEYWORDS.has(previousToken[1])) continue;
    const open = code.indexOf("{", match.index + match[0].length - 1);
    const close = matchBrace(code, open);
    if (close < 0) continue;
    const record = {
      name,
      path: origin.path,
      line: origin.line ?? lineAt(origin.file.lines, match.index),
      signature: match[3],
      bodyStart: open + 1,
      bodyEnd: close,
      code: code.slice(open + 1, close),
      file: origin.file,
      macroExpanded: origin.macroExpanded ?? false,
      // Where this definition starts in the FILE: its own header, or the macro
      // invocation that generated it. It is what a preceding documentation
      // comment is attached to.
      headerStart: origin.headerStart ?? match.index + match[1].length
    };
    const existing = into.get(name);
    if (existing) existing.push(record); else into.set(name, [record]);
  }
  return into;
}

// A file-scope function-like macro invocation can *be* a function definition:
// `BIT_OP(bit_band, &=)` and `GET_CAMERA_DATA_PROPERTY_FN(FarZ, lua_pushnumber)`
// each expand to a whole `static int name(lua_State* L) { ... }`. Expanding
// those invocations in place is what lets the registered symbol they produce be
// read like any other body, instead of being refused as undefined.
//
// Only macros whose own body declares a `lua_State*` parameter list are
// considered, the invocation is expanded with the definition that was in effect
// at that point in the file, and a name that already has a written definition is
// never displaced by an expansion.
function collectMacroGeneratedDefinitions(file, written) {
  const generated = new Map();
  const definitionShape = /[A-Za-z_]\w*\s*\(\s*(?:const\s+)?(?:struct\s+)?lua_State\s*\*/;
  for (const [name, history] of file.macros.functionLikeHistory) {
    if (!history.some((macro) => definitionShape.test(macro.body))) continue;
    const invocation = new RegExp(`(^|[^\\w#])${name}\\s*\\(`, "g");
    for (const match of file.code.matchAll(invocation)) {
      const open = match.index + match[0].length - 1;
      const close = matchParen(file.code, open);
      if (close < 0) continue;
      // The definitions inside a function body are locals of that body, and the
      // ordinary body-level expansion already covers them.
      if (written.some((record) => match.index > record.bodyStart && match.index < record.bodyEnd)) continue;
      const inEffect = history.filter((macro) => macro.at < match.index).pop();
      if (!inEffect || !definitionShape.test(inEffect.body)) continue;
      const rawArguments = splitArguments(file.code.slice(open + 1, close));
      if (inEffect.parameters.length !== rawArguments.length) continue;
      // A macro body may itself invoke another macro that supplies the rest of
      // the definitions - `LUAGETSETV3` writes the getter and then delegates the
      // setter to `LUASET` - so the expansion is run back through the ordinary
      // nested expansion before its definitions are read.
      const expansion = expandFunctionMacros(substituteMacroArguments(inEffect, rawArguments), file.macros);
      collectFunctionDefinitions(expansion, {
        path: file.path,
        file,
        line: lineAt(file.lines, match.index),
        headerStart: match.index + (match[1] ? 1 : 0),
        macroExpanded: true
      }, generated);
    }
  }
  return generated;
}

function parseFunctionDefinitions(file) {
  const definitions = collectFunctionDefinitions(file.code, { path: file.path, file }, new Map());
  const written = [...definitions.values()].flat();
  for (const [name, records] of collectMacroGeneratedDefinitions(file, written)) {
    if (definitions.has(name)) continue;
    definitions.set(name, records);
  }
  return definitions;
}

export function parseSourceFile(path, text) {
  const { code, comments } = lex(text);
  const file = {
    path,
    text,
    code,
    comments,
    lines: lineIndex(text),
    // Macro bodies are read from the comment-masked text so a trailing
    // `// comment` on a #define does not become part of its value.
    macros: collectMacros(code),
    guards: guardRegions(text),
    blockers: []
  };
  file.arrays = parseRegistrationArrays(file);
  file.functions = parseFunctionDefinitions(file);
  return file;
}

// ---------------------------------------------------------------------------
// dmSDK stack-helper enumeration. The helper table is read out of the pinned
// dmSDK headers, so a new engine revision that adds a helper is picked up
// without editing this file.

function luaTypeFromCType(cType) {
  const cleaned = cType.replace(/\bconst\b/g, "").replace(/[*&]/g, "").trim();
  const tail = cleaned.split("::").pop().trim();
  if (!tail) return null;
  if (/^(bool)$/.test(tail)) return "boolean";
  if (/^(float|double|int|long|unsigned|size_t|u?int(8|16|32|64)_t|lua_Number|lua_Integer)$/.test(tail)) return "number";
  if (/^char$/.test(tail)) return "string";
  if (/^dmhash_t$/.test(tail)) return "hash";
  if (/^URL$/.test(tail)) return "url";
  if (/^LuaHBuffer$/.test(tail) || /^HBuffer$/.test(tail)) return "buffer";
  if (/^(Vector3|Vector4|Quat|Matrix4|Point3)$/.test(tail)) return tail.toLowerCase();
  return tail.toLowerCase();
}

export function collectSdkStackHelpers(headers) {
  // A declared helper is a free function whose first parameter is `lua_State*`
  // and which addresses an `int index` stack slot. With only a declaration to
  // read, its family comes from the verb prefix and its accepted types from its
  // own name suffix and declared return type. Nothing is listed by hand: a
  // helper added in a later dmSDK revision is picked up by re-reading headers.
  const index = new HelperIndex();
  const expression =
    /(^|[\s;{}])((?:const\s+)?[A-Za-z_][\w:]*(?:\s*<[^>;{}]*>)?\s*[*&]?)\s+(Check|Resolve|To|Is|Opt|Peek)([A-Za-z0-9_]*)\s*\(\s*(?:const\s+)?(?:struct\s+)?lua_State\s*\*\s*\w+\s*,([^)]*)\)\s*;/g;
  // Every `lua_State*`-first declaration, whether or not it takes a stack index.
  // This is what makes `CheckGOInstance(L)` a recognised overload of the two-
  // argument helper rather than an unreadable call to it.
  const anySignature =
    /(^|[\s;{}])(?:const\s+)?[A-Za-z_][\w:]*(?:\s*<[^>;{}]*>)?\s*[*&]?\s+([A-Za-z_]\w*)\s*\(\s*(?:const\s+)?(?:struct\s+)?lua_State\s*\*\s*\w*\s*((?:,[^)]*)?)\)\s*;/g;
  for (const header of headers) {
    const { code } = lex(header.text);
    for (const match of code.matchAll(anySignature)) {
      const rest = match[3].replace(/^,/, "").trim();
      const parts = rest ? splitArguments(rest) : [];
      // A trailing `...` is recorded as a negative fixed-argument count, which
      // `hasSignature` reads as "this many or more".
      const variadic = parts.length > 0 && parts[parts.length - 1].trim() === "...";
      index.noteSignature(match[2], variadic ? -parts.length : parts.length + 1);
    }
    for (const match of code.matchAll(expression)) {
      const returnType = match[2].trim();
      const verb = match[3];
      const suffix = match[4];
      const parts = splitArguments(match[5]);
      const indexPosition = parts.findIndex((part) => /\bint\b/.test(part) && /index|idx|indx/i.test(part));
      if (indexPosition < 0) continue;
      const name = `${verb}${suffix}`;
      const family = verb === "Check" || verb === "Resolve" ? "required" : verb === "Opt" ? "optional" : "probe";
      // `CheckHashOrString` accepts either spelling; the alternation is written
      // into the helper's own name, so it is read from there.
      const fromName = suffix.split(/Or(?=[A-Z])/).map((part) => luaTypeFromCType(part)).filter(Boolean);
      const fromReturn = luaTypeFromCType(returnType);
      const types = fromName.length ? fromName : fromReturn ? [fromReturn] : [];
      // The analysed call text keeps the lua_State argument in slot 0.
      const arity = parts.length + 1;
      const argument = indexPosition + 1;
      const existing = index.resolve(null, name, arity)?.slots?.find((slot) => slot.argument === argument);
      index.store({
        name,
        arity,
        slots: [{
          argument,
          parameter: null,
          family,
          types: [...new Set([...(existing?.types ?? []), ...types])].sort(compareText)
        }],
        origin: "declaration",
        source: header.path
      });
    }
  }
  return index;
}

// Defold documents a Lua route in a `/*# ... @name module.member */` comment
// written directly above the C function that implements it. That annotation and
// the registration array in the same translation unit are two independent claims
// about the same C symbol, and they can disagree: `script_engine.cpp` documents
// `@name sys.set_render_enable` above a function its own registration array
// registers as `set_render_enabled`. Reading the annotation back off the comment
// is what makes the documented spelling checkable against the registered one,
// for the engine and for any extension using the same convention.
//
// The annotation belongs to a definition only when nothing but whitespace, a
// storage class and a return type separates them, so a comment further up the
// file is never attributed to an unrelated function.
const DOCUMENTATION_COMMENT = /^\/\*[#*]/;
const DOCUMENTED_NAME = /@name\s+([A-Za-z_][\w.]*)/;

export function documentedNameOf(definition) {
  const file = definition.file;
  const start = definition.headerStart;
  if (typeof start !== "number") return null;
  let chosen = null;
  for (const comment of file.comments) {
    if (comment.end > start) break;
    chosen = comment;
  }
  if (!chosen || !DOCUMENTATION_COMMENT.test(chosen.text)) return null;
  if (!/^[\s\w:*&]*$/.test(file.text.slice(chosen.end, start))) return null;
  const match = DOCUMENTED_NAME.exec(chosen.text);
  return match ? { name: match[1], line: lineAt(file.lines, chosen.start) } : null;
}

// A Lua user type is named where it is registered, so `TYPE_HASH_BODY` can be
// read back as `b2Body` instead of degrading to an anonymous `userdata`.
export function collectUserTypes(project) {
  const types = new Map();
  const expression = /([A-Za-z_]\w*)\s*=\s*(?:[\w]+\s*::\s*)?(?:RegisterUserType|SetUserType)\s*\(([^;]*)\)\s*;/g;
  for (const file of project.files) {
    for (const match of file.code.matchAll(expression)) {
      const args = splitArguments(match[2]);
      for (const argument of args.slice(1)) {
        const literal = resolveStringValue(argument, file.macros);
        if (literal === null) continue;
        types.set(match[1], literal);
        break;
      }
    }
  }
  return types;
}

function integerParameters(signature) {
  // Candidate stack-index parameters: every integral parameter after the
  // lua_State. Which one actually is a stack index is decided by the body, not
  // by its name, so nothing here depends on a naming convention.
  const parts = splitArguments(signature);
  const candidates = [];
  for (let position = 1; position < parts.length; position += 1) {
    const part = parts[position];
    if (!/\b(?:int|int32_t|uint32_t|int16_t|uint16_t|size_t|lua_Integer)\b/.test(part)) continue;
    if (/[*&]/.test(part)) continue;
    const match = /([A-Za-z_]\w*)\s*$/.exec(part);
    if (!match) continue;
    candidates.push({ name: match[1], position });
  }
  return candidates;
}

function specialize(types) {
  // `userdata` is the supertype of every named user type, so it is dropped once
  // a specific type is known for the same slot.
  const unique = [...new Set(types)].filter(Boolean);
  const specific = unique.filter((type) => type !== "userdata");
  return (specific.length ? specific : unique).sort(compareText);
}

// A helper index resolves a called name the way C++ does: a file-static helper
// shadows anything with the same name elsewhere in the target, and an overload
// set is selected by the number of arguments the call supplies. Box2D defines a
// separate static `CheckVec2` in five translation units, so a purely global
// index would have to give all five up as ambiguous; the engine also overloads
// `GuiScriptInstance_Check(L, index)` against `GuiScriptInstance_Check(L)`,
// where only the first addresses an argument slot at all.
export class HelperIndex {
  constructor(global = new Map(), byFile = new Map(), signatures = new Map()) {
    // name -> argument count -> record. The argument count counts the
    // `lua_State*` in slot 0, matching the analysed call text.
    this.global = global;
    // path -> name -> argument count -> record.
    this.byFile = byFile;
    // name -> set of argument counts of every `lua_State*`-first signature seen,
    // whether or not that overload addresses a stack index.
    this.signatures = signatures;
  }

  resolve(path, name, argumentCount) {
    const scoped = this.byFile.get(path)?.get(name);
    const shared = this.global.get(name);
    if (!scoped && !shared) return undefined;
    if (argumentCount === undefined) {
      const pool = scoped ?? shared;
      return pool.size === 1 ? [...pool.values()][0] : undefined;
    }
    return scoped?.get(argumentCount) ?? shared?.get(argumentCount);
  }

  // True when the target declares or defines an overload of `name` taking this
  // many arguments. A call that matches such an overload but resolves to no
  // record is decided rather than unparseable: that overload reads no argument
  // slot, so the call proves nothing about one. A signature written with a
  // trailing `...` matches every argument count from its fixed prefix upward.
  hasSignature(name, argumentCount) {
    const seen = this.signatures.get(name);
    if (!seen) return false;
    if (seen.has(argumentCount)) return true;
    for (const fixed of seen) if (fixed < 0 && argumentCount >= -fixed) return true;
    return false;
  }

  // Whether this name carries any argument-accessor record at all.
  hasRecords(path, name) {
    return Boolean(this.byFile.get(path)?.get(name)?.size || this.global.get(name)?.size);
  }

  noteSignature(name, argumentCount) {
    let seen = this.signatures.get(name);
    if (!seen) { seen = new Set(); this.signatures.set(name, seen); }
    seen.add(argumentCount);
  }

  store(record, { path = null } = {}) {
    const scope = path === null
      ? this.global
      : this.byFile.get(path) ?? this.byFile.set(path, new Map()).get(path);
    const pool = scope.get(record.name) ?? scope.set(record.name, new Map()).get(record.name);
    pool.set(record.arity, record);
    this.noteSignature(record.name, record.arity);
  }

  get size() {
    return this.values().length;
  }

  values() {
    const pools = [
      ...this.global.values(),
      ...[...this.byFile.values()].flatMap((item) => [...item.values()])
    ];
    return pools.flatMap((pool) => [...pool.values()]);
  }
}

// `luaL_typerror(L, narg, tname)` and `luaL_argerror(L, narg, extramsg)` are the
// two auxlib calls that raise *about one argument*: both take the slot in their
// second position. Reaching one at the top level of a function body - outside
// every branch - is an unconditional refusal of that argument on the path that
// falls through to it.
const ARGUMENT_RAISE = /\b(?:luaL_typerror|luaL_argerror)\s*\(\s*[A-Za-z_]\w*\s*,\s*([A-Za-z_]\w*)\s*[,)]/g;

// Brace depth at every offset of a function body. Depth 0 is the body's own
// statement sequence: a call there runs on every path that reaches it, while a
// call at depth 1 or more sits inside a branch or a loop and proves only what
// that branch does.
function braceDepths(code) {
  const depths = new Int32Array(code.length + 1);
  let depth = 0;
  for (let at = 0; at < code.length; at += 1) {
    depths[at] = depth;
    if (code[at] === "{") depth += 1;
    else if (code[at] === "}") depth -= 1;
  }
  depths[code.length] = depth;
  return depths;
}

function raisesOnSlot(code, parameterName) {
  const expression = new RegExp(ARGUMENT_RAISE.source, "g");
  const depths = braceDepths(code);
  for (const match of code.matchAll(expression)) {
    if (match[1] !== parameterName) continue;
    if (depths[match.index] === 0) return true;
  }
  return false;
}

// `int top = lua_gettop(L); if (index <= top && ...)` is a presence test written
// as arithmetic rather than as `lua_isnone`. Whatever the helper does with the
// slot below that comparison, it has already handled the slot being absent.
function guardsPresence(code, parameterName) {
  const countNames = new Set(["top"]);
  for (const match of code.matchAll(/\b(?:const\s+)?(?:int|uint32_t|int32_t|size_t)\s+([A-Za-z_]\w*)\s*=\s*lua_gettop\s*\(/g)) {
    countNames.add(match[1]);
  }
  for (const name of countNames) {
    if (new RegExp(`\\b${parameterName}\\s*(?:<=|<|>=|>|==|!=)\\s*${name}\\b`).test(code)) return true;
    if (new RegExp(`\\b${name}\\s*(?:<=|<|>=|>|==|!=)\\s*${parameterName}\\b`).test(code)) return true;
  }
  // The same test written without a local: `if (lua_gettop(L) == instance_arg)`.
  const direct = String.raw`lua_gettop\s*\(\s*\w+\s*\)`;
  if (new RegExp(`\\b${parameterName}\\s*(?:<=|<|>=|>|==|!=)\\s*${direct}`).test(code)) return true;
  if (new RegExp(`${direct}\\s*(?:<=|<|>=|>|==|!=)\\s*\\b${parameterName}\\b`).test(code)) return true;
  return false;
}

// A helper's slot carries two kinds of evidence: the contract written into its
// declared name (`Check*` raises, `Opt*` defaults, `To*`/`Is*` observe) and what
// reading its body recognised. They are combined, not replaced, because each is
// incomplete on its own.
//
// An explicit absence test in the body wins outright: it is positive evidence
// that the helper handles a missing argument. Failing that, a `required` from
// either side wins, because the body scan is a *lower* bound - a body that
// raises down a path the parser cannot follow reads as a probe - and demoting a
// required slot to optional emits a signature that permits a call the engine
// refuses. Over-requiring is visible at compile time; under-requiring is not.
function mergeFamily(fromBody, fromDeclaration) {
  if (fromBody === "presence") return "presence";
  if (fromBody === "required" || fromDeclaration === "required") return "required";
  return fromBody ?? fromDeclaration ?? "probe";
}

// Derive what a helper proves about its own `index` slot by reading its body:
// `CheckVec2` is a vector3 because it calls dmScript::CheckVector3 on that slot,
// and `CheckBody` is a `b2Body` because it reaches dmScript::CheckUserType with
// the type hash that `b2Body` was registered under. Helpers that call helpers
// are resolved to a fixed point.
export function collectBodyDerivedHelpers(project, declared, userTypes) {
  const index = new HelperIndex(new Map(declared.global), new Map(), new Map(declared.signatures));
  const candidates = [];
  for (const [name, definitions] of project.functionsByName) {
    for (const definition of definitions) {
      if (!/^\s*(?:const\s+)?(?:struct\s+)?lua_State\s*\*/.test(definition.signature)) continue;
      const arity = splitArguments(definition.signature).length;
      // Every `lua_State*`-first definition is a known overload, including the
      // ones that address no stack index at all.
      index.noteSignature(name, arity);
      const parameters = integerParameters(definition.signature);
      if (!parameters.length) continue;
      // Two definitions of a name that take different argument counts are
      // overloads, which the arity-keyed index separates; two that take the
      // same count are distinct file-static helpers sharing a spelling, and
      // only file scope tells them apart. A definition produced by expanding a
      // macro invocation is local to the file that wrote the invocation, and
      // its offsets do not index the file text, so its storage class cannot be
      // read from around it either.
      const sameArity = definitions.filter((item) =>
        splitArguments(item.signature).length === arity).length;
      candidates.push({
        name,
        definition,
        arity,
        fileScoped: sameArity > 1 || definition.macroExpanded ||
          /(^|[\s*&])static\s[^;{}]*$/.test(definition.file.code.slice(Math.max(0, definition.bodyStart - 300), definition.bodyStart)),
        parameters
      });
    }
  }

  function store(candidate, record) {
    index.store(record, { path: candidate.fileScoped ? candidate.definition.path : null });
  }

  for (let round = 0; round < 6; round += 1) {
    let changed = false;
    for (const candidate of candidates) {
      const definition = candidate.definition;
      const code = expandFunctionMacros(definition.code, definition.file.macros);
      const calls = callsIn(code);
      // A helper may address more than one slot: Box2D's
      // `CheckJointDefBodies(L, 1, 2, &a, &b, &world)` reads two argument
      // positions in one call. Every integer parameter the body shows stack
      // evidence for becomes a slot of the helper, so the caller's second
      // argument is not left looking unread.
      const chosen = [];
      for (const parameter of candidate.parameters) {
        const types = new Set();
        // A helper that reaches an argument-raising call for its own slot on the
        // fall-through path refuses a missing or wrongly typed argument, however
        // it read the slot on the way there. `CheckHashOrString` returns early
        // for a hash and for a string and then runs `luaL_typerror(L, index, .)`
        // unconditionally, so its slot is required even though every accessor it
        // used is non-raising - which is the difference between a helper that
        // defaults a missing argument and one that rejects it.
        const seen = new Set();
        if (guardsPresence(code, parameter.name)) seen.add("presence");
        if (raisesOnSlot(code, parameter.name)) seen.add("required");
        for (const call of calls) {
          const args = splitArguments(call.argumentsText);
          if (/^(?:Check|To|Is)UserType$/.test(call.name)) {
            if ((args[1] ?? "").trim() !== parameter.name) continue;
            types.add(userTypes.get((args[2] ?? "").trim()) ?? "userdata");
            seen.add(call.name === "CheckUserType" ? "required" : "probe");
            continue;
          }
          const core = CORE_ACCESSORS[call.name];
          const known = core ? null : index.resolve(definition.path, call.name, args.length);
          if (!core && !known) continue;
          for (const inner of core ? [{ argument: 1, family: core.family, types: core.type ? [core.type] : [] }] : known.slots) {
            if ((args[inner.argument] ?? "").trim() !== parameter.name) continue;
            for (const type of inner.types) types.add(type);
            if (inner.family) seen.add(inner.family);
          }
        }
        // A presence test on the slot dominates everything else the body does
        // with it. Box2D's `CheckMaxResults` opens with
        // `if (lua_isnoneornil(L, index)) return 0;` and only then calls
        // `luaL_checkinteger`, so the `luaL_check*` sits on the else-path and
        // the helper accepts a missing argument. Letting the check win there
        // would emit a required parameter for a slot the engine defaults.
        const family = seen.has("presence") ? "presence"
          : seen.has("required") ? "required"
            : seen.has("optional") ? "optional"
              : seen.has("probe") ? "probe" : null;
        if (!types.size && family === null) continue;
        chosen.push({ parameter, types, family });
      }
      if (!chosen.length) continue;
      const previous = index.resolve(definition.path, candidate.name, candidate.arity);
      const priorSlot = (position) => previous?.slots?.find((item) => item.argument === position);
      const record = {
        name: candidate.name,
        arity: candidate.arity,
        slots: chosen.map((item) => ({
          argument: item.parameter.position,
          parameter: item.parameter.name,
          family: mergeFamily(item.family, priorSlot(item.parameter.position)?.family ?? null),
          // Declaration-derived and body-derived types describe the same slot,
          // so they are unioned and then specialised.
          types: specialize([...(priorSlot(item.parameter.position)?.types ?? []), ...item.types])
        })),
        origin: "body",
        source: `${definition.path}:${definition.line}`
      };
      const identity = (item) => JSON.stringify([item?.slots ?? null, item?.origin ?? null]);
      if (identity(previous) !== identity(record)) {
        store(candidate, record);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Registration-site interpretation: an abstract Lua stack machine over the
// recognised C API calls, which is what turns `luaL_register(L, 0, X)` plus a
// later `lua_setfield(L, -2, "chain")` into the module path `b2d.chain`.

const CALL_EXPRESSION = /(?:([A-Za-z_]\w*)\s*::\s*)?([A-Za-z_]\w*)\s*\(/g;

function callsIn(code) {
  const calls = [];
  CALL_EXPRESSION.lastIndex = 0;
  let match;
  while ((match = CALL_EXPRESSION.exec(code)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const before = code.slice(Math.max(0, match.index - 1), match.index);
    if (/[\w:]/.test(before)) continue;
    if (KEYWORDS.has(match[2])) continue;
    calls.push({
      namespace: match[1] ?? null,
      name: match[2],
      start: match.index,
      argumentsText: code.slice(open + 1, close),
      end: close
    });
    CALL_EXPRESSION.lastIndex = open + 1;
  }
  return calls;
}

function integerArgument(value) {
  const trimmed = String(value ?? "").trim();
  return /^-?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

class Table {
  constructor(source) {
    this.kind = "table";
    this.name = null;
    this.absolute = false;
    this.functions = [];
    this.constants = [];
    this.source = source;
  }
}

function pushedValue(kind, detail) {
  return { kind: "value", valueKind: kind, detail };
}

export function interpretRegistrations(project) {
  const roots = [];
  const blockers = [];
  const balanceNotes = new Set();
  const modules = new Map();

  function moduleOf(path) {
    let record = modules.get(path);
    if (!record) {
      record = { module: path, functions: [], constants: [] };
      modules.set(path, record);
    }
    return record;
  }

  function arrayEntries(file, identifier, position) {
    const local = file.arrays.get(identifier);
    if (local && local.length === 1) return local[0];
    if (local && local.length > 1) {
      blockers.push({
        code: "ambiguous-registration-array",
        path: file.path,
        line: lineAt(file.lines, position),
        detail: `registration array '${identifier}' is defined ${local.length} times in the same file`
      });
      return null;
    }
    const global = project.arraysByName.get(identifier) ?? [];
    if (global.length === 1) return global[0];
    blockers.push({
      code: global.length ? "ambiguous-registration-array" : "unknown-registration-array",
      path: file.path,
      line: lineAt(file.lines, position),
      detail: global.length
        ? `registration array '${identifier}' is defined in ${global.length} translation units: ${global.map((item) => item.path).join(", ")}`
        : `registration array '${identifier}' has no visible definition`
    });
    return null;
  }

  function attach(table, record, guardedBy) {
    for (const entry of record.entries) {
      table.functions.push({ ...entry, guard: entry.guard ?? guardedBy ?? null, array: record.array });
    }
    table.commented = [...(table.commented ?? []), ...record.commented.map((entry) => ({ ...entry, array: record.array }))];
  }

  function run(definition, stack, visited, depth) {
    if (depth > 12) {
      blockers.push({
        code: "registration-recursion-limit",
        path: definition.path,
        line: definition.line,
        detail: `registration interpretation exceeded depth 12 at ${definition.name}`
      });
      return;
    }
    const file = definition.file;
    const expanded = expandFunctionMacros(definition.code, file.macros);
    for (const call of callsIn(expanded)) {
      const args = splitArguments(call.argumentsText);
      const qualified = call.namespace ? `${call.namespace}::${call.name}` : call.name;
      if (call.name === "lua_newtable" || call.name === "lua_createtable") {
        stack.push(new Table({ path: definition.path, line: definition.line }));
        continue;
      }
      if (call.name === "luaL_register" || call.name === "luaL_openlib") {
        const nameArgument = args[1];
        const arrayIdentifier = (args[2] ?? "").replace(/^[\w]+::/, "").trim();
        const record = /^[A-Za-z_]\w*$/.test(arrayIdentifier)
          ? arrayEntries(file, arrayIdentifier, definition.bodyStart)
          : null;
        if (!record) {
          if (arrayIdentifier) {
            blockers.push({
              code: "unresolved-registration-argument",
              path: definition.path,
              line: definition.line,
              detail: `${qualified} third argument '${args[2]}' is not a registration array identifier`
            });
          }
          continue;
        }
        const literal = resolveStringValue(nameArgument, file.macros);
        if (literal !== null) {
          const table = new Table({ path: record.path, line: record.line });
          table.name = literal;
          table.absolute = true;
          attach(table, record, null);
          roots.push(table);
          stack.push(table);
          continue;
        }
        if (isNullExpression(nameArgument)) {
          const top = stack[stack.length - 1];
          if (!top || top.kind !== "table") {
            blockers.push({
              code: "anonymous-registration-without-table",
              path: record.path,
              line: record.line,
              detail: `${qualified} registers '${record.array}' into the value on top of the stack, which the interpreter could not resolve to a table`
            });
            continue;
          }
          attach(top, record, null);
          continue;
        }
        blockers.push({
          code: "unresolved-module-name",
          path: definition.path,
          line: definition.line,
          detail: `${qualified} module name '${nameArgument}' is neither a string literal nor a null pointer`
        });
        continue;
      }
      if (call.name === "lua_register") {
        const literal = resolveStringValue(args[1], file.macros);
        if (literal === null) {
          blockers.push({
            code: "unresolved-module-name",
            path: definition.path,
            line: definition.line,
            detail: `lua_register name '${args[1]}' is not a resolvable string literal`
          });
          continue;
        }
        const table = new Table({ path: definition.path, line: definition.line });
        table.name = "";
        table.absolute = true;
        table.functions.push({
          name: literal,
          cFunction: (args[2] ?? "").trim(),
          path: definition.path,
          line: definition.line,
          guard: null,
          array: null
        });
        roots.push(table);
        continue;
      }
      if (call.name === "lua_getfield" || call.name === "lua_rawgetfield") {
        // Reopening an existing sub-table: `lua_getfield(L, -1, "collision_object")`
        // followed by `luaL_register(L, 0, ...)` registers into that sub-table,
        // and the matching `lua_pop` then pops the sub-table, not its parent.
        const offset = integerArgument(args[1]);
        const fieldName = resolveStringValue(args[2], file.macros);
        const owner = offset !== null && offset < 0 ? stack[stack.length + offset] : null;
        if (!owner || owner.kind !== "table" || fieldName === null) {
          stack.push(pushedValue(null, (args[2] ?? "").trim()));
          continue;
        }
        owner.children = owner.children ?? [];
        let child = owner.children.find((item) => item.name === fieldName);
        if (!child) {
          child = new Table({ path: definition.path, line: definition.line });
          child.name = fieldName;
          owner.children.push(child);
        }
        child.reopened = true;
        stack.push(child);
        continue;
      }
      if (PUSH_TYPES[call.name] !== undefined && call.name !== "lua_newtable" && call.name !== "lua_createtable") {
        stack.push(pushedValue(PUSH_TYPES[call.name], (args[1] ?? "").trim()));
        continue;
      }
      if (call.name === "lua_setfield" || call.name === "lua_setglobal" || call.name === "lua_rawset" ||
          call.name === "lua_settable") {
        if (call.name === "lua_settable" || call.name === "lua_rawset") { stack.pop(); stack.pop(); continue; }
        const isGlobal = call.name === "lua_setglobal" || /LUA_GLOBALSINDEX/.test(args[1] ?? "");
        const fieldName = resolveStringValue(isGlobal ? args[1] : args[2], file.macros);
        const value = stack.pop();
        if (!value) continue;
        if (fieldName === null) continue;
        if (isGlobal) {
          const table = new Table({ path: definition.path, line: definition.line });
          table.name = "";
          table.absolute = true;
          if (value.kind === "table") {
            value.name = fieldName;
            value.absolute = true;
            roots.push(value);
          } else if (value.valueKind === "function") {
            table.functions.push({
              name: fieldName,
              cFunction: value.detail,
              path: definition.path,
              line: definition.line,
              guard: null,
              array: null
            });
            roots.push(table);
          } else {
            table.constants.push({
              name: fieldName,
              valueKind: value.valueKind,
              expression: value.detail,
              path: definition.path,
              line: definition.line
            });
            roots.push(table);
          }
          continue;
        }
        const parent = stack[stack.length - 1];
        if (!parent || parent.kind !== "table") continue;
        if (value.kind === "table") {
          value.name = fieldName;
          parent.children = parent.children ?? [];
          if (!parent.children.includes(value)) parent.children.push(value);
        } else if (value.valueKind === "function") {
          parent.functions.push({
            name: fieldName,
            cFunction: value.detail,
            path: definition.path,
            line: definition.line,
            guard: null,
            array: null
          });
        } else {
          parent.constants.push({
            name: fieldName,
            valueKind: value.valueKind,
            expression: value.detail,
            path: definition.path,
            line: definition.line
          });
        }
        continue;
      }
      if (call.name === "lua_pop") {
        const count = Number.parseInt(args[1] ?? "1", 10);
        for (let index = 0; index < (Number.isFinite(count) ? count : 1); index += 1) stack.pop();
        continue;
      }
      if (call.name === "lua_insert" || call.name === "lua_remove" || call.name === "lua_replace") {
        if (call.name !== "lua_insert") stack.pop();
        continue;
      }
      // A plain call whose first argument is the Lua state may itself register
      // into the table currently on the stack, so follow it.
      const callee = project.functionsByName.get(call.name);
      if (!callee || !/\bL\b|m_L|lua_State/.test(args[0] ?? "")) continue;
      if (callee.length > 1) {
        blockers.push({
          code: "ambiguous-registration-callee",
          path: definition.path,
          line: definition.line,
          detail: `call to '${call.name}' resolves to ${callee.length} definitions: ${callee.map((item) => `${item.path}:${item.line}`).join(", ")}`
        });
        continue;
      }
      const key = `${callee[0].path}#${callee[0].line}`;
      if (visited.has(key)) continue;
      if (!/luaL_register|luaL_openlib|lua_register|lua_setfield|lua_setglobal|lua_newtable/.test(callee[0].code)) continue;
      visited.add(key);
      // Every Defold registration helper is stack balanced (DM_LUA_STACK_CHECK
      // or an explicit gettop assertion), so the callee gets its own view of
      // the stack. The table objects themselves are shared, so a callee that
      // registers into the caller's table still does; but a generic helper such
      // as dmScript::RegisterUserType, whose array arguments are runtime
      // parameters, can no longer desynchronise the namespaces above it.
      const inherited = [...stack];
      run(callee[0], inherited, visited, depth + 1);
      if (inherited.length !== stack.length) balanceNotes.add(`${callee[0].path}:${callee[0].line} ${call.name}`);
      visited.delete(key);
    }
  }

  const candidates = [];
  const registrationCapable = [];
  for (const file of project.files) {
    for (const definitions of file.functions.values()) {
      for (const definition of definitions) {
        if (!/luaL_register|luaL_openlib|lua_register|lua_setglobal/.test(definition.code)) continue;
        const expanded = expandFunctionMacros(definition.code, file.macros);
        registrationCapable.push({ definition, expanded });
        const hasLiteralRegistration = callsIn(expanded).some((call) => {
          if (call.name === "lua_register") return true;
          if (call.name !== "luaL_register" && call.name !== "luaL_openlib") return false;
          return resolveStringValue(splitArguments(call.argumentsText)[1], file.macros) !== null;
        });
        if (hasLiteralRegistration) candidates.push(definition);
      }
    }
  }
  // A registration function reached from another one inherits that caller's
  // stack, so running it again as its own entry point would double-count it.
  const invoked = new Set();
  for (const { definition, expanded } of registrationCapable) {
    for (const call of callsIn(expanded)) {
      if (call.name === definition.name) continue;
      const callee = project.functionsByName.get(call.name);
      if (!callee || callee.length !== 1) continue;
      const args = splitArguments(call.argumentsText);
      if (!/\bL\b|m_L|lua_State/.test(args[0] ?? "")) continue;
      invoked.add(`${callee[0].path}#${callee[0].line}`);
    }
  }
  const entryPoints = candidates.filter((definition) => !invoked.has(`${definition.path}#${definition.line}`));
  entryPoints.sort((left, right) => compareText(left.path, right.path) || left.line - right.line);
  for (const entry of entryPoints) {
    run(entry, [], new Set([`${entry.path}#${entry.line}`]), 0);
  }

  function flatten(table, prefix) {
    const path = table.name === "" ? "" : prefix ? `${prefix}.${table.name}` : table.name;
    const record = moduleOf(path);
    for (const item of table.functions) record.functions.push(item);
    for (const item of table.constants) record.constants.push(item);
    for (const child of table.children ?? []) flatten(child, path);
    for (const item of table.commented ?? []) {
      record.commentedOut = [...(record.commentedOut ?? []), item];
    }
  }
  for (const root of roots) flatten(root, "");

  // Blockers are deduplicated by identity: a generic helper reached from many
  // registration sites is one undecidable construct, not one per call site.
  const seen = new Set();
  const uniqueBlockers = [];
  for (const blocker of blockers) {
    const key = `${blocker.code}|${blocker.path}|${blocker.line}|${blocker.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueBlockers.push(blocker);
  }
  uniqueBlockers.sort((left, right) =>
    compareText(left.code, right.code) || compareText(left.path, right.path) || left.line - right.line ||
    compareText(left.detail, right.detail));
  return {
    modules,
    blockers: uniqueBlockers,
    balancedCallees: [...balanceNotes].sort(compareText),
    entryPoints: entryPoints.map((item) => ({ path: item.path, line: item.line, name: item.name }))
  };
}

// ---------------------------------------------------------------------------
// Function-body analysis: minimum and maximum argument counts, per-slot types,
// optionality, and result arity, all from the Lua stack calls in the body.

// `const int definition_index = 2;` names an argument slot. Substituting a
// single-assignment integer local is what turns the helper calls that use it
// back into decidable stack positions.
function propagateIntegerLocals(code, resolveHelper) {
  const assignments = new Map();
  // An integer local aliases an argument slot when it is assigned a literal, the
  // absolute-index normalisation of a literal (`AbsIndex(L, 2)`), or the result
  // of a stack helper that takes a literal slot and hands its index back
  // (`int def_index = CheckDefinitionTable(L, 3);`).
  const expression =
    /\b(?:const\s+)?(?:int|uint32_t|int32_t|size_t)\s+([A-Za-z_]\w*)\s*=\s*(?:(-?\d+)\s*;|(?:[\w]+\s*::\s*)?([A-Za-z_]\w*)\s*\(([^;]*)\)\s*;)/g;
  for (const match of code.matchAll(expression)) {
    const name = match[1];
    let value = match[2] ?? null;
    if (value === null) {
      const callee = match[3];
      const args = splitArguments(match[4] ?? "");
      // `int def_index = CheckDefinitionTable(L, 3);` hands back the index of the
      // slot it was given, so the local names slot 3. A helper addressing more
      // than one slot cannot say which index it returned, so it is not followed.
      const helper = callee === "AbsIndex" || callee === "lua_absindex" ? null : resolveHelper?.(callee, args.length);
      const slot = helper ? (helper.slots.length === 1 ? helper.slots[0].argument : -1)
        : callee === "AbsIndex" || callee === "lua_absindex" ? 1 : -1;
      const literal = slot > 0 ? integerLiteral(args[slot]) : null;
      value = literal === null ? null : String(literal);
    }
    if (value === null) { assignments.set(name, null); continue; }
    if (assignments.has(name)) { assignments.set(name, null); continue; }
    assignments.set(name, value);
  }
  for (const [name, value] of assignments) {
    if (value === null) continue;
    // Any later reassignment makes the alias undecidable, so it is not applied.
    const reassigned = new RegExp(`\\b${name}\\s*(?:\\+\\+|--|[-+*/]?=[^=])`, "g");
    let hits = 0;
    for (const _ of code.matchAll(reassigned)) hits += 1;
    if (hits > 1) continue;
    code = code.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return code;
}

// A stack index reaches the parser as source text. Parenthesised additive
// arithmetic over integer literals is folded, because macro expansion routinely
// produces one: `SHAPE_ARG(1)` becomes `luaL_checknumber(L, 1 + 2)`, which names
// slot 3 exactly. Nothing beyond `+` and `-` over literals is evaluated.
function integerLiteral(value) {
  let trimmed = String(value ?? "").trim();
  while (/^\(.*\)$/.test(trimmed) && matchParen(trimmed, 0) === trimmed.length - 1) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (!/^-?\d+(?:\s*[-+]\s*-?\d+)+$/.test(trimmed)) return null;
  const terms = trimmed.match(/[-+]?\s*-?\d+/g) ?? [];
  let total = 0;
  for (const term of terms) total += Number.parseInt(term.replace(/\s+/g, ""), 10);
  return total;
}

// `LUA_REGISTRYINDEX`, `LUA_GLOBALSINDEX`, `LUA_ENVIRONINDEX` and
// `lua_upvalueindex(n)` are Lua pseudo-indices, not positions in the argument
// window. A call that addresses one is reading the registry, the globals table
// or an upvalue, and so proves nothing about any argument - the same conclusion
// the parser already draws for an explicitly negative index.
const PSEUDO_INDEX = /^(?:LUA_(?:REGISTRY|GLOBALS|ENVIRON)INDEX|lua_upvalueindex\s*\()/;

function pseudoIndex(value) {
  return PSEUDO_INDEX.test(String(value ?? "").trim());
}

export function analyzeFunctionBody(definition, helperIndex, project) {
  const file = definition.file;
  const code = propagateIntegerLocals(
    expandFunctionMacros(definition.code, file.macros),
    (name, argumentCount) => helperIndex.resolve(definition.path, name, argumentCount));
  const slots = new Map();
  const undecided = [];
  const pushes = [];
  const delegates = [];
  let usesGettop = false;
  let topBound = 0;
  const delegateResults = { min: null, max: null };

  // `return Other(L);` is a tail delegation: the registered entry point does no
  // stack work of its own, so the delegate's body is the evidence.
  for (const match of code.matchAll(/\breturn\s+(?:[\w]+\s*::\s*)?([A-Za-z_]\w*)\s*\(\s*L\s*\)\s*;/g)) {
    const candidates = project?.functionsByName.get(match[1]) ?? [];
    const chosen = candidates.filter((item) => item.path === definition.path);
    const target = chosen.length === 1 ? chosen[0] : candidates.length === 1 ? candidates[0] : null;
    if (!target || target === definition) continue;
    if (splitArguments(target.signature).length !== 1) continue;
    delegates.push(target);
  }

  function slot(position) {
    let record = slots.get(position);
    if (!record) {
      record = {
        index: position,
        required: false,
        // Whether a raising accessor reached the slot at the body's own
        // statement level rather than inside a branch.
        requiredUnconditionally: false,
        optional: false,
        presenceGuarded: false,
        types: new Set(),
        accessors: new Set()
      };
      slots.set(position, record);
    }
    return record;
  }

  const depths = braceDepths(code);
  for (const call of callsIn(code)) {
    const args = splitArguments(call.argumentsText);
    const core = CORE_ACCESSORS[call.name];
    const helper = core ? undefined : helperIndex.resolve(definition.path, call.name, args.length);
    if (call.name === "lua_gettop") { usesGettop = true; continue; }
    if (PUSH_TYPES[call.name] !== undefined) { pushes.push({ name: call.name, type: PUSH_TYPES[call.name] }); continue; }
    if (call.namespace === "dmScript" && /^Push/.test(call.name)) {
      pushes.push({ name: `dmScript::${call.name}`, type: luaTypeFromCType(call.name.replace(/^Push/, "")) });
      continue;
    }
    if (call.name === "luaL_checktype" || call.name === "luaL_checkudata") {
      if (pseudoIndex(args[1])) continue;
      const position = integerLiteral(args[1]);
      if (position === null) {
        undecided.push({ code: "dynamic-stack-index", detail: `${call.name}(${args.join(", ")})` });
        continue;
      }
      if (position <= 0) { undecided.push({ code: "relative-stack-index", detail: `${call.name}(${args.join(", ")})` }); continue; }
      const record = slot(position);
      record.required = true;
      if (depths[call.start] === 0) record.requiredUnconditionally = true;
      record.accessors.add(call.name);
      const token = (args[2] ?? "").trim();
      const mapped = call.name === "luaL_checkudata" ? "userdata" : LUA_TYPE_TOKENS[token];
      if (mapped) record.types.add(mapped);
      else if (call.name !== "luaL_checkudata") undecided.push({ code: "unknown-lua-type-token", detail: token });
      continue;
    }
    const spelled = `${call.namespace ? `${call.namespace}::` : ""}${call.name}`;
    if (!core && !helper) {
      // The target declares or defines an overload of this name taking exactly
      // these arguments, and that overload addresses no stack index:
      // `GuiScriptInstance_Check(L)` reads the running instance out of the
      // registry, while `GuiScriptInstance_Check(L, index)` reads a slot. The
      // call is decided - it proves nothing about any argument - so it is not a
      // blocker. A name with helper records but no overload at this argument
      // count is a different matter and stays unparseable.
      if (helperIndex.hasSignature(call.name, args.length)) continue;
      // A name that was never an argument accessor is an ordinary call, not an
      // overload the parser failed on.
      if (helperIndex.hasRecords(definition.path, call.name)) {
        undecided.push({
          code: "unresolved-helper-overload",
          detail: `${spelled}(${args.join(", ")}) matches no ${call.name} overload taking ${args.length} arguments`
        });
      }
      continue;
    }
    const addressed = core
      ? [{ argument: 1, family: core.family, types: core.type ? [core.type] : [] }]
      : helper.slots;
    for (const { argument, family, types } of addressed) {
      const raw = args[argument];
      if (pseudoIndex(raw)) continue;
      const position = integerLiteral(raw);
      if (position === null) {
        undecided.push({ code: "dynamic-stack-index", detail: `${spelled}(${args.join(", ")})` });
        continue;
      }
      if (position <= 0) continue; // A relative index addresses a pushed value, not an argument.
      const record = slot(position);
      record.accessors.add(spelled);
      if (family === "required") {
        record.required = true;
        if (depths[call.start] === 0) record.requiredUnconditionally = true;
      }
      if (family === "optional") record.optional = true;
      if (family === "presence") record.presenceGuarded = true;
      for (const type of types) record.types.add(type);
    }
  }

  for (const delegate of delegates) {
    const inner = analyzeFunctionBody(delegate, helperIndex, project);
    for (const parameter of inner.parameters) {
      if (parameter.evidence === "no-stack-access") continue;
      const record = slot(parameter.index);
      if (parameter.evidence === "checked") {
        record.required = true;
        if (parameter.requirementUnconditional) record.requiredUnconditionally = true;
      }
      if (parameter.evidence === "defaulted") record.optional = true;
      if (parameter.evidence === "presence-guarded") record.presenceGuarded = true;
      for (const type of parameter.types) record.types.add(type);
      for (const accessor of parameter.accessors) record.accessors.add(accessor);
    }
    for (const type of inner.results.pushedTypes) pushes.push({ name: "delegate", type });
    for (const item of inner.undecided) undecided.push(item);
    if (inner.arity.variadic) usesGettop = true;
    topBound = Math.max(topBound, inner.arity.max);
    if (inner.results.decided) { delegateResults.min = inner.results.min; delegateResults.max = inner.results.max; }
  }

  // Whatever local holds `lua_gettop` is the argument count; comparing it with
  // a literal both widens the maximum arity and means the checks below it sit
  // inside a branch, so the minimum cannot be read off them.
  const countNames = new Set(["top"]);
  for (const match of code.matchAll(/\b(?:const\s+)?(?:int|uint32_t|int32_t|size_t)\s+([A-Za-z_]\w*)\s*=\s*lua_gettop\s*\(/g)) {
    countNames.add(match[1]);
  }
  let branchDependent = false;
  for (const name of countNames) {
    for (const match of code.matchAll(new RegExp(`\\b${name}\\s*(?:==|>=|>|<=|<|!=)\\s*(\\d+)`, "g"))) {
      topBound = Math.max(topBound, Number.parseInt(match[1], 10));
      branchDependent = true;
    }
    for (const match of code.matchAll(new RegExp(`(\\d+)\\s*(?:==|>=|>|<=|<|!=)\\s*\\b${name}\\b`, "g"))) {
      topBound = Math.max(topBound, Number.parseInt(match[1], 10));
      branchDependent = true;
    }
  }

  const positions = [...slots.keys()].sort((left, right) => left - right);
  const maximum = Math.max(topBound, positions.length ? positions[positions.length - 1] : 0);
  let minimum = 0;
  for (const position of positions) {
    const record = slots.get(position);
    if (record.required && !record.optional && !record.presenceGuarded) minimum = Math.max(minimum, position);
  }

  const returnCounts = new Set();
  let dynamicReturn = false;
  for (const match of code.matchAll(/\breturn\b([^;]*);/g)) {
    const expression = match[1].trim();
    if (!expression) continue;
    if (delegates.some((item) => new RegExp(`\\b${item.name}\\s*\\(`).test(expression))) continue;
    const literal = integerLiteral(expression);
    if (literal !== null) { returnCounts.add(literal); continue; }
    if (/luaL_error|DM_LUA_ERROR|luaL_argerror|lua_error/.test(expression)) continue;
    dynamicReturn = true;
  }
  const stackCheck = /DM_LUA_STACK_CHECK\s*\(\s*\w+\s*,\s*(-?\d+)\s*\)/.exec(code);
  if (stackCheck) returnCounts.add(Number.parseInt(stackCheck[1], 10));
  if (delegateResults.min !== null) {
    dynamicReturn = false;
    returnCounts.add(delegateResults.min);
    returnCounts.add(delegateResults.max);
  }

  const parameters = [];
  for (let position = 1; position <= maximum; position += 1) {
    const record = slots.get(position);
    if (!record) {
      parameters.push({
        index: position,
        optional: null,
        types: [],
        accessors: [],
        evidence: "no-stack-access",
        requirementUnconditional: false
      });
      continue;
    }
    parameters.push({
      index: position,
      optional: record.required && !record.optional && !record.presenceGuarded
        ? false
        : record.optional || record.presenceGuarded || position > minimum,
      types: [...record.types].sort(compareText),
      accessors: [...record.accessors].sort(compareText),
      evidence: record.required ? "checked" : record.optional ? "defaulted" : record.presenceGuarded ? "presence-guarded" : "probed",
      // A requirement read off a call inside a branch is conditional on that
      // branch, so it does not prove the slot is always refused when missing.
      requirementUnconditional: record.required && record.requiredUnconditionally
    });
  }

  const pushTypes = [...new Set(pushes.map((item) => item.type).filter(Boolean))].sort(compareText);
  const counts = [...returnCounts].filter((value) => value >= 0).sort((left, right) => left - right);
  let results;
  if (dynamicReturn) {
    results = { min: null, max: null, decided: false, reason: "non-literal-return-expression" };
  } else if (!counts.length) {
    results = { min: 0, max: 0, decided: true, reason: null };
  } else {
    results = { min: counts[0], max: counts[counts.length - 1], decided: true, reason: null };
  }

  return {
    cFunction: definition.name,
    path: definition.path,
    line: definition.line,
    arity: {
      min: minimum,
      max: maximum,
      variadic: usesGettop && maximum > minimum,
      // The body selects between argument counts, so a `luaL_check*` below the
      // branch does not prove that slot is always required.
      branchDependent
    },
    parameters,
    results: {
      ...results,
      pushedTypes: pushTypes,
      resultTypes: results.decided && results.min === results.max && results.min === 1 && pushTypes.length === 1
        ? pushTypes
        : null
    },
    undecided
  };
}

export function buildProject(files) {
  const parsed = files.map(({ path, text }) => parseSourceFile(path, text));
  const arraysByName = new Map();
  const functionsByName = new Map();
  for (const file of parsed) {
    for (const [name, records] of file.arrays) {
      arraysByName.set(name, [...(arraysByName.get(name) ?? []), ...records]);
    }
    for (const [name, records] of file.functions) {
      functionsByName.set(name, [...(functionsByName.get(name) ?? []), ...records]);
    }
  }
  return { files: parsed, arraysByName, functionsByName };
}

export { luaTypeFromCType };
