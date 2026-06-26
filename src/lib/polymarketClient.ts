// Thin wrapper around @polymarket/clob-client. Builds either:
//  - a fully authenticated client (when PRIVATE_KEY + PROXY_WALLET_ADDRESS are set), or
//  - a public, read-only client (price/orderbook reads only, no signer/creds) when they aren't.
// The public mode lets you exercise the detector + entry-pricing logic against live
// markets in DRY_RUN before you've ever touched a wallet.

import { ethers } from "ethers";
import { ClobClient, Chain, Side, OrderType } from "@polymarket/clob-client";
import type { ApiKeyCreds, OpenOrder, TickSize } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";

import { config, hasWallet, HOSTS, CHAIN_ID, CONTRACTS } from "../config.js";
import { logger } from "../logger.js";

let provider: ethers.providers.JsonRpcProvider | null = null;
let signer: ethers.Wallet | null = null;
let client: ClobClient | null = null;

export function getPolygonProvider(): ethers.providers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.providers.JsonRpcProvider(
      config.polygonRpcUrl,
      CHAIN_ID,
    );
  }
  return provider;
}

export function getSigner(): ethers.Wallet {
  if (!signer) {
    if (!config.privateKey) {
      throw new Error("PRIVATE_KEY is not set — cannot create a signer.");
    }
    signer = new ethers.Wallet(config.privateKey, getPolygonProvider());
  }
  return signer;
}

/**
 * NOTE on signature types (see @polymarket/order-utils SignatureType enum):
 *   EOA = 0, POLY_PROXY = 1, POLY_GNOSIS_SAFE = 2.
 * Most Polymarket accounts (created via email / Magic-link) are backed by a Gnosis Safe,
 * which is signature type 2. Accounts created by connecting MetaMask directly use type 1.
 * Double check this against SIGNATURE_TYPE in your .env before going live.
 */
function signatureTypeFromConfig(): SignatureType {
  switch (config.signatureType) {
    case 0:
      return SignatureType.EOA;
    case 1:
      return SignatureType.POLY_PROXY;
    default:
      return SignatureType.POLY_GNOSIS_SAFE;
  }
}

/** Idempotent — safe to call multiple times, only builds the client once. */
export async function initClient(): Promise<ClobClient> {
  if (client) return client;

  if (!hasWallet()) {
    logger.warn(
      "No PRIVATE_KEY/PROXY_WALLET_ADDRESS configured — running in public read-only mode " +
        "(price/orderbook reads only, no order placement).",
    );
    client = new ClobClient(HOSTS.clob, Chain.POLYGON);
    return client;
  }

  const wallet = getSigner();
  const sigType = signatureTypeFromConfig();

  let creds: ApiKeyCreds;
  if (config.clobApiKey && config.clobApiSecret && config.clobApiPassphrase) {
    creds = {
      key: config.clobApiKey,
      secret: config.clobApiSecret,
      passphrase: config.clobApiPassphrase,
    };
  } else {
    // Bootstrap client with just a signer (no creds yet) to create-or-derive API credentials.
    const bootstrap = new ClobClient(HOSTS.clob, Chain.POLYGON, wallet);
    creds = await bootstrap.createOrDeriveApiKey();
    logger.info("Derived CLOB API credentials from PRIVATE_KEY (L1 auth).");
  }

  client = new ClobClient(
    HOSTS.clob,
    Chain.POLYGON,
    wallet,
    creds,
    sigType,
    config.proxyWallet,
  );
  logger.success(
    `CLOB client ready (signatureType=${sigType}, funder=${config.proxyWallet}).`,
  );
  return client;
}

export function getClient(): ClobClient {
  if (!client) {
    throw new Error("CLOB client not initialized — call initClient() first.");
  }
  return client;
}

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

/** Raw USDC.e balance (6 decimals) for the given address, as a bigint of base units. */
export async function getUsdcBalance(address: string): Promise<bigint> {
  const erc20 = new ethers.Contract(
    CONTRACTS.usdc,
    ERC20_ABI,
    getPolygonProvider(),
  );
  const bal: ethers.BigNumber = await erc20.balanceOf(address);
  return BigInt(bal.toString());
}

export function formatUsdc(raw: bigint): string {
  return ethers.utils.formatUnits(raw.toString(), 6);
}

// ── Price reads ──────────────────────────────────────────────────────────────
// Public GET endpoints — work even in the no-wallet read-only client. Convention:
// getPrice(token, 'BUY')  = price you'd pay buying right now  = best ASK
// getPrice(token, 'SELL') = price you'd receive selling right now = best BID
// We post our maker buy AT the best bid: that's the most aggressive price that still
// rests in the book without crossing the spread (i.e. still a genuine maker order).

