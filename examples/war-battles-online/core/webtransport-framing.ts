import { validateReliableChannel, type ReliableChannel } from "./transport.ts";

export const RELIABLE_FRAME_HEADER_BYTES = 5;
export const MAX_RELIABLE_MESSAGE_BYTES = 64 * 1024;

/** Builds one owned wire frame shared by browser, native, and server lanes. */
export function encodeReliableFrame(channel: ReliableChannel, payload: Uint8Array): Uint8Array {
  validateReliableChannel(channel);
  if (payload.byteLength > MAX_RELIABLE_MESSAGE_BYTES) {
    throw new RangeError("reliable message exceeds fixed protocol limit");
  }
  const frame = new Uint8Array(RELIABLE_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, channel);
  view.setUint32(1, payload.byteLength, true);
  frame.set(payload, RELIABLE_FRAME_HEADER_BYTES);
  return frame;
}

/** Decodes exactly one message-oriented reliable frame. */
export function decodeReliableFrame(frame: Uint8Array): {
  readonly channel: ReliableChannel;
  readonly payload: Uint8Array;
} {
  if (frame.byteLength < RELIABLE_FRAME_HEADER_BYTES) throw new Error("reliable frame is shorter than its header");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const channel = view.getUint8(0);
  validateReliableChannel(channel);
  const payloadBytes = view.getUint32(1, true);
  if (payloadBytes > MAX_RELIABLE_MESSAGE_BYTES || payloadBytes !== frame.byteLength - RELIABLE_FRAME_HEADER_BYTES) {
    throw new Error("reliable frame length is invalid");
  }
  return { channel, payload: frame.slice(RELIABLE_FRAME_HEADER_BYTES) };
}

/**
 * Incremental decoder for WebTransport streams. One stream may fragment or
 * coalesce frames; the decoder owns partial bytes and emits exact payloads.
 */
export class ReliableFrameDecoder {
  private readonly header = new Uint8Array(RELIABLE_FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private expectedPayloadBytes = -1;
  private channel: ReliableChannel | undefined;
  private payload: Uint8Array | undefined;
  private payloadBytes = 0;

  /** Channel already named by a partial frame, if its header arrived. */
  get partialChannel(): ReliableChannel | undefined {
    return this.channel;
  }

  push(chunk: Uint8Array, emit: (channel: ReliableChannel, payload: Uint8Array) => void): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.headerBytes < RELIABLE_FRAME_HEADER_BYTES) {
        const count = Math.min(RELIABLE_FRAME_HEADER_BYTES - this.headerBytes, chunk.byteLength - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < RELIABLE_FRAME_HEADER_BYTES) continue;

        const channel = this.header[0]!;
        validateReliableChannel(channel);
        this.channel = channel;
        this.expectedPayloadBytes = new DataView(this.header.buffer).getUint32(1, true);
        if (this.expectedPayloadBytes > MAX_RELIABLE_MESSAGE_BYTES) {
          throw new Error("reliable message exceeds fixed protocol limit");
        }
        this.payload = new Uint8Array(this.expectedPayloadBytes);
        this.payloadBytes = 0;
        if (this.expectedPayloadBytes === 0) {
          emit(this.channel, this.payload);
          this.resetFrame();
        }
      }

      if (this.headerBytes === RELIABLE_FRAME_HEADER_BYTES && this.expectedPayloadBytes > 0) {
        const count = Math.min(this.expectedPayloadBytes - this.payloadBytes, chunk.byteLength - offset);
        this.payload!.set(chunk.subarray(offset, offset + count), this.payloadBytes);
        this.payloadBytes += count;
        offset += count;
        if (this.payloadBytes === this.expectedPayloadBytes) {
          emit(this.channel!, this.payload!);
          this.resetFrame();
        }
      }
    }
  }

  finish(): void {
    if (this.headerBytes !== 0) throw new Error("truncated reliable message");
  }

  private resetFrame(): void {
    this.headerBytes = 0;
    this.expectedPayloadBytes = -1;
    this.channel = undefined;
    this.payload = undefined;
    this.payloadBytes = 0;
  }
}
