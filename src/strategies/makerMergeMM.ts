// Maker-merge market making: post a resting (GTC) maker BUY on both YES and NO at the
// current best bid, with combined price capped below $1.00 (MM_MAX_COMBINED). If both fill,
// merge the pair back into USDC via the CTF contract, capturing (1 - combined) per share as
// a market-neutral edge. Orders are placed once and never repriced/cancelled-and-replaced —
// see README for why ("no repricing" trades flexibility for avoiding double-fill/ghost-order
// bugs). On-chain balance is always the source of truth for fills, never CLOB order status
// alone (see ghost-fill handling below).

import { config } from "../config.js";
import { logger } from "../logger.js";
import { sleep, nowSec, errMsg } from "../lib/util.js";
import {
  getBestBid,
  getBestAsk,
  placeMakerBuy,
  cancelOrder,
  marketSell,
  getOrderStatus,
  floorToTick,
  type PlaceOrderResult,
} from "../lib/polymarketClient.js";
import { getConditionalTokenBalance, mergePositions } from "../lib/ctf.js";
import { logCycle } from "../lib/kpiLogger.js";
import { botState } from "../lib/botState.js";
import type { FillWatcher } from "../lib/fillWatcher.js";
import type { CycleRecord, MarketInfo, Position, SideState } from "../types.js";

/** Pushes the current position into the shared dashboard state. Pure bookkeeping side
 * effect — never read back by the strategy itself, so it can never influence trading. */
function pushPositionSnapshot(position: Position, ghostFill: boolean): void {
  botState.setPosition(position.market.asset, {
    asset: position.market.asset,
    slug: position.market.slug,
    duration: position.market.duration,
    status: position.status,
    eventStartTime: position.market.eventStartTime,
    endTime: position.market.endTime,
    yesEntryPrice: position.yes.entryPrice,
    noEntryPrice: position.no.entryPrice,
    yesFilled: position.yes.filled,
    noFilled: position.no.filled,
    ghostFill,
    startedAt: position.startedAt,
  });
}

interface MonitorResult {
  bothFilled: boolean;
  oneSided: boolean;
  ghostFill: boolean;
  cutLoss: boolean;
  timeToFillMs: number | null;
}

/** Runs one full maker-merge cycle on `market`. Returns null if no valid entry was ever
 * found within the entry window (so nothing was risked, and no KPI row is written). */
export async function runCycle(
  market: MarketInfo,
  fillWatcher: FillWatcher,
): Promise<CycleRecord | null> {
  logger.info(`[${market.asset}] watching ${market.slug} for an entry…`);
  botState.setPosition(market.asset, {
    asset: market.asset,
    slug: market.slug,
    duration: market.duration,
    status: "waiting_entry",
    eventStartTime: market.eventStartTime,
    endTime: market.endTime,
    yesEntryPrice: null,
    noEntryPrice: null,
    yesFilled: false,
    noFilled: false,
    ghostFill: false,
    startedAt: null,
  });
  const opp = await waitForEntryOpportunity(market);
  if (!opp) {
    logger.info(
      `[${market.asset}] ${market.slug}: no valid entry within window — skipping this cycle.`,
    );
    botState.clearPosition(market.asset);
    return null;
  }

  const startedAt = Date.now();
  const targetShares = Math.max(config.mmTradeSize, market.minOrderSize);
  const yesPrice = floorToTick(opp.yesBid, market.tickSize);
  const noPrice = floorToTick(opp.noBid, market.tickSize);
  const combined = yesPrice + noPrice;
  const minuteBucket = Math.floor(
    (startedAt / 1000 - market.eventStartTime) / 60,
  );

  logger.trade(
    `[${market.asset}] entering ${market.slug}: YES@${yesPrice} + NO@${noPrice} = ${combined.toFixed(4)}, ${targetShares} shares/side`,
  );

  try {
    const [yesBaseline, noBaseline] = await Promise.all([
      getConditionalTokenBalance(config.proxyWallet, market.yesTokenId),
      getConditionalTokenBalance(config.proxyWallet, market.noTokenId),
    ]);

    const { yesOrder, noOrder } = await placeBothLegs(
      market,
      yesPrice,
      noPrice,
      targetShares,
    );

    fillWatcher.watch(market.yesTokenId);
    fillWatcher.watch(market.noTokenId);

    const position: Position = {
      market,
      startedAt,
      status: "monitoring",
      yes: makeSideState(
        "yes",
        market.yesTokenId,
        yesPrice,
        targetShares,
        yesOrder.orderId,
        yesBaseline,
      ),
      no: makeSideState(
        "no",
        market.noTokenId,
        noPrice,
        targetShares,
        noOrder.orderId,
        noBaseline,
      ),
      firstFillAt: null,
      ghostFillSuspectedAt: null,
      realizedPnl: 0,
    };
    pushPositionSnapshot(position, false);

    const result = await monitorPosition(position);
    fillWatcher.unwatch(market.yesTokenId);
    fillWatcher.unwatch(market.noTokenId);

    const record: CycleRecord = {
      ts: new Date().toISOString(),
      asset: market.asset,
      duration: market.duration,
      conditionId: market.conditionId,
      slug: market.slug,
      minuteBucket,
      yesEntryPrice: yesPrice,
      noEntryPrice: noPrice,
      combined,
      targetShares,
      bothFilled: result.bothFilled,
      oneSided: result.oneSided,
      ghostFill: result.ghostFill,
      cutLoss: result.cutLoss,
      timeToFillMs: result.timeToFillMs,
      pnl: position.realizedPnl,
      dryRun: config.dryRun,
    };
    await logCycle(record);
    botState.pushCycleRecord(record);
    botState.clearPosition(market.asset);
    logger.success(
      `[${market.asset}] cycle complete: ${market.slug} bothFilled=${record.bothFilled} oneSided=${record.oneSided} pnl=${record.pnl.toFixed(4)}`,
    );
    return record;
  } catch (err) {
    // Whatever failed here — partial leg placement (already cleaned up inside
    // placeBothLegs), a balance read, monitoring, anything — don't leave a stale
    // "waiting_entry"/"monitoring" card stuck on the dashboard for this asset until the
    // next detected slot happens to overwrite it.
    botState.clearPosition(market.asset);
    throw err;
  }
}

