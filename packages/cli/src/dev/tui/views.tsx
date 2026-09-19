import {
  Box,
  Column,
  CommandPalette,
  Divider,
  Empty,
  Input,
  KeybindingHelp,
  LogsConsole,
  Modal,
  Progress,
  Row,
  Sparkline,
  SplitPane,
  Table,
  Text,
  VirtualList
} from "@rezi-ui/jsx";

import { describeReleaseReachability } from "../release-reachability.mjs";
import { PANEL_IDS, PANEL_TITLES } from "./keymap.mjs";
import { logLines, renderLogRow, selectionSummary } from "./logViewport.mjs";
import {
  bad,
  basalt,
  basaltRamp,
  delta,
  dim,
  formatBytes,
  good,
  logEntries,
  phaseProgress,
  prism,
  shortFingerprint,
  statusColor,
  targetActivation
} from "./theme.mjs";

const focusedBorderStyle = { fg: prism[4], bold: true };
const restingBorderStyle = { fg: basalt };

/**
 * A panel that shows whether it owns the keyboard. Each panel wraps exactly one
 * focusable widget, so Rezi's own Tab traversal and click-to-focus decide which
 * panel is lit and therefore which panel's scoped keys are live.
 */
export function FocusPanel({ scope, focusedScope, title, height, flex, children }) {
  const focused = scope === focusedScope;
  return (
    <Box
      border={focused ? "double" : "heavy"}
      borderStyle={focused ? focusedBorderStyle : restingBorderStyle}
      title={title ?? PANEL_TITLES[scope]}
      p={0}
      width={flex === undefined ? "full" : undefined}
      flex={flex}
      height={height}
      overflow="hidden"
    >
      {children}
    </Box>
  );
}

/**
 * A fixed-height slot. Data widgets grow to fill their parent, which would
 * swallow the summary lines that sit under them, so each one is given an
 * explicit box to live in.
 */
export function Pane({ height, children }) {
  return (
    <Box border="none" p={0} width="full" height={Math.max(1, height)} overflow="hidden">
      {children}
    </Box>
  );
}

function stageRows(snapshot) {
  return [
    { key: "watch", stage: "watcher" },
    { key: "build", stage: "ttsc" },
    { key: "bundle", stage: "bundle" },
    { key: "signal", stage: "signal" },
    { key: "activate", stage: "activate" }
  ].map((row) => {
    const progress = phaseProgress(snapshot, row.key);
    return { ...row, progress, state: progress === 1 ? "done" : progress > 0 ? "running" : "idle" };
  });
}

export function PipelinePanel({ snapshot, focusedScope, actions, height, compact }) {
  const activation = targetActivation(snapshot);
  const activationText = activation.total === 0 ? "applied unverified" : `applied ${activation.applied}/${activation.total}`;
  const tone = snapshot.phase === "failed" ? "danger" : "accent";
  return (
    <FocusPanel scope="pipeline" focusedScope={focusedScope} height={height}>
      <Column gap={0} px={1} width="full" height="full" overflow="hidden">
        <Pane height={5}>
        <Table
          id={PANEL_IDS.pipeline}
          accessibleLabel="Edit loop stages"
          columns={[
            { key: "stage", header: "stage", width: 9 },
            {
              key: "progress",
              header: "progress",
              flex: 1,
              minWidth: 6,
              render: (value) => <Progress value={value} variant="blocks" showPercent={false} dsTone={tone} />
            },
            { key: "state", header: "", width: 7, align: "right" }
          ]}
          data={stageRows(snapshot)}
          getRowKey={(row) => row.key}
          selectionMode="single"
          showHeader={false}
          border="none"
          onRowPress={() => actions.rebuild?.()}
        />
        </Pane>
        <Text style={{ fg: statusColor(snapshot.phase), bold: true }} textOverflow="ellipsis">
          {`built ${snapshot.lastSuccessfulGeneration ?? 0} · ${activationText}`}
        </Text>
        <Text style={{ fg: dim }} textOverflow="ellipsis">{snapshot.phase ?? "idle"}</Text>
      </Column>
    </FocusPanel>
  );
}

