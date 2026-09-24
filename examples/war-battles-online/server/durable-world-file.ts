/** Deno file adapter for fixed authoritative world checkpoints. */

import {
  WORLD_CHECKPOINT_BYTES,
  type WorldCheckpointStorage,
} from "./world-persistence.ts";

interface DenoFileApi {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
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
    await Deno.writeFile(this.temporaryPath, new Uint8Array(bytes));
    await Deno.rename(this.temporaryPath, this.path);
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "NotFound" || candidate.code === "ENOENT";
}
