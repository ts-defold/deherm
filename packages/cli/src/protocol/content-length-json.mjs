import { EventEmitter } from "node:events";

const defaultMaximumMessageBytes = 16 * 1024 * 1024;
const maximumHeaderBytes = 8192;

/**
 * Create a bounded Content-Length framed JSON transport.
 *
 * DAP and LSP deliberately share this framing primitive. Protocol-specific
 * request/response semantics stay in their owning adapters.
 */
export function createContentLengthJsonTransport(input, output, options = {}) {
  const protocol = options.protocol ?? "JSON";
  const maximumMessageBytes = options.maximumMessageBytes ?? defaultMaximumMessageBytes;
  const events = new EventEmitter();
  let buffer = Buffer.alloc(0);
  let expected = null;
  let closed = false;

  const fail = (error) => {
    if (closed) return;
    closed = true;
    events.emit("error", error);
  };
  const parse = () => {
    while (!closed) {
      if (expected === null) {
        const delimiter = buffer.indexOf("\r\n\r\n");
        if (delimiter < 0) {
          if (buffer.length > maximumHeaderBytes) fail(new Error(`${protocol} header exceeds ${maximumHeaderBytes} bytes`));
          return;
        }
        const headers = buffer.subarray(0, delimiter).toString("ascii").split("\r\n");
        buffer = buffer.subarray(delimiter + 4);
        const contentLength = headers
          .map((line) => line.match(/^content-length:\s*(\d+)$/iu))
          .find(Boolean)?.[1];
        expected = Number(contentLength);
        if (!Number.isSafeInteger(expected) || expected < 1 || expected > maximumMessageBytes) {
          fail(new Error(`${protocol} message has no valid bounded Content-Length`));
          return;
        }
      }
      if (buffer.length < expected) return;
      const body = buffer.subarray(0, expected);
      buffer = buffer.subarray(expected);
      expected = null;
      try {
        events.emit("message", JSON.parse(body.toString("utf8")));
      } catch (error) {
        fail(new Error(`${protocol} message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  };
  input.on("data", (chunk) => {
    if (closed) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    parse();
    if (!closed && buffer.length > maximumMessageBytes + maximumHeaderBytes) {
      fail(new Error(`${protocol} buffered input exceeds the protocol limit`));
    }
  });
  input.on("error", fail);
  input.on("end", () => {
    if (closed) return;
    closed = true;
    events.emit("end");
  });

  return {
    on: (name, listener) => {
      events.on(name, listener);
      return () => events.off(name, listener);
    },
    send(message) {
      if (closed) throw new Error(`${protocol} transport is closed`);
      const body = Buffer.from(JSON.stringify(message), "utf8");
      output.write(`Content-Length: ${body.length}\r\n\r\n`);
      output.write(body);
    },
    close() {
      closed = true;
      input.pause?.();
    }
  };
}
