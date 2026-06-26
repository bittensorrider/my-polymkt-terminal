// CLI: npm run kpi-report
//
// Reads the JSONL cycle log and reports the both-fill rate against the break-even calculator
// from the Medium post that inspired this project: p* = loss / (good + loss), where `good`
// is the average P&L on cycles that both-filled and `loss` is the average P&L magnitude on
// cycles that didn't. Run this regularly in DRY_RUN to see whether your entry gate
// (MM_MAX_COMBINED / MM_MIN_PRICE / MM_MAX_PRICE) clears breakeven before ever risking real funds.

import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import type { CycleRecord } from '../types.js';

async function loadRecords(): Promise<CycleRecord[]> {
  let raw: string;
  try {
    raw = await readFile(config.kpiLogPath, 'utf8');
  } catch {
    console.log(`No KPI log found at ${config.kpiLogPath} yet — run the bot first.`);
    return [];
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CycleRecord);
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const records = await loadRecords();
  if (records.length === 0) return;

  const both = records.filter((r) => r.bothFilled);
  const notBoth = records.filter((r) => !r.bothFilled);
  const fillRate = both.length / records.length;

  const goodAvg = avg(both.map((r) => r.pnl));
  const lossAvg = avg(notBoth.map((r) => r.pnl)); // typically <= 0
  const lossMagnitude = Math.max(0, -lossAvg);

  console.log(`\n=== KPI report: ${config.kpiLogPath} ===`);
  console.log(`Cycles entered: ${records.length}`);
  console.log(`Both-fill rate: ${pct(fillRate)} (${both.length}/${records.length})`);
  console.log(`One-sided / cut-loss exits: ${records.filter((r) => r.oneSided).length}`);
  console.log(`Ghost-fill flags: ${records.filter((r) => r.ghostFill).length}`);
  console.log(`Total P&L: ${records.reduce((s, r) => s + r.pnl, 0).toFixed(4)} USDC`);
  console.log(`Avg P&L when both filled (good): ${goodAvg.toFixed(4)}`);
  console.log(`Avg P&L when not both filled (loss): ${lossAvg.toFixed(4)}`);

  if (lossMagnitude <= 0) {
    console.log(
      '\nEvery entered cycle so far has been non-negative even without both-fills — no breakeven tension to report yet.'
    );
  } else {
    const breakeven = lossMagnitude / (goodAvg + lossMagnitude);
    console.log(`\nBreak-even both-fill rate: ${pct(breakeven)} (need fillRate above this to be net profitable)`);
    const edge = fillRate - breakeven;
    console.log(
      edge >= 0
        ? `Current fill rate clears breakeven by ${pct(edge)}.`
        : `Current fill rate is BELOW breakeven by ${pct(-edge)} — this configuration is losing money at this fill rate.`
    );
  }

  console.log('\n-- By asset --');
  for (const asset of [...new Set(records.map((r) => r.asset))]) {
    const rs = records.filter((r) => r.asset === asset);
    const rsBoth = rs.filter((r) => r.bothFilled);
    console.log(
      `  ${asset}: ${rs.length} cycles, fillRate=${pct(rsBoth.length / rs.length)}, pnl=${rs
        .reduce((s, r) => s + r.pnl, 0)
        .toFixed(4)}`
    );
  }

  console.log('\n-- By minute entered (minutes since market open) --');
  const buckets = new Map<number, CycleRecord[]>();
  for (const r of records) {
    const list = buckets.get(r.minuteBucket) ?? [];
    list.push(r);
    buckets.set(r.minuteBucket, list);
  }
  for (const minute of [...buckets.keys()].sort((a, b) => a - b)) {
    const rs = buckets.get(minute)!;
    const rsBoth = rs.filter((r) => r.bothFilled);
    console.log(`  minute ${minute}: ${rs.length} cycles, fillRate=${pct(rsBoth.length / rs.length)}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
