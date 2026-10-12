#!/usr/bin/env node
// Packaged Defold/Wasm -> browser host -> BattleClient -> authoritative Deno
// server acceptance. Unlike check-real-webtransport.mjs, this gate loads the
// actual Bob-produced game bundle and observes the game component's
// allocation-stable live telemetry object. `--fallback` deliberately makes
// only the WebTransport/QUIC endpoint unavailable; the same packaged game
// must then select the Deno TCP/WebSocket listener and keep exchanging input
// and snapshots.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";
import { startBrowserVideo } from "./browser-video.mjs";
import { matchesPackagedBundleFingerprint } from "./packaged-bundle-fingerprint.mjs";
import { PLAYER_MODE_DEAD, PLAYER_MODE_INFANTRY, PLAYER_MODE_TANK } from "../core/constants.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory =
  process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(repositoryRoot, "build/bundle/War Battles");

async function assertPackagedBundleMatchesCurrentSources() {
  const checked = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, "bin/deherm.mjs"),
      "verify-bundle",
      "--project",
      resolve(exampleRoot, "defold"),
      "--recompute",
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (checked.error) throw checked.error;
  if (!checked.stdout) throw new Error(`bundle source verification failed: ${checked.stderr.trim()}`);
  const report = JSON.parse(checked.stdout);
  const bundle = report.entries.find((entry) => entry.kind === "bundle" && entry.resource === "/deherm/app.dehermc");
  const fingerprint = bundle?.fingerprint?.fromCurrentSources;
  assert.equal(
    report.ok,
    true,
    `the deherm bundle must be bound to current sources: ${bundle?.status ?? report.status}`,
  );
  assert.match(fingerprint ?? "", /^[0-9a-f]{64}$/u, "the current bundle needs a full build fingerprint");
  assert.equal(bundle.fingerprint.onDisk, fingerprint, "the compiled app resource is not from current sources");
  const archiveRoot = join(bundleDirectory, "archive");
  const archives = (await readdir(archiveRoot)).filter((name) => /^game\d+\.arcd$/u.test(name));
  assert.ok(archives.length > 0, "the packaged HTML5 game has no Defold archive");
  let matched = false;
  for (const name of archives) {
    const bytes = await readFile(join(archiveRoot, name));
    matched = matchesPackagedBundleFingerprint(bytes, fingerprint);
    if (matched) break;
  }
  assert.ok(matched, "the packaged HTML5 archive does not contain the current-source build fingerprint; rebuild Bob");
  return fingerprint;
}
const denoBinary = process.env.DEHERM_DENO ?? "deno";
const chromeBinary = process.env.DEHERM_CHROME ?? defaultChromeBinary;
// Client-side `inputsSent` is only an attempted write. The owner gate must
// also observe the authoritative MatchServer accounting on the control plane.
const minimumInputsAccepted = 3;
const rosterSize = 16;
const screenshotPath = process.env.DEHERM_WAR_BATTLES_ONLINE_SCREENSHOT;
const argumentSet = new Set(process.argv.slice(2).filter((argument) => argument !== "--"));
for (const argument of argumentSet) {
  if (
    argument !== "--fallback" &&
    argument !== "--motion" &&
    argument !== "--cadence" &&
    argument !== "--loss" &&
    argument !== "--latency" &&
    argument !== "--video" &&
    argument !== "--soak" &&
    argument !== "--round-loop"
  )
    throw new Error(`Unknown argument: ${argument}`);
}
const fallbackMode = argumentSet.has("--fallback");
const motionMode = argumentSet.has("--motion");
const cadenceMode = argumentSet.has("--cadence");
const lossMode = argumentSet.has("--loss");
const latencyMode = argumentSet.has("--latency");
const videoMode = argumentSet.has("--video");
const soakMode = argumentSet.has("--soak");
const roundLoopMode = argumentSet.has("--round-loop");
const impairmentMode = lossMode || latencyMode;
const lossPercent = lossMode ? Number(process.env.DEHERM_WAR_BATTLES_PACKET_LOSS_PERCENT ?? 10) : 0;
const latencyMilliseconds = latencyMode ? Number(process.env.DEHERM_WAR_BATTLES_LATENCY_MS ?? 65) : 0;
const jitterMilliseconds = latencyMode ? Number(process.env.DEHERM_WAR_BATTLES_JITTER_MS ?? 15) : 0;
const motionPhaseMilliseconds = Number(process.env.DEHERM_WAR_BATTLES_MOTION_PHASE_MS ?? (soakMode ? 15_000 : 2_500));
if (impairmentMode && (fallbackMode || (!motionMode && !cadenceMode))) {
  throw new Error("--loss/--latency require --motion or --cadence and cannot use WebSocket fallback");
}
if (videoMode && !motionMode) throw new Error("--video requires --motion");
if (soakMode && !motionMode) throw new Error("--soak requires --motion");
if (!Number.isInteger(lossPercent) || (lossMode && lossPercent < 1) || lossPercent > 50) {
  throw new Error("DEHERM_WAR_BATTLES_PACKET_LOSS_PERCENT must be an integer from 1 to 50");
}
if (
  !Number.isInteger(latencyMilliseconds) ||
  latencyMilliseconds < 0 ||
  latencyMilliseconds > 500 ||
  !Number.isInteger(jitterMilliseconds) ||
  jitterMilliseconds < 0 ||
  jitterMilliseconds > latencyMilliseconds
) {
  throw new Error("QUIC latency and jitter must be integer milliseconds with 0 <= jitter <= latency <= 500");
}
if (!Number.isInteger(motionPhaseMilliseconds) || motionPhaseMilliseconds < 2_500 || motionPhaseMilliseconds > 60_000) {
  throw new Error("DEHERM_WAR_BATTLES_MOTION_PHASE_MS must be an integer from 2500 to 60000");
}

