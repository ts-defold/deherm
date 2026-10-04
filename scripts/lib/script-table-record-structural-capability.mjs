import { registeredRouteCapability } from "./defold-lua-structural-capabilities.mjs";

function compact(source) {
  return source.replace(/\s+/g, "");
}

function codeOnly(source, preserveLiterals = false) {
  let result = "";
  let mode = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") {
        mode = "code";
        result += char;
      } else result += " ";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        result += "  ";
        mode = "code";
        index += 1;
      } else result += char === "\n" ? char : " ";
      continue;
    }
    if (mode === "string" || mode === "character") {
      if (char === "\\") {
        result += preserveLiterals ? char : " ";
        if (index + 1 < source.length) {
          result += preserveLiterals ? source[index + 1] : source[index + 1] === "\n" ? "\n" : " ";
          index += 1;
        }
      } else if ((mode === "string" && char === '"') || (mode === "character" && char === "'")) {
        result += preserveLiterals ? char : " ";
        mode = "code";
      } else result += preserveLiterals || char === "\n" ? char : " ";
      continue;
    }
    if (char === "/" && next === "/") {
      result += "  ";
      mode = "line-comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      result += "  ";
      mode = "block-comment";
      index += 1;
    } else if (char === '"') {
      result += preserveLiterals ? char : " ";
      mode = "string";
    } else if (char === "'") {
      result += preserveLiterals ? char : " ";
      mode = "character";
    } else result += char;
  }
  return result;
}

function stripWrappingParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === "(") depth += 1;
      else if (value[index] === ")") depth -= 1;
      if (depth === 0 && index !== value.length - 1) {
        wraps = false;
        break;
      }
      if (depth < 0) return value;
    }
    if (!wraps || depth !== 0) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function provesOneReturnedValue(body) {
  const returns = [...codeOnly(body).matchAll(/\breturn\b([\s\S]*?);/g)].map((match) => match[1]);
  let oneResultReturns = 0;
  for (const expression of returns) {
    const value = stripWrappingParentheses(expression).replace(/\s+/g, "");
    // C++ permits u/U before or after one or two l/L suffix characters.
    if (/^1(?:(?:u(?:ll?)?)|(?:(?:ll?)u?))?$/i.test(value)) {
      oneResultReturns += 1;
      continue;
    }
    // luaL_error never returns normally; it is an allowed failure edge rather
    // than evidence for a different successful Lua stack result count.
    if (/^luaL_error\([^;]*\)$/u.test(value)) continue;
    return false;
  }
  return oneResultReturns === 1;
}

function functionBody(source, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signature = new RegExp(
    `(?:^|\\n)\\s*(?:(?:static|inline|extern)\\s+)?[A-Za-z_][A-Za-z0-9_:<>*&\\s]*?\\b${escaped}\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?\\{`,
    "m",
  );
  const match = signature.exec(source);
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let mode = "code";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "string" || mode === "character") {
      if (char === "\\") index += 1;
      else if ((mode === "string" && char === '"') || (mode === "character" && char === "'")) mode = "code";
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
    } else if (char === '"') mode = "string";
    else if (char === "'") mode = "character";
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  return null;
}

const pushCodecs = Object.freeze({
  lua_pushboolean: "Boolean",
  lua_pushinteger: "Integer",
  lua_pushnumber: "Number",
  lua_pushstring: "String",
  lua_pushfstring: "String",
  lua_pushliteral: "String",
});

const readOnlyLuaCalls = new Set([
  "lua_gettop",
  "lua_isboolean",
  "lua_tolstring",
  "luaL_checkinteger",
  "luaL_checklstring",
  "luaL_checknumber",
  "luaL_checkstring",
  "luaL_checktype",
  "luaL_error",
]);
const outputLuaCalls = new Set(["lua_newtable", "lua_setfield", ...Object.keys(pushCodecs)]);

