function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function validateNativeValueProbeReport(report, bindingReport) {
  if (!report || report.target !== "arm64-macos-dynamic-hermes" ||
      !bindingReport || !Array.isArray(bindingReport.bindings) ||
      !Array.isArray(report.probes) || !Array.isArray(report.plannedProbes)) {
    throw new Error("Invalid native value probe report shape");
  }

  const bindingCount = requireCount(bindingReport.bindingCount, "bindingCount");
  const probeCount = requireCount(report.probeCount, "probeCount");
  const plannedFamilyProbeCount = requireCount(
    report.plannedFamilyProbeCount,
    "plannedFamilyProbeCount"
  );
  const routeDispositionCount = requireCount(
    report.routeDispositionCount,
    "routeDispositionCount"
  );
  const uniqueBindingCount = requireCount(report.uniqueBindingCount, "uniqueBindingCount");

  if (bindingCount !== bindingReport.bindings.length ||
      uniqueBindingCount !== bindingCount ||
      probeCount !== report.probes.length ||
      plannedFamilyProbeCount !== report.plannedProbes.length ||
      probeCount + plannedFamilyProbeCount !== routeDispositionCount) {
    throw new Error("Native value probe counts do not account for every generated binding");
  }

  // A binding with several implemented call shapes carries several probes, so
  // the covering invariant is over the set of binding identities, not over the
  // number of dispositions.
  const dispositions = [...report.probes, ...report.plannedProbes];
  const ids = dispositions.map(({ id }) => id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== bindingCount) {
    throw new Error("Native value probe dispositions must cover each binding at least once");
  }
  const generatedIds = new Set(bindingReport.bindings.map(({ id }) => id));
  if (generatedIds.size !== bindingCount || ids.some((id) => !generatedIds.has(id))) {
    throw new Error("Native value probe dispositions do not match generated bindings");
  }

  for (const probe of report.probes) {
    if (probe.state !== "instrumented" && probe.state !== "planned") {
      throw new Error(`Unknown emitted probe state for ${probe.id}: ${probe.state}`);
    }
    if (probe.state === "instrumented" &&
        (typeof probe.expectedMarker !== "string" || !probe.expectedMarker)) {
      throw new Error(`Instrumented probe ${probe.id} has no expected marker`);
    }
  }
  for (const probe of report.plannedProbes) {
    if (probe.state !== "planned-only") {
      throw new Error(`Unknown non-emitted probe state for ${probe.id}: ${probe.state}`);
    }
  }

  return report.probes.filter(({ state }) => state === "instrumented");
}