async function readTelemetry(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: "globalThis.__warBattlesTelemetryV1 ?? null",
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function key(client, type, value, code, virtualKeyCode) {
  await client.send("Input.dispatchKeyEvent", {
    type,
    key: value,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    ...(type === "keyDown" ? { text: value } : {}),
  });
}

async function sampleMotion(client, healthUrl, baseline) {
  const samples = [];
  const inputArrivalWindows = [];
  const phases = [
    { key: "w", code: "KeyW", virtualKeyCode: 87, durationMs: motionPhaseMilliseconds },
    { key: "d", code: "KeyD", virtualKeyCode: 68, durationMs: motionPhaseMilliseconds },
  ];
  samples.push({ at: Date.now(), ...(await readTelemetry(client)) });
  let windowStartAt = samples[0].at;
  let windowStartHealth = await fetch(healthUrl, { cache: "no-store" }).then((response) => response.json());
  const initialAuthorityTickGap = samples[0].localTick - windowStartHealth.stats.tick;
  for (const phase of phases) {
    await key(client, "keyDown", phase.key, phase.code, phase.virtualKeyCode);
    try {
      const deadline = Date.now() + phase.durationMs;
      while (Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 125));
        samples.push({ at: Date.now(), ...(await readTelemetry(client)) });
        const latest = samples.at(-1);
        if (latest.at - windowStartAt >= 1_000) {
          const health = await fetch(healthUrl, { cache: "no-store" }).then((response) => response.json());
          inputArrivalWindows.push({
            endingAtMs: latest.at - samples[0].at,
            inputsAccepted: health.stats.inputsAccepted - windowStartHealth.stats.inputsAccepted,
            inputsLate: health.stats.inputsLate - windowStartHealth.stats.inputsLate,
            inputLeadTicks: latest.inputLeadTicks,
            inputFeedbackLeadTicks: latest.inputFeedbackLeadTicks,
            authoritativeInputsLate: latest.authoritativeInputsLate,
            snapshotsApplied: latest.snapshotsApplied,
            clientServerTickGap: latest.localTick - latest.lastServerTick,
            // The last snapshot is already old when sampled. Compare with the
            // live authority clock too, or a lagging client can look ahead.
            clientAuthorityTickGap: latest.localTick - health.stats.tick,
            snapshotAgeTicks: health.stats.tick - latest.lastServerTick,
            roundTripMilliseconds: latest.roundTripMilliseconds,
            pongsReceived: latest.pongsReceived,
          });
          windowStartAt = latest.at;
          windowStartHealth = health;
        }
      }
    } finally {
      await key(client, "keyUp", phase.key, phase.code, phase.virtualKeyCode);
    }
  }
  const last = samples.at(-1);
  const first = samples[0];
  assert.ok(samples.length >= 30, "sustained browser motion must collect multiple frames per snapshot interval");
  assert.ok(
    samples.every((sample) => sample.state === "ready"),
    "the browser client must stay in the match",
  );
  assert.ok(last.localTick - first.localTick >= 180, "the actual browser simulation must keep stepping");
  assert.ok(last.snapshotsApplied - first.snapshotsApplied >= 20, "the browser must continue receiving snapshots");
  assert.ok(
    last.pongsReceived > first.pongsReceived,
    `the packaged client must measure the live round trip: first=${first.pongsReceived}/${first.roundTripMilliseconds}ms last=${last.pongsReceived}/${last.roundTripMilliseconds}ms ticks=${first.localTick}/${last.localTick}`,
  );
  assert.ok(
    Number.isFinite(last.maximumRemoteInterpolationRebaseDistance) &&
      last.maximumRemoteInterpolationRebaseDistance >= 0,
    "packaged telemetry must expose a bounded remote rebase distance",
  );
  assert.ok(
    Number.isFinite(last.maximumRemotePresentedStepDistance) && last.maximumRemotePresentedStepDistance >= 0,
    "packaged telemetry must expose actual same-life remote presentation steps",
  );
  assert.ok(
    Number.isFinite(last.maximumLocalPresentedStepDistance) && last.maximumLocalPresentedStepDistance >= 0,
    "packaged telemetry must expose actual same-life local presentation steps",
  );
  let segmentOrigin = first;
  let sameLifePairs = 0;
  let maxTravel = 0;
  let maxSampleStep = 0;
  const largeCorrectionEvents = [];
  const localLifecycleTransitions = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (current.localGeneration !== previous.localGeneration || current.localMode !== previous.localMode) {
      localLifecycleTransitions.push({
        atMs: current.at - first.at,
        fromMode: previous.localMode,
        toMode: current.localMode,
        fromGeneration: previous.localGeneration,
        toGeneration: current.localGeneration,
        localTick: current.localTick,
        serverTick: current.lastServerTick,
      });
    }
    if (current.correctionsOverThirtyTwoPixels > previous.correctionsOverThirtyTwoPixels) {
      largeCorrectionEvents.push({
        atMs: current.at - first.at,
        count: current.correctionsOverThirtyTwoPixels - previous.correctionsOverThirtyTwoPixels,
        localTick: current.localTick,
        serverTick: current.lastServerTick,
        inputLeadTicks: current.inputLeadTicks,
        generation: current.localGeneration,
        mode: current.localMode,
        correctionPixels: Math.round(current.lastLargeCorrectionMagnitude / 16),
        predictionErrorPixels: Math.round(current.lastLargeCorrectionPredictionErrorMagnitude / 16),
        predictionComparable: current.lastLargeCorrectionPredictionComparable,
        snapshotTick: current.lastLargeCorrectionSnapshotTick,
        correctedLocalTick: current.lastLargeCorrectionLocalTick,
        eventGeneration: current.lastLargeCorrectionGeneration,
        eventMode: current.lastLargeCorrectionMode,
        predictedPixels: [
          Math.round(current.lastLargeCorrectionPredictedX / 16),
          Math.round(current.lastLargeCorrectionPredictedY / 16),
        ],
        presentedPixels: [
          Math.round(current.lastLargeCorrectionPresentedX / 16),
          Math.round(current.lastLargeCorrectionPresentedY / 16),
        ],
        correctedPixels: [
          Math.round(current.lastLargeCorrectionCorrectedX / 16),
          Math.round(current.lastLargeCorrectionCorrectedY / 16),
        ],
      });
    }
    if (current.localGeneration !== previous.localGeneration || current.localMode !== previous.localMode) {
      segmentOrigin = current;
      continue;
    }
    sameLifePairs += 1;
    maxTravel = Math.max(
      maxTravel,
      Math.hypot(current.localWorldX - segmentOrigin.localWorldX, current.localWorldY - segmentOrigin.localWorldY),
    );
    maxSampleStep = Math.max(
      maxSampleStep,
      Math.hypot(current.localWorldX - previous.localWorldX, current.localWorldY - previous.localWorldY),
    );
  }
  assert.ok(maxTravel >= 16 * 8, "real keyboard input must move the local tank at least eight world pixels");
  const finalHealth = await fetch(healthUrl, { cache: "no-store" }).then((response) => response.json());
  if (finalHealth.stats.tick > windowStartHealth.stats.tick) {
    inputArrivalWindows.push({
      endingAtMs: last.at - first.at,
      inputsAccepted: finalHealth.stats.inputsAccepted - windowStartHealth.stats.inputsAccepted,
      inputsLate: finalHealth.stats.inputsLate - windowStartHealth.stats.inputsLate,
      inputLeadTicks: last.inputLeadTicks,
      inputFeedbackLeadTicks: last.inputFeedbackLeadTicks,
      authoritativeInputsLate: last.authoritativeInputsLate,
      snapshotsApplied: last.snapshotsApplied,
      clientServerTickGap: last.localTick - last.lastServerTick,
      clientAuthorityTickGap: last.localTick - finalHealth.stats.tick,
      snapshotAgeTicks: finalHealth.stats.tick - last.lastServerTick,
    });
  }
  assert.ok(
    finalHealth.stats.inputsAccepted - baseline.stats.inputsAccepted >= 20,
    `the authority must keep accepting the moving client's datagrams: accepted=${finalHealth.stats.inputsAccepted - baseline.stats.inputsAccepted} late=${finalHealth.stats.inputsLate - baseline.stats.inputsLate} clientInputs=${last.inputsSent - first.inputsSent} clientSnapshots=${last.snapshotsApplied - first.snapshotsApplied} firstTicks=${first.localTick}/${first.lastServerTick}/${baseline.stats.tick} lastTicks=${last.localTick}/${last.lastServerTick}/${finalHealth.stats.tick} windows=${JSON.stringify(inputArrivalWindows)}`,
  );
  const inputsAccepted = finalHealth.stats.inputsAccepted - baseline.stats.inputsAccepted;
  const inputsLate = finalHealth.stats.inputsLate - baseline.stats.inputsLate;
  const serverTicksAdvanced = finalHealth.stats.tick - baseline.stats.tick;
  assert.deepEqual(
    localLifecycleTransitions.filter(
      (transition) =>
        transition.fromGeneration === transition.toGeneration &&
        ((transition.fromMode === PLAYER_MODE_DEAD && transition.toMode === PLAYER_MODE_INFANTRY) ||
          (transition.fromMode === PLAYER_MODE_INFANTRY && transition.toMode === PLAYER_MODE_TANK)),
    ),
    [],
    "local presentation must not resurrect or rearm a driver without an authoritative new generation",
  );
  assert.equal(
    last.localPresentedStepsOverThirtyTwoPixels - first.localPresentedStepsOverThirtyTwoPixels,
    0,
    "the packaged game must not present same-life local steps over 32 pixels",
  );
  assert.equal(
    last.remotePresentedStepsOverThirtyTwoPixels - first.remotePresentedStepsOverThirtyTwoPixels,
    0,
    `the packaged game must not present same-life remote steps over 32 pixels; recent=${client.transcript
      .filter((line) => line.includes("remote-presented-step:"))
      .slice(-12)
      .join(" | ")}`,
  );
  if (
    lossMode &&
    latencyMode &&
    lossPercent === 10 &&
    latencyMilliseconds === 65 &&
    jitterMilliseconds === 15 &&
    last.at - first.at >= 10_000
  ) {
    assert.ok(
      Math.abs(last.localTick - first.localTick - serverTicksAdvanced) <= 12,
      "the authoritative and predicted 60 Hz clocks must not drift in a sustained match",
    );
    assert.ok(
      inputsLate * 100 <= (inputsAccepted + inputsLate) * 15,
      `at least 85% of observed commands must arrive before their authoritative tick: accepted=${inputsAccepted} late=${inputsLate} windows=${JSON.stringify(inputArrivalWindows)}`,
    );
    assert.equal(
      last.correctionsOverThirtyTwoPixels - first.correctionsOverThirtyTwoPixels,
      0,
      `the standard impaired profile must not teleport the local tank by over 32 pixels: events=${JSON.stringify(largeCorrectionEvents)} lifecycle=${JSON.stringify(localLifecycleTransitions)} recentWindows=${JSON.stringify(inputArrivalWindows.slice(-4))}`,
    );
    assert.ok(
      last.remoteEjectEffects > first.remoteEjectEffects && last.remoteRearmEffects > first.remoteRearmEffects,
      "sustained online bot play must instantiate both remote ejection and rearm cues",
    );
  }
  return {
    sampleCount: samples.length,
    durationMs: last.at - first.at,
    ticksAdvanced: last.localTick - first.localTick,
    serverTicksAdvanced,
    firstClientServerTickGap: first.localTick - first.lastServerTick,
    firstClientAuthorityTickGap: initialAuthorityTickGap,
    lastClientServerTickGap: last.localTick - last.lastServerTick,
    lastClientAuthorityTickGap: last.localTick - finalHealth.stats.tick,
    firstInputLeadTicks: first.inputLeadTicks,
    lastInputLeadTicks: last.inputLeadTicks,
    maximumInputLeadTicks: Math.max(...samples.map((sample) => sample.inputLeadTicks)),
    maximumInputFeedbackLeadTicks: Math.max(...samples.map((sample) => sample.inputFeedbackLeadTicks)),
    authoritativeInputsLate: last.authoritativeInputsLate - first.authoritativeInputsLate,
    lastRoundTripMilliseconds: last.roundTripMilliseconds,
    maximumRoundTripMilliseconds: Math.max(...samples.map((sample) => sample.roundTripMilliseconds)),
    pongsReceived: last.pongsReceived - first.pongsReceived,
    snapshotsApplied: last.snapshotsApplied - first.snapshotsApplied,
    inputsAccepted,
    inputsLate,
    inputArrivalWindows,
    snapshotsSkippedByBudget:
      finalHealth.stats.snapshotFramesSkippedByBudget - baseline.stats.snapshotFramesSkippedByBudget,
    sameLifePairs,
    maxTravelPixels: Math.round(maxTravel / 16),
    maxSampleStepPixels: Math.round(maxSampleStep / 16),
    maximumLocalCorrectionPixels: Math.round(last.maximumLocalCorrectionMagnitude / 16),
    correctionsOverThirtyTwoPixels: last.correctionsOverThirtyTwoPixels,
    remoteInterpolationRebases: last.remoteInterpolationRebases - first.remoteInterpolationRebases,
    maximumRemoteInterpolationRebasePixels: Math.round(last.maximumRemoteInterpolationRebaseDistance / 16),
    remoteLifecycleHardSnaps: last.remoteLifecycleHardSnaps - first.remoteLifecycleHardSnaps,
    remoteEjectEffects: last.remoteEjectEffects - first.remoteEjectEffects,
    remoteRearmEffects: last.remoteRearmEffects - first.remoteRearmEffects,
    maximumRemotePresentedStepPixels: Math.round(last.maximumRemotePresentedStepDistance / 16),
    remotePresentedStepsOverThirtyTwoPixels:
      last.remotePresentedStepsOverThirtyTwoPixels - first.remotePresentedStepsOverThirtyTwoPixels,
    maximumLocalPresentedStepPixels: Math.round(last.maximumLocalPresentedStepDistance / 16),
    localPresentedStepsOverThirtyTwoPixels:
      last.localPresentedStepsOverThirtyTwoPixels - first.localPresentedStepsOverThirtyTwoPixels,
    largeCorrectionEvents,
    localLifecycleTransitions,
  };
}

