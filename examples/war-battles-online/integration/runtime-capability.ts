export interface ProxyCapabilityReport {
  readonly proxyRuntimeCapability?: {
    readonly state?: string;
    readonly runtimeConformant?: boolean;
    readonly requiredMethods?: readonly string[];
  };
}

export interface WarBattlesRuntimeGate {
  readonly gameplayExecutionObserved?: boolean;
  readonly requirements?: readonly { readonly engineContextVerified?: boolean }[];
}

export interface EngineAttachmentDecision {
  readonly allowed: boolean;
  readonly blockers: readonly string[];
}

export function evaluateEngineAttachment(
  manifest: Readonly<ProxyCapabilityReport>,
  runtimeGate: Readonly<WarBattlesRuntimeGate>,
): EngineAttachmentDecision {
  const blockers: string[] = [];
  const proxy = manifest.proxyRuntimeCapability;
  if (proxy?.runtimeConformant !== true) {
    blockers.push(`component proxy runtime is ${proxy?.state ?? "unknown"}`);
  }
  if (runtimeGate.gameplayExecutionObserved !== true) {
    blockers.push("packaged-engine gameplay execution has not been observed");
  }
  const requirements = runtimeGate.requirements ?? [];
  if (requirements.some((requirement) => requirement.engineContextVerified !== true)) {
    blockers.push("one or more generated API routes lack engine-context verification");
  }
  return Object.freeze({ allowed: blockers.length === 0, blockers: Object.freeze(blockers) });
}
