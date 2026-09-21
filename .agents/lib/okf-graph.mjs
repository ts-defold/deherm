import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_RESULTS = 50;
const MAX_OUTLINE = 200;
const MAX_SECTION_LINES = 200;
const MAX_CELL_BYTES = 4_096;
const MAX_LABEL_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_SQL_BYTES = 16 * 1_024;
const CACHE_BUSY_TIMEOUT_MS = 5_000;
const INDEX_VERSION = "5";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedInteger(value, fallback, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(absolute);
      return entry.isFile() && entry.name.endsWith(".md") ? [absolute] : [];
    }));
  return nested.flat();
}

function frontmatter(source) {
  source = source.replace(/\r\n?/g, "\n");
  if (!source.startsWith("---\n")) return "";
  const end = source.indexOf("\n---\n", 4);
  return end < 0 ? "" : source.slice(4, end);
}

function scalar(metadata, name) {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(metadata);
  return match ? match[1].trim().replace(/^(['"])(.*)\1$/, "$2") : "";
}

function headingSlug(title) {
  const slug = title
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

function headings(source) {
  const lines = source.split(/\r?\n/);
  const found = [];
  const nextSuffix = new Map();
  const usedAnchors = new Set();
  for (let index = 0; index < lines.length; ++index) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (match) {
      const base = headingSlug(match[2]);
      let anchor = base;
      let suffix = nextSuffix.get(base) ?? 2;
      while (usedAnchors.has(anchor)) anchor = `${base}-${suffix++}`;
      nextSuffix.set(base, suffix);
      usedAnchors.add(anchor);
      found.push({
        anchor,
        depth: match[1].length,
        title: match[2],
        line: index + 1
      });
    }
  }
  return found.map((heading, index) => {
    const following = found.slice(index + 1).find((candidate) => candidate.depth <= heading.depth);
    const end = following ? following.line - 1 : lines.length;
    return { ...heading, content: lines.slice(heading.line - 1, end).join("\n") };
  });
}

function unquote(value) {
  return value.trim().replace(/^(['"])(.*)\1$/, "$2");
}

function referencedResources(source) {
  const references = [];
  const metadata = frontmatter(source);
  for (const match of metadata.matchAll(/^\s*resource:\s*(.+?)\s*$/gm)) {
    references.push({ raw: unquote(match[1]), kind: "source", line: 1 });
  }
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; ++index) {
    for (const match of lines[index].matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g)) {
      references.push({ raw: match[1], kind: "links", line: index + 1 });
    }
    let kind = "";
    if (/\b(own|owns|owned|ownership)\b/i.test(lines[index])) kind = "owns";
    else if (/\b(generate|generates|generated|emits|produces)\b/i.test(lines[index])) kind = "generates";
    else if (/\b(verify|verifies|verified|checks|proves)\b/i.test(lines[index])) kind = "verifies";
    if (!kind) continue;
    for (const match of lines[index].matchAll(/`([^`\n]+)`/g)) {
      const candidate = match[1].replace(/[,:;.]+$/, "");
      if (/^(?:\.?\.?\/|[\w@.-]+\/).+|\.(?:c|cc|cpp|h|hpp|js|json|md|mjs|proto|sh|ts|tsx|yaml|yml)$/i.test(candidate)) {
        references.push({ raw: candidate, kind, line: index + 1 });
      }
    }
  }
  return references;
}

function currentHeadingId(docPath, parsedHeadings, line) {
  const heading = parsedHeadings.filter((candidate) => candidate.line <= line).at(-1);
  return heading ? headingId(docPath, heading) : `doc:${docPath}`;
}

function headingId(docPath, heading) {
  return `heading:${docPath}#${heading.anchor}`;
}

function canonicalReference(root, docAbsolute, raw, relation) {
  const docsRoot = path.join(root, ".agents/docs");
  const currentDocument = path.relative(docsRoot, docAbsolute).split(path.sep).join("/");
  if (/^[a-z][a-z+.-]*:/i.test(raw)) {
    return { id: `external:${raw}`, path: raw, kind: "external" };
  }
  if (raw.startsWith("#")) {
    const fragment = raw.slice(1);
    if (!fragment) return { id: `doc:${currentDocument}`, path: currentDocument, kind: "document" };
    let decoded = fragment;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      // Keep malformed percent escapes literal; the edge remains deterministic.
    }
    const anchor = headingSlug(decoded);
    return {
      id: `heading:${currentDocument}#${anchor}`,
      path: `${currentDocument}#${anchor}`,
      kind: "anchor"
    };
  }
  const separator = raw.indexOf("#");
  const withoutFragment = separator < 0 ? raw : raw.slice(0, separator);
  const fragment = separator < 0 ? "" : raw.slice(separator + 1);
  const documentRelative = relation === "links" || /^\.{1,2}\//.test(withoutFragment) ||
    (!withoutFragment.includes("/") && withoutFragment.endsWith(".md"));
  let absolute = path.resolve(documentRelative ? path.dirname(docAbsolute) : root, withoutFragment);
  let relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { id: `external:${raw}`, path: raw, kind: "external" };
  }
  relative = relative.split(path.sep).join("/");
  const docsPrefix = ".agents/docs/";
  if (relative.startsWith(docsPrefix) && relative.endsWith(".md")) {
    const docPath = relative.slice(docsPrefix.length);
    if (fragment) {
      let decoded = fragment;
      try {
        decoded = decodeURIComponent(fragment);
      } catch {
        // Keep malformed percent escapes literal; the edge remains deterministic.
      }
      const anchor = headingSlug(decoded);
      return {
        id: `heading:${docPath}#${anchor}`,
        path: `${docPath}#${anchor}`,
        kind: "anchor"
      };
    }
    return { id: `doc:${docPath}`, path: docPath, kind: "document" };
  }
  return { id: `source:${relative}`, path: relative, absolute, kind: "source" };
}

async function sourceDigest(reference) {
  if (!reference.absolute) return "";
  try {
    const details = await stat(reference.absolute);
    if (!details.isFile()) return "";
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(reference.absolute)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function sqlite() {
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error("the OKF graph requires a Node.js release with the built-in node:sqlite module", { cause: error });
  }
}

async function openDatabase(databasePath, readOnly = false) {
  const { DatabaseSync } = await sqlite();
  const database = new DatabaseSync(databasePath, readOnly ? { readOnly: true } : {});
  database.exec(`PRAGMA busy_timeout = ${CACHE_BUSY_TIMEOUT_MS};`);
  return database;
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      label TEXT NOT NULL,
      line INTEGER NOT NULL,
      level INTEGER NOT NULL,
      digest TEXT NOT NULL,
      content TEXT NOT NULL,
      owner_doc TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_doc TEXT NOT NULL,
      line INTEGER NOT NULL,
      PRIMARY KEY (source, target, kind, line)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS nodes_path ON nodes(path, kind, line);
    CREATE INDEX IF NOT EXISTS edges_source ON edges(source);
    CREATE INDEX IF NOT EXISTS edges_target ON edges(target);
  `);
  database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema', ?)").run(INDEX_VERSION);
}

function initialize(database) {
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  let version = null;
  try {
    database.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
    version = database.prepare("SELECT value FROM metadata WHERE key = 'schema'").get()?.value ?? null;
  } catch {
    version = null;
  }
  if (version !== INDEX_VERSION) {
    database.exec(`
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS nodes;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS metadata;
    `);
  }
  createSchema(database);
}

function truncateUtf8(value, maximumBytes) {
  const text = String(value);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) return { value: text, truncated: false };
  return { value: `${bytes.subarray(0, Math.max(0, maximumBytes - 3)).toString("utf8")}…`, truncated: true };
}

function boundedRows(rows, fields) {
  const output = [];
  let bytes = 2;
  for (const row of rows) {
    const bounded = { ...row };
    for (const field of fields) {
      if (typeof bounded[field] === "string") bounded[field] = truncateUtf8(bounded[field], MAX_LABEL_BYTES).value;
    }
    const size = Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1;
    if (bytes + size > MAX_RESPONSE_BYTES) break;
    output.push(bounded);
    bytes += size;
  }
  return output;
}

function boundedSection(lines, maximumLines) {
  const output = [];
  let bytes = 0;
  let truncated = lines.length > maximumLines;
  for (const line of lines.slice(0, maximumLines)) {
    const bounded = truncateUtf8(line, MAX_CELL_BYTES);
    const size = Buffer.byteLength(bounded.value, "utf8") + (output.length ? 1 : 0);
    if (bytes + size > MAX_RESPONSE_BYTES) {
      truncated = true;
      break;
    }
    output.push(bounded.value);
    bytes += size;
    truncated ||= bounded.truncated;
  }
  return { content: output.join("\n"), truncated };
}

function boundedSqlValue(value) {
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      type: "blob",
      bytes: bytes.byteLength,
      hexPrefix: bytes.subarray(0, Math.min(bytes.byteLength, 64)).toString("hex"),
      truncated: bytes.byteLength > 64
    };
  }
  if (typeof value === "string") return truncateUtf8(value, MAX_CELL_BYTES).value;
  if (typeof value === "bigint") return value.toString();
  return value;
}

function boundedSqlRow(row, remainingBytes) {
  const bounded = {};
  for (const [rawKey, rawValue] of Object.entries(row)) {
    const key = truncateUtf8(rawKey, 256).value;
    bounded[key] = boundedSqlValue(rawValue);
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > remainingBytes) {
      delete bounded[key];
      bounded.__truncated__ = true;
      break;
    }
  }
  return bounded;
}

function replaceDocument(database, record) {
  const { relative, digest, source, metadata, parsedHeadings, references } = record;
  const title = scalar(metadata, "title") || parsedHeadings[0]?.title || path.basename(relative);
  const description = scalar(metadata, "description");
  database.prepare("DELETE FROM edges WHERE source_doc = ?").run(relative);
  database.prepare("DELETE FROM nodes WHERE owner_doc = ?").run(relative);
  database.prepare("DELETE FROM files WHERE path = ?").run(relative);
  database.prepare("INSERT INTO files (path, digest, title, description) VALUES (?, ?, ?, ?)")
    .run(relative, digest, title, description);
  database.prepare(`INSERT INTO nodes
    (id, kind, path, label, line, level, digest, content, owner_doc)
    VALUES (?, 'document', ?, ?, 1, 0, ?, ?, ?)`)
    .run(`doc:${relative}`, relative, title, digest, source, relative);
  const insertNode = database.prepare(`INSERT OR REPLACE INTO nodes
    (id, kind, path, label, line, level, digest, content, owner_doc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEdge = database.prepare(`INSERT OR IGNORE INTO edges
    (source, target, kind, source_doc, line) VALUES (?, ?, ?, ?, ?)`);
  for (const heading of parsedHeadings) {
    const id = headingId(relative, heading);
    insertNode.run(id, "heading", relative, heading.title, heading.line, heading.depth, digest, heading.content, relative);
    insertEdge.run(`doc:${relative}`, id, "contains", relative, heading.line);
  }
  for (const entry of references) {
    const target = canonicalReference(record.root, record.absolute, entry.raw, entry.kind);
    if (target.kind !== "document" && target.kind !== "anchor") {
      insertNode.run(target.id, target.kind, target.path, target.path, 0, 0, "", "", null);
    }
    insertEdge.run(currentHeadingId(relative, parsedHeadings, entry.line), target.id, entry.kind, relative, entry.line);
  }
}

export function defaultOkfCachePath(root) {
  return path.join(root, ".deherm", "cache", "okf-index.sqlite");
}

export async function refreshOkfIndex({ root, databasePath }) {
  const docsRoot = path.join(root, ".agents", "docs");
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = await openDatabase(databasePath);
  try {
    initialize(database);
    const files = await markdownFiles(docsRoot);
    const existing = new Map(database.prepare("SELECT path, digest FROM files").all()
      .map((row) => [row.path, row.digest]));
    const records = [];
    let reused = 0;
    for (const absolute of files) {
      const source = await readFile(absolute, "utf8");
      const relative = path.relative(docsRoot, absolute).split(path.sep).join("/");
      const digest = sha256(source);
      if (existing.get(relative) === digest) {
        existing.delete(relative);
        reused += 1;
        continue;
      }
      existing.delete(relative);
      records.push({
        root,
        absolute,
        relative,
        digest,
        source,
        metadata: frontmatter(source),
        parsedHeadings: headings(source),
        references: referencedResources(source)
      });
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const relative of existing.keys()) {
        database.prepare("DELETE FROM edges WHERE source_doc = ?").run(relative);
        database.prepare("DELETE FROM nodes WHERE owner_doc = ?").run(relative);
        database.prepare("DELETE FROM files WHERE path = ?").run(relative);
      }
      for (const record of records) replaceDocument(database, record);
      database.exec(`DELETE FROM nodes
        WHERE owner_doc IS NULL
          AND id NOT IN (SELECT target FROM edges)`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    let sourceUpdated = 0;
    const sourceNodes = database.prepare("SELECT id, path, digest FROM nodes WHERE kind = 'source' ORDER BY path").all();
    const updateDigest = database.prepare("UPDATE nodes SET digest = ? WHERE id = ?");
    for (const node of sourceNodes) {
      const digest = await sourceDigest({ absolute: path.join(root, node.path) });
      if (digest !== node.digest) {
        updateDigest.run(digest, node.id);
        sourceUpdated += 1;
      }
    }
    return {
      indexed: records.length,
      reused,
      removed: existing.size,
      sourceUpdated,
      documents: files.length,
      nodes: Number(database.prepare("SELECT count(*) AS count FROM nodes").get().count),
      edges: Number(database.prepare("SELECT count(*) AS count FROM edges").get().count)
    };
  } finally {
    database.close();
  }
}

export async function searchOkfIndex({ databasePath, terms, max }) {
  const needles = terms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) throw new Error("search requires at least one non-empty term");
  const limit = boundedInteger(max, 12, MAX_RESULTS, "max");
  const score = needles.map(() => "(CASE WHEN instr(lower(path || ' ' || label || ' ' || content), ?) > 0 THEN 1 ELSE 0 END)").join(" + ");
  const where = needles.map(() => "instr(lower(path || ' ' || label || ' ' || content), ?) > 0").join(" OR ");
  const database = await openDatabase(databasePath, true);
  try {
    return boundedRows(database.prepare(`SELECT kind, path, label, line, (${score}) AS score
      FROM nodes WHERE ${where}
      ORDER BY score DESC, CASE kind WHEN 'document' THEN 0 WHEN 'heading' THEN 1 ELSE 2 END, path, line
      LIMIT ?`).all(...needles, ...needles, limit), ["kind", "path", "label"]);
  } finally {
    database.close();
  }
}

export async function outlineOkfIndex({ databasePath, document, max }) {
  const limit = boundedInteger(max, MAX_OUTLINE, MAX_OUTLINE, "max");
  const database = await openDatabase(databasePath, true);
  try {
    return boundedRows(database.prepare(`SELECT path, label AS title, line, level AS depth
      FROM nodes WHERE kind = 'heading' AND path = ? ORDER BY line LIMIT ?`).all(document, limit), ["path", "title"]);
  } finally {
    database.close();
  }
}

export async function referencesOkfIndex({ databasePath, document, direction, max }) {
  if (direction !== "outgoing" && direction !== "incoming") {
    throw new Error("direction must be outgoing or incoming");
  }
  const limit = boundedInteger(max, 20, MAX_RESULTS, "max");
  const database = await openDatabase(databasePath, true);
  try {
    const rows = direction === "outgoing"
      ? database.prepare(`SELECT e.kind, e.source_doc AS sourcePath, e.line,
          e.target, coalesce(n.path, e.target) AS targetPath,
          coalesce(n.label, e.target) AS targetLabel
        FROM edges e LEFT JOIN nodes n ON n.id = e.target
        WHERE e.source_doc = ? AND e.kind <> 'contains'
        ORDER BY e.line, e.kind, e.target LIMIT ?`).all(document, limit)
      : database.prepare(`SELECT e.kind, e.source_doc AS sourcePath, e.line,
          e.target, coalesce(n.path, e.target) AS targetPath,
          coalesce(n.label, e.target) AS targetLabel
        FROM edges e LEFT JOIN nodes n ON n.id = e.target
        WHERE e.kind <> 'contains' AND (
          e.target = 'doc:' || ? OR e.target IN (
            SELECT id FROM nodes WHERE owner_doc = ? AND kind = 'heading'
          )
        )
        ORDER BY e.source_doc, e.line, e.kind, e.target LIMIT ?`).all(document, document, limit);
    const displayed = rows.map((row) => ({
      ...row,
      targetPath: row.target.startsWith("heading:")
        ? row.target.slice("heading:".length)
        : row.target.startsWith("doc:") ? row.target.slice("doc:".length) : row.targetPath
    }));
    return boundedRows(displayed, ["kind", "sourcePath", "target", "targetPath", "targetLabel"]);
  } finally {
    database.close();
  }
}

export async function sectionOkfIndex({ databasePath, document, terms, maxLines }) {
  const needles = terms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) throw new Error("section requires heading terms");
  const limit = boundedInteger(maxLines, MAX_SECTION_LINES, MAX_SECTION_LINES, "maxLines");
  const database = await openDatabase(databasePath, true);
  try {
    const where = needles.map(() => "instr(lower(label), ?) > 0").join(" AND ");
    const row = database.prepare(`SELECT path, label AS title, line, level AS depth, content
      FROM nodes WHERE kind = 'heading' AND path = ? AND ${where}
      ORDER BY line LIMIT 1`).get(document, ...needles);
    if (!row) throw new Error(`no heading matching ${JSON.stringify(needles.join(" "))} in ${document}`);
    const lines = row.content.split(/\r?\n/);
    const bounded = boundedSection(lines, limit);
    return { ...row, content: bounded.content, truncated: bounded.truncated, totalLines: lines.length };
  } finally {
    database.close();
  }
}

export async function queryOkfSql({ databasePath, sql, max }) {
  const limit = boundedInteger(max, 50, MAX_RESULTS, "max");
  const normalized = sql.trim().replace(/;\s*$/, "");
  if (Buffer.byteLength(normalized, "utf8") > MAX_SQL_BYTES) {
    throw new Error(`SQL query exceeds the ${MAX_SQL_BYTES}-byte limit`);
  }
  if (!/^(?:select|with|explain\s+query\s+plan)\b/i.test(normalized) || normalized.includes(";")) {
    throw new Error("SQL mode accepts exactly one SELECT, WITH, or EXPLAIN QUERY PLAN statement");
  }
  const database = await openDatabase(databasePath, true);
  try {
    const { constants } = await sqlite();
    database.setAuthorizer((action) => action === constants.SQLITE_RECURSIVE
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK);
    const rows = [];
    let responseBytes = 2;
    for (const row of database.prepare(normalized).iterate()) {
      const bounded = boundedSqlRow(row, MAX_RESPONSE_BYTES - responseBytes);
      const size = Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1;
      if (responseBytes + size > MAX_RESPONSE_BYTES) break;
      rows.push(bounded);
      responseBytes += size;
      if (rows.length === limit) break;
    }
    return rows;
  } finally {
    database.close();
  }
}
