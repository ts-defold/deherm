// A channel is a moving discovery source; game.project records the revision the
// user last accepted. Checking never changes that revision. Only an explicit
// acceptance edits the project, after which normal generation updates the lock.

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeDefoldRevision, resolveDefoldRevision } from "./defold-revision.mjs";
import { resolveDefoldChannelRevision } from "./policy-client.mjs";
import { parseGameProject } from "./project.mjs";

const channels = new Set(["stable", "beta", "alpha"]);

export async function readInstalledEditorEvidence(editorPath) {
  const installed = path.resolve(editorPath);
  const candidates = [
    path.join(installed, "Contents", "Resources", "config"),
    path.join(installed, "config"),
    installed,
  ];
  let source;
  let config;
  for (const candidate of candidates) {
    try {
      config = await readFile(candidate, "utf8");
      source = candidate;
      break;
    } catch (error) {
      if (!["ENOENT", "EISDIR", "ENOTDIR"].includes(error?.code)) throw error;
    }
  }
  if (!config) throw new Error(`No Defold Editor config found under ${installed}`);
  const settings = new Map();
  let inBuild = false;
  for (const line of config.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (section) {
      inBuild = section[1] === "build";
      continue;
    }
    if (!inBuild) continue;
    const entry = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (entry) settings.set(entry[1], entry[2]);
  }
  if (!settings.size) throw new Error(`${source}: no [build] section`);
  const value = (key) => settings.get(key);
  return {
    source: "installed-editor",
    authority: "live",
    revision: normalizeDefoldRevision(value("engine_sha1"), `${source} engine_sha1`),
    channel: value("channel") ?? null,
    version: value("version") ?? null,
    evidence: { config: source },
  };
}

export async function checkDefoldUpdate(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const projectFile = path.join(projectRoot, "game.project");
  const source = await readFile(projectFile, "utf8");
  const configuration = parseGameProject(source).defold_hermes ?? {};
  const current = configuration.defold_sdk
    ? normalizeDefoldRevision(configuration.defold_sdk, "game.project [defold_hermes] defold_sdk")
    : null;
  const channel = options.channel ?? configuration.channel ?? null;
  if (channel && !channels.has(channel)) {
    throw new Error(`Unknown Defold channel ${JSON.stringify(channel)}; expected stable, beta, or alpha`);
  }
  const env = options.env ?? process.env;
  const hasLiveEvidence = Boolean(env.DEHERM_DEFOLD_ENGINE_SHA1 || options.bob || env.DEHERM_BOB);
  let live = null;
  if (hasLiveEvidence) {
    const resolved = await resolveDefoldRevision({
      projectRoot,
      properties: {},
      env,
      bob: options.bob,
      runBobVersion: options.runBobVersion,
    });
    if (resolved.blocker) throw new Error(resolved.blocker.message);
    live = resolved.observations.find((row) => row.source === "editor-hook" || row.source === "bob-version") ?? null;
    if (!live) throw new Error("The configured Editor/Bob evidence did not report a Defold engine SHA");
  }
  const editorPath = options.editor ?? env.DEHERM_EDITOR;
  if (editorPath) {
    const installed = await readInstalledEditorEvidence(editorPath);
    if (live && live.revision !== installed.revision) {
      throw new Error(`Supplied Editor ${installed.revision} conflicts with ${live.source} ${live.revision}`);
    }
    live = installed;
  }
  const latest = channel
    ? await resolveDefoldChannelRevision(channel, { fetchImpl: options.fetchImpl, locator: options.locator })
    : null;
  // An independently supplied Bob/Editor identifies the engine actually being
  // used. Never update beyond it merely because a remote channel moved first.
  const candidate = live?.revision ?? latest?.revision ?? null;
  const channelAheadOfTool = Boolean(live && latest && live.revision !== latest.revision);
  return {
    projectRoot,
    projectFile,
    current,
    channel,
    latest,
    live,
    candidate,
    channelAheadOfTool,
    changeKind: candidate && current !== candidate ? (live ? "active-tool-sync" : "channel-update") : null,
    updateAvailable: Boolean(candidate && current !== candidate),
    needsChannelDeclaration: Boolean(options.channel && options.channel !== configuration.channel),
  };
}

