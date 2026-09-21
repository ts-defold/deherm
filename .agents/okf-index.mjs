#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  defaultOkfCachePath,
  metadataOkfIndex,
  outlineOkfIndex,
  queryOkfSql,
  referencesOkfIndex,
  refreshOkfIndex,
  searchOkfIndex,
  sectionOkfIndex
} from "./lib/okf-graph.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(write = console.error) {
  write("Usage:");
  write("  node .agents/okf-index.mjs refresh");
  write("  node .agents/okf-index.mjs search <terms> [--max N]");
  write("  node .agents/okf-index.mjs search --query <terms> [--limit N]");
  write("  node .agents/okf-index.mjs outline <relative-document.md> [--max N]");
  write("  node .agents/okf-index.mjs metadata <relative-document.md>");
  write("  node .agents/okf-index.mjs section <relative-document.md> <heading terms> [--max-lines N]");
  write("  node .agents/okf-index.mjs links <relative-document.md> [--max N]");
  write("  node .agents/okf-index.mjs backlinks <relative-document.md> [--max N]");
  write("  node .agents/okf-index.mjs sql <read-only query> [--max N]");
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
const commandHelp = args.some((argument) => ["--help", "-h"].includes(argument));
const databasePath = path.resolve(process.env.DEHERM_OKF_CACHE || defaultOkfCachePath(root));

if (["help", "--help", "-h"].includes(command) || commandHelp) {
  usage(console.log);
} else if (!command || !["refresh", "search", "outline", "metadata", "section", "links", "backlinks", "sql"].includes(command)) {
  usage();
  process.exitCode = 2;
} else {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const max = option(args, "--max", option(args, "--limit", undefined));
  const maxLines = option(args, "--max-lines", undefined);
  const stats = await refreshOkfIndex({ root, databasePath });
  if (command === "refresh") {
    console.log(JSON.stringify(stats, null, 2));
  } else if (command === "search") {
    const query = option(args, "--query", "");
    if (query) args.unshift(...query.trim().split(/\s+/).filter(Boolean));
    if (args.length === 0) throw new Error("search requires terms or --query");
    const rows = await searchOkfIndex({ databasePath, terms: args, max });
    for (const row of rows) console.log(`${row.path}:${row.line}\t${row.kind}\t${row.label}`);
    console.error(`OKF graph search: ${rows.length} bounded results.`);
  } else if (command === "outline") {
    const document = args.shift();
    if (!document || args.length > 0) throw new Error("outline requires one relative document path");
    const rows = await outlineOkfIndex({ databasePath, document, max });
    for (const row of rows) console.log(`${row.path}:${row.line}\t${"  ".repeat(row.depth - 1)}${row.title}`);
    console.error(`OKF graph outline: ${rows.length} bounded headings.`);
  } else if (command === "metadata") {
    const document = args.shift();
    if (!document || args.length > 0) throw new Error("metadata requires one relative document path");
    console.log(JSON.stringify(await metadataOkfIndex({ databasePath, document }), null, 2));
  } else if (command === "section") {
    const document = args.shift();
    if (!document || args.length === 0) throw new Error("section requires a document and heading terms");
    const row = await sectionOkfIndex({ databasePath, document, terms: args, maxLines });
    console.log(row.content);
    if (row.truncated) console.error(`OKF graph section truncated at ${maxLines ?? 200} lines (${row.totalLines} total).`);
  } else if (command === "links" || command === "backlinks") {
    const document = args.shift();
    if (!document || args.length > 0) throw new Error(`${command} requires one relative document path`);
    const rows = await referencesOkfIndex({
      databasePath,
      document,
      direction: command === "links" ? "outgoing" : "incoming",
      max
    });
    for (const row of rows) {
      console.log(`${row.sourcePath}:${row.line}\t${row.kind}\t${row.targetPath}\t${row.targetLabel}`);
    }
    console.error(`OKF graph ${command}: ${rows.length} bounded edges.`);
  } else {
    if (args.length === 0) throw new Error("sql requires a query");
    const rows = await queryOkfSql({ databasePath, sql: args.join(" "), max });
    for (const row of rows) console.log(JSON.stringify(row));
    console.error(`OKF graph SQL: ${rows.length} bounded rows from a read-only connection.`);
  }
}
