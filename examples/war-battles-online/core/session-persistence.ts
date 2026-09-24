/**
 * Fixed-capacity durable admission state.
 *
 * This is deliberately separate from the tick loop and the world snapshot.
 * It stores only the bounded credential-generation/reservation table needed
 * to make admission deterministic after a process restart. A deployment may
 * persist world snapshots through its own control-plane checkpoint; no such
 * write is performed here on every tick.
 */

import { MAX_PLAYERS } from "./constants.ts";
import { MAX_TICK_SPAN, tickAfter, tickAtOrBefore, tickDeadline } from "./ticks.ts";

export const SESSION_STATE_MAGIC = 0x31534257; // "WBS1" little-endian
export const SESSION_STATE_VERSION = 1;
export const SESSION_STATE_HEADER_BYTES = 24;
export const SESSION_STATE_SLOT_BYTES = 12;
export const SESSION_STATE_BYTES = SESSION_STATE_HEADER_BYTES + MAX_PLAYERS * SESSION_STATE_SLOT_BYTES + 4;

export interface SessionSlotState {
  readonly generation: number;
  /** Zero means currently authenticated; non-zero is a resume deadline. */
  readonly expiresAtTick: number;
  /** Optional opaque principal/version tag owned by the admission service. */
  readonly identityTag: number;
}

export interface SessionStateSnapshot {
  readonly matchId: number;
  readonly rosterSize: number;
  readonly checkpointTick: number;
  readonly generation: Uint32Array;
  readonly expiresAtTick: Uint32Array;
  readonly identityTag: Uint32Array;
}

export interface SessionStateExpectation {
  readonly matchId: number;
  readonly rosterSize: number;
}

export interface SessionLedgerOptions extends SessionStateExpectation {
  /** Grace applied to active credentials found in a crash checkpoint. */
  readonly restartReservationTicks?: number;
}

export class SessionPersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionPersistenceError";
    this.code = code;
  }
}

/** A fixed-capacity table with no allocations on its admission operations. */
export class SessionLedger {
  readonly matchId: number;
  readonly rosterSize: number;
  readonly generation = new Uint32Array(MAX_PLAYERS);
  readonly expiresAtTick = new Uint32Array(MAX_PLAYERS);
  readonly identityTag = new Uint32Array(MAX_PLAYERS);

  private dirty = false;
  private revision = 0;
  private checkpointTick = 0;
  private readonly restartReservationTicks: number;

  constructor(options: SessionLedgerOptions) {
    validateExpectation(options);
    this.matchId = options.matchId >>> 0;
    this.rosterSize = options.rosterSize;
    this.restartReservationTicks = options.restartReservationTicks === undefined
      ? 0
      : boundedTicks(options.restartReservationTicks, "restartReservationTicks");
  }

  get isDirty(): boolean { return this.dirty; }
  get changeRevision(): number { return this.revision; }
  /** Logical tick recorded in the last durable checkpoint. */
  get persistedCheckpointTick(): number { return this.checkpointTick; }

  hasCredential(slot: number): boolean {
    this.requireSlot(slot);
    return this.generation[slot]! !== 0;
  }

  isReserved(slot: number, tick: number): boolean {
    this.requireSlot(slot);
    unsigned(tick, "tick");
    const generation = this.generation[slot]!;
    const expires = this.expiresAtTick[slot]!;
    return generation !== 0 && (expires === 0 || tickAtOrBefore(tick, expires));
  }

  /** Records a successful welcome; expiry zero denotes an active owner. */
  commit(slot: number, generation: number, identityTag = 0): void {
    this.requireSlot(slot);
    unsignedNonzero(generation, "generation");
    unsigned(identityTag, "identityTag");
    const current = this.generation[slot]!;
    const expected = current === 0 ? 1 : ((current + 1) >>> 0 || 1);
    if (generation !== expected) throw persistence("generation", "credential generation is not the next rotation");
    this.generation[slot] = generation >>> 0;
    this.expiresAtTick[slot] = 0;
    this.identityTag[slot] = identityTag >>> 0;
    this.dirty = true;
    this.revision += 1;
  }

  /** Releases an owner while retaining its generation through a grace window. */
  reserveUntil(slot: number, expiresAtTick: number): void {
    this.requireSlot(slot);
    unsigned(expiresAtTick, "expiresAtTick");
    if (this.generation[slot] === 0) throw new SessionPersistenceError("missing-generation", "cannot reserve an unauthenticated slot");
    this.expiresAtTick[slot] = expiresAtTick >>> 0;
    this.dirty = true;
    this.revision += 1;
  }

  /** Releases an owner for a bounded span in uint32 serial-number order. */
  reserveFor(slot: number, tick: number, duration: number): void {
    unsigned(tick, "tick");
    this.reserveUntil(slot, tickDeadline(tick, duration));
  }

  /** Invalidates a slot, normally after a bounded reservation has expired. */
  clear(slot: number): void {
    this.requireSlot(slot);
    this.generation[slot] = 0;
    this.expiresAtTick[slot] = 0;
    this.identityTag[slot] = 0;
    this.dirty = true;
    this.revision += 1;
  }

