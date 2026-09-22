import { createContentLengthJsonTransport } from "../protocol/content-length-json.mjs";

export function createDapTransport(input, output) {
  return createContentLengthJsonTransport(input, output, { protocol: "DAP" });
}
