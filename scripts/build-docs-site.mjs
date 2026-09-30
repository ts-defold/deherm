#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHighlighter } from "shiki";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultOutputDirectory = path.join(repositoryRoot, "build", "docs-site");

const html = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2);
const syntaxTheme = "github-dark-default";
let docsHighlighter;

async function highlighter() {
  docsHighlighter ??= createHighlighter({
    themes: [syntaxTheme],
    langs: ["shellscript", "typescript"],
  });
  return docsHighlighter;
}

function syntaxBlock(renderer, sourceText, language, variant) {
  return `<div class="syntax syntax-${html(variant)}" data-language="${html(language)}">${renderer.codeToHtml(
    sourceText,
    {
      lang: language,
      theme: syntaxTheme,
    },
  )}</div>`;
}
const compactBytes = (value) => {
  if (!Number.isFinite(value)) return "not measured";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 1 : 2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
};

async function readJson(relative) {
  const raw = await readFile(path.join(repositoryRoot, relative), "utf8");
  return { value: JSON.parse(raw), bytes: Buffer.byteLength(raw), sha256: digest(raw) };
}

async function readText(relative) {
  return readFile(path.join(repositoryRoot, relative), "utf8");
}

function source(pathname, record) {
  return { path: pathname, bytes: record.bytes, sha256: record.sha256 };
}

