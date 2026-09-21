#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  defaultOkfCachePath,
  outlineOkfIndex,
  queryOkfSql,
  refreshOkfIndex,
  searchOkfIndex,
  sectionOkfIndex
} from "./lib/okf-graph.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.error("Usage:");
  console.error("  node .agents/okf-index.mjs refresh");
  console.error("  node .agents/okf-index.mjs search <terms> [--max N]");
  console.error("  node .agents/okf-index.mjs outline <relative-document.md> [--max N]");
  console.error("  node .agents/okf-index.mjs section <relative-document.md> <heading terms> [--max-lines N]");
  console.error("  node .agents/okf-index.mjs sql <read-only query> [--max N]");
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const command = args.shift();
const databasePath = path.resolve(process.env.DEHERM_OKF_CACHE || defaultOkfCachePath(root));

if (!command || !["refresh", "search", "outline", "section", "sql"].includes(command)) {
  usage();
  process.exitCode = 2;
} else {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const max = option(args, "--max", undefined);
  const maxLines = option(args, "--max-lines", undefined);
  const stats = await refreshOkfIndex({ root, databasePath });
  if (command === "refresh") {
    console.log(JSON.stringify(stats, null, 2));
  } else if (command === "search") {
    const rows = await searchOkfIndex({ databasePath, terms: args, max });
    for (const row of rows) console.log(`${row.path}:${row.line}\t${row.kind}\t${row.label}`);
    console.error(`OKF graph search: ${rows.length} bounded results.`);
  } else if (command === "outline") {
    const document = args.shift();
    if (!document || args.length > 0) throw new Error("outline requires one relative document path");
    const rows = await outlineOkfIndex({ databasePath, document, max });
    for (const row of rows) console.log(`${row.path}:${row.line}\t${"  ".repeat(row.depth - 1)}${row.title}`);
    console.error(`OKF graph outline: ${rows.length} bounded headings.`);
  } else if (command === "section") {
    const document = args.shift();
    if (!document || args.length === 0) throw new Error("section requires a document and heading terms");
    const row = await sectionOkfIndex({ databasePath, document, terms: args, maxLines });
    console.log(row.content);
    if (row.truncated) console.error(`OKF graph section truncated at ${maxLines ?? 200} lines (${row.totalLines} total).`);
  } else {
    if (args.length === 0) throw new Error("sql requires a query");
    const rows = await queryOkfSql({ databasePath, sql: args.join(" "), max });
    for (const row of rows) console.log(JSON.stringify(row));
    console.error(`OKF graph SQL: ${rows.length} bounded rows from a read-only connection.`);
  }
}
