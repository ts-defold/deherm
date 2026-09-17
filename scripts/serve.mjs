import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json; charset=utf-8"]
]);

const server = createServer((request, response) => {
  const rawPath = new URL(request.url ?? "/", "http://localhost").pathname;
  const requestPath = rawPath === "/" ? "/web/index.html" : rawPath;
  const filePath = normalize(join(root, requestPath));

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
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
