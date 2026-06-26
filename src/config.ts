import 'dotenv/config';
import { z } from 'zod';
import type { Duration } from './types.js';

function boolFromEnv(def: boolean) {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : v.trim().toLowerCase() === 'true'));
}

function numFromEnv(def: number) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    });
}

function listFromEnv(def: string[]) {
  return z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
    );
}

const envSchema = z.object({
  PRIVATE_KEY: z.string().optional().default(''),
  PROXY_WALLET_ADDRESS: z.string().optional().default(''),
  SIGNATURE_TYPE: numFromEnv(2),
  POLYGON_RPC_URL: z.string().default('https://polygon-bor-rpc.publicnode.com'),
  CLOB_API_KEY: z.string().optional().default(''),
  CLOB_API_SECRET: z.string().optional().default(''),
  CLOB_API_PASSPHRASE: z.string().optional().default(''),
  DRY_RUN: boolFromEnv(true),
  MM_ASSETS: listFromEnv(['btc', 'eth', 'sol']),
  MM_DURATION: z.enum(['5m', '15m']).default('15m'),
  MM_TRADE_SIZE: numFromEnv(5),
  MM_MAX_COMBINED: numFromEnv(0.98),
  MM_MIN_PRICE: numFromEnv(0.3),
  MM_MAX_PRICE: numFromEnv(0.69),
  MM_ENTRY_WINDOW_SEC: numFromEnv(45),
  MM_CUT_LOSS_SEC: numFromEnv(60),
  MM_REENTRY_ENABLED: boolFromEnv(true),
  MM_REENTRY_DELAY_SEC: numFromEnv(30),
  CURRENT_MARKET_ENABLED: boolFromEnv(true),
  CURRENT_MARKET_MAX_ODDS: numFromEnv(0.7),
  MM_POLL_SEC: numFromEnv(3),
  MM_DETECTOR_POLL_SEC: numFromEnv(5),
  KPI_LOG_PATH: z.string().default('logs/cycles.jsonl'),
});

const parsed = envSchema.parse(process.env);

export const CHAIN_ID = 137;

export const HOSTS = {
  clob: 'https://clob.polymarket.com',
  gamma: 'https://gamma-api.polymarket.com',
  data: 'https://data-api.polymarket.com',
} as const;

/** Polygon mainnet contract addresses used by Polymarket. Fixed — not env-configurable. */
export const CONTRACTS = {
  ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
} as const;

export const config = {
  privateKey: parsed.PRIVATE_KEY,
  proxyWallet: parsed.PROXY_WALLET_ADDRESS,
  signatureType: parsed.SIGNATURE_TYPE,
  polygonRpcUrl: parsed.POLYGON_RPC_URL,
  clobApiKey: parsed.CLOB_API_KEY,
  clobApiSecret: parsed.CLOB_API_SECRET,
  clobApiPassphrase: parsed.CLOB_API_PASSPHRASE,
  dryRun: parsed.DRY_RUN,
  mmAssets: parsed.MM_ASSETS,
  mmDuration: parsed.MM_DURATION as Duration,
  mmTradeSize: parsed.MM_TRADE_SIZE,
  mmMaxCombined: parsed.MM_MAX_COMBINED,
  mmMinPrice: parsed.MM_MIN_PRICE,
  mmMaxPrice: parsed.MM_MAX_PRICE,
  mmEntryWindowSec: parsed.MM_ENTRY_WINDOW_SEC,
  mmCutLossSec: parsed.MM_CUT_LOSS_SEC,
  mmReentryEnabled: parsed.MM_REENTRY_ENABLED,
  mmReentryDelaySec: parsed.MM_REENTRY_DELAY_SEC,
  currentMarketEnabled: parsed.CURRENT_MARKET_ENABLED,
  currentMarketMaxOdds: parsed.CURRENT_MARKET_MAX_ODDS,
  mmPollSec: parsed.MM_POLL_SEC,
  mmDetectorPollSec: parsed.MM_DETECTOR_POLL_SEC,
  kpiLogPath: parsed.KPI_LOG_PATH,
};

/** True once both an EOA private key and a Polymarket proxy wallet address are configured. */
export function hasWallet(): boolean {
  return config.privateKey.length > 0 && config.proxyWallet.length > 0;
}

/** Throws with a readable, aggregated message if the config can't safely run. Call once at boot. */
export function validateRuntimeConfig(): void {
  const errors: string[] = [];

  if (!config.dryRun && !hasWallet()) {
    errors.push('PRIVATE_KEY and PROXY_WALLET_ADDRESS are required when DRY_RUN=false.');
  }
  if (config.privateKey && !/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
    errors.push('PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.');
  }
  if (config.proxyWallet && !/^0x[0-9a-fA-F]{40}$/.test(config.proxyWallet)) {
    errors.push('PROXY_WALLET_ADDRESS must be a 0x-prefixed 20-byte hex address.');
  }
  if (![0, 1, 2].includes(config.signatureType)) {
    errors.push('SIGNATURE_TYPE must be 0 (EOA), 1 (POLY_PROXY) or 2 (POLY_GNOSIS_SAFE).');
  }
  if (config.mmAssets.length === 0) {
    errors.push('MM_ASSETS must list at least one asset.');
  }
  if (config.mmTradeSize < 5) {
    errors.push('MM_TRADE_SIZE must be >= 5 (CLOB minimum order size).');
  }
  if (config.mmMaxCombined <= 0 || config.mmMaxCombined >= 1) {
    errors.push('MM_MAX_COMBINED must be between 0 and 1 (exclusive).');
  }
  if (config.mmMinPrice <= 0 || config.mmMinPrice >= config.mmMaxPrice) {
    errors.push('MM_MIN_PRICE must be > 0 and < MM_MAX_PRICE.');
  }
  if (config.mmCutLossSec < 0) {
    errors.push('MM_CUT_LOSS_SEC must be >= 0.');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}