export async function acceptDefoldUpdate(update) {
  if (!update.candidate) throw new Error("Cannot accept an update without a resolved engine revision");
  const original = await readFile(update.projectFile, "utf8");
  const lines = original.split(/(?<=\n)/u);
  let inSection = false;
  let replaced = false;
  let channelSeen = false;
  for (let index = 0; index < lines.length; index += 1) {
    const section = /^\s*\[([^\]]+)\]\s*(?:\r?\n)?$/u.exec(lines[index]);
    if (section) {
      inSection = section[1] === "defold_hermes";
      continue;
    }
    if (!inSection) continue;
    const pin = /^(\s*defold_sdk\s*=\s*)([0-9a-f]{40})(\s*(?:\r?\n)?)$/iu.exec(lines[index]);
    if (pin) {
      if (pin[2].toLowerCase() !== update.current) {
        throw new Error("game.project changed since the update was checked; recheck before accepting");
      }
      lines[index] = `${pin[1]}${update.candidate}${pin[3]}`;
      replaced = true;
    }
    const declaration = /^(\s*channel\s*=\s*)(\S+)(\s*(?:\r?\n)?)$/u.exec(lines[index]);
    if (declaration) {
      channelSeen = true;
      if (update.needsChannelDeclaration) lines[index] = `${declaration[1]}${update.channel}${declaration[3]}`;
    }
  }
  if (!replaced) {
    if (update.current) throw new Error("game.project changed since the update was checked; recheck before accepting");
    const sectionIndex = lines.findIndex((line) => /^\s*\[defold_hermes\]\s*(?:\r?\n)?$/u.test(line));
    if (sectionIndex < 0) throw new Error("game.project has no [defold_hermes] section");
    lines.splice(sectionIndex + 1, 0, `defold_sdk = ${update.candidate}\n`);
  }
  if (update.channel && !channelSeen && update.needsChannelDeclaration) {
    const sectionIndex = lines.findIndex((line) => /^\s*\[defold_hermes\]\s*(?:\r?\n)?$/u.test(line));
    if (sectionIndex < 0) throw new Error("game.project has no [defold_hermes] section");
    lines.splice(sectionIndex + 1, 0, `channel = ${update.channel}\n`);
  }
  const next = lines.join("");
  const temporary = `${update.projectFile}.deherm-update-${process.pid}`;
  try {
    await writeFile(temporary, next, { flag: "wx" });
    await rename(temporary, update.projectFile);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true });
    throw error;
  }
  return { revision: update.candidate, channel: update.channel };
}

export function formatDefoldUpdate(update) {
  if (!update.channel && !update.live)
    return "No Defold update source is configured; pass --channel stable, beta, or alpha, or --bob <jar>.";
  const rows = [`Selected Defold: ${update.current ?? "unresolved"}`];
  if (update.channel)
    rows.push(`${update.channel} channel: ${update.latest.revision} (${update.latest.version ?? "version unknown"})`);
  if (update.live) rows.push(`${update.live.source}: ${update.live.revision}`);
  if (update.channelAheadOfTool)
    rows.push("The supplied Editor/Bob and channel differ; the active tool wins until it updates.");
  if (update.needsChannelDeclaration)
    rows.push(`Project is not yet tracking ${update.channel}; acceptance will record it.`);
  rows.push(
    update.updateAvailable
      ? update.changeKind === "active-tool-sync"
        ? `Active tool revision differs from project: ${update.current} -> ${update.candidate}. Confirm before syncing; this may be a downgrade.`
        : `Channel update available: ${update.current} -> ${update.candidate}`
      : "Selected revision is current for the active build tool.",
  );
  return rows.join("\n");
}
