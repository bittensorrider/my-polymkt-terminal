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

  server.on("error", (err) => {
    logger.warn(`Dashboard server failed to start: ${errMsg(err)} — continuing without it.`);
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    logger.info(`Dashboard listening at http://${config.dashboardHost}:${config.dashboardPort}`);
  });

  return {
    stop: () => {
      clearInterval(broadcastTimer);
      for (const ws of clients) ws.close();
      wss.close();
      server.close();
    },
  };
}
