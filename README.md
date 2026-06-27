# my-polymkt-terminal

A maker-merge market maker for Polymarket's 5m/15m crypto Up-or-Down markets, written in TypeScript. Defaults to BTC/ETH (SOL/XRP are supported but trade much thinner — see [Asset selection](#asset-selection)).

Built by @bittensorrider, inspired by the Medium post [A Polymarket Terminal That Works](https://medium.com/readers-club/a-polymarket-terminal-that-works-f257c952503a) and the [direkturcrypto/polymarket-terminal](https://github.com/direkturcrypto/polymarket-terminal) reference implementation — reimplemented from scratch in this repo rather than copied, with a few fixes and design changes noted below.

**Status: dry-run / simulation only.** No live order placement or on-chain transactions have been exercised against real funds. Treat everything here as unaudited.

## Strategy: maker-merge MM

Each 5m/15m Up-or-Down market settles to exactly one of YES/NO. The bot:

1. Watches the order book on both YES and NO right after a market opens.
2. Once `yesBid + noBid <= MM_MAX_COMBINED` (default 0.98) and both bids sit inside `[MM_MIN_PRICE, MM_MAX_PRICE]`, posts a maker-only GTC BUY limit order on **both sides at once**, same share count each.
3. If both fill, merges the pair back into USDC via the CTF contract (`mergePositions`) — this redeems 1 YES + 1 NO share for $1 regardless of outcome, so the captured edge is `1 - combined` per share, before gas.
4. If only one side fills, waits; if neither/only-one has filled by `MM_CUT_LOSS_SEC` before close, cancels open orders and market-sells whatever filled to flatten exposure before the market resolves.

Orders are placed once and never repriced (no cancel/replace loop) — this avoids a class of bugs around cancelled-but-already-filled orders and double exposure. The tradeoff is you'll miss some entries; that's intentional.

### Why "both-fill rate" is the metric that matters

A single maker fill with no merge isn't a market-neutral position — it's a naked directional bet you didn't mean to take. The Medium post's core critique of the reference bot is that it doesn't track this, so a high-looking win rate can hide a strategy that's actually bleeding on one-sided fills. This bot logs every entered cycle to `logs/cycles.jsonl` and `npm run kpi-report` computes:

- both-fill rate (the only thing that earns the spread)
- a break-even both-fill rate, derived the same way the post does: `p* = loss / (good + loss)`, using your actual logged average P&L for both-filled vs. not-both-filled cycles
- per-asset and per-entry-minute breakdowns, to spot whether late entries into a slot fill worse than early ones

Run this regularly while in `DRY_RUN` before ever considering going live.

## Fill detection: on-chain balance is the source of truth

The CLOB can report an order as filled while the corresponding on-chain settlement never lands (a "ghost fill"). This bot never trusts CLOB order status alone for live trading — it polls the actual ERC-1155 conditional-token balance and only marks a side filled once the balance moved. If CLOB says an order is no longer open but the balance hasn't changed, it logs a `ghostFill` flag and keeps watching the chain rather than assuming the fill happened.

The RTDS websocket feed (`wss://ws-live-data.polymarket.com`) is wired in but used purely as a wake-up signal to poll sooner — never as proof of a fill. It's disabled entirely in `DRY_RUN`.

In `DRY_RUN`, there are no real orders to check on-chain, so fills are simulated: a side is marked "filled" once the live best ask reaches your resting bid price. This is a proxy using real order-flow, clearly logged as simulated, not a guarantee that a real order would have filled at that size.

## Signature type — a bug fix vs. the reference repo

Polymarket's `@polymarket/order-utils` defines `SignatureType { EOA = 0, POLY_PROXY = 1, POLY_GNOSIS_SAFE = 2 }` (confirmed by reading the package source directly). The reference repo's code comments mislabel value `2` as `POLY_PROXY` — it's actually `POLY_GNOSIS_SAFE`. Standard Polymarket email/Magic-link accounts are Gnosis Safe proxy wallets, so they need `2`. This bot uses the real enum constants (never magic numbers) and defaults `SIGNATURE_TYPE` to `2` with an explanation in `.env.example`. Use `1` only if your Polymarket account was created by connecting MetaMask directly.

## Two-leg order placement is atomic-by-design, not just "fire and hope"

Entering both legs with a plain `Promise.all` has a failure mode: if one `placeMakerBuy` resolves (a real resting order is now live on the CLOB) while the other rejects, `Promise.all` rejects immediately and the successful order's id is never captured — leaving a live, completely untracked order on the book that nothing will ever watch, cancel, or merge. This came up while cross-checking the bot against the "two-leg atomicity" / "exposure gate" guidance in the Medium post [Building a Profitable Polymarket Arbitrage System](https://medium.com/readers-club/building-a-profitable-polymarket-and-kalshi-arbitrage-system-32a224297488).

`runCycle()` now places both legs through `placeBothLegs()` (`src/strategies/makerMergeMM.ts`), which uses `Promise.allSettled`:

- both legs placed → proceed as before.
- both legs fail → throw, nothing was ever live.
- exactly one leg placed → immediately best-effort cancel it, then throw. A naked, unmonitored resting order is worse than abandoning the cycle outright.

`runCycle()` also now wraps its post-entry body in try/catch so any error past this point clears the dashboard's position card for that asset instead of leaving a stale "waiting_entry"/"monitoring" entry behind.

The same Medium post's other flagged concern — hardcoding `feeRateBps` instead of fetching the live per-market rate — turned out not to apply here: `@polymarket/clob-client`'s `createOrder()` always resolves the live fee rate via `getFeeRateBps()` and overwrites whatever (if anything) was passed in, so this bot was already safe on that front with no code change needed.

Note this new failure path is unreachable in `DRY_RUN` — `placeMakerBuy()`'s dry-run branch always resolves, never rejects — so it only takes effect once `DRY_RUN=false` and you're placing real orders.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — defaults are safe to run as-is (DRY_RUN=true, no wallet needed)
npm run dev:sim     # or: npm run dev  (same thing while DRY_RUN=true)
```

`PRIVATE_KEY` / `PROXY_WALLET_ADDRESS` are optional while `DRY_RUN=true` — the bot runs against the public, unauthenticated Gamma/CLOB read endpoints (`getPrice`/`getMidpoint`) and never needs to place a real order. They become required once `DRY_RUN=false`.

### Going live (not recommended yet)

This has not been run against real funds. If you do anyway: set `PRIVATE_KEY`, `PROXY_WALLET_ADDRESS`, confirm `SIGNATURE_TYPE`, set `DRY_RUN=false`, and start with `MM_TRADE_SIZE` at the 5-share CLOB minimum. The bot will derive CLOB API credentials from your key automatically if `CLOB_API_KEY/SECRET/PASSPHRASE` are left blank.

## Dashboard

A local web dashboard starts automatically alongside the bot (`DASHBOARD_ENABLED=true` by default) at **http://127.0.0.1:3000**. It shows, live:

- per-asset cycle status (waiting for entry / monitoring / done / cut-loss), YES/NO entry prices and fill state, time remaining before cut-loss
- a queued-next badge if a market is waiting because a cycle is already running for that asset
- live **BTC/ETH price charts** (candlestick or line, with a 1m/5m/15m/1h timeframe picker) for visual context next to the up/down markets
- a **Balance** panel: your running cumulative P&L across all logged cycles, both as a number and as an inline trend chart (hand-drawn SVG — no charting library), plus your live on-chain USDC wallet balance and its change since the dashboard started
- the same both-fill-rate / breakeven KPI numbers as `npm run kpi-report`, computed by the same shared code so they always agree
- the last 50 completed cycles

### Price charts

The BTC/ETH chart panel is the one part of the dashboard that needs internet access — it loads [TradingView's lightweight-charts](https://github.com/tradingview/lightweight-charts) from a CDN (`unpkg.com`) in the browser, and the dashboard server's `GET /api/prices?asset=&interval=&limit=` route proxies candle data from Binance's public REST API (no key needed, briefly cached server-side so switching timeframes or having multiple tabs open doesn't multiply requests). Everything else on the page — controls, balance, KPI summary, recent cycles — still works with zero internet access; only this panel shows an error if the CDN script or Binance is unreachable.

This is display-only context for whichever crypto markets you're watching — the strategy itself never reads this feed, it only ever looks at Polymarket's own CLOB bid/ask. Switching chart type or timeframe re-renders from already-fetched candles instantly except when changing timeframe (which re-fetches); the panel otherwise auto-refreshes every 10 seconds.

### Balance panel

The cumulative P&L number and chart are computed from `KPI_LOG_PATH` — the same source `npm run kpi-report` reads — so they cover every cycle ever logged, not just what's happened since the dashboard started. While `DRY_RUN=true` this is simulated P&L, clearly labeled as such.

The live USDC balance is a real on-chain read (`balanceOf` on the USDC contract for `PROXY_WALLET_ADDRESS`) and needs only that address — **no `PRIVATE_KEY` required** — so it works even if you've only filled in your wallet address to watch your balance, before ever deciding to trade live. It's polled on its own 15-second interval (separate from the 1-second live-state updates) to avoid hammering the RPC endpoint, and shows a Δ against the balance first seen after the dashboard booted. If `PROXY_WALLET_ADDRESS` is blank, this section just explains how to enable it; if the RPC read fails, the panel shows the error rather than a stale or fake number.

Controls are deliberately limited to **pause / resume / stop** — there's no live parameter tuning. Asset list, duration, and all risk settings (`MM_*`) stay in `.env` and only take effect on restart, so the strategy logic itself is never touched from the browser.

- **Pause** stops the bot from entering any *new* cycle (including queued re-entries); anything already in flight keeps running to its normal merge or cut-loss exit. It does not cancel orders or flatten positions.
- **Resume** clears the pause.
- **Stop** exits the process immediately — the same as `Ctrl+C`. It does not wait for an in-flight cycle to finish or attempt to flatten exposure first; if a cycle is open when you click it, it's abandoned mid-monitoring, identical to killing the process from the terminal today. The dashboard's confirmation dialog spells this out.

  **If you launched with `npm run dev` / `dev:sim` / `dev:sim:5m`:** those run the bot under `tsx watch`, a file-watcher wrapper. Stop still fully kills the bot itself — dashboard, detector, strategy loop all exit, the port is released — but `tsx watch`'s own wrapper process stays alive afterward (it's a watcher; its only job is waiting for file changes, and it has no flag to exit when its child exits cleanly). That's the process you still see sitting in your terminal — one `Ctrl+C` there closes it. Run with `npm run build && npm run start:sim` (or `npm start`) instead if you want Stop alone to fully return your terminal prompt.

**Security note:** the pause/resume/stop endpoints have no authentication. The dashboard binds to `127.0.0.1` only by default specifically because of that — do not set `DASHBOARD_HOST` to `0.0.0.0` or any public interface unless you put your own auth/proxy in front of it, since anyone who can reach the port can stop the bot. Set `DASHBOARD_ENABLED=false` to turn it off entirely. `DASHBOARD_PORT` defaults to `3000` (the `.env.5m` profile uses `3001` so both can run side by side).

## Asset selection

Polymarket runs the same Up-or-Down format on four assets: BTC, ETH, SOL, XRP. Only **BTC/ETH are enabled** — `MM_ASSETS=sol` or `xrp` fails config validation on boot (`SUPPORTED_ASSETS` in `src/config.ts`) rather than silently running on a thin market. This is a deliberate gate, not just a default, because a live spot check of the currently-open 15m markets (2026-06-26) showed:

| Asset | Volume (this market so far) | Liquidity | Spread |
| ----- | --------------------------- | --------- | ------ |
| BTC   | $9,745                      | $10,413   | 1¢     |
| ETH   | $968                        | $3,607    | 1¢     |
| XRP   | $271                        | $1,420    | 1¢     |
| SOL   | $58                         | $1,766    | 1¢     |

Spreads were tight across the board (Polymarket's market-maker rewards program keeps quoted liquidity present on all four), but SOL and XRP saw 15–35x less actual trading volume than BTC in that window. Maker-merge MM earns its edge from taker flow crossing into your resting bid on _both_ sides — thin volume means fewer takers to cross, which means a lower both-fill rate, which is the metric the whole KPI system above exists to catch. This was one snapshot, not a rigorous study, but it's consistent with BTC/ETH being the dominant pairs everywhere else in crypto.

SOL/XRP support still exists in the code (slug-building, pricing, fills — none of it is BTC/ETH-specific); it's just switched off at `SUPPORTED_ASSETS`. Re-enable by adding them to that list once you actually want to trade them.

## 5-minute markets

The bot defaults to `MM_DURATION=15m`, since that's what's been validated. Polymarket also runs the identical Up-or-Down format at 5-minute intervals, and the bot fully supports it (`MM_DURATION=5m` — `marketDetector.ts` derives the 300s window from this, nothing is hardcoded to 15m), but it hasn't been run there yet, for a timing reason rather than a liquidity one.

A live spot check (2026-06-26) found 5m BTC/ETH liquidity ($18–22k BTC, $3–9k ETH) comparable to or better than 15m, with the same fee schedule — so unlike SOL/XRP, thin liquidity isn't the concern. The concern is that `MM_ENTRY_WINDOW_SEC` and `MM_CUT_LOSS_SEC` are fixed in absolute seconds, not scaled to market duration. The 15m defaults (45s entry, 60s cut-loss) spend ~12% of a 900s window on entry/exit guardrails, leaving ~87% to land a both-fill. Applied unchanged to a 300s market, the same constants spend ~38% of the window, leaving only ~62% — a meaningfully smaller margin for catching both sides before price moves. And price moves just as far on 5m as on 15m, just compressed into a third of the time, which is exactly the combination that drags down both-fill rate.

To test this rather than guess: `.env.5m.example` is a second profile with `MM_DURATION=5m` and tightened timing (`MM_ENTRY_WINDOW_SEC=20`, `MM_CUT_LOSS_SEC=25`) sized proportionally to the shorter window, plus its own KPI log so it never mixes with the 15m baseline.

```bash
cp .env.5m.example .env.5m
npm run dev:sim:5m     # dry-run against the 5m profile
npm run kpi-report:5m  # both-fill rate for this profile's own log
```

Compare its both-fill rate against your 15m baseline (`npm run kpi-report`) before considering 5m for anything beyond `DRY_RUN`.

## Scope and limitations

- Only the maker-merge MM strategy is implemented (no copy-trading, no orderbook sniping).
- Only non-negRisk markets are supported. The crypto Up-or-Down markets in scope here (BTC/ETH/SOL/XRP) are confirmed not negRisk; the bot throws a clear error rather than silently mis-trading if it ever encounters one.
- One condition/market cycle runs at a time per asset; a newly detected slot for a busy asset is queued and picked up after the current cycle ends.
- No automated tests yet — verification so far is `tsc --noEmit`, a full build, and a boot smoke-test (config validation → public-mode client init → detector start → clean shutdown). Logic has not been exercised against a live market.

## Project layout

```
src/
  config.ts            env parsing/validation (zod)
  types.ts             shared types incl. the KPI CycleRecord shape
  logger.ts            leveled console logger
  lib/
    polymarketClient.ts  CLOB client init, price reads, order placement (DRY_RUN-safe)
    ctf.ts               on-chain split/merge/redeem + Gnosis Safe tx signing/execution
    marketDetector.ts     polls Gamma API for the next/current market slug per asset
    fillWatcher.ts         RTDS websocket — advisory wake-up signal only
    kpiLogger.ts           appends one JSONL row per entered cycle
    kpiStats.ts            both-fill-rate/breakeven math, shared by kpi-report and the dashboard
    botState.ts            in-memory live state + pause flag the dashboard reads/controls
    dashboardServer.ts      embedded HTTP+WebSocket server for the web dashboard
    util.ts
  dashboard/
    page.ts                single-file dashboard HTML/CSS/JS, served as a string (no build step)
  strategies/
    makerMergeMM.ts       the strategy itself
  scripts/
    kpiReport.ts          npm run kpi-report — both-fill rate vs. breakeven
  index.ts                wires it all together
```

## Disclaimer

This is a personal project, not financial advice, and trades on Polymarket carry real risk of loss (smart contract risk, market risk, and bugs in this code). Nothing here has been security-audited. Use at your own risk, and don't run real funds through it until you've validated the KPI logs extensively in `DRY_RUN`.
