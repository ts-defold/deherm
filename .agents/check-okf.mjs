import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory()
      ? markdownFiles(absolute)
      : entry.name.endsWith(".md") ? [absolute] : [];
  }));
  return nested.flat();
}

const agentsRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(agentsRoot, "docs");
const files = await markdownFiles(root);
assert.ok(files.length > 0, ".agents/docs knowledge bundle is empty");

for (const file of files) {
  const relative = path.relative(root, file);
  const source = await readFile(file, "utf8");
  if (relative === "log.md") {
    assert.match(source, /^# .+ knowledge log\n/, "log.md: invalid reserved log shape");
  } else {
    assert.match(source, /^---\n[\s\S]*?\n---\n/, `${relative}: missing YAML frontmatter`);
  }
  if (relative === "index.md") {
    assert.match(source, /\nokf_version:\s*["']?0\.2["']?\s*\n/, "index.md: missing OKF version");
  } else if (relative !== "log.md") {
    assert.match(source, /\ntype:\s*[^\n]+\n/, `${relative}: missing type`);
    assert.match(source, /\ntitle:\s*[^\n]+\n/, `${relative}: missing title`);
  }
}

console.log(`OKF structural check passed (${files.length} Markdown files)`);