function moduleRows(snapshot) {
  const modules = snapshot.lastBuildMetrics?.modules ?? [];
  if (modules.length === 0) return [{ key: "empty", file: "waiting for first bundle", bytes: "—" }];
  return modules.map((module, index) => ({
    key: `module-${index}`,
    file: module.file,
    bytes: formatBytes(module.bytes)
  }));
}

export function BundlePanel({ snapshot, focusedScope, ui, actions, height, flex }) {
  const metrics = snapshot.lastBuildMetrics ?? {};
  const recent = snapshot.activeBuild?.changedSources ?? snapshot.history?.at(-1)?.resources ?? [];
  return (
    <FocusPanel scope="bundle" focusedScope={focusedScope} height={height} flex={flex}>
      <Column gap={0} px={1} width="full" height="full" overflow="hidden">
        <Text style={{ fg: prism[2], bold: true }} textOverflow="ellipsis">
          {`${formatBytes(metrics.bytes)}  ${delta(metrics.byteDelta)}  ${metrics.moduleCount ?? 0} modules`}
        </Text>
        <Text style={{ fg: dim }} textOverflow="ellipsis">{`build ${(metrics.durationMs ?? 0).toFixed(1)} ms`}</Text>
        <Text style={{ fg: dim }} textOverflow="ellipsis">{describeReleaseReachability(snapshot.reachability)}</Text>
        <Pane height={Math.max(1, (height ?? 12) - 7)}>
        <Table
          id={PANEL_IDS.bundle}
          accessibleLabel="Largest retained modules"
          columns={[
            { key: "file", header: "largest retained", flex: 1, minWidth: 8, overflow: "middle" },
            { key: "bytes", header: "bytes", width: 10, align: "right" }
          ]}
          data={moduleRows(snapshot)}
          getRowKey={(row) => row.key}
          selection={ui.bundleSelection}
          selectionMode="multi"
          onSelectionChange={(keys) => actions.selectBundle?.(keys)}
          border="none"
        />
        </Pane>
        <Divider label="recent files" />
        <Text textOverflow="middle" style={{ fg: dim }}>{recent.length ? `› ${recent[0]}` : "no pending edits"}</Text>
      </Column>
    </FocusPanel>
  );
}

function targetRow(target) {
  const telemetry = target.telemetry ?? {};
  return {
    key: target.id,
    id: target.id,
    name: target.name ?? target.id,
    status: target.status,
    applied: String(target.appliedGeneration ?? "—").padStart(3),
    signalled: String(target.signalledGeneration ?? "—"),
    pending: String(target.pendingGeneration ?? "—"),
    fingerprint: shortFingerprint(telemetry.bundleFingerprint),
    // Padded for table columns; the raw values feed the acknowledgement line,
    // which must read exactly as the runtime reported it.
    runtimeId: String(telemetry.runtimeId ?? "—"),
    resourceGeneration: String(telemetry.resourceGeneration ?? "—"),
    runtime: String(telemetry.runtimeId ?? "—").padStart(3),
    resource: String(telemetry.resourceGeneration ?? "—").padStart(3),
    frame: (Number.isFinite(telemetry.frameDtMs) ? `${telemetry.frameDtMs.toFixed(2)} ms` : "—").padStart(8),
    url: target.url ?? "",
    target
  };
}

export function targetRows(snapshot) {
  return (snapshot.targets ?? []).map(targetRow);
}

// The acknowledgement identity is printed verbatim rather than summarised: an
// operator comparing a running engine against a build needs the runtime id, the
// resource generation, and the bundle fingerprint exactly as reported.
function AcknowledgementLine({ rows }) {
  const acknowledged = rows.find((row) => row.fingerprint !== "—");
  if (!acknowledged) {
    return <Text style={{ fg: dim }} textOverflow="ellipsis">activation unverified · no runtime acknowledgement</Text>;
  }
  return (
    <Text style={{ fg: good }} textOverflow="middle">
      {`runtime ${acknowledged.runtimeId}  resource ${acknowledged.resourceGeneration}  ${acknowledged.fingerprint}`}
    </Text>
  );
}

