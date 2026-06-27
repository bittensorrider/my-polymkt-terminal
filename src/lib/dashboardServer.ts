// Minimal embedded HTTP + WebSocket server exposing a read-only live view of the bot plus
// pause/resume/stop controls. Reuses the existing `ws` dependency — no new packages needed.
//
// SECURITY: binds to config.dashboardHost (127.0.0.1 by default) and has no authentication.
// The pause/resume/stop endpoints are unauthenticated by design — fine on localhost, but do
// NOT set DASHBOARD_HOST to 0.0.0.0 or a public interface without putting your own auth/proxy
// in front of it, since anyone who can reach the port can stop the bot.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { errMsg } from "./util.js";
import { botState } from "./botState.js";
import { computeKpiStats, type KpiStats } from "./kpiStats.js";
import { getUsdcBalance } from "./ctf.js";
import { getKlines, isChartAsset, isPriceInterval, type Candle } from "./priceFeed.js";
import { DASHBOARD_HTML } from "../dashboard/page.js";
import type { CycleRecord } from "../types.js";

export interface DashboardServerOptions {
  /** Called when the dashboard's Stop button is used. Should perform the same graceful
   * shutdown as SIGINT/SIGTERM. */
  onStopRequested: () => void;
}

export interface DashboardServerHandle {
  stop: () => void;
}

// ── Live on-chain USDC balance — polled on its own slow interval, never on the 1s
// broadcast tick, since it's a real RPC call. Cached so /api/state and every WS snapshot
// just read the last-known value. Gated on PROXY_WALLET_ADDRESS alone (not the stricter
// "has a signer" check) — reading balanceOf only needs a public address.
const USDC_POLL_MS = 15_000;

interface WalletBalanceCache {
  configured: boolean;
  usdcBalance: number | null;
  baselineUsdcBalance: number | null;
  updatedAt: number | null;
  error: string | null;
}

const walletBalance: WalletBalanceCache = {
  configured: config.proxyWallet.length > 0,
  usdcBalance: null,
  baselineUsdcBalance: null,
  updatedAt: null,
  error: null,
};

async function refreshUsdcBalance(): Promise<void> {
  if (!walletBalance.configured) return;
  try {
    const value = await getUsdcBalance(config.proxyWallet);
    walletBalance.usdcBalance = value;
    walletBalance.updatedAt = Date.now();
    walletBalance.error = null;
    if (walletBalance.baselineUsdcBalance === null) {
      walletBalance.baselineUsdcBalance = value;
    }
  } catch (err) {
    walletBalance.error = errMsg(err);
    logger.debug(`Dashboard: USDC balance refresh failed: ${errMsg(err)}`);
  }
}

// ── BTC/ETH price chart data — proxied from Binance's public klines API and cached briefly
// per (asset, interval, limit) so a chart re-rendering or several browser tabs polling at
// once don't each trigger their own Binance request. This is display-only context next to
// the up/down markets; nothing here feeds back into the strategy.
const PRICE_CACHE_TTL_MS = 8_000;

interface PriceCacheEntry {
  candles: Candle[];
  fetchedAt: number;
}

const priceCache = new Map<string, PriceCacheEntry>();

async function getCachedKlines(
  asset: Parameters<typeof getKlines>[0],
  interval: Parameters<typeof getKlines>[1],
  limit: number,
): Promise<Candle[]> {
  const key = `${asset}:${interval}:${limit}`;
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
    return cached.candles;
  }
  try {
    const candles = await getKlines(asset, interval, limit);
    priceCache.set(key, { candles, fetchedAt: Date.now() });
    return candles;
  } catch (err) {
    // Serve stale data rather than nothing if we have it — a chart that's a few extra
    // seconds old beats one that blanks out on a transient Binance hiccup.
    if (cached) return cached.candles;
    throw err;
  }
}

async function loadKpiStats(): Promise<KpiStats> {
  let records: CycleRecord[] = [];
  try {
    const raw = await readFile(config.kpiLogPath, "utf8");
    records = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CycleRecord);
  } catch {
    records = [];
  }
  return computeKpiStats(records);
}

