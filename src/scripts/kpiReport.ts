// CLI: npm run kpi-report
//
// Reads the JSONL cycle log and reports the both-fill rate against the break-even calculator
// from the Medium post that inspired this project: p* = loss / (good + loss), where `good`
// is the average P&L on cycles that both-filled and `loss` is the average P&L magnitude on
// cycles that didn't. Run this regularly in DRY_RUN to see whether your entry gate
// (MM_MAX_COMBINED / MM_MIN_PRICE / MM_MAX_PRICE) clears breakeven before ever risking real funds.
//
// The actual math lives in ../lib/kpiStats.ts, shared with the live dashboard so both
// report identical numbers.

import { readFile } from "node:fs/promises";

import { config } from "../config.js";
import { computeKpiStats } from "../lib/kpiStats.js";
import type { CycleRecord } from "../types.js";

async function loadRecords(): Promise<CycleRecord[]> {
  let raw: string;
  try {
    raw = await readFile(config.kpiLogPath, "utf8");
  } catch {
    console.log(
      `No KPI log found at ${config.kpiLogPath} yet — run the bot first.`,
    );
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CycleRecord);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const records = await loadRecords();
  if (records.length === 0) return;

  const stats = computeKpiStats(records);

  console.log(`\n=== KPI report: ${config.kpiLogPath} ===`);
  console.log(`Cycles entered: ${stats.totalCycles}`);
  console.log(
    `Both-fill rate: ${pct(stats.fillRate)} (${stats.bothFilled}/${stats.totalCycles})`,
  );
  console.log(`One-sided / cut-loss exits: ${stats.oneSided}`);
  console.log(`Ghost-fill flags: ${stats.ghostFills}`);
  console.log(`Total P&L: ${stats.totalPnl.toFixed(4)} USDC`);
  console.log(`  (of which gas cost: ${stats.totalGasCostUsd.toFixed(4)} USDC)`);
  console.log(`Avg P&L when both filled (good): ${stats.goodAvgPnl.toFixed(4)}`);
  console.log(`Avg P&L when not both filled (loss): ${stats.lossAvgPnl.toFixed(4)}`);

  if (stats.breakevenFillRate === null) {
    console.log(
      "\nEvery entered cycle so far has been non-negative even without both-fills — no breakeven tension to report yet.",
    );
  } else {
    console.log(
      `\nBreak-even both-fill rate: ${pct(stats.breakevenFillRate)} (need fillRate above this to be net profitable)`,
    );
    const edge = stats.edge as number;
    console.log(
      edge >= 0
        ? `Current fill rate clears breakeven by ${pct(edge)}.`
        : `Current fill rate is BELOW breakeven by ${pct(-edge)} — this configuration is losing money at this fill rate.`,
    );
  }

  console.log("\n-- By asset --");
  for (const a of stats.byAsset) {
    console.log(
      `  ${a.asset}: ${a.cycles} cycles, fillRate=${pct(a.fillRate)}, pnl=${a.pnl.toFixed(4)}`,
    );
  }

  console.log("\n-- By minute entered (minutes since market open) --");
  for (const b of stats.byMinuteBucket) {
    console.log(`  minute ${b.minute}: ${b.cycles} cycles, fillRate=${pct(b.fillRate)}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