export function TargetsPanel({ snapshot, focusedScope, ui, actions, height, compact }) {
  const rows = targetRows(snapshot);
  return (
    <FocusPanel scope="targets" focusedScope={focusedScope} height={height}>
      <Column gap={0} px={1} width="full" height="full" overflow="hidden">
        {rows.length === 0
          ? <Text style={{ fg: dim }} textOverflow="ellipsis">no target connected · activation unverified</Text>
          : (
            <Pane height={Math.max(1, (height ?? 12) - 3)}>
            <Table
              id={PANEL_IDS.targets}
              accessibleLabel="Reload targets"
              columns={[
                { key: "name", header: "target", flex: 2, minWidth: 6 },
                { key: "status", header: "phase", flex: 2, minWidth: 6, render: (value) => <Text style={{ fg: statusColor(value) }} textOverflow="ellipsis">{String(value)}</Text> },
                ...(compact ? [] : [{ key: "applied", header: "appl", width: 5 }])
              ]}
              data={rows}
              getRowKey={(row) => row.key}
              selection={ui.targetSelection}
              selectionMode="multi"
              onSelectionChange={(keys) => actions.selectTargets?.(keys)}
              onRowPress={(row) => actions.openDetail?.("target", row.id)}
              border="none"
            />
            </Pane>
          )}
        <AcknowledgementLine rows={rows} />
      </Column>
    </FocusPanel>
  );
}

function runtimeRows(telemetry) {
  const frame = telemetry.frameDtMs;
  return [
    { key: "dt", metric: "engine dt", value: Number.isFinite(frame) ? `${frame.toFixed(2)} ms` : "unavailable" },
    {
      key: "heap",
      metric: "Hermes heap",
      value: telemetry.hermesHeapAvailable
        ? `${formatBytes(telemetry.hermesHeapBytes)} / ${formatBytes(telemetry.hermesHeapSizeBytes)}  peak ${formatBytes(telemetry.hermesPeakBytes)}`
        : "unavailable"
    },
    { key: "roots", metric: "callback roots", value: String(telemetry.callbackRoots ?? "—") },
    { key: "components", metric: "component instances", value: String(telemetry.componentInstances ?? "—") },
    { key: "arena", metric: "arena high-water", value: telemetry.arenaHighWaterBytes === undefined ? "unavailable" : formatBytes(telemetry.arenaHighWaterBytes) },
    { key: "lua", metric: "Lua handles", value: `${telemetry.luaRegistryUsed ?? "—"}/${telemetry.luaRegistryCapacity ?? "—"}` }
  ];
}

export function RuntimePanel({ snapshot, focusedScope, ui, actions, height, flex }) {
  const telemetry = snapshot.targets?.[0]?.telemetry ?? {};
  const samples = telemetry.frameSamples?.length ? telemetry.frameSamples : [0];
  const frame = telemetry.frameDtMs;
  return (
    <FocusPanel scope="runtime" focusedScope={focusedScope} height={height} flex={flex}>
      <Column gap={0} px={1} width="full" height="full" overflow="hidden">
        <Sparkline
          data={samples}
          height={2}
          min={0}
          max={Math.max(20, ...samples)}
          style={{ fg: Number.isFinite(frame) && frame > 16.7 ? bad : prism[4] }}
        />
        <Pane height={Math.max(1, (height ?? 12) - 4)}>
        <Table
          id={PANEL_IDS.runtime}
          accessibleLabel="Runtime health metrics"
          columns={[
            { key: "metric", header: "metric", width: 21 },
            { key: "value", header: "value", flex: 1, minWidth: 8, overflow: "ellipsis" }
          ]}
          data={runtimeRows(telemetry)}
          getRowKey={(row) => row.key}
          selection={ui.runtimeSelection}
          selectionMode="multi"
          onSelectionChange={(keys) => actions.selectRuntime?.(keys)}
          showHeader={false}
          border="none"
        />
        </Pane>
      </Column>
    </FocusPanel>
  );
}