function renderPage({ site, metrics, samples }) {
  const navigation = site.navigation
    .map((item) => `<a href="${html(item.href)}" data-section-link>${html(item.label)}</a>`)
    .join("");
  const release = metrics.release;
  const transport = metrics.transport;
  const directNanoseconds = transport.results.directCAbi.bestNanoseconds;
  const relativeToDirect = (nanoseconds) => `${(nanoseconds / directNanoseconds).toFixed(1)}× fastest direct ABI`;
  const overheadPercent = (
    (release.nativeArm64Macos.engineOverheadBytes / release.nativeArm64Macos.stockDefoldEngineBytes) *
    100
  ).toFixed(0);
  const webOverheadPercent = (
    (release.browserWasmWeb.engineShellOverheadBytes /
      (release.browserWasmWeb.stockDefoldEngineWasmBytes + release.browserWasmWeb.stockDefoldEngineJavaScriptBytes)) *
    100
  ).toFixed(0);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${html(site.product)} — ${html(site.tagline)}</title>
  <meta name="description" content="${html(site.description)}">
  <meta name="theme-color" content="#0b0d11">
  <meta property="og:image" content="assets/deherm-og.png">
  <style>
    :root { color-scheme:dark; --bg:#090b0f; --panel:#12161d; --panel2:#171c24; --ink:#f4f5f6; --muted:#9ca5af; --line:#2a313c; --ember:#ff672e; --gold:#f1c66b; --cyan:#67dce8; --green:#82e8a5; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; color:var(--ink); background:var(--bg); font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; overflow-x:hidden; }
    a { color:inherit; } code,pre { font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; }
    .syntax .shiki { margin:0; background:transparent!important; tab-size:2; }
    .syntax .line { min-height:1lh; }
    .syntax-shell .line { display:block; }
    .syntax-shell .line:before { content:"$ "; color:var(--green); user-select:none; }
    .shell { width:min(1180px,calc(100% - 40px)); margin:auto; }
    .nav { position:sticky; z-index:20; top:0; display:flex; justify-content:space-between; align-items:center; min-height:64px; background:#090b0fe8; backdrop-filter:blur(18px); border-bottom:1px solid #ffffff0b; }
    .nav-inner { display:flex; width:min(1180px,calc(100% - 40px)); margin:auto; align-items:center; gap:28px; }
    .brand { font-weight:850; text-decoration:none; letter-spacing:-.04em; font-size:1.12rem; margin-right:auto; }
    .nav-links { display:flex; gap:24px; } .nav-links a { position:relative; color:var(--muted); text-decoration:none; font-size:.86rem; transition:color 180ms ease; } .nav-links a:hover,.nav-links a[aria-current="location"] { color:#fff; } .nav-links a:after { content:""; position:absolute; left:0; right:0; bottom:-9px; height:2px; border-radius:999px; background:linear-gradient(90deg,var(--ember),var(--gold)); transform:scaleX(0); transform-origin:left; opacity:0; transition:transform 220ms ease,opacity 220ms ease; } .nav-links a[aria-current="location"]:after { transform:scaleX(1); opacity:1; }
    .github { border:1px solid var(--line); border-radius:999px; padding:8px 14px; text-decoration:none; font-size:.82rem; }
    .hero { min-height:760px; display:grid; align-items:center; padding:110px 0 90px; position:relative; }
    .hero:before { content:""; position:absolute; width:900px; height:900px; left:46%; top:-360px; border-radius:50%; background:radial-gradient(circle,#fe6d3130 0,#6d4ada14 37%,transparent 68%); filter:blur(4px); pointer-events:none; animation:ambient-glow 11s ease-in-out infinite alternate; }
    .hero-grid { display:grid; grid-template-columns:1.08fr .92fr; gap:72px; align-items:center; position:relative; }
    .kicker { color:var(--ember); font-weight:750; text-transform:uppercase; letter-spacing:.16em; font-size:.72rem; }
    h1 { font-size:clamp(4rem,8.5vw,7.5rem); line-height:.86; letter-spacing:-.085em; margin:18px 0 28px; max-width:8ch; }
    h1 em { color:var(--ember); font-style:normal; }
    .lead { color:#c2c8ce; font-size:clamp(1.1rem,2vw,1.35rem); max-width:600px; line-height:1.55; }
    .actions { display:flex; gap:12px; margin-top:34px; flex-wrap:wrap; }
    .button { display:inline-flex; align-items:center; border-radius:10px; padding:13px 18px; text-decoration:none; font-weight:750; background:var(--ember); color:#130d0a; transition:transform 180ms ease,box-shadow 180ms ease,border-color 180ms ease; } .button:hover { transform:translateY(-2px); box-shadow:0 12px 30px #ff672e24; }
    .button.secondary { background:transparent; color:#fff; border:1px solid var(--line); }
    .terminal { background:#080a0d; border:1px solid #353c47; border-radius:16px; padding:13px; box-shadow:0 45px 100px #000b; transform:perspective(1000px) rotateY(-4deg) rotateX(1deg); animation:terminal-arrive 700ms cubic-bezier(.2,.75,.25,1) 120ms both; }
    .traffic { display:flex; gap:7px; padding:4px 4px 13px; } .traffic i { width:10px; height:10px; border-radius:50%; background:#343b45; } .traffic i:first-child { background:#f1694d; } .traffic i:nth-child(2) { background:#e9bb4f; } .traffic i:nth-child(3) { background:#65ca72; }
    .terminal .syntax { border-radius:10px; padding:21px; background:#0c1015; font-size:.8rem; line-height:1.85; overflow:auto; }
    .band { border-top:1px solid var(--line); padding:120px 0; scroll-margin-top:63px; }
    .band.soft { background:linear-gradient(180deg,#0c0f14,#11161d); }
    .section-head { max-width:760px; margin-bottom:56px; } h2 { font-size:clamp(2.65rem,6vw,5.2rem); line-height:.95; letter-spacing:-.065em; margin:14px 0 22px; } .section-head p { color:var(--muted); font-size:1.15rem; }
    .setup-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:20px; }
    .setup { background:#080a0d; border:1px solid var(--line); border-radius:16px; overflow:hidden; }
    .setup header { padding:14px 18px; color:var(--gold); border-bottom:1px solid var(--line); font-weight:750; font-size:.78rem; text-transform:uppercase; letter-spacing:.1em; }
    .setup .syntax { padding:20px; font-size:.78rem; line-height:1.85; overflow:auto; }
    .quick-grid { display:grid; grid-template-columns:.78fr 1.22fr; gap:20px; align-items:stretch; }
    .steps { display:grid; gap:12px; } .step { border:1px solid var(--line); border-radius:14px; padding:22px; background:var(--panel); } .step strong { display:block; color:var(--gold); font-size:.82rem; text-transform:uppercase; letter-spacing:.12em; margin-bottom:7px; } .step p { margin:0; color:#c7cdd3; }
    .code { background:#080a0d; border:1px solid var(--line); border-radius:16px; overflow:hidden; } .code header { display:flex; justify-content:space-between; padding:13px 18px; color:var(--muted); border-bottom:1px solid var(--line); font-size:.78rem; } .code .syntax { padding:24px; overflow:auto; color:#e5e9ed; font-size:.78rem; line-height:1.65; }
    .feature { display:grid; grid-template-columns:1fr 1fr; gap:54px; align-items:center; margin:110px 0; } .feature.reverse .copy { order:2; } .copy h3 { font-size:clamp(2rem,4vw,3.7rem); line-height:1; letter-spacing:-.055em; margin:10px 0 20px; } .copy p { color:var(--muted); font-size:1.08rem; } .pills { display:flex; flex-wrap:wrap; gap:8px; margin-top:25px; } .pills span { border:1px solid var(--line); color:#bdc5ce; padding:7px 10px; border-radius:999px; font-size:.75rem; }
    .shot { background:#141820; border:1px solid #343c48; border-radius:18px; padding:10px; box-shadow:0 35px 80px #0009; overflow:hidden; transition:transform 260ms ease,border-color 260ms ease,box-shadow 260ms ease; } .shot:hover { transform:translateY(-3px); border-color:#495464; box-shadow:0 42px 90px #000b; } .shot img { display:block; width:100%; height:auto; border-radius:10px; }
    .shot-vscode { aspect-ratio:16/10; }
    .shot-vscode img { width:111%; max-width:none; transform:translateX(-10%); }
    .bench-grid,.size-grid,.target-grid,.example-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
    .metric { border:1px solid var(--line); border-radius:18px; padding:27px; background:var(--panel); min-height:220px; transition:transform 200ms ease,border-color 200ms ease,background-color 200ms ease; } .metric:hover { transform:translateY(-3px); border-color:#414b59; background:#151a22; } .metric strong { display:block; font-size:clamp(2rem,4vw,3.2rem); letter-spacing:-.06em; color:var(--gold); line-height:1; margin:20px 0 14px; } .metric h3 { margin:0; font-size:.9rem; } .metric p { color:var(--muted); font-size:.84rem; margin:0; }
    .boundary { margin-top:18px; color:#7f8994; font-size:.74rem; max-width:900px; }
    .size-grid { grid-template-columns:1fr 1fr; margin-top:80px; } .size-card { border-radius:20px; padding:32px; border:1px solid var(--line); background:linear-gradient(145deg,#181e27,#10141a); } .size-card .big { font-size:clamp(2.6rem,6vw,5rem); font-weight:850; letter-spacing:-.075em; line-height:1; margin:15px 0; } .size-card dl { display:grid; grid-template-columns:1fr auto; gap:9px 20px; color:var(--muted); font-size:.82rem; } .size-card dt,.size-card dd { margin:0; } .size-card dd { color:#e7ebee; font-family:ui-monospace,monospace; }
    .target-grid { grid-template-columns:repeat(3,1fr); } .target { min-height:290px; padding:28px; border:1px solid var(--line); background:var(--panel); border-radius:18px; } .target .symbol { font-size:2rem; color:var(--cyan); } .target h3 { font-size:1.35rem; margin:22px 0 10px; } .target p { color:var(--muted); font-size:.9rem; } .target code { color:var(--gold); font-size:.78rem; }
    .example-grid { grid-template-columns:1.3fr .7fr; } .example { border:1px solid var(--line); border-radius:20px; padding:35px; min-height:310px; background:linear-gradient(135deg,#171c25,#0d1015); display:flex; flex-direction:column; justify-content:flex-end; position:relative; overflow:hidden; } .example:before { content:""; position:absolute; inset:-30% -20% 20% 40%; background:radial-gradient(circle,#ff672e30,transparent 65%); } .example h3,.example p,.example a { position:relative; } .example h3 { font-size:2rem; margin:0 0 8px; letter-spacing:-.04em; } .example p { color:var(--muted); } .example a { color:var(--cyan); text-decoration:none; font-weight:700; }
    footer { padding:25px 0; color:var(--muted); border-top:1px solid var(--line); font-size:.78rem; } footer .shell { display:flex; justify-content:space-between; align-items:center; gap:22px; } .footer-brand { display:flex; align-items:baseline; gap:9px; } .footer-brand strong { color:var(--ink); font-size:.93rem; letter-spacing:-.025em; } .footer-links { display:flex; align-items:center; gap:7px; } .footer-links a { display:inline-flex; align-items:center; gap:7px; min-height:34px; padding:6px 9px; border-radius:8px; color:#adb6bf; text-decoration:none; transition:color 160ms ease,background-color 160ms ease; } .footer-links a:hover { color:#fff; background:#ffffff0b; } .footer-links svg { width:15px; height:15px; fill:currentColor; flex:none; }
    @keyframes terminal-arrive { from { opacity:0; transform:perspective(1000px) rotateY(-4deg) rotateX(1deg) translateY(14px); } to { opacity:1; transform:perspective(1000px) rotateY(-4deg) rotateX(1deg) translateY(0); } }
    @keyframes ambient-glow { from { transform:translate3d(-12px,-4px,0) scale(.98); opacity:.78; } to { transform:translate3d(18px,12px,0) scale(1.04); opacity:1; } }
    @media (max-width:860px) { .nav-links { display:none; } .hero { min-height:auto; } .hero-grid,.setup-grid,.quick-grid,.feature,.size-grid,.example-grid { grid-template-columns:1fr; } .feature.reverse .copy { order:initial; } .bench-grid,.target-grid { grid-template-columns:1fr; } .terminal { transform:none; } .hero-grid { gap:45px; } footer .shell { align-items:flex-start; flex-direction:column; gap:12px; } }
    @media (prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } *,*:before,*:after { animation-duration:.01ms!important; animation-iteration-count:1!important; transition-duration:.01ms!important; } }
  </style>
</head>
<body>
  <nav class="nav"><div class="nav-inner"><a class="brand" href="#">déherm</a><div class="nav-links">${navigation}</div><a class="github" href="${html(site.links.repository)}">GitHub ↗</a></div></nav>
  <header class="hero"><div class="shell hero-grid"><div><div class="kicker">Defold × TypeScript × Hermes</div><h1>Make games. <em>Stay typed.</em></h1><p class="lead">${html(site.description)}</p><div class="actions"><a class="button" href="#quick-start">Get started</a><a class="button secondary" href="${html(site.links.repository)}">View source</a></div></div><div class="terminal"><div class="traffic"><i></i><i></i><i></i></div>${samples.newProject}</div></div></header>

  <section class="band soft" id="quick-start"><div class="shell"><div class="section-head"><div class="kicker">Quick start</div><h2>Playable in four commands.</h2><p>Scaffold a complete Defold + TypeScript game, or add déherm to the directory that already contains your <code>game.project</code>. The project’s selected Defold revision remains the source of truth.</p></div><div class="setup-grid"><div class="setup"><header>${html(site.quickStart.newProject.label)}</header>${samples.newProject}</div><div class="setup"><header>${html(site.quickStart.existingProject.label)}</header>${samples.existingProject}</div></div><div class="quick-grid"><div class="steps"><div class="step"><strong>01 · Author</strong><p>Save this as <code>src/player.script.ts</code>. Generation creates the <code>/src/player.script</code> proxy that you attach to a game object in Defold.</p></div><div class="step"><strong>02 · Play</strong><p><code>pnpm dev</code> opens the full TUI. Press <code>p</code> to build and launch native Defold; press <code>w</code> for HTML5.</p></div><div class="step"><strong>03 · Iterate</strong><p>Save TypeScript or an asset. The watcher compiles the new generation, activates it, and reports HMR and runtime telemetry in the same console.</p></div></div><div class="code"><header><span>src/player.script.ts</span><span>generated as /src/player.script</span></header>${samples.component}</div></div></div></section>

  <section class="band" id="developer-tools"><div class="shell"><div class="section-head"><div class="kicker">The loop</div><h2>Built for the work between saves.</h2><p>The editor and terminal are one development surface: generation state, engine targets, logs, live instances, source maps, profiles, and hot reload stay visible.</p></div><div class="feature"><div class="copy"><div class="kicker">TUI</div><h3>Build, launch, inspect, reload.</h3><p>The default CLI is a full terminal UI. It follows the current generation into native Defold and HTML5, reports the exact activated bundle fingerprint, exposes live logs and target telemetry, and keeps controls discoverable on laptop keyboards.</p><div class="pills"><span>file watcher</span><span>incremental compiler</span><span>native + HTML5</span><span>HMR status</span><span>live logs</span><span>profiles</span></div></div><figure class="shot"><img src="assets/deherm-tui.svg" alt="Déherm development TUI showing build state, targets, logs, and metrics"></figure></div><div class="feature reverse"><div class="copy"><div class="kicker">VS Code</div><h3>Your game, alive in the editor.</h3><p>The language server understands generated Defold resources and component contexts. The extension adds inline property defaults, live instance values, TypeScript source-mapped debugging, evaluate, CPU profiles, and streaming heap snapshots.</p><div class="pills"><span>completion + hover</span><span>resource names</span><span>breakpoints</span><span>live instances</span><span>.cpuprofile</span><span>.heapsnapshot</span></div></div><figure class="shot shot-vscode"><img src="assets/vscode-live-values.png" alt="VS Code editing a Defold TypeScript component with live values"></figure></div></div></section>

  <section class="band soft" id="performance"><div class="shell"><div class="section-head"><div class="kicker">Measured in Release</div><h2>Know what the boundary costs.</h2><p>Every headline uses nanoseconds. These generated transport measurements isolate crossing and framing work over stub providers so engine work cannot hide it.</p></div><div class="bench-grid"><article class="metric"><h3>Direct generated C ABI</h3><strong>${directNanoseconds.toFixed(1)} ns</strong><p><b>1.0× fastest direct ABI.</b> Fastest observed borrowed-handle frame; the measured range was ${transport.results.directCAbi.bestNanoseconds.toFixed(1)}–${transport.results.directCAbi.worstNanoseconds.toFixed(1)} ns.</p></article><article class="metric"><h3>Static Hermes typed-native</h3><strong>${transport.results.typedNativeMedianNanoseconds.toFixed(1)} ns</strong><p><b>${relativeToDirect(transport.results.typedNativeMedianNanoseconds)}.</b> Median across ${transport.results.typedNativeShapes} argument/result shapes; ${transport.results.typedNativeMinimumNanoseconds.toFixed(1)}–${transport.results.typedNativeMaximumNanoseconds.toFixed(1)} ns observed.</p></article><article class="metric"><h3>Complete generated Lua crossing</h3><strong>${transport.results.luaStackMedianNanoseconds.toFixed(1)} ns</strong><p><b>${relativeToDirect(transport.results.luaStackMedianNanoseconds)}.</b> Protected Lua alone measured ${transport.results.protectedLuaMedianNanoseconds.toFixed(1)} ns; déherm added ${transport.results.luaBridgeOwnedMedianNanoseconds.toFixed(1)} ns of staging and transport.</p></article></div><p class="boundary">${html(transport.evidenceBoundary)} Host: ${html(transport.host.cpu)}, ${transport.build.warmupCalls.toLocaleString("en-US")} warm-up calls, best of ${transport.build.repeats} × ${transport.build.callsPerRepeat.toLocaleString("en-US")} calls.</p>
  <div class="size-grid"><article class="size-card"><div class="kicker">arm64 macOS release</div><div class="big">${compactBytes(release.nativeArm64Macos.packageLogicalBytes)}</div><p>Complete War Battles <code>.app</code> logical file bytes.</p><dl><dt>Linked déherm engine</dt><dd>${compactBytes(release.nativeArm64Macos.engineBytes)}</dd><dt>Stock Defold release engine</dt><dd>${compactBytes(release.nativeArm64Macos.stockDefoldEngineBytes)}</dd><dt>Hermes + déherm engine delta</dt><dd>+${compactBytes(release.nativeArm64Macos.engineOverheadBytes)} (${overheadPercent}%)</dd><dt>Optimized game bytecode</dt><dd>${compactBytes(release.nativeArm64Macos.applicationBytecodeBytes)}</dd></dl></article><article class="size-card"><div class="kicker">HTML5 / wasm-web release</div><div class="big">${compactBytes(release.browserWasmWeb.packageLogicalBytes)}</div><p>Complete deployable browser directory. The browser lane does not embed Hermes.</p><dl><dt>Wasm engine</dt><dd>${compactBytes(release.browserWasmWeb.engineWasmBytes)}</dd><dt>Engine JavaScript</dt><dd>${compactBytes(release.browserWasmWeb.engineJavaScriptBytes)}</dd><dt>Déherm browser-host delta</dt><dd>+${compactBytes(release.browserWasmWeb.engineShellOverheadBytes)} (${webOverheadPercent}%)</dd><dt>Hermes embedded</dt><dd>no</dd></dl></article></div><p class="boundary">${html(release.evidenceBoundary)}</p></div></section>

  <section class="band" id="targets"><div class="shell"><div class="section-head"><div class="kicker">One authored surface</div><h2>The runtime follows the target.</h2><p>The generator emits the whole compatible API once. The build keeps only reachable code and selects the transport that belongs on the target.</p></div><div class="target-grid"><article class="target"><div class="symbol">◆</div><h3>Native development</h3><p>Dynamic Hermes keeps iteration immediate: bundle JavaScript to Hermes bytecode, load it in the Defold extension, and hot reload without relinking the engine.</p><code>Hermes bytecode + JSI</code></article><article class="target"><div class="symbol">▲</div><h3>Native release</h3><p>Static Hermes can compile the reachable typed subset through generated C ABI bindings. Dynamic Hermes remains available where the selected profile needs it.</p><code>typed-native + generated fallback</code></article><article class="target"><div class="symbol">●</div><h3>HTML5</h3><p>Use the JavaScript engine already in the browser. Generated direct-memory bindings call into Defold’s Wasm engine without embedding another VM or using embind.</p><code>browser JS + Wasm direct memory</code></article></div></div></section>

  <section class="band soft" id="examples"><div class="shell"><div class="section-head"><div class="kicker">Ship something</div><h2>Examples that exercise the product.</h2><p>Start small, then inspect the dogfood game and the standalone networking extension when you need the full stack.</p></div><div class="example-grid"><article class="example"><h3>War Battles Online</h3><p>A complete Defold game written in TypeScript: generated components, GUI, native and browser targets, hot reload, Static Hermes reachability, bots, and a 32-player network simulation.</p><a href="${html(site.links.warBattles)}">Explore the game →</a></article><article class="example"><h3>WebTransport</h3><p>A separately usable Defold extension with a Lua API, C API, TypeScript surface, browser backend, native QUIC backend, and minimal Deno echo server.</p><a href="${html(site.links.webTransport)}">Use the extension →</a></article></div></div></section>
  <footer><div class="shell"><div class="footer-brand"><strong>déherm</strong><span>TypeScript for Defold · MIT licensed</span></div><nav class="footer-links" aria-label="Community links"><a href="${html(site.links.tsDefold)}" target="_blank" rel="noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 6h-3.1a15.8 15.8 0 0 0-1.3-3.1A8.1 8.1 0 0 1 18.9 8ZM12 4c.8 1 1.5 2.3 1.9 4h-3.8c.4-1.7 1.1-3 1.9-4ZM4.3 14a8 8 0 0 1 0-4h3.4a16.6 16.6 0 0 0 0 4H4.3Zm.8 2h3.1a15.8 15.8 0 0 0 1.3 3.1A8.1 8.1 0 0 1 5.1 16Zm3.1-8H5.1a8.1 8.1 0 0 1 4.4-3.1A15.8 15.8 0 0 0 8.2 8ZM12 20c-.8-1-1.5-2.3-1.9-4h3.8c-.4 1.7-1.1 3-1.9 4Zm2.3-6H9.7a14.8 14.8 0 0 1 0-4h4.6a14.8 14.8 0 0 1 0 4Zm.2 5.1a15.8 15.8 0 0 0 1.3-3.1h3.1a8.1 8.1 0 0 1-4.4 3.1Zm1.8-5.1a16.6 16.6 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4Z"/></svg><span>ts-defold</span></a><a href="${html(site.links.repository)}" target="_blank" rel="noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .7a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.2.8-.5v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.8 5.4-5.5 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.6.8.5A11.5 11.5 0 0 0 12 .7Z"/></svg><span>GitHub</span></a><a href="${html(site.links.discord)}" target="_blank" rel="noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 5.3A17.2 17.2 0 0 0 15.2 4l-.5 1a15.8 15.8 0 0 0-5.4 0l-.5-1a17.4 17.4 0 0 0-4.3 1.3C1.8 9.3 1.1 13.2 1.4 17a17.6 17.6 0 0 0 5.3 2.7l1.3-1.8-1.8-.9.4-.3c3.5 1.6 7.3 1.6 10.8 0l.5.3-1.9.9 1.3 1.8a17.6 17.6 0 0 0 5.3-2.7c.4-4.4-.7-8.2-3.1-11.7ZM8.3 14.7c-1.1 0-1.9-1-1.9-2.2s.8-2.2 1.9-2.2 2 1 1.9 2.2c0 1.2-.8 2.2-1.9 2.2Zm7.4 0c-1.1 0-1.9-1-1.9-2.2s.8-2.2 1.9-2.2 2 1 1.9 2.2c0 1.2-.8 2.2-1.9 2.2Z"/></svg><span>Discord</span></a></nav></div></footer>
  <script>
    (() => {
      const links = [...document.querySelectorAll("[data-section-link]")];
      const sections = links.map((link) => document.querySelector(link.hash)).filter(Boolean);
      let scheduled = false;
      const update = () => {
        scheduled = false;
        const marker = 64 + innerHeight * 0.28;
        let active = null;
        for (const section of sections) {
          if (section.getBoundingClientRect().top <= marker) active = section.id;
        }
        for (const link of links) {
          if (link.hash === \`#\${active}\`) link.setAttribute("aria-current", "location");
          else link.removeAttribute("aria-current");
        }
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(update);
      };
      addEventListener("scroll", schedule, { passive: true });
      addEventListener("resize", schedule, { passive: true });
      update();
    })();
  </script>
</body></html>\n`;
}

export async function buildDocsSite({ output = defaultOutputDirectory } = {}) {
  const site = JSON.parse(await readText("docs/site/site.json"));
  const [packageJson, scriptAccounting, dmsdkAccounting, release, transport, vscode] = await Promise.all([
    readJson("package.json"),
    readJson("packages/bindings/generated/defold-script-api-accounting.json"),
    readJson("packages/bindings/generated/defold-dmsdk-accounting.json"),
    readJson("docs/site/evidence/release-sizes.json"),
    readJson("docs/site/evidence/transport-overhead.json"),
    readJson("examples/war-battles-online/evidence/vscode-live-values.json"),
  ]);
  const quickStartSource = await readText("docs/site/quick-start.script.ts");
  const syntax = await highlighter();
  const samples = {
    newProject: syntaxBlock(syntax, site.quickStart.newProject.commands.join("\n"), "shellscript", "shell"),
    existingProject: syntaxBlock(syntax, site.quickStart.existingProject.commands.join("\n"), "shellscript", "shell"),
    component: syntaxBlock(syntax, quickStartSource, "typescript", "typescript"),
  };
  const metrics = {
    schemaVersion: 2,
    packageVersion: packageJson.value.version,
    defoldRevision: scriptAccounting.value.defoldRevision,
    surface: {
      scriptFunctions: scriptAccounting.value.functionCount,
      dmsdkDeclarations: dmsdkAccounting.value.declarationCount,
    },
    release: release.value,
    transport: transport.value,
    editor: { vscodeEvidenceKey: vscode.value.evidenceKey, screenshot: vscode.value.screenshot },
    sourceInputs: [
      source("package.json", packageJson),
      source("packages/bindings/generated/defold-script-api-accounting.json", scriptAccounting),
      source("packages/bindings/generated/defold-dmsdk-accounting.json", dmsdkAccounting),
      source("docs/site/evidence/release-sizes.json", release),
      source("docs/site/evidence/transport-overhead.json", transport),
      source("examples/war-battles-online/evidence/vscode-live-values.json", vscode),
    ],
    evidenceBoundary:
      "Only release bundle records and unprofiled Release transport benchmarks are presented as size or overhead evidence. Development artifacts, repository totals, and CI cache sizes are excluded.",
  };
  await mkdir(path.join(output, "assets"), { recursive: true });
  await Promise.all([
    copyFile(
      path.join(repositoryRoot, "docs/assets/brand/deherm-dev-tui-preview-150x48.svg"),
      path.join(output, "assets/deherm-tui.svg"),
    ),
    copyFile(
      path.join(repositoryRoot, "examples/war-battles-online/evidence/vscode-live-values.png"),
      path.join(output, "assets/vscode-live-values.png"),
    ),
    copyFile(path.join(repositoryRoot, "docs/assets/brand/deherm-og.png"), path.join(output, "assets/deherm-og.png")),
  ]);
  await writeFile(path.join(output, "index.html"), renderPage({ site, metrics, samples }));
  await writeFile(path.join(output, "metrics.json"), `${json(metrics)}\n`);
  return { output, metrics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--out");
  const output = outputIndex === -1 ? defaultOutputDirectory : path.resolve(process.argv[outputIndex + 1]);
  const result = await buildDocsSite({ output });
  console.log(`built docs site at ${result.output}; release evidence for ${result.metrics.packageVersion}`);
}
