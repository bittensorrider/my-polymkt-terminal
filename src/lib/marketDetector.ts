// Polls Polymarket's Gamma API for upcoming "{asset}-updown-{duration}-{eventStartTimestamp}"
// markets — the deterministic slug format behind the 5m/15m crypto Up-or-Down markets.

import { HOSTS } from "../config.js";
import { logger } from "../logger.js";
import { errMsg, nowSec } from "./util.js";
import type { Asset, Duration, MarketInfo } from "../types.js";

export function slotSeconds(duration: Duration): number {
  return duration === "15m" ? 900 : 300;
}

export function currentSlotStart(duration: Duration, atSec = nowSec()): number {
  const slot = slotSeconds(duration);
  return Math.floor(atSec / slot) * slot;
}

export function nextSlotStart(duration: Duration, atSec = nowSec()): number {
  return currentSlotStart(duration, atSec) + slotSeconds(duration);
}

export function buildSlug(
  asset: Asset,
  duration: Duration,
  slotStartSec: number,
): string {
  return `${asset}-updown-${duration}-${slotStartSec}`;
}

interface GammaMarketRaw {
  conditionId?: string;
  condition_id?: string;
  question?: string;
  clobTokenIds?: string;
  endDate?: string;
  end_date_iso?: string;
  eventStartTime?: string;
  negRisk?: boolean;
  neg_risk?: boolean;
  orderPriceMinTickSize?: number | string;
  order_price_min_tick_size?: number | string;
  orderMinSize?: number | string;
  order_min_size?: number | string;
}

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Returns null on 404 (market not created on Gamma yet — normal while waiting for a future slot). */
export async function fetchMarketBySlug(
  slug: string,
): Promise<GammaMarketRaw | null> {
  const res = await fetch(`${HOSTS.gamma}/markets/slug/${slug}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Gamma API returned ${res.status} for slug ${slug}`);
  }
  const body = (await res.json()) as GammaMarketRaw | GammaMarketRaw[];
  return Array.isArray(body) ? (body[0] ?? null) : body;
}

export function normalizeMarket(
  raw: GammaMarketRaw,
  asset: Asset,
  duration: Duration,
  slug: string,
): MarketInfo | null {
  const conditionId = raw.conditionId ?? raw.condition_id;
  const tokenIds = parseJsonArray(raw.clobTokenIds);
  if (!conditionId || tokenIds.length < 2 || !tokenIds[0] || !tokenIds[1]) {
    logger.warn(
      `Market ${slug} is missing conditionId/clobTokenIds — skipping.`,
    );
    return null;
  }

  const endDateStr = raw.endDate ?? raw.end_date_iso;
  const slot = currentSlotStart(duration);
  const endTime = endDateStr
    ? Math.floor(Date.parse(endDateStr) / 1000)
    : slot + slotSeconds(duration);
  const eventStartStr = raw.eventStartTime;
  const eventStartTime = eventStartStr
    ? Math.floor(Date.parse(eventStartStr) / 1000)
    : endTime - slotSeconds(duration);

  return {
    asset,
    duration,
    slug,
    conditionId,
    question: raw.question ?? slug,
    yesTokenId: tokenIds[0],
    noTokenId: tokenIds[1],
    negRisk: Boolean(raw.negRisk ?? raw.neg_risk ?? false),
    tickSize: Number(
      raw.orderPriceMinTickSize ?? raw.order_price_min_tick_size ?? 0.01,
    ),
    minOrderSize: Number(raw.orderMinSize ?? raw.order_min_size ?? 5),
    eventStartTime,
    endTime,
  };
}

export type OnMarketFound = (market: MarketInfo) => void;

/** Polls ahead of each upcoming slot per configured asset, calling onFound exactly once per
 * slot as soon as Gamma has the market created (it typically pre-creates slots a few minutes
 * ahead of open). Dedupes by slot so a found market is never reported twice. */
export class MarketDetector {
  private timer: NodeJS.Timeout | null = null;
  private readonly scheduledSlot = new Map<Asset, number>();

  constructor(
    private readonly assets: Asset[],
    private readonly duration: Duration,
    private readonly pollSec: number,
    private readonly onFound: OnMarketFound,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollSec * 1000);
    logger.info(
      `Market detector started (assets=${this.assets.join(",")}, duration=${this.duration}, poll=${this.pollSec}s).`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Looks up the slot that's running *right now* for each asset — used at boot to decide
   * whether to jump into an in-progress market instead of waiting for the next fresh slot. */
  async checkCurrentMarket(minSecondsRemaining: number): Promise<MarketInfo[]> {
    const found: MarketInfo[] = [];
    for (const asset of this.assets) {
      const slot = currentSlotStart(this.duration);
      const remaining = slot + slotSeconds(this.duration) - nowSec();
      if (remaining < minSecondsRemaining) continue;

      const slug = buildSlug(asset, this.duration, slot);
      try {
        const raw = await fetchMarketBySlug(slug);
        if (!raw) continue;
        const market = normalizeMarket(raw, asset, this.duration, slug);
        if (market) {
          this.scheduledSlot.set(asset, slot);
          found.push(market);
        }
      } catch (err) {
        logger.warn(`checkCurrentMarket(${asset}) failed: ${errMsg(err)}`);
      }
    }
    return found;
  }

  private async tick(): Promise<void> {
    for (const asset of this.assets) {
      const slot = nextSlotStart(this.duration);
      if (this.scheduledSlot.get(asset) === slot) continue;

      const slug = buildSlug(asset, this.duration, slot);
      try {
        const raw = await fetchMarketBySlug(slug);
        if (!raw) continue; // not created on Gamma yet — try again next poll
        const market = normalizeMarket(raw, asset, this.duration, slug);
        if (!market) continue;
        this.scheduledSlot.set(asset, slot);
        this.onFound(market);
      } catch (err) {
        logger.warn(`Detector tick failed for ${asset}: ${errMsg(err)}`);
      }
    }
  }
}
