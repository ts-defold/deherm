import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const mimeTypes = new Map([
  [".json", "application/json; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"]
]);

function resolveRequest(root, requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  if (!url.pathname.startsWith("/build/")) return undefined;
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname.slice("/build/".length));
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0")) return null;
  const candidate = path.resolve(root, decoded);
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return candidate;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function startResourceServer(options) {
  const root = await realpath(path.resolve(options.root));
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      const file = resolveRequest(root, request.url ?? "/");
      if (file === undefined) {
        response.writeHead(404).end();
        return;
      }
      if (file === null) {
        response.writeHead(400).end();
        return;
      }
      let resolved;
      try {
        resolved = await realpath(file);
      } catch (error) {
        if (error?.code === "ENOENT") {
          response.writeHead(404).end();
          return;
        }
        throw error;
      }
      if (!contained(root, resolved)) {
        response.writeHead(400).end();
        return;
      }
      const metadata = await stat(resolved);
      if (!metadata.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const contents = await readFile(resolved);
      const etag = `"${createHash("sha256").update(contents).digest("hex")}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag }).end();
        return;
      }
      response.writeHead(200, {
        "content-length": contents.byteLength,
        "content-type": mimeTypes.get(path.extname(resolved)) ?? "application/octet-stream",
        etag
      });
      if (request.method === "HEAD") response.end();
      else response.end(contents);
    } catch (error) {
      options.onError?.(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("resource server did not bind a TCP port");
  return {
    root,
    port: address.port,
    baseUrl: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}/build`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
