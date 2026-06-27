// Domain types shared across the detector, strategy, and KPI logger.

export type Asset = string; // 'btc' | 'eth' | 'sol' | 'xrp' ... kept open, Polymarket adds assets over time
export type Duration = "5m" | "15m";
export type SideName = "yes" | "no";

/** Normalized view of a Polymarket "{asset}-updown-{duration}-{ts}" market, from Gamma API. */
export interface MarketInfo {
  asset: Asset;
  duration: Duration;
  slug: string;
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  negRisk: boolean;
  tickSize: number;
  minOrderSize: number;
  /** Unix seconds. */
  eventStartTime: number;
  /** Unix seconds. */
  endTime: number;
}

/** Per-side (YES or NO) order/fill bookkeeping within an active cycle. */
export interface SideState {
  side: SideName;
  tokenId: string;
  entryPrice: number;
  targetShares: number;
  orderId: string | null;
  filled: boolean;
  filledShares: number;
  /** On-chain ERC-1155 balance (as a decimal string) snapshotted before the order was placed. */
  baselineBalance: string;
}

export type CycleStatus =
  | "entering"
  | "monitoring"
  | "merging"
  | "recovering"
  | "cut_loss"
  | "done";

/** Live state for one maker-merge cycle on one market. */
export interface Position {
  market: MarketInfo;
  startedAt: number; // ms epoch
  status: CycleStatus;
  yes: SideState;
  no: SideState;
  firstFillAt: number | null;
  ghostFillSuspectedAt: number | null;
  realizedPnl: number;
}

/** One row written to the KPI log (JSONL) per completed cycle. This is the data the
 * Medium-post critique says the reference bot never tracked: both-fill rate over time. */
export interface CycleRecord {
  ts: string; // ISO timestamp at cycle close
  asset: Asset;
  duration: Duration;
  conditionId: string;
  slug: string;
  /** Minutes elapsed since market open when the entry orders were placed (0..duration-1). */
  minuteBucket: number;
  yesEntryPrice: number;
  noEntryPrice: number;
  combined: number;
  targetShares: number;
  bothFilled: boolean;
  oneSided: boolean;
  ghostFill: boolean;
  cutLoss: boolean;
  timeToFillMs: number | null;
  pnl: number;
  /** Real Polygon gas cost of the merge tx, in USD, already subtracted from `pnl`. Always 0
   * in DRY_RUN (no real tx) and also 0 for cycles that never reached a merge (one-sided /
   * cut-loss exits never call mergePositions). */
  gasCostUsd: number;
  dryRun: boolean;
}