export function filteredLogEntries(snapshot, ui) {
  const entries = logEntries(snapshot);
  const query = ui.filter?.query ?? "";
  if (!query) return entries;
  const needle = query.toLowerCase();
  return entries.filter((entry) => `${entry.source ?? ""} ${entry.message ?? ""}`.toLowerCase().includes(needle));
}

export function LogsPanel({ snapshot, ui, actions, focusedScope, height }) {
  const selecting = Boolean(ui.logSelection);
  const summary = selecting ? selectionSummary(logLines(filteredLogEntries(snapshot, ui)), ui.logSelection) : undefined;
  const title = ui.filter?.query ? `${PANEL_TITLES.logs} · /${ui.filter.query}` : PANEL_TITLES.logs;
  const inner = Math.max(1, (height ?? 8) - 2 - (summary ? 1 : 0));
  return (
    <FocusPanel scope="logs" focusedScope={focusedScope} title={summary ? `${title} · SELECTION` : title} height={height}>
      <Column gap={0} width="full" height="full" overflow="hidden">
        <Pane height={inner}>
          {selecting
            ? <SelectableLogs snapshot={snapshot} ui={ui} actions={actions} />
            : (
              <LogsConsole
                id={PANEL_IDS.logs}
                entries={filteredLogEntries(snapshot, ui)}
                scrollTop={ui.logScroll}
                autoScroll={ui.logAutoScroll}
                showSource
                showTimestamps
                onScroll={(value) => actions.setLogScroll?.(value)}
              />
            )}
        </Pane>
        {summary ? <Text style={{ fg: prism[2] }} textOverflow="ellipsis">{summary}</Text> : undefined}
      </Column>
    </FocusPanel>
  );
}

/**
 * Selection view for the log stream. VirtualList keeps windowing, wheel, and
 * keyboard navigation inside the framework; only the highlighted row painting
 * and the caret arithmetic are hand-written, because no widget models a
 * character-granular selection over a log console.
 */
function SelectableLogs({ snapshot, ui, actions }) {
  const lines = logLines(filteredLogEntries(snapshot, ui));
  return (
    <VirtualList
      id={PANEL_IDS.logsSelection}
      accessibleLabel="Log selection"
      items={lines}
      itemHeight={1}
      renderItem={(line, index) => renderLogRow(line, ui.logSelection, index)}
      onScroll={(scrollTop) => actions.setLogSelectionScroll?.(scrollTop)}
    />
  );
}

export function TargetsView({ snapshot, focusedScope, ui, actions, height }) {
  const rows = targetRows(snapshot);
  if (rows.length === 0) {
    return (
      <FocusPanel scope="targets" focusedScope={focusedScope} title="TARGETS" height={height}>
        <Empty
          title="No target connected"
          description="deherm dev registers the local engine service at launch. Press p to start the built game, or pass --target <url> for a remote engine."
        />
      </FocusPanel>
    );
  }
  return (
    <FocusPanel scope="targets" focusedScope={focusedScope} title="TARGETS" height={height}>
      <Column gap={0} px={1} width="full" height="full" overflow="hidden">
        <Pane height={Math.max(1, (height ?? 14) - 3)}>
        <Table
          id={PANEL_IDS.targets}
          accessibleLabel="Targets"
          columns={[
            { key: "name", header: "target", flex: 2, minWidth: 8 },
            { key: "applied", header: "gen", width: 5 },
            { key: "fingerprint", header: "fingerprint", width: 15 },
            { key: "status", header: "phase", flex: 2, minWidth: 8, render: (value) => <Text style={{ fg: statusColor(value) }} textOverflow="ellipsis">{String(value)}</Text> },
            { key: "runtime", header: "rt", width: 5 },
            { key: "resource", header: "res", width: 5 },
            { key: "frame", header: "frame dt", width: 9 }
          ]}
          data={rows}
          getRowKey={(row) => row.key}
          selection={ui.targetSelection}
          selectionMode="multi"
          onSelectionChange={(keys) => actions.selectTargets?.(keys)}
          onRowPress={(row) => actions.openDetail?.("target", row.id)}
          border="none"
        />
        </Pane>
        <Text style={{ fg: dim }} textOverflow="ellipsis">enter opens the focused target · y copies the selection</Text>
      </Column>
    </FocusPanel>
  );
}