/** Places both legs via Promise.allSettled rather than Promise.all so a single-leg failure
 * never leaves the other leg orphaned. If exactly one leg made it onto the live book before
 * the other failed, the placed leg is best-effort cancelled immediately — a naked,
 * unmonitored resting maker order is worse than abandoning the cycle outright, since nothing
 * else in this file would ever watch, cancel, or merge it. */
async function placeBothLegs(
  market: MarketInfo,
  yesPrice: number,
  noPrice: number,
  targetShares: number,
): Promise<{ yesOrder: PlaceOrderResult; noOrder: PlaceOrderResult }> {
  const [yesResult, noResult] = await Promise.allSettled([
    placeMakerBuy(market.yesTokenId, yesPrice, targetShares, market.tickSize),
    placeMakerBuy(market.noTokenId, noPrice, targetShares, market.tickSize),
  ]);

  if (yesResult.status === "fulfilled" && noResult.status === "fulfilled") {
    return { yesOrder: yesResult.value, noOrder: noResult.value };
  }

  if (yesResult.status === "rejected" && noResult.status === "rejected") {
    throw new Error(
      `both leg placements failed — yes: ${errMsg(yesResult.reason)}; no: ${errMsg(noResult.reason)}`,
    );
  }

  // Exactly one leg succeeded — figure out which, and cancel it before this throws.
  const placedSide = yesResult.status === "fulfilled" ? "YES" : "NO";
  const placedOrder =
    yesResult.status === "fulfilled"
      ? yesResult.value
      : (noResult as PromiseFulfilledResult<PlaceOrderResult>).value;
  const failedSide = placedSide === "YES" ? "NO" : "YES";
  const failedReason =
    yesResult.status === "rejected"
      ? yesResult.reason
      : (noResult as PromiseRejectedResult).reason;

  logger.error(
    `[${market.asset}] ${market.slug}: ${failedSide} leg placement failed (${errMsg(failedReason)}) after ` +
      `${placedSide} was already placed (order ${placedOrder.orderId}) — cancelling ${placedSide} now ` +
      `to avoid a naked, unmonitored position.`,
  );
  await cancelOrder(placedOrder.orderId).catch((err) =>
    logger.error(
      `[${market.asset}] ${market.slug}: cancel of orphaned ${placedSide} order ${placedOrder.orderId} ` +
        `FAILED (${errMsg(err)}) — check this order manually on Polymarket, it may still be live.`,
    ),
  );
  throw new Error(
    `${failedSide} leg placement failed after ${placedSide} was placed — cancelled ${placedSide}, aborting cycle.`,
  );
}

function makeSideState(
  side: "yes" | "no",
  tokenId: string,
  entryPrice: number,
  targetShares: number,
  orderId: string,
  baseline: bigint,
): SideState {
  return {
    side,
    tokenId,
    entryPrice,
    targetShares,
    orderId,
    filled: false,
    filledShares: 0,
    baselineBalance: baseline.toString(),
  };
}

