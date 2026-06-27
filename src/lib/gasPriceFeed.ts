// Live POL/USD spot price, used only to convert real on-chain gas costs (paid in POL by the
// Safe's signer EOA on every mergePositions tx) into USD for P&L accounting in
// makerMergeMM.ts. POL is Polygon's native gas token (rebranded from MATIC in 2024 — Binance
// delisted MATICUSDT in September 2024 as part of that rebrand; POLUSDT is the current,
// correct pair to query).
//
// Unlike priceFeed.ts (purely cosmetic dashboard chart data, never read by the strategy),
// this feed DOES feed back into realizedPnl — but only ever to subtract a small known cost
// from an already-confirmed real transaction, never to gate a trading decision. A failed
// fetch here is handled by the caller as "couldn't price this tx's gas, treat as $0" rather
// than ever blocking or retrying the merge itself.

const POL_USDT_SYMBOL = "POLUSDT";
const CACHE_MS = 60_000; // gas cost only needs ~minute-level price accuracy for bookkeeping

let cached: { price: number; at: number } | null = null;

interface BinanceTickerPrice {
  symbol: string;
  price: string;
}

/** Current POL/USD spot price via Binance's public ticker endpoint (no key required).
 * Cached for CACHE_MS so repeated merges in quick succession don't each trigger a fetch.
 * Throws on any non-2xx response, network failure, or unparseable price — callers should
 * catch this and fall back to $0 gas cost for that cycle rather than retrying indefinitely. */
export async function getPolUsdPrice(): Promise<number> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.price;
  }
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${POL_USDT_SYMBOL}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Binance ticker/price returned ${res.status} for ${POL_USDT_SYMBOL}`,
    );
  }
  const raw = (await res.json()) as BinanceTickerPrice;
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(
      `Binance ticker/price returned a non-numeric/invalid price for ${POL_USDT_SYMBOL}: ${raw.price}`,
    );
  }
  cached = { price, at: Date.now() };
  return price;
}
