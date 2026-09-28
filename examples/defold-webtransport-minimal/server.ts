interface WebTransportDatagramsLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable?: WritableStream<Uint8Array>;
  createWritable?(): WritableStream<Uint8Array>;
}

interface ServerWebTransportSessionLike {
  readonly url: string;
  readonly ready: Promise<void>;
  readonly closed: Promise<unknown>;
  readonly datagrams: WebTransportDatagramsLike;
  readonly incomingBidirectionalStreams: ReadableStream<{
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
  }>;
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
  close(info?: { closeCode?: number; reason?: string }): void;
}

interface DenoWebTransportRuntime {
  readonly QuicEndpoint: new (options: { hostname: string; port: number }) => {
    listen(options: { cert: string; key: string; alpnProtocols: readonly string[] }): AsyncIterable<{
      accept(): Promise<unknown>;
    }>;
  };
  upgradeWebTransport(connection: unknown): Promise<ServerWebTransportSessionLike>;
}

function datagramWriter(datagrams: WebTransportDatagramsLike): WritableStreamDefaultWriter<Uint8Array> {
  const writable = datagrams.createWritable?.() ?? datagrams.writable;
  if (!writable) throw new Error("This Deno build exposes no WebTransport datagram writer");
  return writable.getWriter();
}

async function echoDatagrams(session: ServerWebTransportSessionLike): Promise<void> {
  const reader = session.datagrams.readable.getReader();
  const writer = datagramWriter(session.datagrams);
  try {
    for (;;) {
      const packet = await reader.read();
      if (packet.done) return;
      await writer.write(packet.value);
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

async function echoBidirectionalStreams(session: ServerWebTransportSessionLike): Promise<void> {
  const reader = session.incomingBidirectionalStreams.getReader();
  try {
    for (;;) {
      const stream = await reader.read();
      if (stream.done) return;
      void stream.value.readable.pipeTo(stream.value.writable).catch(console.error);
    }
  } finally {
    reader.releaseLock();
  }
}

async function drainUnidirectionalStreams(session: ServerWebTransportSessionLike): Promise<void> {
  const reader = session.incomingUnidirectionalStreams.getReader();
  try {
    for (;;) {
      const stream = await reader.read();
      if (stream.done) return;
      void stream.value.pipeTo(new WritableStream()).catch(console.error);
    }
  } finally {
    reader.releaseLock();
  }
}

const runtime = Deno as unknown as DenoWebTransportRuntime;
if (runtime.QuicEndpoint === undefined || runtime.upgradeWebTransport === undefined) {
  throw new Error("Deno QUIC/WebTransport is unavailable; run a current Deno with --unstable-net");
}

const hostname = Deno.env.get("HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("PORT") ?? "4443");
const endpoint = new runtime.QuicEndpoint({ hostname, port });
const listener = endpoint.listen({
  cert: await Deno.readTextFile("cert.pem"),
  key: await Deno.readTextFile("key.pem"),
  alpnProtocols: ["h3"],
});

console.log(`minimal WebTransport echo server listening at https://${hostname}:${port}/echo`);
for await (const incoming of listener) {
  void (async () => {
    const session = await runtime.upgradeWebTransport(await incoming.accept());
    await session.ready;
    console.log(`session ready: ${session.url}`);
    await Promise.all([
      echoDatagrams(session),
      echoBidirectionalStreams(session),
      drainUnidirectionalStreams(session),
      session.closed,
    ]);
  })().catch((error: unknown) => console.error("session failed", error));
}
