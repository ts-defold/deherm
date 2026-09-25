import {
  BattleClient,
  NetworkBotDriver,
  WebTransportGameClient,
  type ClientState,
  type WebTransportConnectionOptions,
} from "../core/index.ts";

interface DashboardConfig {
  readonly webTransportUrl: string;
  readonly certificateHash?: string;
  readonly maximumBots: number;
}

interface StartOptions {
  readonly count?: number;
  readonly skill?: number;
  readonly url?: string;
  readonly certificateHash?: string;
}

interface BotRow {
  readonly index: number;
  readonly client: BattleClient;
  readonly driver: NetworkBotDriver;
  state: ClientState | "opening" | "failed";
  error: string;
  transport?: WebTransportGameClient;
  lastPingAt: number;
}

export interface NetworkBotDashboardBotSummary {
  readonly index: number;
  readonly playerId: number;
  readonly state: ClientState | "opening" | "failed";
  readonly snapshotsApplied: number;
  readonly inputsSent: number;
  readonly inputsDropped: number;
  readonly roundTripMilliseconds: number;
  readonly pongsReceived: number;
  readonly commandsStaged: number;
  readonly nonIdleCommands: number;
  readonly chassisRequests: number;
  readonly weaponUpgradeRequests: number;
}

export interface NetworkBotDashboardSummary {
  readonly requested: number;
  readonly connected: number;
  readonly ready: number;
  readonly failed: number;
  readonly snapshotsApplied: number;
  readonly inputsSent: number;
  readonly inputsDropped: number;
  readonly maximumRoundTripMilliseconds: number;
  readonly players: readonly number[];
  readonly bots: readonly NetworkBotDashboardBotSummary[];
}

interface NetworkBotDashboardApi {
  start(options?: StartOptions): Promise<void>;
  stop(): void;
  summary(): NetworkBotDashboardSummary;
}

declare global {
  // Deliberately exposed for the real browser/QUIC integration gate and for
  // operators automating the dashboard through DevTools.
  var __warBattlesNetworkBots: NetworkBotDashboardApi | undefined;
}

const frameMilliseconds = 1000 / 60;
const rows: BotRow[] = [];
const resumeTokens: Array<Uint8Array | undefined> = [];
let configured: DashboardConfig = {
  webTransportUrl: "https://localhost:4433",
  maximumBots: 32,
};
let generation = 0;
let timer: number | undefined;
let lastFrame = performance.now();
let activeConnectionKey = "";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing dashboard element #${id}`);
  return element as T;
};

const urlInput = byId<HTMLInputElement>("url");
const countInput = byId<HTMLInputElement>("count");
const skillInput = byId<HTMLSelectElement>("skill");
const startButton = byId<HTMLButtonElement>("start");
const stopButton = byId<HTMLButtonElement>("stop");
const status = byId<HTMLElement>("status");
const botTable = byId<HTMLTableSectionElement>("bots");

