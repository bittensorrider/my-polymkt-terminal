// Single-file vanilla HTML/CSS/JS dashboard page, served as a plain string by
// dashboardServer.ts. No build step — ships as part of the normal tsc build with zero extra
// steps (see NOTE below for why this lives in a .ts file instead of a .html one).
//
// DEPENDENCIES: the price-chart panel loads TradingView's lightweight-charts from a CDN
// (unpkg), and the server-side /api/prices route it talks to calls Binance's public REST
// API. Both need outbound internet access from the machine running the dashboard. Nothing
// else on this page does — control buttons, balance, KPI summary, and recent cycles all keep
// working with no internet at all; only the chart panel degrades (shows an error) if either
// is unreachable. Price data is for visual context only — the strategy never reads it.
//
// NOTE: this file is a .ts module (not raw .html) specifically so it gets compiled into
// dist/ automatically alongside everything else — `tsc` only emits .ts -> .js, it does not
// copy static assets, so embedding the markup as a string constant avoids needing a
// separate asset-copy step in the build.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>my-polymkt-terminal</title>
<script src="https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js"></script>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #141821;
    --panel-2: #1a1f29;
    --border: #2a3140;
    --border-soft: rgba(255, 255, 255, 0.06);
    --text: #e8edf4;
    --dim: #8b96a5;
    --dim-2: #5d6776;
    --blue: #5b9dff;
    --green: #2ecf75;
    --amber: #f0a93c;
    --red: #ff5d5d;
    --btc: #f7931a;
    --eth: #8c9eff;
    --radius: 14px;
    --radius-sm: 9px;
    --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background:
      radial-gradient(1100px 500px at 50% -10%, rgba(91, 157, 255, 0.07), transparent),
      var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 22px;
    border-bottom: 1px solid var(--border-soft);
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(11, 14, 20, 0.72);
    backdrop-filter: saturate(180%) blur(14px);
    -webkit-backdrop-filter: saturate(180%) blur(14px);
    box-shadow: 0 1px 0 var(--border-soft), 0 12px 28px -16px rgba(0, 0, 0, 0.6);
  }
  header h1 {
    font-size: 15px;
    margin: 0;
    margin-right: 6px;
    font-weight: 650;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  header h1::before {
    content: "";
    width: 9px;
    height: 9px;
    border-radius: 3px;
    background: linear-gradient(135deg, var(--blue), var(--green));
    display: inline-block;
    flex-shrink: 0;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--dim);
    background: rgba(255, 255, 255, 0.04);
  }
  .pill.dryrun { color: var(--amber); background: rgba(240, 169, 60, 0.14); }
  .pill.live { color: var(--red); background: rgba(255, 93, 93, 0.14); }
  .pill.running { color: var(--green); background: rgba(46, 207, 117, 0.14); }
  .pill.paused { color: var(--amber); background: rgba(240, 169, 60, 0.14); }
  .pill.conn-ok { color: var(--green); background: rgba(46, 207, 117, 0.14); }
  .pill.conn-bad { color: var(--red); background: rgba(255, 93, 93, 0.14); }
  .spacer { flex: 1; }
  button {
    font-family: var(--font-ui);
    font-size: 12.5px;
    font-weight: 600;
    padding: 7px 16px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--text);
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background-color 0.15s, transform 0.1s;
  }
  button:hover { border-color: var(--blue); color: var(--blue); }
  button:active { transform: scale(0.96); }
  button.danger { color: var(--red); border-color: rgba(255, 93, 93, 0.35); background: rgba(255, 93, 93, 0.07); }
  button.danger:hover { border-color: var(--red); background: rgba(255, 93, 93, 0.16); }
  button:disabled { opacity: 0.35; cursor: default; transform: none; }
  main {
    padding: 22px 20px 30px;
    max-width: 1240px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
  }
  .card {
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 10px 24px -14px rgba(0, 0, 0, 0.6);
    position: relative;
    overflow: hidden;
  }
  .card.accent-btc, .card.accent-eth { padding-left: 21px; }
  .card.accent-btc::before, .card.accent-eth::before {
    content: "";
    position: absolute;
    left: 0; top: 14px; bottom: 14px;
    width: 3px;
    border-radius: 0 3px 3px 0;
  }
  .card.accent-btc::before { background: var(--btc); }
  .card.accent-eth::before { background: var(--eth); }
  .card h2 {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--dim);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    color: var(--dim);
    font-size: 13px;
  }
  .row b { color: var(--text); font-weight: 600; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .badge {
    display: inline-block;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .badge.waiting_entry { background: rgba(240, 169, 60, 0.14); color: var(--amber); }
  .badge.entering { background: rgba(240, 169, 60, 0.14); color: var(--amber); }
  .badge.monitoring { background: rgba(91, 157, 255, 0.14); color: var(--blue); }
  .badge.merging { background: rgba(91, 157, 255, 0.14); color: var(--blue); }
  .badge.recovering { background: rgba(240, 169, 60, 0.14); color: var(--amber); }
  .badge.done { background: rgba(46, 207, 117, 0.14); color: var(--green); }
  .badge.cut_loss { background: rgba(255, 93, 93, 0.14); color: var(--red); }
  .badge.idle { background: rgba(255, 255, 255, 0.06); color: var(--dim); }
  .fill-yes, .fill-no {
    display: inline-block;
    width: 9px; height: 9px;
    border-radius: 50%;
    margin-right: 5px;
    background: rgba(255, 255, 255, 0.12);
  }
  .fill-yes.on, .fill-no.on { background: var(--green); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border-soft); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  th { color: var(--dim-2); font-weight: 600; text-transform: uppercase; font-size: 10.5px; font-family: var(--font-ui); letter-spacing: 0.05em; }
  tbody tr:hover { background: rgba(255, 255, 255, 0.03); }
  td.pnl-pos { color: var(--green); }
  td.pnl-neg { color: var(--red); }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 14px;
  }
  .kpi-stat .num { font-size: 23px; font-weight: 700; font-family: var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .kpi-stat .label { color: var(--dim-2); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 3px; }
  .edge-pos { color: var(--green); }
  .edge-neg { color: var(--red); }
  .empty { color: var(--dim-2); padding: 10px 0; font-size: 13px; }
  footer { text-align: center; color: var(--dim-2); font-size: 11px; padding: 24px 20px; }

  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
    gap: 14px;
  }
  .chart-card .chart-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .chart-card h2 { margin-bottom: 4px; }
  .chart-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .chart-symbol { color: var(--dim-2); font-weight: 500; text-transform: none; letter-spacing: 0; }
  .chart-price { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 21px; font-weight: 700; color: var(--text); }
  .chart-change { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 12.5px; font-weight: 600; }
  .chart-controls { display: flex; gap: 8px; align-items: center; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .seg button {
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--dim);
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 600;
  }
  .seg button:hover { color: var(--blue); border-color: transparent; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button.active { background: rgba(91, 157, 255, 0.14); color: var(--blue); }
  .chart-box { width: 100%; height: 260px; }
  .chart-foot { display: flex; justify-content: space-between; color: var(--dim-2); font-size: 11px; margin-top: 8px; font-family: var(--font-mono); }
</style>
</head>
<body>
<header>
  <h1>my-polymkt-terminal</h1>
  <span id="pill-mode" class="pill">--</span>
  <span id="pill-run" class="pill">--</span>
  <span id="pill-conn" class="pill conn-bad">connecting…</span>
  <span id="pill-uptime" class="pill">uptime --</span>
  <div class="spacer"></div>
  <button id="btn-pause">Pause</button>
  <button id="btn-resume">Resume</button>
  <button id="btn-stop" class="danger">Stop</button>
</header>
<main>
  <section>
    <div class="cards" id="asset-cards"><div class="empty">Waiting for first update…</div></div>
  </section>

  <section>
    <div class="charts-grid">
      <div class="card chart-card accent-btc" data-asset="btc">
        <div class="chart-head">
          <div class="chart-title">
            <h2 style="margin:0;">BTC <span class="chart-symbol">BTC/USDT</span></h2>
          </div>
        </div>
        <div class="chart-title" style="margin-bottom:10px;">
          <span class="chart-price" id="price-btc-last">--</span>
          <span class="chart-change" id="price-btc-change"></span>
        </div>
        <div class="chart-controls" style="margin-bottom:10px;">
          <div class="seg" data-kind="type" data-asset="btc">
            <button data-value="candle" class="active">Candles</button>
            <button data-value="line">Line</button>
          </div>
          <div class="seg" data-kind="interval" data-asset="btc">
            <button data-value="1m" class="active">1m</button>
            <button data-value="5m">5m</button>
            <button data-value="15m">15m</button>
            <button data-value="1h">1h</button>
          </div>
        </div>
        <div class="chart-box" id="chart-btc"></div>
        <div class="chart-foot">
          <span id="price-btc-status">Loading…</span>
          <span>via Binance</span>
        </div>
      </div>

      <div class="card chart-card accent-eth" data-asset="eth">
        <div class="chart-head">
          <div class="chart-title">
            <h2 style="margin:0;">ETH <span class="chart-symbol">ETH/USDT</span></h2>
          </div>
        </div>
        <div class="chart-title" style="margin-bottom:10px;">
          <span class="chart-price" id="price-eth-last">--</span>
          <span class="chart-change" id="price-eth-change"></span>
        </div>
        <div class="chart-controls" style="margin-bottom:10px;">
          <div class="seg" data-kind="type" data-asset="eth">
            <button data-value="candle" class="active">Candles</button>
            <button data-value="line">Line</button>
          </div>
          <div class="seg" data-kind="interval" data-asset="eth">
            <button data-value="1m" class="active">1m</button>
            <button data-value="5m">5m</button>
            <button data-value="15m">15m</button>
            <button data-value="1h">1h</button>
          </div>
        </div>
        <div class="chart-box" id="chart-eth"></div>
        <div class="chart-foot">
          <span id="price-eth-status">Loading…</span>
          <span>via Binance</span>
        </div>
      </div>
    </div>
  </section>

  <section class="card" id="balance-card">
    <h2>Balance</h2>
    <div id="wallet-body" class="empty">Loading…</div>
    <div id="balance-chart"></div>
    <div id="balance-chart-summary" class="row"></div>
  </section>

  <section class="card">
    <h2>KPI summary</h2>
    <div id="kpi-body" class="empty">No cycles logged yet.</div>
  </section>

  <section class="card">
    <h2>Recent cycles</h2>
    <div id="cycles-body" class="empty">No cycles logged yet.</div>
  </section>
</main>
<footer>Local control surface — bound to this machine only. Settings (assets / duration / risk) are configured via .env and change only on restart.</footer>

<script>
(function () {
  var assets = [];
  var ws = null;
  var reconnectTimer = null;

  function el(tag, opts) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) node.className = opts.cls;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.html !== undefined) node.innerHTML = opts.html;
    return node;
  }

  function fmtPct(n) {
    return (n * 100).toFixed(1) + "%";
  }

  function fmtNum(n, d) {
    return Number(n).toFixed(d === undefined ? 4 : d);
  }

  function fmtCountdown(seconds) {
    if (seconds === null || seconds === undefined) return "--";
    var s = Math.max(0, Math.round(seconds));
    var m = Math.floor(s / 60);
    var rem = s % 60;
    return m + "m " + (rem < 10 ? "0" : "") + rem + "s";
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(proto + location.host);
    ws.onopen = function () {
      setConn(true);
    };
    ws.onclose = function () {
      setConn(false);
      scheduleReconnect();
    };
    ws.onerror = function () {
      setConn(false);
    };
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === "snapshot") render(msg.state, msg.kpi);
      } catch (e) {
        console.error("bad snapshot", e);
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  function setConn(ok) {
    var pill = document.getElementById("pill-conn");
    pill.className = "pill " + (ok ? "conn-ok" : "conn-bad");
    pill.textContent = ok ? "live" : "reconnecting…";
  }

  function setText(id, text, cls) {
    var node = document.getElementById(id);
    node.textContent = text;
    if (cls) node.className = cls;
  }

  function renderHeader(state) {
    setText("pill-mode", state.dryRun ? "DRY RUN" : "LIVE", "pill " + (state.dryRun ? "dryrun" : "live"));
    setText("pill-run", state.paused ? "paused" : "running", "pill " + (state.paused ? "paused" : "running"));
    var upMs = state.now - state.startedAt;
    var upMin = Math.floor(upMs / 60000);
    var h = Math.floor(upMin / 60);
    var m = upMin % 60;
    setText("pill-uptime", "uptime " + h + "h " + m + "m");
    document.getElementById("btn-pause").disabled = state.paused;
    document.getElementById("btn-resume").disabled = !state.paused;
  }

  function renderAssetCards(state) {
    assets = state.mmAssets || assets;
    var container = document.getElementById("asset-cards");
    container.innerHTML = "";
    if (assets.length === 0) {
      container.appendChild(el("div", { cls: "empty", text: "No assets configured." }));
      return;
    }
    var positionsByAsset = {};
    (state.positions || []).forEach(function (p) { positionsByAsset[p.asset] = p; });
    var queuedByAsset = {};
    (state.queued || []).forEach(function (q) { queuedByAsset[q.asset] = q; });

    assets.forEach(function (asset) {
      var pos = positionsByAsset[asset];
      var accent = (asset === "btc" || asset === "eth") ? " accent-" + asset : "";
      var card = el("div", { cls: "card" + accent });
      var title = el("h2");
      title.appendChild(document.createTextNode(asset.toUpperCase()));
      var status = pos ? pos.status : "idle";
      title.appendChild(el("span", { cls: "badge " + status, text: status.replace("_", " ") }));
      card.appendChild(title);

      if (!pos) {
        card.appendChild(el("div", { cls: "row", text: "Waiting for next market…" }));
      } else {
        var rowSlug = el("div", { cls: "row" });
        rowSlug.appendChild(document.createTextNode("market"));
        rowSlug.appendChild(el("b", { text: pos.slug }));
        card.appendChild(rowSlug);

        var rowYes = el("div", { cls: "row" });
        var yesDot = el("span", { cls: "fill-yes" + (pos.yesFilled ? " on" : "") });
        var yesLabel = el("span");
        yesLabel.appendChild(yesDot);
        yesLabel.appendChild(document.createTextNode("YES"));
        rowYes.appendChild(yesLabel);
        rowYes.appendChild(el("b", { text: pos.yesEntryPrice === null ? "--" : fmtNum(pos.yesEntryPrice, 3) }));
        card.appendChild(rowYes);

        var rowNo = el("div", { cls: "row" });
        var noDot = el("span", { cls: "fill-no" + (pos.noFilled ? " on" : "") });
        var noLabel = el("span");
        noLabel.appendChild(noDot);
        noLabel.appendChild(document.createTextNode("NO"));
        rowNo.appendChild(noLabel);
        rowNo.appendChild(el("b", { text: pos.noEntryPrice === null ? "--" : fmtNum(pos.noEntryPrice, 3) }));
        card.appendChild(rowNo);

        var secondsLeft = pos.endTime ? pos.endTime - Math.floor(state.now / 1000) : null;
        var rowTime = el("div", { cls: "row" });
        rowTime.appendChild(document.createTextNode("time left"));
        rowTime.appendChild(el("b", { text: fmtCountdown(secondsLeft) }));
        card.appendChild(rowTime);

        if (pos.ghostFill) {
          card.appendChild(el("div", { cls: "row", html: '<span style="color:var(--amber)">ghost-fill suspected</span>' }));
        }
      }

      var q = queuedByAsset[asset];
      if (q) {
        card.appendChild(el("div", { cls: "row", html: "queued next: <b>" + q.slug + "</b>" }));
      }

      container.appendChild(card);
    });
  }

  function renderWallet(state) {
    var body = document.getElementById("wallet-body");
    var w = state.wallet || {};
    if (!w.configured) {
      body.className = "empty";
      body.textContent = "No PROXY_WALLET_ADDRESS set — add it to .env to see your live USDC balance here (read-only check, no PRIVATE_KEY needed for this).";
      return;
    }
    if (w.usdcBalance === null || w.usdcBalance === undefined) {
      body.className = "empty";
      body.textContent = w.error ? ("Balance check failed: " + w.error) : "Fetching balance…";
      return;
    }
    body.className = "";
    body.innerHTML = "";
    var baseline = (w.baselineUsdcBalance === null || w.baselineUsdcBalance === undefined) ? w.usdcBalance : w.baselineUsdcBalance;
    var delta = w.usdcBalance - baseline;
    var ageSec = w.updatedAt ? Math.max(0, Math.round((state.now - w.updatedAt) / 1000)) : null;

    var rowBal = el("div", { cls: "row" });
    rowBal.appendChild(document.createTextNode("USDC balance"));
    rowBal.appendChild(el("b", { text: fmtNum(w.usdcBalance, 4) }));
    body.appendChild(rowBal);

    var rowDelta = el("div", { cls: "row" });
    rowDelta.appendChild(document.createTextNode("since dashboard start"));
    rowDelta.appendChild(el("b", { cls: delta >= 0 ? "edge-pos" : "edge-neg", text: (delta >= 0 ? "+" : "") + fmtNum(delta, 4) }));
    body.appendChild(rowDelta);

    var rowAge = el("div", { cls: "row" });
    rowAge.appendChild(document.createTextNode("updated"));
    rowAge.appendChild(el("b", { text: ageSec === null ? "--" : ageSec + "s ago" }));
    body.appendChild(rowAge);

    if (w.error) {
      body.appendChild(el("div", { cls: "row", html: '<span style="color:var(--amber)">last refresh failed: ' + w.error + "</span>" }));
    }
  }

  function renderBalanceChart(kpi, state) {
    var container = document.getElementById("balance-chart");
    var summary = document.getElementById("balance-chart-summary");
    var points = (kpi && kpi.cumulativePnl) || [];
    if (points.length === 0) {
      container.innerHTML = "";
      summary.className = "row";
      summary.textContent = "";
      return;
    }
    var w = 600, h = 140, pad = 10;
    var values = points.map(function (p) { return p.cumulativePnl; });
    var minV = Math.min(0, Math.min.apply(null, values));
    var maxV = Math.max(0, Math.max.apply(null, values));
    if (minV === maxV) { minV -= 1; maxV += 1; }

    function xAt(i) {
      return points.length <= 1 ? w / 2 : pad + (i / (points.length - 1)) * (w - pad * 2);
    }
    function yAt(v) {
      return h - pad - ((v - minV) / (maxV - minV)) * (h - pad * 2);
    }
    var zeroY = yAt(0);
    var linePath = points.map(function (p, i) {
      return (i === 0 ? "M" : "L") + xAt(i).toFixed(1) + "," + yAt(p.cumulativePnl).toFixed(1);
    }).join(" ");
    var last = values[values.length - 1];
    var color = last >= 0 ? "var(--green)" : "var(--red)";
    var areaPath = linePath +
      " L" + xAt(points.length - 1).toFixed(1) + "," + zeroY.toFixed(1) +
      " L" + xAt(0).toFixed(1) + "," + zeroY.toFixed(1) + " Z";

    var svg =
      '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" style="width:100%;height:140px;display:block;">' +
      '<line x1="' + pad + '" y1="' + zeroY.toFixed(1) + '" x2="' + (w - pad) + '" y2="' + zeroY.toFixed(1) + '" stroke="var(--border)" stroke-dasharray="4,4" />' +
      '<path d="' + areaPath + '" fill="' + color + '" opacity="0.12" stroke="none" />' +
      '<path d="' + linePath + '" fill="none" stroke="' + color + '" stroke-width="2" />' +
      "</svg>";
    container.innerHTML = svg;

    summary.className = last >= 0 ? "row edge-pos" : "row edge-neg";
    summary.textContent = "cumulative p&l: " + (last >= 0 ? "+" : "") + fmtNum(last) + " USDC over " + points.length +
      " cycle" + (points.length === 1 ? "" : "s") + (state && state.dryRun ? " (dry-run simulated)" : "");
  }

  function renderKpi(kpi) {
    var body = document.getElementById("kpi-body");
    if (!kpi || kpi.totalCycles === 0) {
      body.className = "empty";
      body.textContent = "No cycles logged yet.";
      return;
    }
    body.className = "";
    body.innerHTML = "";
    var grid = el("div", { cls: "kpi-grid" });

    function stat(label, value) {
      var box = el("div", { cls: "kpi-stat" });
      box.appendChild(el("div", { cls: "num", text: value }));
      box.appendChild(el("div", { cls: "label", text: label }));
      grid.appendChild(box);
    }

    stat("cycles", String(kpi.totalCycles));
    stat("both-fill rate", fmtPct(kpi.fillRate));
    stat("total p&l", fmtNum(kpi.totalPnl) + " USDC");
    stat("gas cost", fmtNum(kpi.totalGasCostUsd) + " USDC");
    stat("ghost fills", String(kpi.ghostFills));

    body.appendChild(grid);

    var breakevenLine = el("div", { cls: "row" });
    if (kpi.breakevenFillRate === null) {
      breakevenLine.textContent = "No breakeven tension yet — every cycle so far has been non-negative even without both-fills.";
    } else {
      var edgeTxt = kpi.edge >= 0
        ? "clears breakeven by " + fmtPct(kpi.edge)
        : "BELOW breakeven by " + fmtPct(-kpi.edge);
      breakevenLine.appendChild(document.createTextNode("breakeven fill rate: "));
      breakevenLine.appendChild(el("b", { text: fmtPct(kpi.breakevenFillRate) }));
      breakevenLine.appendChild(document.createTextNode(" — current rate "));
      breakevenLine.appendChild(el("b", { cls: kpi.edge >= 0 ? "edge-pos" : "edge-neg", text: edgeTxt }));
    }
    body.appendChild(breakevenLine);
  }

  function renderCycles(state) {
    var body = document.getElementById("cycles-body");
    var rows = state.recentCycles || [];
    if (rows.length === 0) {
      body.className = "empty";
      body.textContent = "No cycles logged yet.";
      return;
    }
    body.className = "";
    body.innerHTML = "";
    var table = el("table");
    var thead = el("thead");
    thead.innerHTML = "<tr><th>time</th><th>asset</th><th>slug</th><th>result</th><th>gas</th><th>pnl</th></tr>";
    table.appendChild(thead);
    var tbody = el("tbody");
    rows.slice(0, 20).forEach(function (r) {
      var tr = el("tr");
      var time = new Date(r.ts).toISOString().slice(11, 19);
      var result = r.bothFilled ? "both filled" : (r.cutLoss ? "cut loss" : "one-sided");
      var gas = r.gasCostUsd ? fmtNum(r.gasCostUsd) : "—";
      tr.innerHTML =
        "<td>" + time + "</td>" +
        "<td>" + r.asset.toUpperCase() + "</td>" +
        "<td>" + r.slug + "</td>" +
        "<td>" + result + "</td>" +
        "<td>" + gas + "</td>" +
        '<td class="' + (r.pnl >= 0 ? "pnl-pos" : "pnl-neg") + '">' + fmtNum(r.pnl) + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  function render(state, kpi) {
    renderHeader(state);
    renderAssetCards(state);
    renderWallet(state);
    renderBalanceChart(kpi, state);
    renderKpi(kpi);
    renderCycles(state);
  }

  function post(path) {
    return fetch(path, { method: "POST" }).then(function (r) { return r.json(); });
  }

  document.getElementById("btn-pause").addEventListener("click", function () {
    post("/api/pause");
  });
  document.getElementById("btn-resume").addEventListener("click", function () {
    post("/api/resume");
  });
  document.getElementById("btn-stop").addEventListener("click", function () {
    if (!confirm("Stop the bot now? This exits the process immediately (same as Ctrl+C) — any in-flight cycle is abandoned mid-monitoring rather than flattened.")) return;
    post("/api/stop");
  });

  // ── BTC/ETH price charts (lightweight-charts, fed by /api/prices). Fully independent of
  // the WS snapshot loop above — these run their own fetch/refresh cycle since chart data
  // isn't part of bot state.
  var CHART_ASSETS = ["btc", "eth"];
  var chartState = {};

  function setActiveSegButton(btn) {
    var siblings = btn.parentElement.children;
    for (var i = 0; i < siblings.length; i++) siblings[i].classList.remove("active");
    btn.classList.add("active");
  }

  function setSeriesType(asset, type) {
    var st = chartState[asset];
    if (!st) return;
    if (st.series) {
      st.chart.removeSeries(st.series);
      st.series = null;
    }
    if (type === "candle") {
      st.series = st.chart.addCandlestickSeries({
        upColor: "#2ecf75",
        downColor: "#ff5d5d",
        borderVisible: false,
        wickUpColor: "#2ecf75",
        wickDownColor: "#ff5d5d",
      });
    } else {
      st.series = st.chart.addLineSeries({ color: "#5b9dff", lineWidth: 2 });
    }
    st.type = type;
  }

  function renderChartSeries(asset) {
    var st = chartState[asset];
    if (!st || !st.series || st.candles.length === 0) return;
    if (st.type === "candle") {
      st.series.setData(st.candles.map(function (c) {
        return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
      }));
    } else {
      st.series.setData(st.candles.map(function (c) {
        return { time: c.time, value: c.close };
      }));
    }
  }

  function updatePriceHeader(asset) {
    var st = chartState[asset];
    var candles = st.candles;
    if (!candles || candles.length === 0) return;
    var last = candles[candles.length - 1];
    var first = candles[0];
    var change = last.close - first.open;
    var pct = first.open !== 0 ? (change / first.open) * 100 : 0;
    var priceEl = document.getElementById("price-" + asset + "-last");
    if (priceEl) priceEl.textContent = "$" + last.close.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    var changeEl = document.getElementById("price-" + asset + "-change");
    if (changeEl) {
      changeEl.textContent = (change >= 0 ? "+" : "") + change.toFixed(2) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)";
      changeEl.style.color = change >= 0 ? "var(--green)" : "var(--red)";
    }
  }

  function loadPrices(asset) {
    var st = chartState[asset];
    if (!st) return;
    fetch("/api/prices?asset=" + asset + "&interval=" + st.interval + "&limit=200")
      .then(function (r) {
        return r.json().then(function (body) { return { ok: r.ok, body: body }; });
      })
      .then(function (res) {
        var statusEl = document.getElementById("price-" + asset + "-status");
        if (!res.ok) {
          if (statusEl) { statusEl.textContent = (res.body && res.body.error) || "Price feed error"; statusEl.style.color = "var(--red)"; }
          return;
        }
        st.candles = res.body.candles || [];
        renderChartSeries(asset);
        updatePriceHeader(asset);
        if (statusEl) { statusEl.textContent = "updated " + new Date().toLocaleTimeString(); statusEl.style.color = ""; }
      })
      .catch(function () {
        var statusEl = document.getElementById("price-" + asset + "-status");
        if (statusEl) { statusEl.textContent = "price feed unreachable"; statusEl.style.color = "var(--red)"; }
      });
  }

  function initCharts() {
    if (typeof LightweightCharts === "undefined") {
      CHART_ASSETS.forEach(function (asset) {
        var box = document.getElementById("chart-" + asset);
        if (box) box.innerHTML = '<div class="empty">Chart library failed to load from the CDN — check your internet connection and reload.</div>';
        var statusEl = document.getElementById("price-" + asset + "-status");
        if (statusEl) statusEl.textContent = "chart library unavailable";
      });
      return;
    }

    CHART_ASSETS.forEach(function (asset) {
      var container = document.getElementById("chart-" + asset);
      if (!container) return;
      var chart = LightweightCharts.createChart(container, {
        autoSize: true,
        layout: {
          background: { color: "transparent" },
          textColor: "#8b96a5",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.04)" },
          horzLines: { color: "rgba(255,255,255,0.04)" },
        },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
        timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
        crosshair: { mode: 1 },
      });

      chartState[asset] = { chart: chart, series: null, type: "candle", interval: "1m", candles: [] };
      setSeriesType(asset, "candle");

      var typeBtns = document.querySelectorAll('.seg[data-kind="type"][data-asset="' + asset + '"] button');
      for (var i = 0; i < typeBtns.length; i++) {
        typeBtns[i].addEventListener("click", function (ev) {
          var btn = ev.currentTarget;
          var a = btn.parentElement.getAttribute("data-asset");
          setActiveSegButton(btn);
          setSeriesType(a, btn.getAttribute("data-value"));
          renderChartSeries(a);
        });
      }

      var intervalBtns = document.querySelectorAll('.seg[data-kind="interval"][data-asset="' + asset + '"] button');
      for (var j = 0; j < intervalBtns.length; j++) {
        intervalBtns[j].addEventListener("click", function (ev) {
          var btn = ev.currentTarget;
          var a = btn.parentElement.getAttribute("data-asset");
          setActiveSegButton(btn);
          chartState[a].interval = btn.getAttribute("data-value");
          loadPrices(a);
        });
      }

      loadPrices(asset);
    });

    setInterval(function () {
      CHART_ASSETS.forEach(function (asset) { loadPrices(asset); });
    }, 10000);
  }

  connect();
  fetch("/api/state").then(function (r) { return r.json(); }).then(function (data) {
    render(data.state, data.kpi);
  }).catch(function () {});
  initCharts();
})();
</script>
</body>
</html>
`;
