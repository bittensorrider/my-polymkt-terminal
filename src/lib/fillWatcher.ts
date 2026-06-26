// Real-Time Data Stream (RTDS) websocket client. This is a *wake-up signal only* — it tells
// the strategy "check on-chain balance now, something may have filled," it is never treated
// as authoritative proof of a fill (see ghost-fill handling in strategies/makerMergeMM.ts and
// the project README for why: the CLOB can report a fill whose on-chain settlement never
// lands). Disabled entirely in DRY_RUN, since there's nothing real to subscribe to.

import WebSocket, { type RawData } from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL_MS = 5000;
const MAX_RECONNECT_MS = 30000;

export interface FillSignal {
  tokenId: string;
  side: string;
  size: number;
  price: number;
  conditionId?: string;
}

export type FillCallback = (fill: FillSignal) => void;

export class FillWatcher {
  private ws: WebSocket | null = null;
  private reconnectMs = 2000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly watchedTokens = new Set<string>();
  private stopped = true;

  constructor(private readonly onFill: FillCallback) {}

  watch(tokenId: string): void {
    this.watchedTokens.add(tokenId);
  }

  unwatch(tokenId: string): void {
    this.watchedTokens.delete(tokenId);
  }

  start(): void {
    if (config.dryRun) {
      logger.info('[DRY_RUN] fill watcher disabled — strategy relies on simulated/on-chain polling instead.');
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    logger.info('Connecting to RTDS fill feed…');
    const ws = new WebSocket(RTDS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectMs = 2000;
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'trades' }] }));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, PING_INTERVAL_MS);
      logger.success('RTDS fill feed connected.');
    });

    ws.on('message', (raw: RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const payload = (msg.payload ?? msg) as Record<string, unknown>;
        const tokenId = (payload.asset ?? payload.tokenId) as string | undefined;
        if (!tokenId || !this.watchedTokens.has(tokenId)) return;

        const proxyWallet = payload.proxyWallet as string | undefined;
        if (config.proxyWallet && proxyWallet && proxyWallet.toLowerCase() !== config.proxyWallet.toLowerCase()) {
          return;
        }

        this.onFill({
          tokenId,
          side: String(payload.side ?? 'UNKNOWN'),
          size: Number(payload.size ?? 0),
          price: Number(payload.price ?? 0),
          conditionId: payload.conditionId as string | undefined,
        });
      } catch {
        // ignore malformed frames — this feed is advisory only
      }
    });

    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      logger.warn(`RTDS feed closed — reconnecting in ${this.reconnectMs}ms.`);
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
    });

    ws.on('error', (err: Error) => {
      logger.error(`RTDS feed error: ${err.message}`);
    });
  }
}