// ── Entry pricing ─────────────────────────────────────────────────────────────
// We join the best bid on each side (the most aggressive price that still rests as a maker
// order without crossing the ask) and only enter once YES-bid + NO-bid <= MM_MAX_COMBINED —
// that gap is the edge we're paid for providing liquidity on both sides at once.

async function waitForEntryOpportunity(
  market: MarketInfo,
): Promise<{ yesBid: number; noBid: number } | null> {
  const STABILIZATION_SEC = 10; // let the book settle right after open before quoting off it
  const stabilizeUntil = market.eventStartTime + STABILIZATION_SEC;
  const entryDeadline =
    market.eventStartTime + STABILIZATION_SEC + config.mmEntryWindowSec;
  const cutLossDeadline = market.endTime - config.mmCutLossSec;

  while (nowSec() < stabilizeUntil) {
    if (nowSec() >= cutLossDeadline) return null;
    await sleep(1000);
  }

  const inBand = (p: number) =>
    p >= config.mmMinPrice && p <= config.mmMaxPrice;

  while (nowSec() < entryDeadline && nowSec() < cutLossDeadline) {
    try {
      const [yesBid, noBid] = await Promise.all([
        getBestBid(market.yesTokenId),
        getBestBid(market.noTokenId),
      ]);
      const combined = yesBid + noBid;
      if (combined <= config.mmMaxCombined && inBand(yesBid) && inBand(noBid)) {
        return { yesBid, noBid };
      }
      logger.debug(
        `${market.slug}: combined=${combined.toFixed(4)} (yes=${yesBid}, no=${noBid}) — outside entry gate.`,
      );
    } catch (err) {
      logger.warn(`${market.slug}: price check failed: ${errMsg(err)}`);
    }
    await sleep(Math.max(1000, config.mmPollSec * 1000));
  }
  return null;
}

// ── Monitoring loop ───────────────────────────────────────────────────────────

async function monitorPosition(position: Position): Promise<MonitorResult> {
  const { market } = position;
  const cutLossDeadline = market.endTime - config.mmCutLossSec;
  const result: MonitorResult = {
    bothFilled: false,
    oneSided: false,
    ghostFill: false,
    cutLoss: false,
    timeToFillMs: null,
  };
  let oneSidedWarned = false;

  for (;;) {
    await checkFills(position, result);
    pushPositionSnapshot(position, result.ghostFill);

    if (position.yes.filled && position.no.filled) {
      await mergeFilledPair(position, result);
      pushPositionSnapshot(position, result.ghostFill);
      return result;
    }

    if ((position.yes.filled || position.no.filled) && !oneSidedWarned) {
      oneSidedWarned = true;
      logger.warn(
        `[${market.asset}] ${market.slug}: one side filled, waiting on the other (cut-loss in ${cutLossDeadline - nowSec()}s).`,
      );
    }

    if (nowSec() >= cutLossDeadline) {
      await cutLossExit(position, result);
      pushPositionSnapshot(position, result.ghostFill);
      return result;
    }

    await sleep(config.mmPollSec * 1000);
  }
}

async function checkFills(
  position: Position,
  result: MonitorResult,
): Promise<void> {
  if (config.dryRun) {
    await checkFillsSimulated(position);
  } else {
    await checkFillsOnchain(position, result);
  }
}

/** DRY_RUN fill simulation: we never place a real order, so instead we watch the *live*
 * order book. If the best ask touches/crosses our resting bid price, a real seller would
 * have crossed into our level — a reasonable proxy for "this would likely have filled." */
async function checkFillsSimulated(position: Position): Promise<void> {
  for (const side of [position.yes, position.no] as const) {
    if (side.filled) continue;
    try {
      const ask = await getBestAsk(side.tokenId);
      if (ask <= side.entryPrice + 1e-9) {
        side.filled = true;
        side.filledShares = side.targetShares;
        if (position.firstFillAt === null) position.firstFillAt = Date.now();
        logger.trade(
          `[DRY_RUN][${position.market.asset}] simulated fill: ${side.side.toUpperCase()} @ ${side.entryPrice} (live ask reached ${ask}).`,
        );
      }
    } catch (err) {
      logger.debug(
        `simulated fill check failed for ${side.side}: ${errMsg(err)}`,
      );
    }
  }
}

/** Live fill detection: on-chain ERC-1155 balance delta is the only thing that marks a side
 * as filled. CLOB order status is cross-checked only to flag a possible ghost fill (order no
 * longer open, but balance still unchanged) — logged, never trusted on its own. */
