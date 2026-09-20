#!/usr/bin/env node

// Attaches a resource namespace to every name-shaped script parameter, using
// the pinned API documentation and the pinned resource declaration schema. The
// output is what lets the compiler decide whether a literal name is checkable
// at all; routes without a determinable namespace carry an explicit unresolved
// marker.

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { buildResourceNamespaceClassification } from "../packages/compiler/src/resource-namespace-classification.mjs";
import { publicScriptModulePath } from "../packages/compiler/src/script-public-api-policy.mjs";
import { safeParameterIdentifier } from "../packages/compiler/src/names.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  schema: new URL("packages/bindings/generated/defold-resource-declaration-schema.json", root)
};
const outputUrl = new URL("packages/bindings/generated/defold-script-resource-namespaces.json", root);

function pascal(value) {
  const words = value.replace(/^defold_(?:api|enum)\./, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("") || "Anonymous";
  return /^[A-Za-z_$]/.test(joined) ? joined : `_${joined}`;
}

function camel(value) {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
  return value.replace(/_([a-zA-Z0-9])/g, (_, character) => character.toUpperCase());
}

/** The identifier the generated TypeScript signature gives a parameter. */
function parameterIdentifier(rawName, index) {
  return safeParameterIdentifier(camel(String(rawName ?? "").replace(/\?$/, "")), index);
}

/** The generated TypeScript interface a route's member is declared on. */
function interfaceNameFor(fn) {
  const [rootName] = publicScriptModulePath(fn.modulePath);
  return `${pascal(rootName)}Api`;
}

export function generateScriptResourceNamespaces(texts) {
  const ir = JSON.parse(texts.ir);
  const schema = JSON.parse(texts.schema);
  const classification = buildResourceNamespaceClassification({
    ir, schema, interfaceNameFor, parameterIdentifier
  });
  return {
    schemaVersion: 1,
    generator: "scripts/generate-script-resource-namespace-classification.mjs",
    defoldRevision: ir.defoldRevision,
    resourceSchemaVersion: schema.schemaVersion,
    derivation: [
      "value shape decides whether a parameter carries a name or a Defold address",
      "the documented noun selects the declaration namespace kind",
      "the module's own resource, or a sibling address parameter, selects the resource",
      "everything else carries an explicit unresolved marker and is never checked"
    ],
    ...classification
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const texts = Object.fromEntries(await Promise.all(Object.entries(urls).map(async ([name, url]) =>
    [name, await readFile(url, "utf8")]
  )));
  const report = generateScriptResourceNamespaces(texts);
  const expected = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    if (await readFile(outputUrl, "utf8") !== expected) throw new Error(`${outputUrl.pathname} is stale`);
  } else await writeFile(outputUrl, expected);
  console.log(`${check ? "Verified" : "Generated"} resource namespaces for ${report.routes.length} routes ` +
    `(${report.counts.resolved} namespaced names, ${report.counts.address} addresses, ${report.counts.unresolved} unresolved).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
