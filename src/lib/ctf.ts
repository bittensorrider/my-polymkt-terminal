// On-chain operations against the ConditionalTokens (CTF) contract, executed through the
// user's Gnosis Safe proxy wallet (Polymarket's standard account type for email/Magic-link
// logins — see SIGNATURE_TYPE note in polymarketClient.ts).
//
// Every mutating call funnels through execSafeCall(), which:
//   1. short-circuits to a logged no-op when DRY_RUN=true (no signer/funds required), and
//   2. otherwise serializes Safe transactions through a promise queue so the Safe's nonce
//      is never raced across concurrent calls (e.g. approving USDC while also merging).
//
// negRisk markets (multi-outcome events wrapped by Polymarket's NegRiskAdapter) need a
// different split/merge/redeem path that this build does not implement — the in-scope
// BTC/ETH/SOL/XRP Up-or-Down 5m/15m markets are standalone binary conditions (negRisk=false),
// confirmed live against the Gamma API, so this should never trigger in normal operation.

import { ethers } from 'ethers';
import { config, CONTRACTS } from '../config.js';
import { getPolygonProvider, getSigner } from './polymarketClient.js';
import { logger } from '../logger.js';

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const PARTITION = [1, 2]; // index sets for a binary condition's two outcome slots
const USDC_DECIMALS = 6;
export const MIN_SHARES_PER_SIDE = 2.5;

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
];

const CTF_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ctfInterface = new ethers.utils.Interface(CTF_ABI);
const erc20Interface = new ethers.utils.Interface(ERC20_ABI);

function ctfRead(): ethers.Contract {
  return new ethers.Contract(CONTRACTS.ctf, CTF_ABI, getPolygonProvider());
}

function usdcRead(): ethers.Contract {
  return new ethers.Contract(CONTRACTS.usdc, ERC20_ABI, getPolygonProvider());
}

function assertNotNegRisk(negRisk: boolean, op: string): void {
  if (negRisk) {
    throw new Error(
      `${op}: refusing to act — this market is flagged negRisk=true. NegRiskAdapter ` +
        'split/merge/redeem is not implemented in this build. The in-scope crypto Up-or-Down ' +
        'markets should never be negRisk; investigate before trading this market.'
    );
  }
}

// ── Gnosis Safe execution queue ─────────────────────────────────────────────

export interface SafeCallResult {
  dryRun: boolean;
  txHash: string;
}

let txQueue: Promise<unknown> = Promise.resolve();

/** Routes `to`/`data` through the user's Safe via execTransaction. DRY_RUN-safe. */
export async function execSafeCall(to: string, data: string, description: string): Promise<SafeCallResult> {
  if (config.dryRun) {
    logger.info(`[DRY_RUN] would execute Safe call: ${description}`);
    return { dryRun: true, txHash: `SIM-${Date.now()}-${Math.floor(Math.random() * 1e6)}` };
  }

  const run = txQueue.then(() => doExecSafeCall(to, data, description));
  txQueue = run.catch(() => undefined); // never let one failure poison later queued calls
  return run;
}

