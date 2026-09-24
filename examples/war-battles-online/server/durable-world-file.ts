/** Deno file adapter for fixed authoritative world checkpoints. */

import {
  WORLD_CHECKPOINT_BYTES,
  type WorldCheckpointStorage,
} from "./world-persistence.ts";
import { replaceDurably, type DurableFileRuntime } from "./durable-file.ts";

interface DenoFileApi extends DurableFileRuntime {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options?: { mode?: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

declare const Deno: DenoFileApi;

export class DenoDurableWorldFile implements WorldCheckpointStorage {
  readonly path: string;
  readonly temporaryPath: string;

  constructor(path: string) {
    this.path = path;
    if (path.length === 0) throw new RangeError("world checkpoint path must not be empty");
    this.temporaryPath = `${path}.tmp`;
  }

  async read(): Promise<Uint8Array | undefined> {
    try {
      const bytes = await Deno.readFile(this.path);
      if (bytes.byteLength !== WORLD_CHECKPOINT_BYTES) throw new Error("world checkpoint has an unexpected length");
      return new Uint8Array(bytes);
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== WORLD_CHECKPOINT_BYTES) throw new RangeError("world checkpoint exceeds fixed capacity");
    await replaceDurably(Deno, this.temporaryPath, this.path, bytes);
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "NotFound" || candidate.code === "ENOENT";
}
