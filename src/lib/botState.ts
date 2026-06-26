// Shared, in-memory live-state store for the dashboard. This module is pure bookkeeping —
// it never makes a trading decision itself. The detector/strategy push updates into it as
// they run; the dashboard server only ever reads from it (plus the one mutation it's allowed
// to make: setPaused(), which the strategy's entry point checks before starting a new cycle).

import type { CycleRecord, CycleStatus, Duration } from "../types.js";

export interface PositionSnapshot {
  asset: string;
  slug: string;
  duration: Duration;
  status: CycleStatus | "waiting_entry";
  eventStartTime: number; // unix seconds
  endTime: number; // unix seconds
  yesEntryPrice: number | null;
  noEntryPrice: number | null;
  yesFilled: boolean;
  noFilled: boolean;
  ghostFill: boolean;
  startedAt: number | null; // ms epoch once orders are placed, null while still waiting
}

export interface QueuedSlot {
  asset: string;
  slug: string;
}

const MAX_RECENT_CYCLES = 50;

let paused = false;
const bootedAt = Date.now();
const positions = new Map<string, PositionSnapshot>();
const queued = new Map<string, string>();
const recentCycles: CycleRecord[] = [];

export const botState = {
  isPaused(): boolean {
    return paused;
  },

  setPaused(value: boolean): void {
    paused = value;
  },

  getBootedAt(): number {
    return bootedAt;
  },

  setPosition(asset: string, snapshot: PositionSnapshot): void {
    positions.set(asset, snapshot);
  },

  clearPosition(asset: string): void {
    positions.delete(asset);
  },

  getPositions(): PositionSnapshot[] {
    return [...positions.values()];
  },

  setQueued(asset: string, slug: string | null): void {
    if (slug === null) {
      queued.delete(asset);
    } else {
      queued.set(asset, slug);
    }
  },

  getQueued(): QueuedSlot[] {
    return [...queued.entries()].map(([asset, slug]) => ({ asset, slug }));
  },

  pushCycleRecord(record: CycleRecord): void {
    recentCycles.unshift(record);
    if (recentCycles.length > MAX_RECENT_CYCLES) {
      recentCycles.length = MAX_RECENT_CYCLES;
    }
  },

  getRecentCycles(): CycleRecord[] {
    return recentCycles;
  },
};