export function generationRows(snapshot) {
  const history = snapshot.history ?? [];
  const metricsByGeneration = new Map();
  if (snapshot.lastBuildMetrics && snapshot.lastSuccessfulGeneration) {
    metricsByGeneration.set(snapshot.lastSuccessfulGeneration, snapshot.lastBuildMetrics);
  }
  return [...history].reverse().map((record) => {
    const metrics = metricsByGeneration.get(record.generation);
    return {
      key: `generation-${record.generation}`,
      generation: String(record.generation).padStart(3),
      fingerprint: shortFingerprint(record.fingerprint),
      bytes: (metrics ? formatBytes(metrics.bytes) : "—").padStart(9),
      moduleDelta: (metrics ? `${metrics.moduleCount ?? 0} (${delta(metrics.byteDelta)})` : "—").padStart(15),
      duration: (Number.isFinite(record.durationMs) ? `${record.durationMs} ms` : "—").padStart(7),
      outcome: record.status,
      resources: String(record.resources?.length ?? 0),
      record
    };
  });
}

const outcomeColor = (outcome) => (outcome === "activated" ? good : outcome === "rejected" || outcome === "failed" ? bad : prism[4]);

export function GenerationsView({ snapshot, focusedScope, ui, actions, height }) {
  const rows = generationRows(snapshot);
  if (rows.length === 0) {
    return (
      <FocusPanel scope="generations" focusedScope={focusedScope} height={height}>
        <Empty
          title="No generation built yet"
          description="Every build of this session lands here with its fingerprint, size, module delta, and activation outcome."
        />
      </FocusPanel>
    );
  }
  return (
    <FocusPanel scope="generations" focusedScope={focusedScope} height={height}>
      <Column gap={0} px={1} width="full" height="full" overflow="hidden">
        <Pane height={Math.max(1, (height ?? 14) - 3)}>
        <Table
          id={PANEL_IDS.generations}
          accessibleLabel="Build generations"
          columns={[
            { key: "generation", header: "gen", width: 5 },
            { key: "fingerprint", header: "fingerprint", width: 15 },
            { key: "bytes", header: "bytes", width: 11 },
            { key: "moduleDelta", header: "modules (Δ)", width: 17 },
            { key: "duration", header: "build", width: 9 },
            { key: "outcome", header: "activation", flex: 1, minWidth: 9, render: (value) => <Text style={{ fg: outcomeColor(value) }} textOverflow="ellipsis">{String(value)}</Text> }
          ]}
          data={rows}
          getRowKey={(row) => row.key}
          selection={ui.generationSelection}
          selectionMode="multi"
          onSelectionChange={(keys) => actions.selectGenerations?.(keys)}
          onRowPress={(row) => actions.openDetail?.("generation", row.key)}
          border="none"
        />
        </Pane>
        <Text style={{ fg: dim }} textOverflow="ellipsis">
          built means produced; activated means a runtime acknowledged that exact fingerprint
        </Text>
      </Column>
    </FocusPanel>
  );
}

/**
 * Instances deliberately ships an empty state instead of inferred rows.
 *
 * The engine emits `DEHERM_EVENT telemetry` once a second carrying counts only
 * (component_instances, callback_roots, lua_handles). Nothing in that record
 * identifies an individual instance, so a per-instance table here could only be
 * fabricated. Listing identities needs a runtime instance channel, and that
 * protocol change is owned outside this console.
 */
