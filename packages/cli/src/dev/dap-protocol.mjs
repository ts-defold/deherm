import { EventEmitter } from "node:events";

const maximumDapMessageBytes = 16 * 1024 * 1024;

export function createDapTransport(input, output) {
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
          if (buffer.length > 8192) fail(new Error("DAP header exceeds 8192 bytes"));
          return;
        }
        const headers = buffer.subarray(0, delimiter).toString("ascii").split("\r\n");
        buffer = buffer.subarray(delimiter + 4);
        const contentLength = headers
          .map((line) => line.match(/^content-length:\s*(\d+)$/iu))
          .find(Boolean)?.[1];
        expected = Number(contentLength);
        if (!Number.isSafeInteger(expected) || expected < 1 || expected > maximumDapMessageBytes) {
          fail(new Error("DAP message has no valid bounded Content-Length"));
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
        fail(new Error(`DAP message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  };
  input.on("data", (chunk) => {
    if (closed) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    if (buffer.length > maximumDapMessageBytes + 8192) {
      fail(new Error("DAP buffered input exceeds the protocol limit"));
      return;
    }
    parse();
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
      if (closed) throw new Error("DAP transport is closed");
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