function buildStateJson() {
  return {
    dryRun: config.dryRun,
    mmAssets: config.mmAssets,
    mmDuration: config.mmDuration,
    paused: botState.isPaused(),
    startedAt: botState.getBootedAt(),
    now: Date.now(),
    positions: botState.getPositions(),
    queued: botState.getQueued(),
    recentCycles: botState.getRecentCycles(),
    wallet: { ...walletBalance },
  };
}

async function buildSnapshotPayload(): Promise<string> {
  const [state, kpi] = [buildStateJson(), await loadKpiStats()];
  return JSON.stringify({ type: "snapshot", state, kpi });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardServerOptions,
): Promise<void> {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
    return;
  }

  if (req.method === "GET" && url === "/api/state") {
    const state = buildStateJson();
    const kpi = await loadKpiStats();
    sendJson(res, 200, { state, kpi });
    return;
  }

  if (req.method === "GET" && url.startsWith("/api/prices")) {
    const params = new URL(url, "http://localhost").searchParams;
    const asset = (params.get("asset") ?? "").toLowerCase();
    const interval = params.get("interval") ?? "1m";
    const limit = Math.min(500, Math.max(10, Number(params.get("limit")) || 200));

    if (!isChartAsset(asset)) {
      sendJson(res, 400, { error: "asset must be one of the supported assets (btc, eth)" });
      return;
    }
    if (!isPriceInterval(interval)) {
      sendJson(res, 400, { error: "interval must be one of 1m, 5m, 15m, 1h" });
      return;
    }
    try {
      const candles = await getCachedKlines(asset, interval, limit);
      sendJson(res, 200, { asset, interval, candles });
    } catch (err) {
      sendJson(res, 502, { error: `Price feed unavailable: ${errMsg(err)}` });
    }
    return;
  }

  if (req.method === "POST" && url === "/api/pause") {
    botState.setPaused(true);
    logger.info("Dashboard: paused — no new cycles will be entered until resumed.");
    sendJson(res, 200, { paused: true });
    return;
  }

  if (req.method === "POST" && url === "/api/resume") {
    botState.setPaused(false);
    logger.info("Dashboard: resumed.");
    sendJson(res, 200, { paused: false });
    return;
  }

  if (req.method === "POST" && url === "/api/stop") {
    logger.warn("Dashboard: stop requested — shutting down now (same as Ctrl+C).");
    sendJson(res, 200, { stopping: true });
    // Let the response flush before tearing the process down.
    setTimeout(() => options.onStopRequested(), 100);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

export function startDashboardServer(options: DashboardServerOptions): DashboardServerHandle {
  const server = createServer((req, res) => {
    handleRequest(req, res, options).catch((err) => {
      logger.error(`Dashboard request failed: ${errMsg(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("Internal error");
    });
  });

  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();

  async function sendSnapshot(ws: WebSocket): Promise<void> {
    if (ws.readyState !== ws.OPEN) return;
    try {
      const payload = await buildSnapshotPayload();
      ws.send(payload);
    } catch (err) {
      logger.debug(`Dashboard: snapshot send failed: ${errMsg(err)}`);
    }
  }

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
    void sendSnapshot(ws);
  });

  const broadcastTimer = setInterval(() => {
    for (const ws of clients) void sendSnapshot(ws);
  }, 1000);

  let balanceTimer: NodeJS.Timeout | null = null;
  if (walletBalance.configured) {
    void refreshUsdcBalance();
    balanceTimer = setInterval(() => void refreshUsdcBalance(), USDC_POLL_MS);
  }

  server.on("error", (err) => {
    logger.warn(`Dashboard server failed to start: ${errMsg(err)} — continuing without it.`);
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    logger.info(`Dashboard listening at http://${config.dashboardHost}:${config.dashboardPort}`);
  });

  return {
    stop: () => {
      clearInterval(broadcastTimer);
      if (balanceTimer) clearInterval(balanceTimer);
      for (const ws of clients) ws.close();
      wss.close();
      server.close();
    },
  };
}