  /** Expires reservations without touching active credentials (expiry zero). */
  expire(tick: number): number {
    unsigned(tick, "tick");
    let cleared = 0;
    for (let slot = 0; slot < this.rosterSize; slot += 1) {
      const expires = this.expiresAtTick[slot]!;
      if (this.generation[slot] !== 0 && expires !== 0 && tickAfter(tick, expires)) {
        this.clear(slot);
        cleared += 1;
      }
    }
    return cleared;
  }

  /** Control-plane copy for diagnostics or tests; not used in the tick loop. */
  snapshot(checkpointTick: number): SessionStateSnapshot {
    unsigned(checkpointTick, "checkpointTick");
    return {
      matchId: this.matchId,
      rosterSize: this.rosterSize,
      checkpointTick: checkpointTick >>> 0,
      generation: new Uint32Array(this.generation),
      expiresAtTick: new Uint32Array(this.expiresAtTick),
      identityTag: new Uint32Array(this.identityTag),
    };
  }

  encode(checkpointTick: number): Uint8Array {
    return encodeSessionState(this.snapshot(checkpointTick));
  }

  restore(bytes: Uint8Array, restartReservationTicks = this.restartReservationTicks): void {
    boundedTicks(restartReservationTicks, "restartReservationTicks");
    const restored = decodeSessionState(bytes, { matchId: this.matchId, rosterSize: this.rosterSize });
    this.generation.set(restored.generation);
    this.expiresAtTick.set(restored.expiresAtTick);
    this.identityTag.set(restored.identityTag);
    this.checkpointTick = restored.checkpointTick;
    // A crash can leave an active credential with expiry zero. It must not
    // permanently block anonymous admission after restart; give it one
    // bounded reservation window while still allowing its current token to
    // resume. Explicitly disconnected reservations retain their deadline.
    if (restartReservationTicks > 0) {
      const deadline = tickDeadline(restored.checkpointTick, restartReservationTicks);
      for (let slot = 0; slot < this.rosterSize; slot += 1) {
        if (this.generation[slot] !== 0 && this.expiresAtTick[slot] === 0) this.expiresAtTick[slot] = deadline;
      }
    }
    this.dirty = false;
    this.revision += 1;
  }

  markClean(revision = this.revision): void {
    if (revision === this.revision) this.dirty = false;
  }

  markCheckpoint(tick: number): void {
    unsigned(tick, "checkpointTick");
    this.checkpointTick = tick >>> 0;
  }

  private requireSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.rosterSize) throw new RangeError("session slot is outside the roster");
  }
}

export function encodeSessionState(state: SessionStateSnapshot): Uint8Array {
  validateSnapshot(state);
  const bytes = new Uint8Array(SESSION_STATE_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, SESSION_STATE_MAGIC, true);
  view.setUint16(4, SESSION_STATE_VERSION, true);
  view.setUint16(6, SESSION_STATE_HEADER_BYTES, true);
  view.setUint32(8, state.matchId >>> 0, true);
  view.setUint32(12, state.checkpointTick >>> 0, true);
  view.setUint8(16, state.rosterSize);
  view.setUint8(17, MAX_PLAYERS);
  view.setUint16(18, SESSION_STATE_SLOT_BYTES, true);
  view.setUint32(20, 0, true);
  let offset = SESSION_STATE_HEADER_BYTES;
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    view.setUint32(offset, state.generation[slot]!, true);
    view.setUint32(offset + 4, state.expiresAtTick[slot]!, true);
    view.setUint32(offset + 8, state.identityTag[slot]!, true);
    offset += SESSION_STATE_SLOT_BYTES;
  }
  view.setUint32(offset, crc32(bytes.subarray(0, offset)), true);
  return bytes;
}

export function decodeSessionState(bytes: Uint8Array, expected: SessionStateExpectation): SessionStateSnapshot {
  validateExpectation(expected);
  if (bytes.byteLength !== SESSION_STATE_BYTES) throw persistence("length", "session state has an unexpected length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SESSION_STATE_MAGIC) throw persistence("magic", "session state magic mismatch");
  if (view.getUint16(4, true) !== SESSION_STATE_VERSION) throw persistence("version", "unsupported session state version");
  if (view.getUint16(6, true) !== SESSION_STATE_HEADER_BYTES || view.getUint16(18, true) !== SESSION_STATE_SLOT_BYTES) {
    throw persistence("layout", "session state layout is not canonical");
  }
  if (view.getUint32(20, true) !== 0 || view.getUint8(17) !== MAX_PLAYERS) throw persistence("reserved", "session state reserved fields are nonzero");
  if (view.getUint32(8, true) !== (expected.matchId >>> 0)) throw persistence("match", "session state belongs to another match");
  if (view.getUint8(16) !== expected.rosterSize) throw persistence("roster", "session state roster size differs");
  const checksumOffset = SESSION_STATE_BYTES - 4;
  if (view.getUint32(checksumOffset, true) !== crc32(bytes.subarray(0, checksumOffset))) throw persistence("checksum", "session state checksum mismatch");
  const generation = new Uint32Array(MAX_PLAYERS);
  const expiresAtTick = new Uint32Array(MAX_PLAYERS);
  const identityTag = new Uint32Array(MAX_PLAYERS);
  let offset = SESSION_STATE_HEADER_BYTES;
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    generation[slot] = view.getUint32(offset, true);
    expiresAtTick[slot] = view.getUint32(offset + 4, true);
    identityTag[slot] = view.getUint32(offset + 8, true);
    if (slot >= expected.rosterSize && (generation[slot] !== 0 || expiresAtTick[slot] !== 0 || identityTag[slot] !== 0)) {
      throw persistence("capacity", "session state contains a record outside the roster");
    }
    if (generation[slot] === 0 && (expiresAtTick[slot] !== 0 || identityTag[slot] !== 0)) {
      throw persistence("record", "session state has metadata without a credential generation");
    }
    offset += SESSION_STATE_SLOT_BYTES;
  }
  return {
    matchId: view.getUint32(8, true),
    rosterSize: view.getUint8(16),
    checkpointTick: view.getUint32(12, true),
    generation,
    expiresAtTick,
    identityTag,
  };
}