const api: NetworkBotDashboardApi = {
  async start(options = {}) {
    const activeGeneration = ++generation;
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    const count = boundedInteger(options.count ?? Number(countInput.value), 1, configured.maximumBots);
    const skill = boundedInteger(options.skill ?? Number(skillInput.value), 0, 3);
    const url = options.url ?? (urlInput.value.trim() || configured.webTransportUrl);
    const certificateHash = options.certificateHash ?? configured.certificateHash;
    const connectionOptions = webTransportOptions(certificateHash);
    const connectionKey = `${url}\n${certificateHash ?? ""}`;
    if (activeConnectionKey !== connectionKey) {
      closeRows("network bot endpoint changed", false);
      resumeTokens.length = 0;
      activeConnectionKey = connectionKey;
    } else if (
      rows.some((row) => row.state === "failed" || row.client.state === "rejected" || row.client.state === "closed")
    ) {
      closeRows("failed bot wave replaced", true);
    }
    while (rows.length > count) {
      const row = rows.pop()!;
      saveResumeToken(row);
      row.client.close(1000, "network bot count reduced");
    }
    for (const row of rows) row.driver.setSkill(skill);
    urlInput.value = url;
    countInput.value = String(count);
    skillInput.value = String(skill);
    status.textContent = `Opening ${count} genuine WebTransport bot sessions…`;
    startButton.disabled = true;
    stopButton.disabled = false;

    for (let index = rows.length; index < count; index += 1) {
      if (activeGeneration !== generation) break;
      const row = makeBot(index, skill);
      rows.push(row);
      render();
      try {
        const transport = await WebTransportGameClient.connect(url, row.client, undefined, connectionOptions);
        if (activeGeneration !== generation) {
          transport.close(1000, "dashboard run replaced");
          break;
        }
        row.transport = transport;
        row.client.attach(transport);
        row.state = row.client.state;
      } catch (error: unknown) {
        row.state = "failed";
        row.error = error instanceof Error ? error.message : String(error);
      }
      // Admission remains observable and avoids a connection storm hiding the
      // first useful failure behind thirty-one concurrent handshakes.
      await delay(20);
    }
    if (activeGeneration !== generation) return;
    lastFrame = performance.now();
    timer = window.setInterval(tick, frameMilliseconds);
    startButton.disabled = false;
    render();
  },
  stop: stopBots,
  summary,
};
globalThis.__warBattlesNetworkBots = api;

startButton.addEventListener("click", () => startFromUi());
stopButton.addEventListener("click", stopBots);
window.addEventListener("beforeunload", stopBots);

void loadConfig().then(() => {
  const parameters = new URL(location.href).searchParams;
  const autoStart = Number(parameters.get("autostart") ?? 0);
  if (autoStart > 0) {
    startFromUi({
      count: autoStart,
      skill: Number(parameters.get("skill") ?? skillInput.value),
    });
  } else {
    render();
  }
});

function startFromUi(options?: StartOptions): void {
  void api.start(options).catch((error: unknown) => {
    status.textContent = `Deploy failed: ${error instanceof Error ? error.message : String(error)}`;
    startButton.disabled = false;
    stopButton.disabled = rows.length === 0;
  });
}

async function loadConfig(): Promise<void> {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (response.ok) configured = (await response.json()) as DashboardConfig;
  } catch {
    // A static build remains useful when the operator enters the endpoint and
    // uses a publicly trusted certificate.
  }
  urlInput.value = configured.webTransportUrl;
  countInput.max = String(configured.maximumBots);
}

function makeBot(index: number, skill: number): BotRow {
  const row = {} as BotRow;
  const client = new BattleClient({
    name: `netbot-${String(index + 1).padStart(2, "0")}`,
    assistAim: false,
    onWelcome: () => {
      row.state = "ready";
      saveResumeToken(row);
    },
    onClose: (close) => {
      saveResumeToken(row);
      row.transport = undefined;
      row.state = close.state;
    },
    onReject: (reject) => {
      row.state = "failed";
      row.error = `${reject.code}: ${reject.reason}`;
    },
    onError: (error) => {
      row.error = error instanceof Error ? error.message : String(error);
    },
  });
  const resumeToken = resumeTokens[index];
  if (resumeToken !== undefined) client.resumeToken.set(resumeToken);
  Object.assign(row, {
    index,
    client,
    driver: new NetworkBotDriver(client, { skill }),
    state: "opening" as const,
    error: "",
    lastPingAt: 0,
  });
  return row;
}

function tick(): void {
  const now = performance.now();
  const elapsed = Math.min(250, Math.max(0, now - lastFrame));
  lastFrame = now;
  for (const row of rows) {
    row.driver.update(elapsed, 8);
    if (row.client.state === "ready" && now - row.lastPingAt >= 1_000) {
      row.client.ping(Date.now());
      row.lastPingAt = now;
    }
    if (row.state !== "failed") row.state = row.client.state;
  }
  render();
}

