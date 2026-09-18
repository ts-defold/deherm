import express from "express";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { H3Transport } from "@colyseus/h3-transport";
import { Room, defineServer } from "colyseus";

const here = dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "2567", 10);
const probePort = Number.parseInt(process.env.PROBE_PORT ?? "8080", 10);
const certificateDirectory = join(here, ".certs");
const certificatePath = join(certificateDirectory, "localhost.crt");
const privateKeyPath = join(certificateDirectory, "localhost.key");

if (
  !Number.isInteger(port) || port < 1 || port > 65535 ||
  !Number.isInteger(probePort) || probePort < 1 || probePort > 65535
) {
  throw new Error(`invalid PORT/PROBE_PORT: ${process.env.PORT}/${process.env.PROBE_PORT}`);
}

class BattleProbeRoom extends Room {
  maxClients = 32;

  onCreate() {
    this.onMessage("reliable-probe", (client, message) => {
      client.send("reliable-ack", {
        nonce: message?.nonce,
        lane: "reliable-stream",
      });
    });

    // The browser probe calls Room.sendUnreliable(), which the H3 SDK sends on
    // a QUIC datagram. A reliable acknowledgement proves that at least one
    // datagram crossed the browser/server boundary; it does not pretend that
    // every datagram must arrive.
    this.onMessage("unreliable-probe", (client, message) => {
      client.send("unreliable-ack", {
        sequence: message?.sequence,
        lane: "quic-datagram-in/reliable-stream-out",
      });
    });
  }
}

await mkdir(certificateDirectory, { recursive: true });
execFileSync("openssl", [
  "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
  "-nodes", "-sha256",
  "-days", "10",
  "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  "-keyout", privateKeyPath,
  "-out", certificatePath,
], { stdio: "ignore" });
const certificate = await readFile(certificatePath);
const privateKey = await readFile(privateKeyPath);
const fingerprint = Array.from(
  Buffer.from(new X509Certificate(certificate).fingerprint256.replaceAll(":", ""), "hex"),
);

const app = express();
app.get("/health", (_request, response) => {
  response.json({ ok: true, transport: "colyseus-h3-webtransport" });
});
app.get("/", async (_request, response, next) => {
  try {
    response.type("html").send(await readFile(join(here, "probe.html"), "utf8"));
  } catch (error) {
    next(error);
  }
});
app.use("/sdk", express.static(join(here, "node_modules", "@colyseus", "sdk", "dist")));

// The local certificate has an explicit localhost SAN and a ten-day lifetime,
// staying within browser WebTransport's certificate-hash constraints. The
// localhost proxy below injects its SHA-256 fingerprint into the reservation.
// Production must supply a publicly trusted certificate instead.
const server = defineServer({
  rooms: {
    battle_probe: BattleProbeRoom,
  },
  transport: new H3Transport({ app, cert: certificate, key: privateKey }),
});

await server.listen(port, host);
console.log(`Colyseus H3 probe listening on https://${host}:${port} (TCP + UDP)`);

// The self-signed fingerprint is sufficient for browser WebTransport, but not
// for the preceding browser fetch to the HTTPS matchmaker. This plain-HTTP
// localhost helper performs only that local POST inside the container and
// returns the reservation (including the certificate fingerprint). It is a dev
// probe convenience, not a production deployment pattern.
const probeApp = express();
probeApp.get("/health", (_request, response) => {
  response.json({ ok: true, transport: "colyseus-h3-webtransport" });
});
probeApp.get("/", async (_request, response, next) => {
  try {
    response.type("html").send(await readFile(join(here, "probe.html"), "utf8"));
  } catch (error) {
    next(error);
  }
});
probeApp.use("/sdk", express.static(join(here, "node_modules", "@colyseus", "sdk", "dist")));
probeApp.post("/reservation", express.raw({ type: "application/json", limit: "4kb" }), (request, response) => {
  const body = request.body?.byteLength ? request.body : Buffer.from("{}");
  const upstream = httpsRequest({
    hostname: "127.0.0.1",
    port,
    path: "/matchmake/joinOrCreate/battle_probe",
    method: "POST",
    rejectUnauthorized: false,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "content-length": body.byteLength,
    },
  }, (upstreamResponse) => {
    const chunks = [];
    upstreamResponse.on("data", (chunk) => chunks.push(chunk));
    upstreamResponse.on("end", () => {
      try {
        const reservation = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        reservation.fingerprint = fingerprint;
        response.status(upstreamResponse.statusCode ?? 502).json(reservation);
      } catch (error) {
        response.status(502).json({ error: `invalid matchmaking response: ${error.message}` });
      }
    });
  });
  upstream.on("error", (error) => {
    response.status(502).json({ error: error.message });
  });
  upstream.end(body);
});

createHttpServer(probeApp).listen(probePort, host, () => {
  console.log(`Browser probe listening on http://${host}:${probePort}`);
});