export interface SessionStateStorage {
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
}

/**
 * Async persistence coordinator. Writes are explicit and serialized; callers
 * should invoke flush after admission/disconnect events or a chosen checkpoint
 * boundary, never from MatchServer.step().
 */
export class DurableSessionPersistence {
  readonly ledger: SessionLedger;
  private readonly storage: SessionStateStorage;
  private writeTail: Promise<void> = Promise.resolve();
  private healthy = true;

  constructor(ledger: SessionLedger, storage: SessionStateStorage) {
    this.ledger = ledger;
    this.storage = storage;
  }

  /** Whether the most recent storage operation completed successfully. */
  get isHealthy(): boolean { return this.healthy; }

  async restore(): Promise<boolean> {
    try {
      const bytes = await this.storage.read();
      if (bytes === undefined) return false;
      this.ledger.restore(bytes);
      this.healthy = true;
      return true;
    } catch (error: unknown) {
      this.healthy = false;
      throw error;
    }
  }

  async flush(checkpointTick: number): Promise<void> {
    const bytes = this.ledger.encode(checkpointTick);
    const revision = this.ledger.changeRevision;
    // Keep the tail itself rejected so the caller observes this write's
    // failure, but recover before the next queued write. A rejected promise
    // chained with plain `.then()` would permanently poison every retry.
    const write = this.writeTail.catch(() => undefined).then(() => this.storage.write(bytes));
    this.writeTail = write;
    try {
      await write;
      this.healthy = true;
      this.ledger.markClean(revision);
      this.ledger.markCheckpoint(checkpointTick);
    } catch (error: unknown) {
      this.healthy = false;
      throw error;
    }
  }
}

/** In-memory adapter used by focused restart tests and embedders. */
export class MemorySessionStateStorage implements SessionStateStorage {
  private bytes?: Uint8Array;

  async read(): Promise<Uint8Array | undefined> {
    return this.bytes === undefined ? undefined : new Uint8Array(this.bytes);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== SESSION_STATE_BYTES) throw new RangeError("session state write exceeds fixed capacity");
    this.bytes = new Uint8Array(bytes);
  }
}

function validateExpectation(expected: SessionStateExpectation): void {
  unsigned(expected.matchId, "matchId");
  if (!Number.isInteger(expected.rosterSize) || expected.rosterSize < 1 || expected.rosterSize > MAX_PLAYERS) {
    throw new SessionPersistenceError("roster", "roster size is outside the fixed player capacity");
  }
}

function validateSnapshot(state: SessionStateSnapshot): void {
  validateExpectation(state);
  unsigned(state.checkpointTick, "checkpointTick");
    if (state.generation.length !== MAX_PLAYERS || state.expiresAtTick.length !== MAX_PLAYERS || state.identityTag.length !== MAX_PLAYERS) {
    throw persistence("capacity", "session state arrays must equal MAX_PLAYERS");
  }
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    unsigned(state.generation[slot]!, "generation");
    unsigned(state.expiresAtTick[slot]!, "expiresAtTick");
    unsigned(state.identityTag[slot]!, "identityTag");
    if (state.generation[slot] === 0 && (state.expiresAtTick[slot] !== 0 || state.identityTag[slot] !== 0)) {
      throw persistence("record", "session state has metadata without a credential generation");
    }
  }
}

function unsigned(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw persistence("range", `${field} must fit uint32`);
}

function boundedTicks(value: number, field: string): number {
  unsigned(value, field);
  if (value > MAX_TICK_SPAN) throw persistence("range", `${field} must be at most ${MAX_TICK_SPAN}`);
  return value >>> 0;
}

function unsignedNonzero(value: number, field: string): void {
  unsigned(value, field);
  if (value === 0) throw persistence("range", `${field} must be nonzero`);
}

function persistence(code: string, message: string): SessionPersistenceError {
  return new SessionPersistenceError(`session-state-${code}`, message);
}

// Standard CRC-32 is a corruption guard, not an authentication primitive.
// Resume tokens carry the HMAC; deployments should protect the state file with
// normal filesystem/volume access controls as well.
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
