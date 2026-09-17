import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"]
]);

const server = createServer((request, response) => {
  let rawPath;
  try {
    rawPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("invalid URL\n");
    return;
  }
  const requestPath = rawPath === "/" ? "/web/index.html" : rawPath;
  const filePath = normalize(join(root, requestPath));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  if ((filePath !== root && !filePath.startsWith(rootPrefix))
      || !existsSync(filePath)
      || !statSync(filePath).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }

  response.writeHead(200, { "content-type": mime.get(extname(filePath)) ?? "application/octet-stream" });
  createReadStream(filePath).pipe(response);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Defold Hermes browser spike: http://127.0.0.1:${port}`);
});