function stopBots(): void {
  generation += 1;
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  closeRows("network bot dashboard stopped", true);
  startButton.disabled = false;
  stopButton.disabled = true;
  render();
}

function summary(): NetworkBotDashboardSummary {
  let connected = 0;
  let ready = 0;
  let failed = 0;
  let snapshotsApplied = 0;
  let inputsSent = 0;
  let inputsDropped = 0;
  let maximumRoundTripMilliseconds = 0;
  const players: number[] = [];
  const bots: NetworkBotDashboardBotSummary[] = [];
  for (const row of rows) {
    if (row.transport !== undefined) connected += 1;
    if (row.client.state === "ready") ready += 1;
    if (row.state === "failed" || row.client.state === "rejected") failed += 1;
    snapshotsApplied += row.client.stats.snapshotsApplied;
    inputsSent += row.client.stats.inputsSent;
    inputsDropped += row.client.stats.inputsDropped;
    maximumRoundTripMilliseconds = Math.max(maximumRoundTripMilliseconds, row.client.stats.lastRoundTripMilliseconds);
    if (row.client.playerId > 0) players.push(row.client.playerId);
    bots.push({
      index: row.index,
      playerId: row.client.playerId,
      state: row.state,
      snapshotsApplied: row.client.stats.snapshotsApplied,
      inputsSent: row.client.stats.inputsSent,
      inputsDropped: row.client.stats.inputsDropped,
      roundTripMilliseconds: row.client.stats.lastRoundTripMilliseconds,
      pongsReceived: row.client.stats.pongsReceived,
      commandsStaged: row.driver.stats.commandsStaged,
      nonIdleCommands: row.driver.stats.nonIdleCommands,
      chassisRequests: row.driver.stats.chassisRequests,
      weaponUpgradeRequests: row.driver.stats.weaponUpgradeRequests,
    });
  }
  return {
    requested: rows.length,
    connected,
    ready,
    failed,
    snapshotsApplied,
    inputsSent,
    inputsDropped,
    maximumRoundTripMilliseconds,
    players,
    bots,
  };
}

function saveResumeToken(row: BotRow): void {
  if (row.client.playerId > 0) resumeTokens[row.index] = row.client.resumeToken.slice();
}

function closeRows(reason: string, preserveResumeTokens: boolean): void {
  for (const row of rows) {
    if (preserveResumeTokens) saveResumeToken(row);
    row.client.close(1000, reason);
  }
  rows.length = 0;
}

function render(): void {
  const total = summary();
  status.textContent =
    total.requested === 0
      ? "Idle — start a bot wave against the running match server."
      : `${total.ready}/${total.requested} ready · ${total.snapshotsApplied} snapshots · ${total.inputsSent} inputs · ${total.inputsDropped} dropped`;
  botTable.replaceChildren(...rows.map(renderBot));
}

function renderBot(row: BotRow): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className =
    row.state === "failed" || row.client.state === "rejected" ? "failed" : row.client.state === "ready" ? "ready" : "";
  const values = [
    `BOT ${String(row.index + 1).padStart(2, "0")}`,
    row.state,
    row.client.playerId || "—",
    row.client.stats.lastServerTick,
    row.client.stats.snapshotsApplied,
    row.client.stats.inputsSent,
    row.client.stats.inputsDropped,
    row.client.stats.lastRoundTripMilliseconds || "—",
    row.error || "—",
  ];
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    tr.append(cell);
  }
  return tr;
}

function webTransportOptions(hash: string | undefined): WebTransportConnectionOptions | undefined {
  if (hash === undefined || hash === "") return undefined;
  const normalized = hash.replace(/:/gu, "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error("Certificate SHA-256 must be 64 hexadecimal characters");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return { serverCertificateHashes: [{ algorithm: "sha-256", value: bytes.buffer }] };
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
