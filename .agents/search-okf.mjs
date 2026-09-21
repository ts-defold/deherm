#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const agentsRoot = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.join(agentsRoot, "docs");

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.name.endsWith(".md") ? [absolute] : [];
  }));
  return nested.flat();
}

function usage() {
  console.error("Usage:");
  console.error("  pnpm knowledge:search -- <terms> [--max N]");
  console.error("  pnpm knowledge:outline -- <relative-document.md>");
  console.error("  pnpm knowledge:section -- <relative-document.md> <heading terms>");
}

const argv = process.argv.slice(2);
let maximum = 12;
const terms = [];
let mode = "search";
for (let index = 0; index < argv.length; ++index) {
  if (argv[index] === "--") {
    continue;
  } else if (argv[index] === "--outline" || argv[index] === "--section") {
    mode = argv[index].slice(2);
  } else if (argv[index] === "--max") {
    maximum = Number.parseInt(argv[++index] ?? "", 10);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 50) {
      throw new Error("--max must be an integer from 1 through 50");
    }
  } else {
    terms.push(argv[index].toLowerCase());
  }
}
if (terms.length === 0) {
  usage();
  process.exitCode = 2;
} else if (mode === "outline" || mode === "section") {
  const requested = terms.shift();
  const absolute = path.resolve(docsRoot, requested);
  const relative = path.relative(docsRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".md")) {
    throw new Error("knowledge document must be a relative Markdown path beneath .agents/docs");
  }
  const lines = (await readFile(absolute, "utf8")).split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    return match ? [{ depth: match[1].length, title: match[2], line: index + 1 }] : [];
  });
  if (mode === "outline") {
    for (const heading of headings.slice(0, 200)) {
      console.log(`${relative}:${heading.line}\t${"  ".repeat(heading.depth - 1)}${heading.title}`);
    }
    console.error(`OKF outline: ${Math.min(headings.length, 200)}/${headings.length} headings shown.`);
  } else {
    if (terms.length === 0) throw new Error("section mode requires heading terms");
    const needle = terms.join(" ").toLowerCase();
    const heading = headings.find((candidate) => candidate.title.toLowerCase().includes(needle));
    if (!heading) throw new Error(`no heading matching ${JSON.stringify(needle)} in ${relative}`);
    const following = headings.find((candidate) => candidate.line > heading.line && candidate.depth <= heading.depth);
    const end = following ? following.line - 1 : lines.length;
    const boundedEnd = Math.min(end, heading.line + 200);
    console.log(lines.slice(heading.line - 1, boundedEnd).join("\n"));
    if (boundedEnd < end) console.error(`OKF section truncated at 200 lines (${end - heading.line + 1} total).`);
  }
} else {
  const rows = [];
  for (const file of await markdownFiles(docsRoot)) {
    const source = await readFile(file, "utf8");
    const lines = source.split(/\r?\n/);
    const title = lines.find((line) => /^title:\s*/.test(line))?.replace(/^title:\s*/, "") ??
      lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "") ?? path.basename(file);
    const relative = path.relative(docsRoot, file);
    const haystack = `${relative}\n${title}\n${source}`.toLowerCase();
    const matchedTerms = terms.filter((term) => haystack.includes(term));
    if (matchedTerms.length === 0) continue;
    const firstLine = lines.findIndex((line) => matchedTerms.some((term) => line.toLowerCase().includes(term)));
    const heading = firstLine < 0 ? "" :
      lines.slice(0, firstLine + 1).reverse().find((line) => /^#{1,6}\s+/.test(line)) ?? "";
    rows.push({
      relative,
      title,
      heading: heading.replace(/^#{1,6}\s+/, ""),
      line: firstLine + 1,
      score: matchedTerms.length * 100 + (relative.toLowerCase().includes(terms[0]) ? 10 : 0)
    });
  }
  rows.sort((left, right) => right.score - left.score || left.relative.localeCompare(right.relative));
  const selected = rows.slice(0, maximum);
  for (const row of selected) {
    const location = row.line > 0 ? `${row.relative}:${row.line}` : row.relative;
    console.log(`${location}\t${row.title}${row.heading && row.heading !== row.title ? ` — ${row.heading}` : ""}`);
  }
  console.error(`OKF search: ${selected.length}/${rows.length} matching documents shown (max ${maximum}).`);
}
