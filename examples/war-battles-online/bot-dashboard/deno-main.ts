declare const Deno: {
  readonly args: string[];
  readonly errors: { readonly NotFound: new (...arguments_: unknown[]) => Error };
  readFile(path: URL): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  serve(
    options: { hostname: string; port: number },
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;
};

const arguments_ = [...Deno.args];
const value = (name: string, fallback: string): string => {
  const index = arguments_.indexOf(name);
  return index >= 0 && arguments_[index + 1] !== undefined ? arguments_[index + 1]! : fallback;
};
const hostname = value("--hostname", "127.0.0.1");
const port = integer(value("--port", "8090"), "--port", 1, 65_535);
const webTransportUrl = value("--webtransport-url", "https://localhost:4433");
const certificateHashFile = value("--certificate-hash-file", "server/certs/fingerprint.txt");
const maximumBots = integer(value("--maximum-bots", "32"), "--maximum-bots", 1, 32);
const root = new URL("./dist/", import.meta.url);
let certificateHash = "";
try {
  certificateHash = (await Deno.readTextFile(certificateHashFile)).trim();
} catch {
  // Publicly trusted deployments do not need a certificate pin.
}

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
]);

Deno.serve({ hostname, port }, async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/config.json") {
    return Response.json(
      { webTransportUrl, certificateHash: certificateHash || undefined, maximumBots },
      {
        headers: { "cache-control": "no-store" },
      },
    );
  }
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!/^(?:index\.html|client\.js|client\.js\.map)$/u.test(name)) return new Response("not found\n", { status: 404 });
  try {
    const bytes = await Deno.readFile(new URL(name, root));
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body.buffer, {
      headers: {
        "content-type": types.get(name.slice(name.lastIndexOf("."))) ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch (error: unknown) {
    if (error instanceof Deno.errors.NotFound) return new Response("dashboard not built\n", { status: 503 });
    throw error;
  }
});

console.log(`war-battles-network-bot-dashboard:listening:http://${hostname}:${port}`);
console.log(`war-battles-network-bot-dashboard:target:${webTransportUrl}:maximum=${maximumBots}`);

function integer(text: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return parsed;
}