async function doExecSafeCall(to: string, data: string, description: string): Promise<SafeCallResult> {
  const signer = getSigner();
  const safe = new ethers.Contract(config.proxyWallet, SAFE_ABI, signer);

  const value = 0;
  const operation = 0; // Call
  const safeTxGas = 0;
  const baseGas = 0;
  const gasPrice = 0;
  const gasToken = ethers.constants.AddressZero;
  const refundReceiver = ethers.constants.AddressZero;

  const nonce = await safe.nonce();
  const txHash: string = await safe.getTransactionHash(
    to,
    value,
    data,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    nonce
  );

  // Sign the raw Safe transaction digest directly (no EIP-191 personal-sign prefix). This is
  // the standard ECDSA path the Safe contract's signature check expects (recovers v in {27,28}
  // straight off `to.recover(safeTxHash, signature)`), and is the on-chain analogue of
  // SignatureType.POLY_GNOSIS_SAFE used for order signing.
  const signingKey = new ethers.utils.SigningKey(signer.privateKey);
  const sig = signingKey.signDigest(txHash);
  const signature = ethers.utils.joinSignature(sig);

  logger.trade(`Submitting Safe tx: ${description}`);
  let tx: ethers.providers.TransactionResponse;
  try {
    tx = await safe.execTransaction(
      to,
      value,
      data,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      signature
    );
  } catch (err) {
    throw new Error(`Safe execTransaction failed (${description}): ${errMsg(err)}`);
  }
  const receipt = await tx.wait();
  logger.success(`Safe tx confirmed: ${description} (${receipt.transactionHash})`);
  return { dryRun: false, txHash: receipt.transactionHash };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Approvals (cached per-process; real check skipped entirely in DRY_RUN) ────

const approvedSpenders = new Set<string>();
const approvedOperators = new Set<string>();

export async function ensureUsdcApproval(spender: string): Promise<void> {
  if (config.dryRun || approvedSpenders.has(spender)) return;

  const allowance: ethers.BigNumber = await usdcRead().allowance(config.proxyWallet, spender);
  if (allowance.gte(ethers.utils.parseUnits('1000000', USDC_DECIMALS))) {
    approvedSpenders.add(spender);
    return;
  }
  const data = erc20Interface.encodeFunctionData('approve', [spender, ethers.constants.MaxUint256]);
  await execSafeCall(CONTRACTS.usdc, data, `approve USDC spend for ${spender}`);
  approvedSpenders.add(spender);
}

export async function ensureCtfApproval(operator: string): Promise<void> {
  if (config.dryRun || approvedOperators.has(operator)) return;

  const isApproved: boolean = await ctfRead().isApprovedForAll(config.proxyWallet, operator);
  if (isApproved) {
    approvedOperators.add(operator);
    return;
  }
  const data = ctfInterface.encodeFunctionData('setApprovalForAll', [operator, true]);
  await execSafeCall(CONTRACTS.ctf, data, `setApprovalForAll(CTF -> ${operator}, true)`);
  approvedOperators.add(operator);
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** ERC-1155 outcome-token balance for `owner`. Source of truth for fill detection —
 * always prefer this over CLOB order status, which can report "ghost fills" that never
 * actually settle on-chain. */
export async function getConditionalTokenBalance(owner: string, tokenId: string): Promise<bigint> {
  if (!owner) return 0n;
  const bal: ethers.BigNumber = await ctfRead().balanceOf(owner, tokenId);
  return BigInt(bal.toString());
}

export async function isResolved(conditionId: string): Promise<boolean> {
  if (config.dryRun && !config.proxyWallet) return false;
  const denom: ethers.BigNumber = await ctfRead().payoutDenominator(conditionId);
  return !denom.isZero();
}

// ── Mutations ───────────────────────────────────────────────────────────────

export async function splitPosition(
  conditionId: string,
  amountUsdcPerSide: number,
  negRisk: boolean
): Promise<SafeCallResult> {
  assertNotNegRisk(negRisk, 'splitPosition');
  if (amountUsdcPerSide < MIN_SHARES_PER_SIDE) {
    throw new Error(`splitPosition amount ${amountUsdcPerSide} is below the ${MIN_SHARES_PER_SIDE} minimum.`);
  }
  await ensureUsdcApproval(CONTRACTS.ctf);
  const amount = ethers.utils.parseUnits(amountUsdcPerSide.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  const data = ctfInterface.encodeFunctionData('splitPosition', [
    CONTRACTS.usdc,
    ZERO_BYTES32,
    conditionId,
    PARTITION,
    amount,
  ]);
  return execSafeCall(CONTRACTS.ctf, data, `splitPosition ${amountUsdcPerSide} USDC on ${shortId(conditionId)}`);
}

/** Merges an equal number of YES+NO shares back into USDC at $1.00/pair. Floors to USDC
 * precision before parsing so we never ask to merge a hair more than what's actually held
 * on-chain (which would revert) due to floating-point rounding up. */
export async function mergePositions(
  conditionId: string,
  sharesPerSide: number,
  negRisk: boolean
): Promise<SafeCallResult> {
  assertNotNegRisk(negRisk, 'mergePositions');
  const floored = Math.floor(sharesPerSide * 10 ** USDC_DECIMALS) / 10 ** USDC_DECIMALS;
  if (floored <= 0) {
    throw new Error(`mergePositions amount rounds to 0 (input ${sharesPerSide}).`);
  }
  const amount = ethers.utils.parseUnits(floored.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  const data = ctfInterface.encodeFunctionData('mergePositions', [
    CONTRACTS.usdc,
    ZERO_BYTES32,
    conditionId,
    PARTITION,
    amount,
  ]);
  return execSafeCall(CONTRACTS.ctf, data, `mergePositions ${floored} shares/side on ${shortId(conditionId)}`);
}

export async function redeemPositions(conditionId: string, negRisk: boolean): Promise<SafeCallResult> {
  assertNotNegRisk(negRisk, 'redeemPositions');
  if (!config.dryRun) {
    const resolved = await isResolved(conditionId);
    if (!resolved) {
      throw new Error(`redeemPositions: market ${shortId(conditionId)} is not resolved yet.`);
    }
  }
  const data = ctfInterface.encodeFunctionData('redeemPositions', [
    CONTRACTS.usdc,
    ZERO_BYTES32,
    conditionId,
    PARTITION,
  ]);
  return execSafeCall(CONTRACTS.ctf, data, `redeemPositions on ${shortId(conditionId)}`);
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}
