// Single-file vanilla HTML/CSS/JS dashboard page, served as a plain string by
// dashboardServer.ts. Deliberately dependency-free (no CDN fetch, no build step) so it
// works fully offline and ships as part of the normal tsc build with zero extra steps.
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
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --dim: #8b949e;
    --blue: #58a6ff;
    --green: #3fb950;
    --amber: #d29922;
    --red: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 14px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--bg);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  header h1 {
    font-size: 16px;
    margin: 0;
    margin-right: 8px;
    font-weight: 600;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--dim);
  }
  .pill.dryrun { color: var(--amber); border-color: var(--amber); }
  .pill.live { color: var(--red); border-color: var(--red); }
  .pill.running { color: var(--green); border-color: var(--green); }
  .pill.paused { color: var(--amber); border-color: var(--amber); }
  .pill.conn-ok { color: var(--green); border-color: var(--green); }
  .pill.conn-bad { color: var(--red); border-color: var(--red); }
  .spacer { flex: 1; }
  button {
    font-family: inherit;
    font-size: 12px;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  button:hover { border-color: var(--blue); }
  button.danger:hover { border-color: var(--red); color: var(--red); }
  button:disabled { opacity: 0.4; cursor: default; }
  main {
    padding: 20px;
    max-width: 1200px;
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
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .card h2 {
    margin: 0 0 10px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--dim);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
    color: var(--dim);
  }
  .row b { color: var(--text); font-weight: 500; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    text-transform: uppercase;
  }
  .badge.waiting_entry { background: #3d2f00; color: var(--amber); }
  .badge.entering { background: #3d2f00; color: var(--amber); }
  .badge.monitoring { background: #0d2a4d; color: var(--blue); }
  .badge.merging { background: #0d2a4d; color: var(--blue); }
  .badge.recovering { background: #3d2f00; color: var(--amber); }
  .badge.done { background: #0d3321; color: var(--green); }
  .badge.cut_loss { background: #3d0d0d; color: var(--red); }
  .badge.idle { background: #21262d; color: var(--dim); }
  .fill-yes, .fill-no {
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 50%;
    margin-right: 5px;
    background: var(--border);
  }
  .fill-yes.on, .fill-no.on { background: var(--green); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--dim); font-weight: 500; text-transform: uppercase; font-size: 11px; }
  td.pnl-pos { color: var(--green); }
  td.pnl-neg { color: var(--red); }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 14px;
  }
  .kpi-stat .num { font-size: 22px; font-weight: 600; }
  .kpi-stat .label { color: var(--dim); font-size: 11px; text-transform: uppercase; margin-top: 2px; }
  .edge-pos { color: var(--green); }
  .edge-neg { color: var(--red); }
  .empty { color: var(--dim); padding: 10px 0; }
  footer { text-align: center; color: var(--dim); font-size: 11px; padding: 20px; }
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
      var card = el("div", { cls: "card" });
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
    thead.innerHTML = "<tr><th>time</th><th>asset</th><th>slug</th><th>result</th><th>pnl</th></tr>";
    table.appendChild(thead);
    var tbody = el("tbody");
    rows.slice(0, 20).forEach(function (r) {
      var tr = el("tr");
      var time = new Date(r.ts).toISOString().slice(11, 19);
      var result = r.bothFilled ? "both filled" : (r.cutLoss ? "cut loss" : "one-sided");
      tr.innerHTML =
        "<td>" + time + "</td>" +
        "<td>" + r.asset.toUpperCase() + "</td>" +
        "<td>" + r.slug + "</td>" +
        "<td>" + result + "</td>" +
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

  connect();
  fetch("/api/state").then(function (r) { return r.json(); }).then(function (data) {
    render(data.state, data.kpi);
  }).catch(function () {});
})();
</script>
</body>
</html>
`;