export function InstancesView({ snapshot, focusedScope, height }) {
  const telemetry = snapshot.targets?.[0]?.telemetry ?? {};
  const counts = [
    { label: "component instances", value: telemetry.componentInstances },
    { label: "callback roots", value: telemetry.callbackRoots },
    { label: "Lua handles", value: telemetry.luaRegistryUsed }
  ];
  return (
    <FocusPanel scope="instances" focusedScope={focusedScope} height={height}>
      <Column gap={0} px={1} width="full" height="full" overflow="hidden">
        <Text style={{ fg: prism[2], bold: true }} textOverflow="ellipsis">requires runtime instance channel</Text>
        <Text style={{ fg: dim }} textOverflow="ellipsis">
          The engine reports telemetry once per second as counts, never identities.
        </Text>
        <Text style={{ fg: dim }} textOverflow="ellipsis">
          Per-instance rows need a runtime instance channel; that protocol change is owned outside this console.
        </Text>
        <Divider label="counts reported today" />
        {counts.map((entry) => (
          <Row key={entry.label} justify="between" width="full">
            <Text style={{ fg: basaltRamp[4] }} textOverflow="ellipsis">{entry.label}</Text>
            <Text style={{ fg: entry.value === undefined ? dim : good }}>
              {entry.value === undefined ? "unavailable" : String(entry.value)}
            </Text>
          </Row>
        ))}
      </Column>
    </FocusPanel>
  );
}

export function OverviewView({ snapshot, focusedScope, ui, actions, mode, height }) {
  const compact = mode === "compact";
  const bottomHeight = mode === "wide" && height >= 24 ? 12 : 0;
  const topHeight = height - bottomHeight;
  const top = (
    <Pane height={topHeight}>
      <SplitPane
        id="deherm-overview-split"
        accessibleLabel="Edit loop and targets"
        direction="horizontal"
        sizes={ui.overviewSizes}
        minSizes={[24, 24]}
        onChange={(sizes) => actions.setOverviewSizes?.(sizes)}
      >
        <PipelinePanel snapshot={snapshot} focusedScope={focusedScope} actions={actions} height={topHeight} compact={compact} />
        <TargetsPanel snapshot={snapshot} focusedScope={focusedScope} ui={ui} actions={actions} height={topHeight} compact={compact} />
      </SplitPane>
    </Pane>
  );
  if (bottomHeight === 0) return top;
  return (
    <Column gap={0} width="full" height={height} overflow="hidden">
      {top}
      <Row gap={1} width="full" height={bottomHeight}>
        <BundlePanel snapshot={snapshot} focusedScope={focusedScope} ui={ui} actions={actions} height={bottomHeight} flex={1} />
        <RuntimePanel snapshot={snapshot} focusedScope={focusedScope} ui={ui} actions={actions} height={bottomHeight} flex={1} />
      </Row>
    </Column>
  );
}

export function PaletteOverlay({ ui, actions, items }) {
  return (
    <CommandPalette
      id="deherm-palette"
      open
      query={ui.palette.query}
      selectedIndex={ui.palette.selectedIndex}
      placeholder="Run a déherm action"
      sources={[{ id: "actions", name: "Actions", getItems: () => items, priority: 10 }]}
      onChange={(query) => actions.setPaletteQuery?.(query)}
      onSelectionChange={(index) => actions.setPaletteIndex?.(index)}
      onSelect={(item) => actions.runPaletteItem?.(item)}
      onClose={() => actions.closeOverlay?.("palette")}
    />
  );
}

export function HelpOverlay({ bindings, actions }) {
  return (
    <Modal
      id="deherm-help"
      title="déherm dev · keys"
      width={76}
      maxWidth="full"
      height="full"
      onClose={() => actions.closeOverlay?.("help")}
      content={
        <Column gap={1} width="full">
          <Text style={{ fg: dim }} textOverflow="ellipsis">
            Projected from the console keymap, so an advertised key is always a registered key.
          </Text>
          <KeybindingHelp bindings={bindings} title="" showMode sort={false} />
        </Column>
      }
    />
  );
}

export function FilterOverlay({ ui, actions }) {
  return (
    <Modal
      id="deherm-filter"
      title="Filter logs"
      width={64}
      onClose={() => actions.closeOverlay?.("filter")}
      initialFocus="deherm-filter-input"
      content={
        <Column gap={1} width="full">
          <Input
            id="deherm-filter-input"
            value={ui.filter.query}
            accessibleLabel="Log filter"
            placeholder="substring of source or message"
            onInput={(value) => actions.setFilterQuery?.(value)}
          />
          <Text style={{ fg: dim }} textOverflow="ellipsis">
            Escape closes; the filter stays applied until it is cleared.
          </Text>
        </Column>
      }
    />
  );
}

