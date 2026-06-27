// Live & historical BTC/ETH spot-price candles for the dashboard's price chart panel.
//
// Source: Binance's public REST API (no key required). This is purely for visual context
// next to the up/down markets — the strategy itself never reads this feed; maker-merge MM
// only ever looks at Polymarket's own CLOB bid/ask (see strategies/makerMergeMM.ts). If
// Binance is unreachable (rate-limited, blocked network, etc.) the chart panel degrades to
// an error message — it never affects trading.

import { SUPPORTED_ASSETS } from "../config.js";

export type ChartAsset = (typeof SUPPORTED_ASSETS)[number]; // "btc" | "eth"

export const PRICE_INTERVALS = ["1m", "5m", "15m", "1h"] as const;
export type PriceInterval = (typeof PRICE_INTERVALS)[number];

const BINANCE_SYMBOL: Record<ChartAsset, string> = {
  btc: "BTCUSDT",
  eth: "ETHUSDT",
};

export interface Candle {
  /** Unix seconds (lightweight-charts wants seconds, Binance gives ms). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function isChartAsset(v: string): v is ChartAsset {
  return (SUPPORTED_ASSETS as readonly string[]).includes(v);
}

export function isPriceInterval(v: string): v is PriceInterval {
  return (PRICE_INTERVALS as readonly string[]).includes(v);
}

/** One row of Binance's kline response — see
 * https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-data
 * [openTime, open, high, low, close, volume, closeTime, ...unused trailing fields] */
type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

/** Fetches the most recent `limit` candles for `asset` at `interval`. Throws on any
 * non-2xx response or network failure — callers decide how to surface that (the dashboard
 * server turns it into a 502 + cached "last known good" data rather than crashing). */
export async function getKlines(
  asset: ChartAsset,
  interval: PriceInterval,
  limit: number,
): Promise<Candle[]> {
  const symbol = BINANCE_SYMBOL[asset];
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance klines returned ${res.status} for ${symbol} ${interval}`);
  }
  const raw = (await res.json()) as BinanceKline[];
  return raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}
