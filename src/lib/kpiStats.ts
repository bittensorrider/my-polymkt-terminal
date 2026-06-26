// Pure KPI computation shared between the CLI (src/scripts/kpiReport.ts) and the dashboard
// server, so both ever report the exact same numbers from the exact same logic. See
// kpiReport.ts's header comment for the breakeven formula this implements.

import type { CycleRecord } from "../types.js";

export interface AssetBreakdown {
  asset: string;
  cycles: number;
  fillRate: number;
  pnl: number;
}

export interface MinuteBreakdown {
  minute: number;
  cycles: number;
  fillRate: number;
}

/** One point on the running-balance trend chart: the cumulative sum of `pnl` over all cycles
 * up to and including this one, in log order (oldest first). */
export interface PnlPoint {
  ts: string;
  cumulativePnl: number;
}

export interface KpiStats {
  totalCycles: number;
  bothFilled: number;
  oneSided: number;
  ghostFills: number;
  fillRate: number;
  totalPnl: number;
  goodAvgPnl: number;
  lossAvgPnl: number;
  lossMagnitude: number;
  /** null when every cycle so far has been non-negative even without a both-fill — no
   * breakeven tension exists yet to compute against. */
  breakevenFillRate: number | null;
  /** fillRate - breakevenFillRate; null whenever breakevenFillRate is null. */
  edge: number | null;
  byAsset: AssetBreakdown[];
  byMinuteBucket: MinuteBreakdown[];
  /** Running balance trend — cumulative pnl after each cycle, oldest first. Empty if no
   * cycles logged yet. */
  cumulativePnl: PnlPoint[];
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function computeKpiStats(records: CycleRecord[]): KpiStats {
  const both = records.filter((r) => r.bothFilled);
  const notBoth = records.filter((r) => !r.bothFilled);
  const fillRate = records.length === 0 ? 0 : both.length / records.length;

  const goodAvgPnl = avg(both.map((r) => r.pnl));
  const lossAvgPnl = avg(notBoth.map((r) => r.pnl));
  const lossMagnitude = Math.max(0, -lossAvgPnl);

  const breakevenFillRate =
    lossMagnitude > 0 ? lossMagnitude / (goodAvgPnl + lossMagnitude) : null;
  const edge = breakevenFillRate === null ? null : fillRate - breakevenFillRate;

  const byAsset: AssetBreakdown[] = [...new Set(records.map((r) => r.asset))].map(
    (asset) => {
      const rs = records.filter((r) => r.asset === asset);
      const rsBoth = rs.filter((r) => r.bothFilled);
      return {
        asset,
        cycles: rs.length,
        fillRate: rs.length === 0 ? 0 : rsBoth.length / rs.length,
        pnl: rs.reduce((s, r) => s + r.pnl, 0),
      };
    },
  );

  const bucketMap = new Map<number, CycleRecord[]>();
  for (const r of records) {
    const list = bucketMap.get(r.minuteBucket) ?? [];
    list.push(r);
    bucketMap.set(r.minuteBucket, list);
  }
  const byMinuteBucket: MinuteBreakdown[] = [...bucketMap.keys()]
    .sort((a, b) => a - b)
    .map((minute) => {
      const rs = bucketMap.get(minute)!;
      const rsBoth = rs.filter((r) => r.bothFilled);
      return {
        minute,
        cycles: rs.length,
        fillRate: rs.length === 0 ? 0 : rsBoth.length / rs.length,
      };
    });

  let running = 0;
  const cumulativePnl: PnlPoint[] = records.map((r) => {
    running += r.pnl;
    return { ts: r.ts, cumulativePnl: running };
  });

  return {
    totalCycles: records.length,
    bothFilled: both.length,
    oneSided: records.filter((r) => r.oneSided).length,
    ghostFills: records.filter((r) => r.ghostFill).length,
    fillRate,
    totalPnl: records.reduce((s, r) => s + r.pnl, 0),
    goodAvgPnl,
    lossAvgPnl,
    lossMagnitude,
    breakevenFillRate,
    edge,
    byAsset,
    byMinuteBucket,
    cumulativePnl,
  };
}
