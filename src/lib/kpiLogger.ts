// Structured per-cycle KPI logging — the instrumentation the Medium-post review specifically
// flags as missing from the reference bot. Every entered cycle (orders actually placed) gets
// one JSONL row here, regardless of outcome, so both-fill rate can be measured over time
// instead of guessed at. See src/scripts/kpiReport.ts for the reader/analyzer.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { CycleRecord } from '../types.js';

let dirEnsured = false;

export async function logCycle(record: CycleRecord): Promise<void> {
  if (!dirEnsured) {
    await mkdir(dirname(config.kpiLogPath), { recursive: true }).catch(() => undefined);
    dirEnsured = true;
  }
  await appendFile(config.kpiLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  logger.debug(
    `KPI logged: ${record.asset} ${record.slug} bothFilled=${record.bothFilled} pnl=${record.pnl.toFixed(4)}`
  );
}
