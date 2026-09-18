function boundedPush(items, value, capacity) {
  if (items.length === capacity) items.shift();
  items.push(value);
}

function changed(model) {
  model.version += 1;
  return true;
}

export function createDevModel(options = {}) {
  return {
    phase: "idle",
    version: 0,
    generation: 0,
    activeBuild: undefined,
    lastBuildMetrics: undefined,
    lastSuccessfulGeneration: 0,
    targets: new Map(),
    logs: [],
    nextLogSequence: 1,
    history: [],
    logCapacity: options.logCapacity ?? 2_000,
    historyCapacity: options.historyCapacity ?? 128,
    engine: { status: "stopped" },
    defoldBuild: { status: "idle" },
    selectedPanel: "overview",
    // Where this session accumulates classified runtime defects, so any console
    // over the snapshot can read the pool without knowing the layout.
    bugPoolFile: options.bugPoolFile,
    startedAt: options.now ?? Date.now()
  };
}

function target(model, id) {
  const current = model.targets.get(id);
  if (current) return current;
  const created = { id, status: "disconnected", appliedGeneration: 0, telemetry: {} };
  model.targets.set(id, created);
  return created;
}

export function applyDevEvent(model, event) {
  const at = event.at ?? Date.now();
  switch (event.type) {
    case "build-started": {
      if (!Number.isSafeInteger(event.generation) || event.generation <= model.generation) return false;
      model.generation = event.generation;
      model.phase = "building";
      model.activeBuild = { generation: event.generation, startedAt: at, changedSources: [...(event.changedSources ?? [])] };
      return changed(model);
    }
    case "build-succeeded": {
      if (event.generation !== model.generation || model.activeBuild?.generation !== event.generation) return false;
      model.phase = "built";
      model.lastSuccessfulGeneration = event.generation;
      model.lastBuildMetrics = event.metrics ? { ...event.metrics } : undefined;
      const record = {
        generation: event.generation,
        status: "built",
        durationMs: at - model.activeBuild.startedAt,
        fingerprint: event.fingerprint,
        resources: [...(event.resources ?? [])]
      };
      boundedPush(model.history, record, model.historyCapacity);
      model.activeBuild = undefined;
      return changed(model);
    }
    case "build-failed": {
      if (event.generation !== model.generation || model.activeBuild?.generation !== event.generation) return false;
      model.phase = "failed";
      boundedPush(model.history, {
        generation: event.generation,
        status: "failed",
        durationMs: at - model.activeBuild.startedAt,
        diagnostic: event.diagnostic
      }, model.historyCapacity);
      model.activeBuild = undefined;
      boundedPush(model.logs, {
        sequence: model.nextLogSequence++, at, level: "error", source: "build", message: String(event.diagnostic ?? "build failed")
      }, model.logCapacity);
      return changed(model);
    }
    case "target-connected": {
      const item = target(model, event.id);
      Object.assign(item, { status: "connected", url: event.url, name: event.name, connectedAt: at });
      return changed(model);
    }
    case "target-configured": {
      const item = target(model, event.id);
      Object.assign(item, { status: "unverified", url: event.url, name: event.name });
      return changed(model);
    }
    case "target-disconnected": {
      Object.assign(target(model, event.id), { status: "disconnected", disconnectedAt: at });
      return changed(model);
    }
    case "reload-started": {
      if (event.generation !== model.lastSuccessfulGeneration) return false;
      Object.assign(target(model, event.id), { status: "reloading", pendingGeneration: event.generation });
      model.phase = "reloading";
      return changed(model);
    }
    case "reload-signalled": {
      const item = target(model, event.id);
      if (item.pendingGeneration !== event.generation) return false;
      Object.assign(item, { status: "awaiting-activation", signalledGeneration: event.generation, signalledAt: at });
      model.phase = "awaiting-activation";
      return changed(model);
    }
    case "activation-succeeded": {
      const item = target(model, event.id);
      if (item.pendingGeneration !== event.generation || item.signalledGeneration !== event.generation) return false;
      Object.assign(item, {
        status: "connected",
        appliedGeneration: event.generation,
        pendingGeneration: undefined,
        signalledGeneration: undefined,
        lastReloadAt: at
      });
      if ([...model.targets.values()].every((entry) => entry.pendingGeneration === undefined)) model.phase = "ready";
      return changed(model);
    }
    case "runtime-activation-observed": {
      const item = target(model, event.id);
      const record = [...model.history].reverse().find(({ fingerprint }) =>
        fingerprint === event.fingerprint);
      item.telemetry = {
        ...item.telemetry,
        bundleFingerprint: event.fingerprint,
        resourceGeneration: event.resourceGeneration,
        runtimeId: event.runtimeId,
        activationObservedAt: at
      };
      if (!record) {
        boundedPush(model.logs, {
          sequence: model.nextLogSequence++, at, level: "warn", source: "runtime",
          message: `runtime activated unknown bundle ${event.fingerprint}`
        }, model.logCapacity);
        return changed(model);
      }
      if (item.pendingGeneration !== undefined && item.pendingGeneration > record.generation) {
        boundedPush(model.logs, {
          sequence: model.nextLogSequence++, at, level: "info", source: "runtime",
          message: `runtime activated superseded bundle ${record.generation}; still awaiting ${item.pendingGeneration}`
        }, model.logCapacity);
        return changed(model);
      }
      Object.assign(item, {
        status: "connected",
        appliedGeneration: record.generation,
        pendingGeneration: undefined,
        signalledGeneration: undefined,
        lastReloadAt: at,
        diagnostic: undefined
      });
      record.status = "activated";
      record.resourceGeneration = event.resourceGeneration;
      record.runtimeId = event.runtimeId;
      if ([...model.targets.values()].every((entry) => entry.pendingGeneration === undefined)) {
        model.phase = "ready";
      }
      return changed(model);
    }
    case "runtime-activation-rejected": {
      const item = target(model, event.id);
      const record = event.fingerprint === "unavailable"
        ? undefined
        : [...model.history].reverse().find(({ fingerprint }) => fingerprint === event.fingerprint);
      item.telemetry = {
        ...item.telemetry,
        rejectedFingerprint: event.fingerprint,
        rejectedResourceGeneration: event.resourceGeneration,
        rejectedRuntimeId: event.runtimeId,
        activationRejectedAt: at
      };
      if (record && item.pendingGeneration === record.generation) {
        Object.assign(item, {
          status: "activation-failed",
          pendingGeneration: undefined,
          signalledGeneration: undefined,
          diagnostic: `runtime rejected bundle ${record.generation}`
        });
        record.status = "rejected";
        model.phase = "failed";
      }
      return changed(model);
    }
    case "activation-failed":
    case "reload-failed": {
      const item = target(model, event.id);
      if (item.pendingGeneration !== event.generation) return false;
      Object.assign(item, {
        status: event.type,
        pendingGeneration: undefined,
        signalledGeneration: undefined,
        diagnostic: event.diagnostic
      });
      model.phase = "failed";
      return changed(model);
    }
    case "telemetry": {
      const item = target(model, event.id);
      const samples = event.values?.frameDtMs === undefined
        ? item.telemetry.frameSamples
        : [...(item.telemetry.frameSamples ?? []), event.values.frameDtMs].slice(-60);
      item.telemetry = { ...item.telemetry, ...event.values, frameSamples: samples, at };
      return changed(model);
    }
    case "engine-starting": {
      model.engine = { status: "starting", executable: event.executable };
      return changed(model);
    }
    case "defold-build-started": {
      model.defoldBuild = { status: "building", reason: event.reason, startedAt: at };
      boundedPush(model.logs, {
        sequence: model.nextLogSequence++, at, level: "info", source: "bob", message: `building Defold resources (${event.reason ?? "change"})`
      }, model.logCapacity);
      return changed(model);
    }
    case "defold-build-succeeded": {
      model.defoldBuild = { status: "ready", reason: event.reason, resources: [...(event.resources ?? [])], finishedAt: at };
      boundedPush(model.logs, {
        sequence: model.nextLogSequence++, at, level: "info", source: "bob", message: `Defold build ready; ${event.resources?.length ?? 0} compiled resource(s) changed`
      }, model.logCapacity);
      return changed(model);
    }
    case "defold-build-failed": {
      model.defoldBuild = { status: "failed", reason: event.reason, diagnostic: event.diagnostic, finishedAt: at };
      boundedPush(model.logs, {
        sequence: model.nextLogSequence++, at, level: "error", source: "bob", message: String(event.diagnostic ?? "Defold build failed")
      }, model.logCapacity);
      return changed(model);
    }
    case "engine-started": {
      model.engine = { status: "running", executable: event.executable, pid: event.pid, startedAt: at };
      boundedPush(model.logs, {
        sequence: model.nextLogSequence++, at, level: "info", source: "engine", message: `launched pid ${event.pid}`
      }, model.logCapacity);
      return changed(model);
    }
    case "engine-stopped": {
      model.engine = { status: "stopped", code: event.code, signal: event.signal, stoppedAt: at };
      boundedPush(model.logs, {
        sequence: model.nextLogSequence++, at, level: "info", source: "engine",
        message: `stopped${event.signal ? ` by ${event.signal}` : ` with code ${event.code ?? "unknown"}`}`
      }, model.logCapacity);
      return changed(model);
    }
    case "engine-failed": {
      model.engine = { status: "failed", diagnostic: event.diagnostic, stoppedAt: at };
      boundedPush(model.logs, {
        sequence: model.nextLogSequence++, at, level: "error", source: "engine", message: String(event.diagnostic)
      }, model.logCapacity);
      return changed(model);
    }
    case "log": {
      boundedPush(model.logs, {
        sequence: model.nextLogSequence++,
        at,
        level: event.level ?? "info",
        source: event.source ?? "deherm",
        message: String(event.message)
      }, model.logCapacity);
      return changed(model);
    }
    case "panel-selected": {
      model.selectedPanel = event.panel;
      return changed(model);
    }
    default:
      throw new Error(`unknown dev event: ${event.type}`);
  }
}

export function snapshotDevModel(model) {
  return {
    ...model,
    engine: { ...model.engine },
    defoldBuild: { ...model.defoldBuild, resources: model.defoldBuild.resources ? [...model.defoldBuild.resources] : undefined },
    activeBuild: model.activeBuild ? { ...model.activeBuild, changedSources: [...model.activeBuild.changedSources] } : undefined,
    lastBuildMetrics: model.lastBuildMetrics ? {
      ...model.lastBuildMetrics,
      modules: model.lastBuildMetrics.modules?.map((value) => ({ ...value }))
    } : undefined,
    targets: [...model.targets.values()].map((value) => ({ ...value, telemetry: { ...value.telemetry } })),
    logs: model.logs.map((value) => ({ ...value })),
    history: model.history.map((value) => ({ ...value, resources: value.resources ? [...value.resources] : undefined }))
  };
}
