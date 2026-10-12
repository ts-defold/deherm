import type { BattleClient, NetworkBotDriver } from "../core/index.ts";
import { PLAYER_MODE_DEAD, PLAYER_MODE_INFANTRY, PLAYER_MODE_TANK } from "../core/constants.ts";

const MAXIMUM_ELAPSED_MILLISECONDS = 250;
const MAXIMUM_STEPS = 8;

/**
 * Keeps a dashboard bot advancing when Chromium throttles background-page
 * timers. Snapshot delivery is network-driven, so each authoritative frame is
 * also a clock wake-up; the ordinary interval remains a foreground fallback.
 */
export class NetworkBotClock {
  observedTravelUnits = 0;
  observedMode: number | undefined;
  observedModeTransitions = 0;
  observedEjections = 0;
  observedTankReentries = 0;
  observedRespawns = 0;
  minimumModeTransitionIntervalTicks: number | undefined;

  private readonly client: BattleClient;
  private readonly driver: NetworkBotDriver;
  private lastUpdateAt: number;
  private snapshotX = 0;
  private snapshotY = 0;
  private haveSnapshotPosition = false;
  private lastModeTransitionTick: number | undefined;

  constructor(client: BattleClient, driver: NetworkBotDriver, now: number) {
    this.client = client;
    this.driver = driver;
    this.lastUpdateAt = now;
  }

  reset(now: number): void {
    this.lastUpdateAt = now;
  }

  /** Advances from a foreground timer or another non-authoritative wake-up. */
  update(now: number): number {
    const elapsed = Math.min(MAXIMUM_ELAPSED_MILLISECONDS, Math.max(0, now - this.lastUpdateAt));
    this.lastUpdateAt = now;
    return this.driver.update(elapsed, MAXIMUM_STEPS);
  }

  /** Applies and observes the latest snapshot before advancing bot intent. */
  onSnapshot(now: number): number {
    const snapshotsBefore = this.client.stats.snapshotsApplied;
    this.client.update(0);
    if (this.client.stats.snapshotsApplied > snapshotsBefore) this.captureAuthoritativePosition();
    return this.update(now);
  }

  private captureAuthoritativePosition(): void {
    const world = this.client.world;
    const slot = this.client.playerId - 1;
    if (world === undefined || slot < 0 || slot >= world.playerX.length) return;
    const x = world.playerX[slot]!;
    const y = world.playerY[slot]!;
    const mode = world.playerMode[slot]!;
    if (this.haveSnapshotPosition) {
      this.observedTravelUnits += Math.abs(x - this.snapshotX) + Math.abs(y - this.snapshotY);
      if (mode !== this.observedMode) {
        const previousMode = this.observedMode;
        this.observedModeTransitions += 1;
        if (previousMode === PLAYER_MODE_TANK && mode === PLAYER_MODE_INFANTRY) this.observedEjections += 1;
        if (previousMode === PLAYER_MODE_INFANTRY && mode === PLAYER_MODE_TANK) this.observedTankReentries += 1;
        if (previousMode === PLAYER_MODE_DEAD && mode === PLAYER_MODE_TANK) this.observedRespawns += 1;
        if (this.lastModeTransitionTick !== undefined) {
          const interval = (world.tick - this.lastModeTransitionTick) >>> 0;
          this.minimumModeTransitionIntervalTicks = Math.min(
            this.minimumModeTransitionIntervalTicks ?? interval,
            interval,
          );
        }
        this.lastModeTransitionTick = world.tick;
      }
    }
    this.snapshotX = x;
    this.snapshotY = y;
    this.observedMode = mode;
    this.haveSnapshotPosition = true;
  }
}
