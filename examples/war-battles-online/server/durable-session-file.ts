/** Deno file adapter for DurableSessionPersistence.
 *
 * The core persistence format is fixed-size and checksummed. This adapter only
 * supplies durable bytes; it writes a sibling temporary file and renames it so
 * a process interruption cannot expose a partially written state file.
 */

import {
  SESSION_STATE_BYTES,
  type SessionStateStorage,
} from "../core/session-persistence.ts";

interface DenoFileApi {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

declare const Deno: DenoFileApi;

export class DenoDurableSessionFile implements SessionStateStorage {
  readonly path: string;
  readonly temporaryPath: string;

  constructor(path: string) {
    if (path.length === 0) throw new RangeError("session state path must not be empty");
    this.path = path;
    this.temporaryPath = `${path}.tmp`;
  }

  async read(): Promise<Uint8Array | undefined> {
    try {
      const bytes = await Deno.readFile(this.path);
      if (bytes.byteLength !== SESSION_STATE_BYTES) throw new Error("session state file has an unexpected length");
      return new Uint8Array(bytes);
    } catch (error: unknown) {
      // Only an absent file means first boot. Corruption and permission errors
      // must reach DurableSessionPersistence and fail closed.
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== SESSION_STATE_BYTES) throw new RangeError("session state write exceeds fixed capacity");
    await Deno.writeFile(this.temporaryPath, new Uint8Array(bytes));
    await Deno.rename(this.temporaryPath, this.path);
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "NotFound" || candidate.code === "ENOENT";
}

