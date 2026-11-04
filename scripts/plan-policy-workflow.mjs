#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFOLD_REVISION = /^[a-f0-9]{40}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const END_TO_END_CHANNELS = new Set(["stable", "beta", "alpha"]);

function exactRevision(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DEFOLD_REVISION.test(value)) {
    throw new Error(`${label} must be an exact 40-character Defold revision`);
  }
  return value;
}

function policyRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`Channel plan ${label} must be an array`);
  return value.map((row, index) => {
    const rowLabel = `Channel plan ${label}[${index}]`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${rowLabel} must be an object`);
    }
    if (typeof row.channel !== "string" || row.channel.length === 0) {
      throw new Error(`${rowLabel} must name a channel`);
    }
    const sha1 = exactRevision(row.sha1, `${rowLabel} sha1`);
    if (!sha1) throw new Error(`${rowLabel} sha1 is required`);
    const version = typeof row.version === "string" && row.version.length > 0 ? row.version : "unknown";
    return { channel: row.channel, sha1, version, canary: row.canary === true };
  });
}

function indexedRevisionSet(value) {
  if (!Array.isArray(value)) throw new Error("Channel plan indexedRevisions must be an array");
  return new Set(
    value.map((revision, index) => {
      const exact = exactRevision(revision, `Channel plan indexedRevisions[${index}]`);
      if (!exact) throw new Error(`Channel plan indexedRevisions[${index}] is required`);
      return exact;
    }),
  );
}

function policyCompatibilityGroups(value) {
  if (!Array.isArray(value)) throw new Error("Policy compatibility index must be an array");
  return value.map((row, index) => {
    const label = `Policy compatibility index[${index}]`;
    const compatibility = row?.compatibility?.sha256;
    if (typeof compatibility !== "string" || !SHA_256.test(compatibility)) {
      throw new Error(`${label} must contain a native compatibility SHA-256`);
    }
    if (!Array.isArray(row.revisions)) throw new Error(`${label} revisions must be an array`);
    const revisions = row.revisions.map((revision, revisionIndex) => {
      const exact = exactRevision(revision, `${label} revisions[${revisionIndex}]`);
      if (!exact) throw new Error(`${label} revisions[${revisionIndex}] is required`);
      return exact;
    });
    return { compatibility, revisions: new Set(revisions) };
  });
}

function exactCompatibility(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !SHA_256.test(value)) {
    throw new Error("Callback compatibility must be an exact SHA-256 digest");
  }
  return value;
}

function knownRoute(channel) {
  return END_TO_END_CHANNELS.has(channel) ? channel : null;
}

function observedRoute(observations, revision, requestedChannel) {
  return observations.find((row) => row.sha1 === revision)?.channel ?? requestedChannel ?? null;
}

/**
 * Plan policy derivation, consumer generation smoke, and the narrower Bob
 * handoff from one channel snapshot and one indexed-revision set.
 */
export function planPolicyWorkflow({
  event,
  requestedRevision,
  requestedChannel,
  refreshOnly,
  callbackRevision,
  callbackCompatibility,
  compatibilityIndex,
  channelPlan,
}) {
  if (typeof event !== "string" || event.length === 0) throw new Error("Policy workflow event is required");
  if (typeof refreshOnly !== "boolean") throw new Error("Policy workflow refreshOnly must be a boolean");
  if (!channelPlan || typeof channelPlan !== "object" || Array.isArray(channelPlan)) {
    throw new Error("Policy workflow requires one channel-plan snapshot");
  }

  const observations = policyRows(channelPlan.observations, "observations");
  const plannedDerivations = policyRows(channelPlan.derive, "derive");
  const indexed = indexedRevisionSet(channelPlan.indexedRevisions);
  const manualRevision = exactRevision(requestedRevision, "Requested revision");
  const callback = exactRevision(callbackRevision, "Callback revision");
  const callbackCompatibilitySha = exactCompatibility(callbackCompatibility);
  const compatibilityGroups = compatibilityIndex === undefined ? null : policyCompatibilityGroups(compatibilityIndex);
  if (Boolean(callbackCompatibilitySha) !== Boolean(compatibilityGroups)) {
    throw new Error("Callback compatibility and its policy compatibility index must be supplied together");
  }
  const channel =
    requestedChannel === undefined || requestedChannel === null || requestedChannel === "" ? null : requestedChannel;
  if (channel !== null && !END_TO_END_CHANNELS.has(channel)) {
    throw new Error(`Requested revision channel must be stable, beta, or alpha: ${channel}`);
  }

  if (event !== "workflow_dispatch" && (manualRevision || channel || refreshOnly || callback)) {
    throw new Error("Manual revisions and artifact callbacks require a workflow_dispatch event");
  }
  if (callback && !refreshOnly) throw new Error("Callback revision requires artifact refresh-only mode");

  if (event === "workflow_dispatch" && refreshOnly) {
    const callbackGroup =
      callback && indexed.has(callback) && callbackCompatibilitySha
        ? compatibilityGroups.find(({ compatibility }) => compatibility === callbackCompatibilitySha)
        : null;
    if (callback && indexed.has(callback) && callbackCompatibilitySha && !callbackGroup?.revisions.has(callback)) {
      throw new Error("Indexed callback revision is missing from its native compatibility group");
    }

    const consumerRevisions = observations
      .filter(({ sha1 }) => indexed.has(sha1))
      .map(({ channel: observationChannel, sha1 }) => ({ channel: observationChannel, sha1 }));
    if (callback && indexed.has(callback) && !consumerRevisions.some(({ sha1 }) => sha1 === callback)) {
      consumerRevisions.push({
        channel: observedRoute(observations, callback, channel),
        sha1: callback,
      });
    }
    const callbackRoute = callback && indexed.has(callback) ? observedRoute(observations, callback, channel) : null;
    const candidateByRevision = new Map();
    if (callbackGroup) {
      for (const observation of observations) {
        const { channel: observationChannel, sha1 } = observation;
        if (
          indexed.has(sha1) &&
          callbackGroup.revisions.has(sha1) &&
          knownRoute(observationChannel) !== null &&
          !candidateByRevision.has(sha1)
        ) {
          candidateByRevision.set(sha1, { channel: observationChannel, sha1 });
        }
      }
    }
    if (callbackRoute && knownRoute(callbackRoute) && !candidateByRevision.has(callback)) {
      candidateByRevision.set(callback, { channel: callbackRoute, sha1: callback });
    }
    return {
      derive: [],
      trackedRevisions: null,
      authoritative: false,
      consumerRevisions,
      endToEndCandidates: [...candidateByRevision.values()],
    };
  }

  if (event === "workflow_dispatch" && manualRevision) {
    const matchingObservation = observations.find(({ sha1 }) => sha1 === manualRevision);
    const manualRoute = matchingObservation?.channel ?? channel;
    return {
      derive: [
        {
          channel: "manual",
          sha1: manualRevision,
          version: matchingObservation?.version ?? "unknown",
          canary: false,
        },
      ],
      trackedRevisions: null,
      authoritative: false,
      consumerRevisions: [{ channel: manualRoute, sha1: manualRevision }],
      endToEndCandidates:
        manualRoute && knownRoute(manualRoute) ? [{ channel: manualRoute, sha1: manualRevision }] : [],
    };
  }

  if (observations.length === 0) throw new Error("Normal policy planning requires at least one channel observation");
  const derive = plannedDerivations.map(({ channel: observationChannel, sha1, version, canary }) => ({
    channel: observationChannel,
    sha1,
    version,
    canary,
  }));
  return {
    derive,
    trackedRevisions: observations.map(({ channel: observationChannel, sha1, version }) => ({
      channel: observationChannel,
      sha1,
      version,
    })),
    authoritative: true,
    consumerRevisions: observations.map(({ channel: observationChannel, sha1 }) => ({
      channel: observationChannel,
      sha1,
    })),
    endToEndCandidates: derive
      .filter(({ canary }) => !canary)
      .filter(({ channel: observationChannel }) => knownRoute(observationChannel) !== null)
      .map(({ channel: observationChannel, sha1 }) => ({ channel: observationChannel, sha1 })),
  };
}

function nextArgument(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = nextArgument(argv, index, option);
    index += 1;
    if (option === "--event") options.event = value;
    else if (option === "--requested-revision") options.requestedRevision = value;
    else if (option === "--requested-channel") options.requestedChannel = value;
    else if (option === "--refresh-only") {
      if (value !== "true" && value !== "false") throw new Error("--refresh-only must be true or false");
      options.refreshOnly = value === "true";
    } else if (option === "--callback-revision") options.callbackRevision = value;
    else if (option === "--callback-compatibility") options.callbackCompatibility = value;
    else if (option === "--channel-plan") options.channelPlanPath = value;
    else if (option === "--compatibility-index") options.compatibilityIndexPath = value;
    else throw new Error(`Unknown argument ${option}`);
  }
  for (const name of [
    "event",
    "requestedRevision",
    "requestedChannel",
    "refreshOnly",
    "callbackRevision",
    "channelPlanPath",
  ]) {
    if (options[name] === undefined) throw new Error(`Usage: plan-policy-workflow.mjs requires --${name}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const { channelPlanPath, compatibilityIndexPath, ...options } = parseArguments(argv);
  const channelPlan = JSON.parse(await readFile(channelPlanPath, "utf8"));
  const compatibilityIndex = compatibilityIndexPath
    ? JSON.parse(await readFile(compatibilityIndexPath, "utf8"))
    : undefined;
  const plan = planPolicyWorkflow({ ...options, channelPlan, compatibilityIndex });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
