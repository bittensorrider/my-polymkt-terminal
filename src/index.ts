// Entry point: wires together the market detector, the maker-merge MM strategy, and the
// RTDS fill watcher, then keeps the process alive printing periodic status until SIGINT/SIGTERM.

import { config, validateRuntimeConfig } from './config.js';
import { logger } from './logger.js';
import { sleep, errMsg } from './lib/util.js';
import { initClient, getBestBid } from './lib/polymarketClient.js';
import { MarketDetector } from './lib/marketDetector.js';
import { FillWatcher } from './lib/fillWatcher.js';
import { runCycle } from './strategies/makerMergeMM.js';
import type { MarketInfo } from './types.js';

const runningByAsset = new Set<string>();
const pendingByAsset = new Map<string, MarketInfo>();

/** Serializes cycles per asset: if one is already running for this asset, the newly found
 * market is queued and picked up (after an optional re-entry delay) once the current one ends. */
async function handleMarket(market: MarketInfo, fillWatcher: FillWatcher): Promise<void> {
  if (runningByAsset.has(market.asset)) {
    pendingByAsset.set(market.asset, market);
    logger.info(`[${market.asset}] ${market.slug} queued — a cycle is already running for this asset.`);
    return;
  }

  runningByAsset.add(market.asset);
  try {
    await runCycle(market, fillWatcher);
  } catch (err) {
    logger.error(`[${market.asset}] cycle threw an error: ${errMsg(err)}`);
  } finally {
    runningByAsset.delete(market.asset);
  }

  const next = pendingByAsset.get(market.asset);
  if (next) {
    pendingByAsset.delete(market.asset);
    if (config.mmReentryEnabled) {
      logger.info(`[${market.asset}] re-entry delay ${config.mmReentryDelaySec}s before ${next.slug}.`);
      await sleep(config.mmReentryDelaySec * 1000);
    }
    void handleMarket(next, fillWatcher);
  }
}

function printStatus(): void {
  const running = [...runningByAsset].join(', ') || 'none';
  logger.info(`status: dryRun=${config.dryRun} running=[${running}] queued=${pendingByAsset.size}`);
}

async function maybeEnterCurrentMarkets(detector: MarketDetector, fillWatcher: FillWatcher): Promise<void> {
  if (!config.currentMarketEnabled) return;

  const current = await detector.checkCurrentMarket(config.mmCutLossSec + 15);
  for (const market of current) {
    try {
      const [yesBid, noBid] = await Promise.all([getBestBid(market.yesTokenId), getBestBid(market.noTokenId)]);
      const worst = Math.max(yesBid, noBid);
      if (worst > config.currentMarketMaxOdds) {
        logger.info(`[${market.asset}] skipping in-progress ${market.slug} — odds already too lopsided (${worst.toFixed(3)}).`);
        continue;
      }
    } catch (err) {
      logger.warn(`[${market.asset}] could not check in-progress odds for ${market.slug}: ${errMsg(err)} — skipping.`);
      continue;
    }
    void handleMarket(market, fillWatcher);
  }
}

async function main(): Promise<void> {
  validateRuntimeConfig();
  logger.info(
    `Starting my-polymkt-terminal — DRY_RUN=${config.dryRun}, assets=${config.mmAssets.join(',')}, duration=${config.mmDuration}`
  );

  await initClient();

  const fillWatcher = new FillWatcher(() => {
    // Wake-up signal only. The strategy's own poll loop re-checks on-chain balance on a
    // fixed cadence regardless — this just means we don't have to wait for the next tick.
  });
  fillWatcher.start();

  const detector = new MarketDetector(config.mmAssets, config.mmDuration, config.mmDetectorPollSec, (market) => {
    void handleMarket(market, fillWatcher);
  });

  await maybeEnterCurrentMarkets(detector, fillWatcher);
  detector.start();

  const statusTimer = setInterval(printStatus, 60_000);

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down…`);
    clearInterval(statusTimer);
    detector.stop();
    fillWatcher.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Fatal error: ${errMsg(err)}`);
  process.exit(1);
});