/**
 * Observe server-side accepted-input increments at a fixed polling cadence.
 * This is an application-level arrival proxy, not a QUIC packet timestamp.
 * Browser stalls are scheduled independently of the Node health poller.
 */
async function sampleInputArrivalWindow(client, healthUrl, durationMs, stallOffsetsMs = []) {
  const start = Date.now();
  const samples = [];
  const stalls = [];
  const poll = async () => {
    while (Date.now() - start < durationMs) {
      const health = await fetch(healthUrl, { cache: "no-store" }).then((response) => response.json());
      samples.push({ at: Date.now() - start, accepted: health.stats.inputsAccepted });
      await new Promise((done) => setTimeout(done, 25));
    }
  };
  const blockBrowser = async () => {
    for (const offset of stallOffsetsMs) {
      await new Promise((done) => setTimeout(done, Math.max(0, start + offset - Date.now())));
      const beganAt = Date.now() - start;
      const result = await client.send("Runtime.evaluate", {
        expression:
          "(() => { const until = performance.now() + 180; while (performance.now() < until) {} return true; })()",
        returnByValue: true,
      });
      assert.equal(result.result.value, true, "the packaged browser must execute the deliberate main-thread stall");
      stalls.push({ beganAt, durationMs: Date.now() - start - beganAt });
    }
  };
  await Promise.all([poll(), blockBrowser()]);
  assert.ok(samples.length >= durationMs / 60, "the independent health poller must keep observing the server");
  let maximumArrivalGapMs = 0;
  let maximumAcceptedPerPoll = 0;
  let lastIncreaseAt = samples[0].at;
  for (let index = 1; index < samples.length; index += 1) {
    const accepted = samples[index].accepted - samples[index - 1].accepted;
    if (accepted <= 0) continue;
    maximumArrivalGapMs = Math.max(maximumArrivalGapMs, samples[index].at - lastIncreaseAt);
    maximumAcceptedPerPoll = Math.max(maximumAcceptedPerPoll, accepted);
    lastIncreaseAt = samples[index].at;
  }
  return {
    elapsedMs: samples.at(-1).at - samples[0].at,
    samples: samples.length,
    accepted: samples.at(-1).accepted - samples[0].accepted,
    maximumArrivalGapMs,
    maximumAcceptedPerPoll,
    stalls,
  };
}