async function checkFillsOnchain(
  position: Position,
  result: MonitorResult,
): Promise<void> {
  for (const side of [position.yes, position.no] as const) {
    if (side.filled) continue;
    try {
      const balance = await getConditionalTokenBalance(
        config.proxyWallet,
        side.tokenId,
      );
      const baseline = BigInt(side.baselineBalance);
      const delta = Number(balance - baseline) / 1e6; // CTF outcome tokens use 6 decimals
      if (delta >= side.targetShares * 0.999) {
        side.filled = true;
        side.filledShares = delta;
        if (position.firstFillAt === null) position.firstFillAt = Date.now();
        logger.trade(
          `[${position.market.asset}] confirmed on-chain fill: ${side.side.toUpperCase()} +${delta.toFixed(2)} shares.`,
        );
        continue;
      }
      if (side.orderId && !result.ghostFill) {
        const status = await getOrderStatus(side.orderId);
        if (status === null) {
          result.ghostFill = true;
          logger.warn(
            `[${position.market.asset}] ${side.side.toUpperCase()} order ${side.orderId} is no longer open on the CLOB but on-chain balance hasn't moved — possible ghost fill, continuing to watch on-chain.`,
          );
        }
      }
    } catch (err) {
      logger.warn(
        `on-chain balance check failed for ${side.side}: ${errMsg(err)}`,
      );
    }
  }
}

// ── Exit paths ────────────────────────────────────────────────────────────────

async function mergeFilledPair(
  position: Position,
  result: MonitorResult,
): Promise<void> {
  const { market } = position;
  result.bothFilled = true;
  result.timeToFillMs = Date.now() - position.startedAt;

  const mergeShares = Math.min(
    position.yes.filledShares,
    position.no.filledShares,
  );
  try {
    await mergePositions(market.conditionId, mergeShares, market.negRisk);
    const cost =
      (position.yes.entryPrice + position.no.entryPrice) * mergeShares;
    position.realizedPnl += mergeShares - cost;
    position.status = "done";
    logger.success(
      `[${market.asset}] merged ${mergeShares} shares/side -> +${(mergeShares - cost).toFixed(4)} USDC.`,
    );
  } catch (err) {
    logger.error(
      `mergePositions failed: ${errMsg(err)} — pair left unmerged; redeem manually once the market resolves.`,
    );
  }

  // Defensive: equal targetShares on both sides means this should be ~0, but a partial-fill
  // edge case could leave a small remainder. Never hold a naked remainder into resolution.
  const leftoverYes = position.yes.filledShares - mergeShares;
  const leftoverNo = position.no.filledShares - mergeShares;
  if (leftoverYes > 1e-6)
    await flattenShares(position, position.yes, leftoverYes);
  if (leftoverNo > 1e-6) await flattenShares(position, position.no, leftoverNo);
}

async function cutLossExit(
  position: Position,
  result: MonitorResult,
): Promise<void> {
  const { market } = position;
  result.cutLoss = true;
  logger.warn(`[${market.asset}] ${market.slug}: cut-loss window reached.`);

  for (const side of [position.yes, position.no] as const) {
    if (!side.filled && side.orderId) {
      await cancelOrder(side.orderId).catch((err) =>
        logger.warn(`cancelOrder(${side.side}) failed: ${errMsg(err)}`),
      );
    }
  }

  const yesFilled = position.yes.filled;
  const noFilled = position.no.filled;
  result.oneSided = yesFilled !== noFilled;

  if (yesFilled && noFilled) {
    await mergeFilledPair(position, result); // last-second double confirmation, just in case
    return;
  }
  if (yesFilled)
    await flattenShares(position, position.yes, position.yes.filledShares);
  if (noFilled)
    await flattenShares(position, position.no, position.no.filledShares);
  position.status = "cut_loss";
}

/** Market-sells `shares` of one side to flatten unwanted directional exposure. Never used to
 * "dump" the expensive side at a guaranteed large loss — only ever called for whichever side
 * actually filled (the cheap-side remainder), per the project's ghost-fill recovery rule. */
async function flattenShares(
  position: Position,
  side: SideState,
  shares: number,
): Promise<void> {
  try {
    await marketSell(side.tokenId, shares);
    position.realizedPnl -= side.entryPrice * shares;
    logger.warn(
      `[${position.market.asset}] flattened ${shares.toFixed(2)} ${side.side.toUpperCase()} shares.`,
    );
  } catch (err) {
    logger.error(
      `flattenShares(${side.side}) failed: ${errMsg(err)} — exposure remains open, check manually.`,
    );
  }
}
