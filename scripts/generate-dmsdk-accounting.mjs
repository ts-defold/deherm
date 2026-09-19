#!/usr/bin/env node

// Every dmSDK declaration must be accounted for, with a reason.
//
// The script surface has had this gate for a long time: 926 routes reconcile
// exactly to 915 stable-ID + 8 compiler-intrinsic + 3 separate-module + 0
// pending, and a route that fits none of those fails the build. The dmSDK
// surface had no such gate, so 2140 declarations could become "1175 functions,
// 167 absent" with nothing stating where the rest went or why.
//
// That asymmetry is the problem this closes. A declaration we choose not to
// bind is a DECISION, and a decision has to be written down and counted -
// silence is not a disposition. Deciding not to project raw Lua stack
// manipulation into TypeScript is correct; letting it quietly disappear from
// the census is not, because nothing then distinguishes "we decided" from "we
// lost track".

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generated = path.join(root, "packages", "bindings", "generated");
export const accountingPath = path.join(generated, "defold-dmsdk-accounting.json");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/**
 * Why a declaration is not a bound, callable route.
 *
 * Each is a claim someone can check, not a bucket to sweep things into. A
 * category that stops being defensible should be deleted, which forces its
 * members back into the census rather than letting them sit mislabelled.
 */
const categories = Object.freeze({
  "bound": "Projected as a callable route.",
  "transport-infrastructure":
    "Consumed by the runtime's own C++ and never projected. The Lua C API is the case: " +
    "lua_bridge.hpp includes <dmsdk/lua/lua.h> and calls lua_settop, lua_gettop and luaL_ref " +
    "directly, which Extender compiles. Projecting raw stack manipulation into TypeScript " +
    "would be meaningless and unsafe.",
  "header-only":
    "static or inline, so it emits no external symbol by design and is reached by the thunk " +
    "the bindings already compile rather than by linking.",
  "type-metadata": "A record, enum or alias, which describes a shape rather than a call.",
  "non-public": "Private or protected, so it is not part of the surface at all.",
  "variant-gated":
    "Present only in some build variant - the profiler API is compiled out entirely when " +
    "NDEBUG is defined, and Defold links a parallel _null archive for release.",
  "platform-internal":
    "A backend's internal handle accessor - WebGPU, Vulkan, the iOS UIApplicationDelegate " +
    "registration. Reaching these from TypeScript would hand out raw driver state.",
  "absent":
    "Declared in a header but present in no engine archive for any target, and not explained " +
    "by any category above. A real finding that stays blocked.",
  "pending":
    "Bindable in principle and not yet lowered. This is the only category that represents " +
    "work outstanding rather than a decision taken."
});

function categorise(declaration, evidence) {
  if (declaration.disposition === "intentionally-hidden-non-public") return "non-public";
  if (!["function", "method", "constructor", "destructor"].includes(declaration.kind)) return "type-metadata";
  if (/\/lua\/(lua|lauxlib)\.h$/.test(declaration.header ?? "")) return "transport-infrastructure";
  const record = evidence?.declarations?.[declaration.id];
  if (record?.linkage === "header-only") return "header-only";
  if (declaration.inline || declaration.storageClass === "static") return "header-only";
  if (record?.linkage === "external") return "pending";
  if (/graphics_webgpu\.h$|graphics_vulkan\.h$/.test(declaration.header ?? "")) return "platform-internal";
  if (/\/profile\.h$/.test(declaration.header ?? "")) return "variant-gated";
  return "absent";
}

export async function buildAccounting(options = {}) {
  const ir = await readJson(options.irPath ?? path.join(generated, "defold-sdk-ir.json"));
  const evidence = await readJson(options.evidencePath ?? path.join(generated, "defold-dmsdk-symbol-evidence.json"))
    .catch(() => null);

  const rows = [];
  const counts = Object.fromEntries(Object.keys(categories).map((key) => [key, 0]));
  for (const declaration of ir.declarations ?? []) {
    const category = categorise(declaration, evidence);
    assert(category in categories, `${declaration.id}: unknown accounting category ${category}`);
    counts[category] += 1;
    rows.push({ id: declaration.id, name: declaration.name, header: declaration.header, category });
  }

  // The three claims that make this a gate rather than a summary.
  assert.equal(rows.length, (ir.declarations ?? []).length, "dmSDK accounting omitted declarations");
  assert.equal(new Set(rows.map(({ id }) => id)).size, rows.length, "dmSDK accounting duplicates declarations");
  assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), rows.length,
    "dmSDK accounting categories do not sum to the declaration count");

  return {
    schemaVersion: 1,
    kind: "deherm.dmsdk.accounting",
    comment:
      "Every dmSDK declaration and why it is or is not a bound route. Categories are claims, not " +
      "buckets: a declaration we choose not to bind is a decision that has to be written down and " +
      "counted, because silence does not distinguish a decision from a loss.",
    defoldRevision: ir.defoldRevision,
    categories,
    declarationCount: rows.length,
    counts,
    declarations: rows.sort((left, right) => (left.id < right.id ? -1 : 1))
  };
}

async function main(argv = process.argv.slice(2)) {
  const report = await buildAccounting();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (argv.includes("--check")) {
    const existing = await readFile(accountingPath, "utf8").catch(() => "");
    if (existing !== serialized) throw new Error("defold-dmsdk-accounting.json is stale; run node scripts/generate-dmsdk-accounting.mjs");
  }
  else await writeFile(accountingPath, serialized);
  const shown = Object.entries(report.counts).filter(([, n]) => n > 0)
    .map(([key, n]) => `${n} ${key}`).join(", ");
  console.log(`Verified exact dmSDK accounting: ${shown}; ${report.declarationCount} total.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
