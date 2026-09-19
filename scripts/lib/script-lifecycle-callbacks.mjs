// The script lifecycle callbacks, read from the engine tables that define them.
//
// These are the functions a USER writes and the ENGINE calls - `init`, `update`,
// `on_message` and the rest. Defold's reference documentation declares them the
// same way it declares callable API, as namespace-less `function init(self) end`
// stubs, once per script type. They are not callable API: nothing in a Defold
// script calls `init()`, and binding them as routes would emit a callable
// `defold.init()` that means nothing.
//
// They also collide. `gameobject_script.cpp_doc.lua` and `gui_script.cpp_doc.lua`
// both declare `init`, `final`, `update`, `on_input`, `on_message` and
// `on_reload`, so a parse that takes namespace-less declarations as routes
// produces the same route id twice. That is what stopped every derivation of
// Defold 1.13.1: the archive at that revision declares them per source file,
// where 1.14.0 consolidates its globals into one `builtins.lua`. The collision
// was never a hash collision - it was the same id, twice, for a surface that
// should not have been a route at all.
//
// ── Why the engine source and not a list in this file ──────────────────────
//
// Each script type's callbacks are a C array the engine indexes by slot, and it
// is the only authority on which names exist for a revision. Reading it means a
// Defold release that adds a callback is DISCOVERED here rather than silently
// re-classified as a Defold global and emitted as a nonsense route - and that a
// callback we do not yet support is nameable as a gap instead of invisible.
//
// The `script` table, for instance, carries `late_update` and `fixed_update`,
// which the component proxy contract does not yet support; reading the table is
// what makes that a reported difference rather than an assumption.

import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where each script type's callback table lives, and what it is called.
 *
 * `proxyKind` matches `componentProxyConstants.sourceKinds[].proxyKind`, so the
 * two surfaces can be compared without a second mapping.
 */
export const LIFECYCLE_TABLES = Object.freeze([
  Object.freeze({
    proxyKind: "script",
    source: "engine/gameobject/src/gameobject/gameobject_script.cpp",
    symbol: "SCRIPT_FUNCTION_NAMES"
  }),
  Object.freeze({
    proxyKind: "gui_script",
    source: "engine/gui/src/gui.cpp",
    symbol: "SCRIPT_FUNCTION_NAMES"
  }),
  Object.freeze({
    proxyKind: "render_script",
    source: "engine/render/src/render/render_script.cpp",
    symbol: "RENDER_SCRIPT_FUNCTION_NAMES"
  })
]);

/**
 * The Lua 5.1 base library, which Defold documents alongside its own API.
 *
 * This list is the Lua 5.1 specification's, not Defold's, which is why it is
 * written here rather than read from the engine: it is fixed by a language
 * standard that does not move with a Defold release. Defold 1.13.1 ships these
 * as `doc/lua_base.doc_h_doc.lua`; 1.14.0 does not document them as stubs at
 * all. Either way they are not Defold API and we do not bind them - a
 * TypeScript author has JavaScript's own equivalents, and Hermes provides them.
 */
export const LUA_BASE_LIBRARY = Object.freeze([
  "assert", "collectgarbage", "dofile", "error", "getfenv", "getmetatable",
  "ipairs", "load", "loadfile", "loadstring", "module", "next", "pairs",
  "pcall", "print", "rawequal", "rawget", "rawset", "require", "select",
  "setfenv", "setmetatable", "tonumber", "tostring", "type", "unpack", "xpcall"
]);

const TABLE = (symbol) => new RegExp(
  `${symbol}\\s*\\[[^\\]]*\\]\\s*=\\s*\\{([^}]*)\\}`, "s"
);

/**
 * Read every script type's callback names from the engine checkout.
 *
 * @param {string} defoldRoot  path to `upstream/defold`
 * @returns {Promise<{byProxyKind: Map<string, string[]>, names: Set<string>, tables: object[]}>}
 */
export async function readLifecycleCallbacks(defoldRoot) {
  const tables = [];
  const byProxyKind = new Map();
  const names = new Set();
  for (const table of LIFECYCLE_TABLES) {
    const file = path.join(defoldRoot, table.source);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) {
      throw new Error(
        `${table.source} is not in this Defold checkout, so the ${table.proxyKind} ` +
        "lifecycle callbacks cannot be read. They decide which documented globals " +
        "are callbacks rather than callable API, so guessing them is not an option."
      );
    }
    const match = text.match(TABLE(table.symbol));
    if (!match) {
      throw new Error(
        `${table.source} no longer declares ${table.symbol} as an initialised array. ` +
        "That table is the only authority on this script type's callback names."
      );
    }
    const callbacks = [...match[1].matchAll(/"([a-z_][a-z0-9_]*)"/g)].map(([, name]) => name);
    if (!callbacks.length) {
      throw new Error(`${table.source}: ${table.symbol} parsed to an empty name list`);
    }
    tables.push({ ...table, callbacks });
    byProxyKind.set(table.proxyKind, callbacks);
    for (const name of callbacks) names.add(name);
  }
  return { byProxyKind, names, tables };
}

/**
 * Classify one namespace-less documented declaration.
 *
 * Every namespace-less declaration lands in exactly one class, and only
 * `defold-global` is a callable route. The caller asserts the partition is
 * exhaustive, because "we did not bind it" and "we did not notice it" must not
 * look the same - the classes below are the explicit, reviewable statement of
 * which documented globals we deliberately do not bind, and why.
 */
export function classifyGlobalDeclaration({ name, source, lifecycleNames }) {
  // The editor's scripting API is a different runtime with its own host. It
  // also re-declares `pprint`, so leaving it in would collide with the engine's.
  if (/(^|\/)editor\.apidoc/.test(source)) return "editor-scripting";
  if (lifecycleNames.has(name)) return "lifecycle-callback";
  if (LUA_BASE_LIBRARY.includes(name)) return "lua-standard-library";
  return "defold-global";
}