function callsIn(body) {
  const code = codeOnly(body);
  const calls = [];
  const callPattern = /\b([A-Za-z_][A-Za-z0-9_:]*)\s*\(/g;
  for (const match of code.matchAll(callPattern)) {
    const open = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    for (let index = open; index < code.length; index += 1) {
      if (code[index] === "(") depth += 1;
      else if (code[index] === ")" && --depth === 0) {
        calls.push({ name: match[1], arguments: code.slice(open + 1, index) });
        break;
      }
    }
  }
  return calls;
}

function hasOnlyModeledLuaCalls(body, allowOutput) {
  return callsIn(body)
    .filter(({ name }) => name.startsWith("lua_") || name.startsWith("luaL_"))
    .every(({ name }) => readOnlyLuaCalls.has(name) || (allowOutput && outputLuaCalls.has(name)));
}

function hasLuaStateArgument(args) {
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= args.length; index += 1) {
    const char = args[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if ((char === "," && depth === 0) || index === args.length) {
      if (args.slice(start, index).trim() === "L") return true;
      start = index + 1;
    }
  }
  return false;
}

function stateHelperCalls(body) {
  return callsIn(body)
    .filter(
      ({ name, arguments: args }) =>
        !name.startsWith("lua_") &&
        !name.startsWith("luaL_") &&
        name !== "DM_LUA_STACK_CHECK" &&
        hasLuaStateArgument(args),
    )
    .map(({ name }) => name);
}

function tableOutput(body) {
  if (!hasOnlyModeledLuaCalls(body, true) || stateHelperCalls(body).length !== 0) return null;
  const code = compact(codeOnly(body, true));
  if ((code.match(/lua_newtable\(L\)/g) ?? []).length !== 1) return null;
  const fields = [];
  const fieldPattern =
    /(lua_pushboolean|lua_pushinteger|lua_pushnumber|lua_pushstring|lua_pushfstring|lua_pushliteral)\(L,[^;]*\);lua_setfield\(L,-2,"([^"]+)"\);/g;
  for (const match of code.matchAll(fieldPattern)) fields.push({ name: match[2], codec: pushCodecs[match[1]] });
  const scalarPushCount = (
    code.match(
      /(?:lua_pushboolean|lua_pushinteger|lua_pushnumber|lua_pushstring|lua_pushfstring|lua_pushliteral)\(L,/g,
    ) ?? []
  ).length;
  const fieldPopCount = (code.match(/lua_setfield\(L,-2,/g) ?? []).length;
  return fields.length > 0 && scalarPushCount === fields.length && fieldPopCount === fields.length ? fields : null;
}

function sameFieldSet(observed, expected) {
  const key = ({ name, codec }) => `${name}\0${codec}`;
  return (
    observed.length === expected.length && observed.map(key).sort().join("\n") === expected.map(key).sort().join("\n")
  );
}

function hasArgumentCheck(body, codec, index) {
  const code = compact(codeOnly(body));
  if (codec === "String") {
    return (
      code.includes(`luaL_checktype(L,${index},LUA_TSTRING)`) ||
      code.includes(`luaL_checkstring(L,${index})`) ||
      code.includes(`luaL_checklstring(L,${index},`)
    );
  }
  if (codec === "Integer") return code.includes(`luaL_checkinteger(L,${index})`);
  if (codec === "Number") return code.includes(`luaL_checknumber(L,${index})`);
  if (codec === "Boolean") return code.includes(`lua_isboolean(L,${index})`);
  return false;
}

/**
 * Prove the exact table shape and one-result Lua stack effect consumed by the
 * fixed-record replay adapter. Private payload math and error text are outside
 * this capability; registration, argument checks, field names/codecs, and the
 * returned table count are not.
 */
export function tableRecordStructuralCapability({
  surface,
  routeName,
  registrationSource,
  sourceTexts,
  argumentCodecs,
  fields,
}) {
  if (
    typeof routeName !== "string" ||
    typeof registrationSource !== "string" ||
    !(sourceTexts instanceof Map) ||
    !Array.isArray(argumentCodecs) ||
    !Array.isArray(fields)
  ) {
    throw new Error(`${routeName ?? "table-record route"}: malformed structural capability request`);
  }
  const registration = registeredRouteCapability(surface, routeName, registrationSource.replace(/^engine\//, ""));
  if (!registration) return null;
  const registrationText = sourceTexts.get(registrationSource);
  const wrapper = functionBody(registrationText, registration.cFunction);
  if (!wrapper || !provesOneReturnedValue(wrapper)) return null;
  if (!argumentCodecs.every((codec, index) => hasArgumentCheck(wrapper, codec, index + 1))) return null;

  let producer = { mode: "registered-function", symbol: registration.cFunction, source: registrationSource };
  let observedFields = tableOutput(wrapper);
  if (!observedFields || !sameFieldSet(observedFields, fields)) {
    if (!hasOnlyModeledLuaCalls(wrapper, false)) return null;
    const calls = stateHelperCalls(wrapper);
    if (calls.length !== 1) return null;
    const matches = [];
    for (const symbol of new Set(calls)) {
      for (const [source, text] of sourceTexts) {
        const body = functionBody(text, symbol);
        const output = body ? tableOutput(body) : null;
        if (output && sameFieldSet(output, fields)) matches.push({ symbol, source, output });
      }
    }
    if (matches.length !== 1) return null;
    producer = { mode: "one-result-wrapper", symbol: matches[0].symbol, source: matches[0].source };
    observedFields = matches[0].output;
  }
  if (!sameFieldSet(observedFields, fields)) return null;

  return {
    registration,
    arguments: { arity: argumentCodecs.length, codecs: [...argumentCodecs], checked: true },
    result: { arity: 1, kind: "fixed-table-record", fields: observedFields },
    stackEffect: { tablePushes: 1, returnedValues: 1 },
    producer,
  };
}