async function sampleBrowserCadence(client, healthUrl) {
  const before = await readTelemetry(client);
  const beforeHealth = await fetch(healthUrl, { cache: "no-store" }).then((response) => response.json());
  await key(client, "keyDown", "w", "KeyW", 87);
  try {
    const baseline = await sampleInputArrivalWindow(client, healthUrl, 2_500);
    const afterBaseline = await readTelemetry(client);
    const baselineHealth = await fetch(healthUrl, { cache: "no-store" }).then((response) => response.json());
    const stalled = await sampleInputArrivalWindow(client, healthUrl, 4_500, [700, 1_700, 2_700, 3_700]);
    const after = await readTelemetry(client);
    const afterHealth = await fetch(healthUrl, { cache: "no-store" }).then((response) => response.json());
    assert.equal(after.state, "ready", "browser must remain in the online match after render stalls");
    const minimumStalledAcceptance =
      lossMode && latencyMode && lossPercent === 10 && latencyMilliseconds === 65 && jitterMilliseconds === 15
        ? 180
        : 45;
    assert.ok(
      baseline.accepted >= 30 && stalled.accepted >= minimumStalledAcceptance,
      `the server must keep receiving live input: baseline=${JSON.stringify(baseline)} stalled=${JSON.stringify(stalled)}` +
        ` clientTicks=${before.localTick}/${afterBaseline.localTick}/${after.localTick}` +
        ` authorityTicks=${beforeHealth.stats.tick}/${baselineHealth.stats.tick}/${afterHealth.stats.tick}` +
        ` sent=${before.inputsSent}/${afterBaseline.inputsSent}/${after.inputsSent}` +
        ` dropped=${before.inputsDropped}/${afterBaseline.inputsDropped}/${after.inputsDropped}`,
    );
    if (minimumStalledAcceptance === 180) {
      const accepted = afterHealth.stats.inputsAccepted - beforeHealth.stats.inputsAccepted;
      const late = afterHealth.stats.inputsLate - beforeHealth.stats.inputsLate;
      assert.ok(
        late * 100 <= (accepted + late) * 15,
        `the standard impaired stall profile must not make most commands late: accepted=${accepted} late=${late}`,
      );
    }
    return {
      baseline,
      stalled,
      clientInputsSent: after.inputsSent - before.inputsSent,
      clientInputsDropped: after.inputsDropped - before.inputsDropped,
      baselineClientInputsSent: afterBaseline.inputsSent - before.inputsSent,
      stalledClientInputsSent: after.inputsSent - afterBaseline.inputsSent,
      stalledClientInputsDropped: after.inputsDropped - afterBaseline.inputsDropped,
      snapshotsApplied: after.snapshotsApplied - before.snapshotsApplied,
      serverLateInputs: afterHealth.stats.inputsLate - beforeHealth.stats.inputsLate,
      initialAuthorityTickGap: before.localTick - beforeHealth.stats.tick,
      baselineAuthorityTickGap: afterBaseline.localTick - baselineHealth.stats.tick,
      stalledAuthorityTickGap: after.localTick - afterHealth.stats.tick,
      reportedElapsedMilliseconds: Math.round(
        after.onlineReportedElapsedMilliseconds - afterBaseline.onlineReportedElapsedMilliseconds,
      ),
      wallElapsedMilliseconds: Math.round(
        after.onlineWallElapsedMilliseconds - afterBaseline.onlineWallElapsedMilliseconds,
      ),
      maximumWallDeltaMilliseconds: Math.round(after.onlineMaximumWallDeltaMilliseconds),
      finalInputLeadTicks: after.inputLeadTicks,
      maximumLocalCorrectionPixels: Math.round(after.maximumLocalCorrectionMagnitude / 16),
      correctionsOverThirtyTwoPixels: after.correctionsOverThirtyTwoPixels - before.correctionsOverThirtyTwoPixels,
    };
  } finally {
    await key(client, "keyUp", "w", "KeyW", 87);
  }
}

