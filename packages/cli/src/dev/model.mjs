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
    selectedPanel: "overview",
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
      item.telemetry = { ...item.telemetry, ...event.values, at };
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