function detailFields(detail, snapshot) {
  if (detail?.kind === "target") {
    const row = targetRows(snapshot).find((candidate) => candidate.id === detail.id);
    if (!row) return undefined;
    const telemetry = row.target.telemetry ?? {};
    return {
      title: `Target · ${row.name}`,
      pairs: [
        ["url", row.url || "—"],
        ["phase", row.status],
        ["applied generation", row.applied],
        ["signalled generation", row.signalled],
        ["pending generation", row.pending],
        ["bundle fingerprint", telemetry.bundleFingerprint ?? "unacknowledged"],
        ["runtime id", row.runtime],
        ["resource generation", row.resource],
        ["frame dt", row.frame],
        ["Hermes heap", telemetry.hermesHeapAvailable ? `${formatBytes(telemetry.hermesHeapBytes)} / ${formatBytes(telemetry.hermesHeapSizeBytes)}` : "unavailable"],
        ["diagnostic", row.target.diagnostic ?? "none"]
      ]
    };
  }
  if (detail?.kind === "generation") {
    const row = generationRows(snapshot).find((candidate) => candidate.key === detail.id);
    if (!row) return undefined;
    return {
      title: `Generation ${row.generation}`,
      pairs: [
        ["fingerprint", row.record.fingerprint ?? "—"],
        ["bytes", row.bytes],
        ["modules (Δ)", row.moduleDelta],
        ["build duration", row.duration],
        ["activation outcome", row.outcome],
        ["resources", (row.record.resources ?? []).join(", ") || "none"],
        ["runtime id", String(row.record.runtimeId ?? "—")],
        ["resource generation", String(row.record.resourceGeneration ?? "—")],
        ["diagnostic", row.record.diagnostic ?? "none"]
      ]
    };
  }
  return undefined;
}

export function DetailOverlay({ ui, snapshot, actions }) {
  const detail = detailFields(ui.detail, snapshot);
  if (!detail) return undefined;
  return (
    <Modal
      id="deherm-detail"
      title={detail.title}
      width={78}
      maxWidth="full"
      onClose={() => actions.closeOverlay?.("detail")}
      content={
        <Column gap={0} width="full">
          {detail.pairs.map(([label, value]) => (
            <Row key={label} justify="between" width="full" gap={2}>
              <Text style={{ fg: dim }}>{label}</Text>
              <Text textOverflow="middle" style={{ fg: basaltRamp[4] }}>{String(value)}</Text>
            </Row>
          ))}
          <Divider />
          <Text style={{ fg: dim }} textOverflow="ellipsis">y copies these fields · r signals a reload to every target</Text>
        </Column>
      }
    />
  );
}

export function detailClipboardText(ui, snapshot) {
  const detail = detailFields(ui.detail, snapshot);
  return detail ? detail.pairs.map(([label, value]) => `${label}\t${value}`).join("\n") : "";
}

export function SessionPlate({ snapshot }) {
  const activation = targetActivation(snapshot);
  const applied = activation.total === 0 ? "ACK UNVERIFIED" : `ACK ${activation.applied}/${activation.total}`;
  return (
    <Box border="heavy" px={1} py={0} height={7} borderStyle={{ fg: prism[0] }}>
      <Text style={{ fg: prism[2], bold: true }}>déherm dev // operator console</Text>
      <Text style={{ fg: prism[4], bold: true }}>DYNAMIC HERMES</Text>
      <Text style={{ fg: basaltRamp[4] }}>{`BUNDLE ${snapshot.lastSuccessfulGeneration ?? 0}`}</Text>
      <Text style={{ fg: activation.progress === 1 ? good : prism[4], bold: true }}>{applied}</Text>
      <Text style={{ fg: dim }}>{`${snapshot.phase ?? "idle"} · engine ${snapshot.engine?.status ?? "stopped"}`}</Text>
    </Box>
  );
}