function makeCertificate(directory) {
  const cert = join(directory, "localhost.crt");
  const key = join(directory, "localhost.key");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "10",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=serverAuth",
    ],
    { stdio: "ignore" },
  );
  const der = execFileSync("openssl", ["x509", "-in", cert, "-outform", "der"]);
  return { cert, key, sha256: createHash("sha256").update(der).digest("hex") };
}

function linesFrom(child, target) {
  const append = (chunk) => target.push(...chunk.toString("utf8").split(/\r?\n/u).filter(Boolean));
  child.stdout.on("data", append);
  child.stderr.on("data", append);
}

async function stop(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((done) => child.once("exit", done)), new Promise((done) => setTimeout(done, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/** One browser-session UDP hop; impairs whole encrypted QUIC packets, not game messages. */
async function createImpairmentProxy(serverPort, dropPercent, latencyMs, jitterMs) {
  const browserSide = createSocket("udp4");
  // Deno's `localhost` QUIC listener binds ::1 on macOS, while Chromium's
  // explicit proxy URL uses 127.0.0.1. The hop bridges those loopback families.
  const serverSide = createSocket("udp6");
  const errors = [];
  const stats = {
    configuredLossPercent: dropPercent,
    browserToServer: 0,
    serverToBrowser: 0,
    droppedBrowserToServer: 0,
    droppedServerToBrowser: 0,
    configuredOneWayLatencyMs: latencyMs,
    configuredJitterMs: jitterMs,
    delayedBrowserToServer: 0,
    delayedServerToBrowser: 0,
  };
  let browserPeer;
  let enabled = false;
  let randomState = 0x5eed_cafe;
  const pending = new Set();
  const nextRandom = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
  };
  const shouldDrop = () => {
    if (!enabled) return false;
    return nextRandom() % 100 < dropPercent;
  };
  const forward = (packet, socket, port, address, direction) => {
    const send = (bytes) =>
      socket.send(bytes, port, address, (error) => {
        if (error) errors.push(String(error));
      });
    if (!enabled || latencyMs === 0) return send(packet);
    const delay = latencyMs + (jitterMs === 0 ? 0 : (nextRandom() % (jitterMs * 2 + 1)) - jitterMs);
    stats[direction] += 1;
    // Retain packet bytes across the timer boundary; UDP buffers belong to
    // the receive callback and are not a durable transport queue.
    const bytes = Buffer.from(packet);
    const timer = setTimeout(() => {
      pending.delete(timer);
      send(bytes);
    }, delay);
    pending.add(timer);
  };
  const bind = (socket, address) =>
    new Promise((resolveBind, rejectBind) => {
      const onError = (error) => rejectBind(error);
      socket.once("error", onError);
      socket.bind(0, address, () => {
        socket.off("error", onError);
        resolveBind();
      });
    });
  try {
    await bind(browserSide, "127.0.0.1");
    await bind(serverSide, "::1");
  } catch (error) {
    browserSide.close();
    serverSide.close();
    throw error;
  }
  browserSide.on("error", (error) => errors.push(String(error)));
  serverSide.on("error", (error) => errors.push(String(error)));
  browserSide.on("message", (packet, peer) => {
    browserPeer = { address: peer.address, port: peer.port };
    stats.browserToServer += 1;
    if (shouldDrop()) {
      stats.droppedBrowserToServer += 1;
      return;
    }
    forward(packet, serverSide, serverPort, "::1", "delayedBrowserToServer");
  });
  serverSide.on("message", (packet) => {
    if (browserPeer === undefined) return;
    stats.serverToBrowser += 1;
    if (shouldDrop()) {
      stats.droppedServerToBrowser += 1;
      return;
    }
    forward(packet, browserSide, browserPeer.port, browserPeer.address, "delayedServerToBrowser");
  });
  return {
    port: browserSide.address().port,
    stats,
    errors,
    enable() {
      enabled = true;
    },
    async close() {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      await Promise.all([browserSide, serverSide].map((socket) => new Promise((done) => socket.close(done))));
    },
  };
}

async function run() {
  const packagedFingerprint = await assertPackagedBundleMatchesCurrentSources();
  console.log(`war-battles-packaged-online:source-fingerprint=${packagedFingerprint}`);
  const scratch = await mkdtemp(join(tmpdir(), "war-battles-packaged-online."));
  const serverLines = [];
  let server;
  let page;
  let impairmentProxy;
  let video;
  try {
    const certificate = makeCertificate(scratch);
    const quicPort = await freeLoopbackPort();
    const pagePort = await freeLoopbackPort();
    const debuggingPort = await freeLoopbackPort();
    const healthPort = await freeLoopbackPort();
    const serverUrl = `https://localhost:${quicPort}`;
    if (impairmentMode)
      impairmentProxy = await createImpairmentProxy(quicPort, lossPercent, latencyMilliseconds, jitterMilliseconds);
    // Keep the authoritative server alive, but point the packaged client at a
    // different loopback port for the fallback run. This makes QUIC failure
    // deterministic while leaving its TCP/WebSocket control listener usable.
    const clientServerUrl = fallbackMode
      ? `https://localhost:${await freeLoopbackPort()}`
      : impairmentProxy === undefined
        ? serverUrl
        : `https://127.0.0.1:${impairmentProxy.port}`;
    const websocketUrl = `ws://localhost:${healthPort}/ws`;
    const healthUrl = `http://localhost:${healthPort}/readyz`;
    const acceptedInputMarker = `war-battles-server:stats:inputs-accepted:count=${minimumInputsAccepted}`;

    server = spawn(
      denoBinary,
      [
        "run",
        "--unstable-net",
        "--allow-net",
        "--allow-read",
        "--allow-env",
        resolve(exampleRoot, "server/deno-main.ts"),
        "--hostname",
        impairmentMode ? "::1" : "localhost",
        "--port",
        String(quicPort),
        "--health-port",
        String(healthPort),
        "--cert",
        certificate.cert,
        "--key",
        certificate.key,
        "--roster",
        String(rosterSize),
        "--bot-skill",
        "2",
        ...(roundLoopMode ? ["--smoke-round-after-inputs", "30"] : []),
      ],
      { cwd: exampleRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    linesFrom(server, serverLines);
    await waitFor(() => serverLines.some((line) => line.includes("war-battles-server:listening:")), {
      timeoutMs: 15_000,
      intervalMs: 50,
      what: `the Deno QUIC listener (tail: ${JSON.stringify(serverLines.slice(-12))})`,
    });

    page = await openBundlePage({
      bundleDirectory,
      port: pagePort,
      debuggingPort,
      chromeBinary,
      // Headless Chrome's compositor surface is shorter than its requested
      // outer window. Leave room for the entire emulated 720 px game viewport
      // so screencast frames do not clip the bottom HUD.
      chromeArguments: motionMode ? ["--window-size=1380,960"] : undefined,
      retain: true,
      deferNavigation: true,
    });
    if (motionMode) {
      // Exercise the shipped 1280×720 canvas, not Chrome's small default
      // viewport. Otherwise the motion probe underestimates render work and
      // its captured game art is too small for meaningful visual inspection.
      await page.client.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    await page.client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `if (${!fallbackMode} && typeof globalThis.WebTransport === "function") {
        const NativeWebTransport = globalThis.WebTransport;
        globalThis.WebTransport = new Proxy(NativeWebTransport, {
          construct(target, args) {
            const session = Reflect.construct(target, args);
            globalThis.__warBattlesWebTransportProbeV1 = session;
            return session;
          },
        });
      }
      globalThis.__warBattlesConfigV1 = ${JSON.stringify({
        server: clientServerUrl,
        serverWebSocket: websocketUrl,
        serverCertificateSha256: fallbackMode ? "00".repeat(32) : certificate.sha256,
      })};`,
    });
    const loaded = page.client.waitForEvent("Page.loadEventFired");
    await page.client.send("Page.navigate", { url: page.pageUrl });
    await loaded;
    const viewportResult = await page.client.send("Runtime.evaluate", {
      expression: `(() => {
        const canvas = document.querySelector("canvas");
        const rect = canvas?.getBoundingClientRect();
        return {
          innerWidth: innerWidth,
          innerHeight: innerHeight,
          canvasWidth: canvas?.width ?? 0,
          canvasHeight: canvas?.height ?? 0,
          displayedWidth: Math.round(rect?.width ?? 0),
          displayedHeight: Math.round(rect?.height ?? 0),
        };
      })()`,
      returnByValue: true,
    });
    const viewport = viewportResult.result.value;
    if (motionMode) {
      assert.equal(viewport.innerWidth, 1280, "motion evidence must use the target browser width");
      assert.equal(viewport.innerHeight, 720, "motion evidence must use the target browser height");
      // This headless Chrome/Defold page currently exposes a 1205×678 canvas
      // despite the emulated 1280×720 CSS viewport. Record actual backing
      // dimensions and reject the much smaller default test surface.
      assert.ok(
        viewport.canvasWidth >= 1200 && viewport.canvasHeight >= 675,
        `motion evidence must use a near-native canvas: ${JSON.stringify(viewport)}`,
      );
    }

    let lastTelemetry = null;
    const telemetry = await waitFor(
      async () => {
        const value = await readTelemetry(page.client);
        lastTelemetry = value;
        if (value?.state === "failed" || value?.state === "rejected") {
          throw new Error(`packaged client failed: ${JSON.stringify(value)}`);
        }
        return value?.mode === "online" &&
          value.state === "ready" &&
          value.transport === (fallbackMode ? "websocket-tcp" : "webtransport-h3-quic") &&
          value.inputLane === (fallbackMode ? "reliable-fallback" : "datagram") &&
          value.snapshotsApplied >= minimumInputsAccepted &&
          value.inputsSent >= minimumInputsAccepted
          ? value
          : false;
      },
      {
        timeoutMs: 60_000,
        intervalMs: 100,
        what: `the packaged Defold game to exchange ${fallbackMode ? "WebSocket/TCP" : "QUIC"} traffic`,
      },
    ).catch(async (error) => {
      const browser = await page.client
        .send("Runtime.evaluate", {
          expression:
            "({title: document.title, text: document.body?.innerText?.slice(0, 800), readyState: document.readyState})",
          returnByValue: true,
        })
        .then((result) => result.result.value)
        .catch((inspectionError) => String(inspectionError));
      throw new Error(
        `${String(error)}: ${JSON.stringify({ telemetry: lastTelemetry, transcript: page.client.transcript.slice(-20), failures: page.client.failures.slice(-10), browser, server: serverLines.slice(-12) })}`,
        { cause: error },
      );
    });

    const expectedFallbackFailures = page.client.failures.filter(
      (failure) =>
        fallbackMode &&
        failure.kind === "log" &&
        failure.detail.includes(`Failed to establish a connection to ${clientServerUrl}/`) &&
        failure.detail.includes("ERR_CONNECTION_REFUSED"),
    );
    const fatal = page.client.failures.filter(
      (failure) => !failure.url?.endsWith("/favicon.ico") && !expectedFallbackFailures.includes(failure),
    );
    assert.equal(telemetry.mode, "online");
    assert.equal(telemetry.state, "ready");
    assert.equal(telemetry.transport, fallbackMode ? "websocket-tcp" : "webtransport-h3-quic");
    assert.equal(telemetry.inputLane, fallbackMode ? "reliable-fallback" : "datagram");
    assert.equal(telemetry.rosterSize, rosterSize);
    assert.ok(telemetry.playerId > 0);
    assert.ok(telemetry.snapshotsApplied >= minimumInputsAccepted);
    assert.ok(telemetry.inputsSent >= minimumInputsAccepted);
    assert.ok(telemetry.lastServerTick > 0);
    assert.ok(Number.isInteger(telemetry.inputLeadTicks) && telemetry.inputLeadTicks >= 0);
    assert.ok(Number.isFinite(telemetry.maximumLocalCorrectionMagnitude));
    assert.ok(Number.isInteger(telemetry.remoteInterpolationRebases));
    if (roundLoopMode) {
      await waitFor(
        async () => {
          const value = await readTelemetry(page.client);
          return value?.state === "ready" && value.round === 1 && value.roundPhase === 1 ? value : false;
        },
        { timeoutMs: 12_000, intervalMs: 100, what: "the browser client to observe authoritative round countdown" },
      );
      await waitFor(
        async () => {
          const value = await readTelemetry(page.client);
          if (value?.state !== "ready" || value.mode !== "online") return false;
          return value.round === 2 &&
            value.roundPhase === 0 &&
            value.lastRoundKeyframeTick >= value.roundStartTick &&
            value.snapshotsApplied > telemetry.snapshotsApplied
            ? value
            : false;
        },
        { timeoutMs: 20_000, intervalMs: 100, what: "a post-round-state authoritative second-round keyframe" },
      );
      assert.ok(serverLines.some((line) => line.includes("war-battles-server:smoke-round-triggered")));
      assert.ok(serverLines.some((line) => line.includes("war-battles-server:round-started:2")));
    }
    assert.ok(Number.isFinite(telemetry.maximumRemoteInterpolationRebaseDistance));
    assert.ok(Number.isInteger(telemetry.remoteLifecycleHardSnaps));
    assert.ok(Number.isInteger(telemetry.remoteEjectEffects));
    assert.ok(Number.isInteger(telemetry.remoteRearmEffects));
    assert.ok(Number.isFinite(telemetry.maximumRemotePresentedStepDistance));
    assert.ok(Number.isInteger(telemetry.remotePresentedStepsOverThirtyTwoPixels));
    assert.ok(Number.isFinite(telemetry.maximumLocalPresentedStepDistance));
    assert.ok(Number.isInteger(telemetry.localPresentedStepsOverThirtyTwoPixels));
    assert.ok(Number.isInteger(telemetry.correctionsOverThirtyTwoPixels));

    let browserDatagramMaxAge = null;
    if (!fallbackMode) {
      const browserQueue = await page.client.send("Runtime.evaluate", {
        expression: `(() => {
          const session = globalThis.__warBattlesWebTransportProbeV1;
          return {
            captured: session !== undefined,
            outgoingMaxAge: session?.datagrams?.outgoingMaxAge ?? null,
            outgoingMaxBufferedDatagrams: session?.datagrams?.outgoingMaxBufferedDatagrams ?? null,
          };
        })()`,
        returnByValue: true,
      });
      assert.equal(browserQueue.result.value?.captured, true, "the browser game must use the native WebTransport host");
      assert.equal(
        browserQueue.result.value?.outgoingMaxAge,
        150,
        "Chromium must apply the input-datagram expiry hint rather than merely expose a setter",
      );
      browserDatagramMaxAge = browserQueue.result.value.outgoingMaxAge;
    }

    // `inputsSent` above is client telemetry and can pass even if the server
    // drops every packet. Read the server's control endpoint after the game is
    // ready and require both its live MatchServer stats and exact milestone
    // marker, with enough context to diagnose a stalled authority in CI.
    const authoritativeHealth = await waitFor(
      async () => {
        let response;
        let body;
        try {
          response = await fetch(healthUrl, { cache: "no-store" });
          body = await response.text();
        } catch {
          throw new Error(
            [
              `health fetch failed for ${healthUrl}: ${error instanceof Error ? error.message : String(error)}`,
              `telemetry=${JSON.stringify(telemetry)}`,
              `server=${JSON.stringify(serverLines.slice(-12))}`,
            ].join("; "),
          );
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          throw new Error(
            [
              `health response was not JSON: status=${response.status} body=${JSON.stringify(body.slice(0, 500))}`,
              `telemetry=${JSON.stringify(telemetry)}`,
              `server=${JSON.stringify(serverLines.slice(-12))}`,
            ].join("; "),
          );
        }
        const inputsAccepted = payload?.stats?.inputsAccepted;
        const markerObserved = serverLines.includes(acceptedInputMarker);
        if (
          !response.ok ||
          !Number.isFinite(inputsAccepted) ||
          inputsAccepted < minimumInputsAccepted ||
          !markerObserved
        ) {
          throw new Error(
            [
              `authoritative acceptance incomplete: status=${response.status}`,
              `inputsAccepted=${JSON.stringify(inputsAccepted)}`,
              `required=${minimumInputsAccepted}`,
              `marker=${markerObserved ? "observed" : `missing:${acceptedInputMarker}`}`,
              `health=${JSON.stringify(payload)}`,
              `telemetry=${JSON.stringify(telemetry)}`,
              `server=${JSON.stringify(serverLines.slice(-12))}`,
            ].join("; "),
          );
        }
        return payload;
      },
      {
        timeoutMs: 5_000,
        intervalMs: 50,
        what: `the authoritative server to report at least ${minimumInputsAccepted} accepted inputs at ${healthUrl}`,
      },
    );
    assert.ok(authoritativeHealth.stats.inputsAccepted >= minimumInputsAccepted);
    if (roundLoopMode)
      assert.equal(authoritativeHealth.stats.serverBots, rosterSize - 1, "all vacant roster slots use server bots");
    assert.ok(serverLines.includes(acceptedInputMarker));
    assert.equal(
      expectedFallbackFailures.length,
      fallbackMode ? 1 : 0,
      "the fallback gate must observe exactly the deliberately unavailable QUIC endpoint",
    );
    assert.deepEqual(fatal, [], `packaged browser failures: ${JSON.stringify(fatal)}`);
    assert.ok(page.client.transcript.includes(`war-battles:arena-init:players=${rosterSize}:online=1`));
    assert.ok(page.client.transcript.some((line) => line.includes("war-battles:net:client-welcome:")));
    assert.ok(serverLines.some((line) => line.includes("session-joined:")));
    if (fallbackMode) {
      assert.ok(
        page.client.transcript.some(
          (line) => line.includes("war-battles:arena-online-fallback:") && line.endsWith(":websocket-tcp"),
        ),
      );
      assert.ok(page.client.transcript.includes("war-battles:net:transport=websocket-tcp"));
      assert.ok(serverLines.some((line) => line.includes("session-accepted:websocket-tcp")));
    } else {
      assert.ok(
        page.client.transcript.some((line) =>
          line.startsWith("war-battles:net:transport=webtransport-h3-quic:backend="),
        ),
      );
    }

    await waitFor(() => page.client.transcript.includes("war-battles:title-hidden-by-deploy"), {
      timeoutMs: 5_000,
      intervalMs: 50,
      what: "the online match to replace the title with live gameplay",
    });

    // Keep admission and TLS clean; impair only established match traffic.
    impairmentProxy?.enable();

    if (videoMode) {
      video = await startBrowserVideo(
        page.client,
        resolve(
          process.env.DEHERM_WAR_BATTLES_ONLINE_VIDEO ??
            resolve(repositoryRoot, `build/evidence/war-battles-online-${impairmentMode ? "impaired" : "clean"}.mp4`),
        ),
      );
    }
    let motion;
    try {
      motion = motionMode ? await sampleMotion(page.client, healthUrl, authoritativeHealth) : null;
    } catch (error) {
      // A visual failure is the most valuable clip to keep. The outer finally
      // still shuts down Chrome and the server, but aborting here would throw
      // away the frames that show what the assertion actually observed.
      if (video !== undefined) {
        try {
          console.error(`war-battles-packaged-online:failed-video=${JSON.stringify(await video.stop())}`);
        } catch (videoError) {
          console.error(`war-battles-packaged-online:failed-video-unavailable=${String(videoError)}`);
        }
      }
      throw error;
    }
    const videoEvidence = video === undefined ? null : await video.stop();
    const cadence = cadenceMode ? await sampleBrowserCadence(page.client, healthUrl) : null;
    if (impairmentProxy !== undefined) {
      assert.deepEqual(impairmentProxy.errors, [], "the UDP impairment hop must not fail forwarding");
      if (lossMode) {
        assert.ok(
          impairmentProxy.stats.droppedBrowserToServer > 0,
          "the probe must actually drop browser QUIC packets",
        );
        assert.ok(impairmentProxy.stats.droppedServerToBrowser > 0, "the probe must actually drop server QUIC packets");
      }
      if (latencyMode) {
        assert.ok(
          impairmentProxy.stats.delayedBrowserToServer > 0,
          "the probe must actually delay browser QUIC packets",
        );
        assert.ok(
          impairmentProxy.stats.delayedServerToBrowser > 0,
          "the probe must actually delay server QUIC packets",
        );
      }
    }

    if (screenshotPath) {
      const canvas = await page.client.send("Runtime.evaluate", {
        expression: `(() => {
          const bounds = document.querySelector("canvas")?.getBoundingClientRect();
          return bounds && { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        })()`,
        returnByValue: true,
      });
      const bounds = canvas.result.value;
      assert.ok(bounds?.width > 0 && bounds?.height > 0, "online game canvas is not visible");
      const screenshot = await page.client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { ...bounds, scale: 1 },
      });
      await mkdir(dirname(screenshotPath), { recursive: true });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    }

    console.log(
      [
        "war-battles-packaged-online:ok",
        `mode=${fallbackMode ? "websocket-fallback" : "webtransport"}`,
        `transport=${telemetry.transport}`,
        `inputLane=${telemetry.inputLane}`,
        `player=${telemetry.playerId}`,
        `snapshots=${telemetry.snapshotsApplied}`,
        `inputs=${telemetry.inputsSent}`,
        `accepted=${authoritativeHealth.stats.inputsAccepted}`,
        `serverTick=${telemetry.lastServerTick}`,
        ...(roundLoopMode ? ["roundLoop=authoritative-admission-countdown-restart"] : []),
        `lead=${telemetry.inputLeadTicks}`,
        `maxCorrection=${telemetry.maximumLocalCorrectionMagnitude}`,
        ...(motionMode ? [`viewport=${JSON.stringify(viewport)}`] : []),
        `correctionsOver32px=${telemetry.correctionsOverThirtyTwoPixels}`,
        `datagramMaxAgeMs=${browserDatagramMaxAge ?? "n/a"}`,
        `firstKeyframeClock=${JSON.stringify(page.client.transcript.find((line) => line.includes("first-keyframe-clock:")) ?? null)}`,
        ...(motion === null ? [] : [`motion=${JSON.stringify(motion)}`]),
        ...(videoEvidence === null ? [] : [`video=${JSON.stringify(videoEvidence)}`]),
        ...(cadence === null ? [] : [`cadence=${JSON.stringify(cadence)}`]),
        ...(impairmentProxy === undefined ? [] : [`quicImpairment=${JSON.stringify(impairmentProxy.stats)}`]),
      ].join(":"),
    );
    return telemetry;
  } finally {
    await video?.abort().catch(() => undefined);
    await page?.close().catch(() => undefined);
    await stop(server);
    await impairmentProxy?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

await run();