function toNumber(res: unknown): number {
  if (typeof res === "number") return res;
  if (typeof res === "string") return Number(res);
  if (res && typeof res === "object") {
    const obj = res as Record<string, unknown>;
    const val = obj.price ?? obj.midpoint ?? obj.mid;
    if (val !== undefined) return Number(val);
  }
  throw new Error(`Unexpected price response shape: ${JSON.stringify(res)}`);
}

export async function getBestBid(tokenId: string): Promise<number> {
  const res = await getClient().getPrice(tokenId, "SELL");
  return toNumber(res);
}

export async function getBestAsk(tokenId: string): Promise<number> {
  const res = await getClient().getPrice(tokenId, "BUY");
  return toNumber(res);
}

export async function getMidpoint(tokenId: string): Promise<number> {
  const res = await getClient().getMidpoint(tokenId);
  return toNumber(res);
}

const VALID_TICKS: TickSize[] = ["0.1", "0.01", "0.001", "0.0001"];

export function tickSizeToOption(tick: number): TickSize {
  const asStr = VALID_TICKS.find((t) => Math.abs(Number(t) - tick) < 1e-9);
  if (!asStr) {
    logger.warn(`Unrecognized tick size ${tick}, defaulting to 0.01.`);
    return "0.01";
  }
  return asStr;
}

/** Rounds a price down to the nearest valid tick — never round UP a buy price, that would
 * mean paying more than intended. */
export function floorToTick(price: number, tick: number): number {
  const ticks = Math.floor(price / tick + 1e-9);
  return Math.round(ticks * tick * 1e8) / 1e8;
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface PlaceOrderResult {
  orderId: string;
  dryRun: boolean;
}

/** Places a resting (GTC) maker BUY limit order. DRY_RUN-safe: returns a synthetic order id
 * and never touches the live CLOB order endpoints. */
export async function placeMakerBuy(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
): Promise<PlaceOrderResult> {
  if (config.dryRun) {
    const orderId = `SIM-${tokenId.slice(-8)}-${Date.now()}`;
    logger.trade(
      `[DRY_RUN] would place GTC BUY ${shares} @ ${price} on token …${tokenId.slice(-8)}`,
    );
    return { orderId, dryRun: true };
  }
  const resp = await getClient().createAndPostOrder(
    { tokenID: tokenId, price, size: shares, side: Side.BUY },
    { tickSize: tickSizeToOption(tickSize), negRisk: false },
    OrderType.GTC,
  );
  const orderId: string | undefined =
    resp?.orderID ?? resp?.orderId ?? resp?.id;
  if (!orderId) {
    throw new Error(
      `createAndPostOrder returned no order id: ${JSON.stringify(resp)}`,
    );
  }
  logger.trade(`Placed GTC BUY ${shares} @ ${price} -> order ${orderId}`);
  return { orderId, dryRun: false };
}

/** Market-sells `shares` of `tokenId` (FOK). Used only for ghost-fill recovery — selling off
 * an unwanted one-sided remainder, never to "dump" the expensive side at a guaranteed loss. */
export async function marketSell(
  tokenId: string,
  shares: number,
): Promise<PlaceOrderResult> {
  if (config.dryRun) {
    const orderId = `SIM-SELL-${tokenId.slice(-8)}-${Date.now()}`;
    logger.trade(
      `[DRY_RUN] would market-SELL ${shares} of token …${tokenId.slice(-8)}`,
    );
    return { orderId, dryRun: true };
  }
  const resp = await getClient().createAndPostMarketOrder(
    {
      tokenID: tokenId,
      amount: shares,
      side: Side.SELL,
      orderType: OrderType.FOK,
    },
    { tickSize: "0.01", negRisk: false },
  );
  const orderId: string | undefined =
    resp?.orderID ?? resp?.orderId ?? resp?.id;
  logger.trade(
    `Market-sold ${shares} of token …${tokenId.slice(-8)} -> order ${orderId ?? "(no id returned)"}`,
  );
  return { orderId: orderId ?? `UNKNOWN-${Date.now()}`, dryRun: false };
}

export async function cancelOrder(orderId: string): Promise<void> {
  if (config.dryRun || orderId.startsWith("SIM-")) {
    logger.info(`[DRY_RUN] would cancel order ${orderId}`);
    return;
  }
  await getClient().cancelOrder({ orderID: orderId });
  logger.info(`Cancelled order ${orderId}`);
}

/** Live order status from the CLOB — useful as a *signal*, never as the sole truth (see
 * ghost-fill handling in the strategy, which always cross-checks on-chain balance). */
export async function getOrderStatus(
  orderId: string,
): Promise<OpenOrder | null> {
  if (config.dryRun || orderId.startsWith("SIM-")) return null;
  try {
    return await getClient().getOrder(orderId);
  } catch {
    return null; // order no longer open (filled or cancelled) — caller should check balance
  }
}
