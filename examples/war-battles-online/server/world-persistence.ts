/** Fixed-capacity authoritative world checkpoint control-plane helpers. */

import { SNAPSHOT_BYTES } from "../core/constants.ts";
import { crc32 } from "../core/session-persistence.ts";
import type { BattleWorld } from "../core/world.ts";

export const WORLD_CHECKPOINT_MAGIC = 0x31574257;
// Version 2 adds the admission-shape identity (roster size and team mode) to
// the fixed header.  Do not accept version 1 files whose shape was implicit.
export const WORLD_CHECKPOINT_VERSION = 2;
export const WORLD_CHECKPOINT_HEADER_BYTES = 32;
export const WORLD_CHECKPOINT_BYTES = WORLD_CHECKPOINT_HEADER_BYTES + SNAPSHOT_BYTES + 4;

export class WorldCheckpointError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorldCheckpointError";
    this.code = code;
  }
}

export interface WorldCheckpointStorage {
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
}

export interface WorldCheckpointContext {
  readonly matchId: number;
  readonly mapSeed: number;
  readonly rosterSize: number;
  readonly teams: boolean;
}

interface CheckpointWrite {
  bytes: Uint8Array;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export function encodeWorldCheckpoint(world: BattleWorld, context: WorldCheckpointContext): Uint8Array {
  validateContext(context);
  if (world.matchId !== (context.matchId >>> 0) || world.mapSeed !== (context.mapSeed >>> 0)) {
    throw checkpoint("identity", "world checkpoint context does not match the world");
  }
  const bytes = new Uint8Array(WORLD_CHECKPOINT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, WORLD_CHECKPOINT_MAGIC, true);
  view.setUint16(4, WORLD_CHECKPOINT_VERSION, true);
  view.setUint16(6, WORLD_CHECKPOINT_HEADER_BYTES, true);
  view.setUint32(8, SNAPSHOT_BYTES, true);
  view.setUint32(12, world.matchId, true);
  view.setUint32(16, world.mapSeed, true);
  view.setUint32(20, world.tick, true);
  view.setUint8(24, context.rosterSize);
  view.setUint8(25, context.teams ? 1 : 0);
  view.setUint16(26, 0, true);
  view.setUint32(28, 0, true);
  world.writeSnapshot(bytes, WORLD_CHECKPOINT_HEADER_BYTES);
  view.setUint32(WORLD_CHECKPOINT_BYTES - 4, crc32(bytes.subarray(0, WORLD_CHECKPOINT_BYTES - 4)), true);
  return bytes;
}

export function decodeWorldCheckpoint(world: BattleWorld, bytes: Uint8Array, context: WorldCheckpointContext): void {
  validateContext(context);
  if (bytes.byteLength !== WORLD_CHECKPOINT_BYTES) throw checkpoint("length", "world checkpoint has an unexpected length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== WORLD_CHECKPOINT_MAGIC) throw checkpoint("magic", "world checkpoint magic mismatch");
  if (view.getUint16(4, true) !== WORLD_CHECKPOINT_VERSION) throw checkpoint("version", "unsupported world checkpoint version");
  if (view.getUint16(6, true) !== WORLD_CHECKPOINT_HEADER_BYTES || view.getUint32(8, true) !== SNAPSHOT_BYTES) throw checkpoint("layout", "world checkpoint layout is not canonical");
  if (view.getUint16(26, true) !== 0 || view.getUint32(28, true) !== 0) throw checkpoint("reserved", "world checkpoint reserved fields are nonzero");
  if (view.getUint32(12, true) !== world.matchId) throw checkpoint("match", "world checkpoint belongs to another match");
  if (view.getUint32(16, true) !== world.mapSeed) throw checkpoint("arena", "world checkpoint belongs to another arena");
  if (view.getUint8(24) !== context.rosterSize) throw checkpoint("roster", "world checkpoint roster size differs");
  if (view.getUint8(25) !== (context.teams ? 1 : 0)) throw checkpoint("teams", "world checkpoint team mode differs");
  if (view.getUint32(WORLD_CHECKPOINT_BYTES - 4, true) !== crc32(bytes.subarray(0, WORLD_CHECKPOINT_BYTES - 4))) throw checkpoint("checksum", "world checkpoint checksum mismatch");
  const checkpointTick = view.getUint32(20, true);
  try {
    world.restoreSnapshot(bytes, WORLD_CHECKPOINT_HEADER_BYTES);
  } catch (error: unknown) {
    throw checkpoint("payload", error instanceof Error ? error.message : "world checkpoint payload is invalid");
  }
  if (world.tick !== checkpointTick) throw checkpoint("tick", "world checkpoint tick does not match its payload");
}

export class DurableWorldCheckpoint {
  readonly storage: WorldCheckpointStorage;
  private activeWrite?: CheckpointWrite;
  private pendingWrite?: CheckpointWrite;
  private healthy = true;
  readonly context: WorldCheckpointContext;
  constructor(storage: WorldCheckpointStorage, context: WorldCheckpointContext) {
    this.storage = storage;
    this.context = context;
    validateContext(context);
  }
  get isHealthy(): boolean { return this.healthy; }

  async restore(world: BattleWorld): Promise<boolean> {
    try {
      const bytes = await this.storage.read();
      if (bytes === undefined) return false;
      decodeWorldCheckpoint(world, bytes, this.context);
      this.healthy = true;
      return true;
    } catch (error: unknown) {
      this.healthy = false;
      throw error;
    }
  }

  flush(world: BattleWorld): Promise<void> {
    const bytes = encodeWorldCheckpoint(world, this.context);
    if (this.activeWrite === undefined) {
      const write = checkpointWrite(bytes);
      this.activeWrite = write;
      void this.run(write);
      return write.promise;
    }
    if (this.pendingWrite === undefined) this.pendingWrite = checkpointWrite(bytes);
    else this.pendingWrite.bytes = bytes;
    return this.pendingWrite.promise;
  }

  private async run(write: CheckpointWrite): Promise<void> {
    try {
      await this.storage.write(write.bytes);
      this.healthy = true;
      write.resolve();
    } catch (error: unknown) {
      this.healthy = false;
      write.reject(error);
    } finally {
      const next = this.pendingWrite;
      this.pendingWrite = undefined;
      this.activeWrite = next;
      if (next !== undefined) void this.run(next);
    }
  }
}

function checkpointWrite(bytes: Uint8Array): CheckpointWrite {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { bytes, promise, resolve, reject };
}

export class MemoryWorldCheckpointStorage implements WorldCheckpointStorage {
  private bytes?: Uint8Array;
  async read(): Promise<Uint8Array | undefined> { return this.bytes === undefined ? undefined : new Uint8Array(this.bytes); }
  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== WORLD_CHECKPOINT_BYTES) throw new RangeError("world checkpoint exceeds fixed capacity");
    this.bytes = new Uint8Array(bytes);
  }
}

function checkpoint(code: string, message: string): WorldCheckpointError {
  return new WorldCheckpointError(`world-checkpoint-${code}`, message);
}

function validateContext(context: WorldCheckpointContext): void {
  if (!Number.isInteger(context.matchId) || context.matchId < 0 || context.matchId > 0xffff_ffff) throw checkpoint("context", "checkpoint match id is invalid");
  if (!Number.isInteger(context.mapSeed) || context.mapSeed < 0 || context.mapSeed > 0xffff_ffff) throw checkpoint("context", "checkpoint arena seed is invalid");
  if (!Number.isInteger(context.rosterSize) || context.rosterSize < 1 || context.rosterSize > 32) throw checkpoint("context", "checkpoint roster size is invalid");
  if (typeof context.teams !== "boolean") throw checkpoint("context", "checkpoint team mode is invalid");
}
