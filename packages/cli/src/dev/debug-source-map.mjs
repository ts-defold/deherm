import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LEAST_UPPER_BOUND,
  TraceMap,
  generatedPositionFor,
  originalPositionFor,
  sourceContentFor
} from "@jridgewell/trace-mapping";

function sourceUrl(file) {
  return file.startsWith("file:") ? new URL(file).href : pathToFileURL(path.resolve(file)).href;
}

function sourcePath(url) {
  return url.startsWith("file:") ? fileURLToPath(url) : url;
}

export class DebugSourceMap {
  constructor(file) {
    this.file = path.resolve(file);
    this.identity = null;
    this.trace = null;
    this.sources = [];
  }

  async refresh() {
    const information = await stat(this.file, { bigint: true });
    const identity = `${information.mtimeNs}:${information.size}`;
    if (identity === this.identity) return false;
    const document = JSON.parse(await readFile(this.file, "utf8"));
    const trace = new TraceMap(document, pathToFileURL(this.file).href);
    this.trace = trace;
    this.sources = trace.resolvedSources.map((url, index) => ({
      index,
      url,
      path: sourcePath(url),
      name: path.basename(sourcePath(url))
    }));
    this.identity = identity;
    return true;
  }

  generated(source, line, column = 0) {
    if (!this.trace) throw new Error("Debug source map has not been loaded");
    const position = generatedPositionFor(this.trace, {
      source: sourceUrl(source),
      line,
      column,
      bias: LEAST_UPPER_BOUND
    });
    if (position.line == null || position.column == null) return null;
    return { line: position.line, column: position.column };
  }

  original(line, column = 0) {
    if (!this.trace) throw new Error("Debug source map has not been loaded");
    const position = originalPositionFor(this.trace, { line, column });
    if (position.source == null || position.line == null || position.column == null) return null;
    return {
      source: sourcePath(position.source),
      line: position.line,
      column: position.column,
      name: position.name ?? null
    };
  }

  content(source) {
    if (!this.trace) throw new Error("Debug source map has not been loaded");
    return sourceContentFor(this.trace, sourceUrl(source), true) ?? null;
  }
}
