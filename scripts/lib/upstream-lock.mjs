import { readFile } from "node:fs/promises";
import path from "node:path";

export function parseLock(text, label = "upstream.lock") {
  const values = new Map();
  const duplicates = [];
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (!match) continue;
    if (values.has(match[1])) duplicates.push(match[1]);
    values.set(match[1], match[2]);
  }
  if (duplicates.length > 0) {
    throw new Error(`${label} declares ${[...new Set(duplicates)].join(", ")} more than once`);
  }
  return values;
}

export async function readLockKeys(lockFile, keys) {
  const label = path.basename(lockFile);
  const values = parseLock(await readFile(lockFile, "utf8"), label);
  const missing = keys.filter((key) => !values.has(key));
  if (missing.length > 0) {
    throw new Error(`${label} does not declare ${missing.join(", ")}, which this consumer requires`);
  }
  return Object.fromEntries(keys.map((key) => [key, values.get(key)]));
}
