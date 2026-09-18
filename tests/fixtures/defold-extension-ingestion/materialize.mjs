// Materializes a Defold project whose two third-party extensions are resolved
// the way Bob resolves them: as dependency archives under `.internal/lib`,
// named with Bob's own cache-key scheme, containing the upstream archive's
// top-level directory.
//
// The archives are built from the pinned interface files checked in under
// `vendor/`, so ingestion is offline, reproducible, and vendors no
// third-party native source. `extensions.lock.json` records the exact
// revisions, digests, licence provenance, and what was deliberately not
// vendored.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";

export const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));

export async function readExtensionLock() {
  return JSON.parse(await readFile(path.join(fixtureRoot, "extensions.lock.json"), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Bob names each resolved dependency archive
 * `sha1hex(dependencyUrl)-base64url(etag).zip`. Reproduced here so the fixture
 * project's `.internal/lib` layout matches a real Bob-resolved project.
 */
export function bobCacheArchiveName(dependencyUrl, etag) {
  const key = createHash("sha1").update(dependencyUrl, "utf8").digest("hex");
  return `${key}-${Buffer.from(etag, "utf8").toString("base64url")}.zip`;
}

/**
 * Writes the fixture project into `target` and returns the project root.
 *
 * Verifies every vendored file against the digest pinned in
 * `extensions.lock.json` before it is packed, so a silently edited fixture
 * fails loudly instead of changing what "real ingestion" means.
 */
export async function materializeIngestionProject(target, options = {}) {
  const lock = await readExtensionLock();
  const root = path.resolve(target);
  await mkdir(path.join(root, ".internal", "lib"), { recursive: true });
  await writeFile(
    path.join(root, "game.project"),
    await readFile(path.join(fixtureRoot, "project", "game.project"))
  );
  const archives = [];
  for (const extension of lock.extensions) {
    const files = {};
    for (const file of extension.vendoredFiles) {
      const bytes = await readFile(path.join(fixtureRoot, file.path));
      const digest = sha256(bytes);
      if (digest !== file.sha256) {
        throw new Error(`${file.path}: pinned sha256 ${file.sha256} but found ${digest}`);
      }
      files[`${extension.archiveEntryPrefix}/${file.upstream}`] = new Uint8Array(bytes);
    }
    const name = bobCacheArchiveName(extension.dependencyUrl, extension.revision);
    if (name !== extension.bobCacheArchive) {
      throw new Error(`${extension.id}: pinned Bob cache archive ${extension.bobCacheArchive} but derived ${name}`);
    }
    await writeFile(path.join(root, ".internal", "lib", name), zipSync(files));
    archives.push({ id: extension.id, archive: `.internal/lib/${name}` });
  }
  // A resolved dependency that ships no ext.manifest is the shape 43 of the 61
  // most-starred portal assets take. Included so discovery's report about them
  // is exercised by a real project layout rather than only by a unit test.
  if (options.includeLuaOnlyLibrary === true) {
    const luaOnly = zipSync({
      "lua-only-library/README.md": new Uint8Array(Buffer.from("# Pure Lua library\n", "utf8")),
      "lua-only-library/mymodule.lua": new Uint8Array(Buffer.from("local M = {}\nreturn M\n", "utf8")),
      "lua-only-library/other.lua": new Uint8Array(Buffer.from("return {}\n", "utf8"))
    });
    const name = bobCacheArchiveName("https://example.invalid/lua-only-library.zip", "fixture");
    await writeFile(path.join(root, ".internal", "lib", name), luaOnly);
    archives.push({ id: "lua-only-library", archive: `.internal/lib/${name}` });
  }
  return { root, lock, archives };
}
