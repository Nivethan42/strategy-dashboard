let overviewChart;
let compareChart;

const state = {
  current: null,
  strategies: {},
  refreshLog: [],
  changelog: [],
  activeRange: "FULL",
};

const byId = (id) => document.getElementById(id);
const fmt = (value, fallback = "N/A") => (value === null || value === undefined || value === "" ? fallback : String(value));
const esc = (value, fallback = "N/A") => fmt(value, fallback)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function metricRow(label, value) {
  return `<div class="kv"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function tabInit() {
  byId("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("is-active"));
    btn.classList.add("is-active");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
    document.querySelector(`[data-view="${tab}"]`).classList.add("is-active");
  });
}

function signalClass(signal) {
  return signal === "BUY" ? "buy" : "cash";
}

function buildHero() {
  const strategies = state.current.strategies;
  const best = strategies.find((s) => s.signalIsBuy) || strategies[0];

  byId("hero").innerHTML = `
    <div class="hero-main">
      <h2>${esc(best.displayName)}: ${esc(best.currentSignal)}</h2>
      <p>${esc(best.currentActionText)}</p>
      <p>${esc(best.signalChangeSummary)} • ${esc(best.streakType)} streak: ${esc(best.streakLength)} day(s)</p>
    </div>
    <div class="hero-signal">
      <div>Current signal focus</div>
      <div class="signal-pill ${signalClass(best.currentSignal)}">${esc(best.currentSignal)} / ${best.signalIsBuy ? "INVESTED" : "CASH"}</div>
      ${metricRow(`Latest open (${fmt(best.sourceTicker)})`, best.latestOpen.source)}
      ${metricRow(`Latest open (${fmt(best.tradedTicker)})`, best.latestOpen.traded)}
    </div>`;
}

function buildSummary() {
  const container = byId("summary-grid");
  container.innerHTML = "";
  state.current.strategies.forEach((s) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3>${esc(s.displayName)}</h3>
      ${metricRow("Signal", s.currentSignal)}
      ${metricRow("Today", s.signalChangeSummary)}
      ${metricRow("Action", s.currentActionText)}
      ${metricRow("BUY/CASH streak", `${fmt(s.streakType)} ${fmt(s.streakLength)}d`)}
      ${metricRow(`${fmt(s.tradedTicker)} Open`, s.latestOpen.traded)}
      <div class="indicator-grid">${renderIndicatorsMini(state.strategies[s.id].indicators)}</div>
    `;
    container.appendChild(card);
  });
}

function renderIndicatorsMini(indicators) {
  return indicators
    .map((i) => `<div class="indicator-card"><div class="top"><strong>${esc(i.label)}</strong><span class="badge ${i.passed ? "ok" : "fail"}">${i.passed ? "PASS" : "FAIL"}</span></div><div class="indicator-val">${esc(i.displayValue)}</div><small>${esc(i.rule)}</small></div>`)
    .join("");
}

function buildQuickCompare() {
  const container = byId("quick-compare");
  container.innerHTML = "";
  state.current.strategies.forEach((s) => {
    container.appendChild(strategyCard(s, [
      { label: "Signal", value: s.currentSignal },
      { label: "CAGR", value: s.backtest.cagr },
      { label: "Max DD", value: s.backtest.maxDrawdown },
      { label: "Trades", value: s.backtest.tradeCount },
      { label: "Window", value: s.backtest.window },
    ]));
  });
}

function strategyCard(strategy, metrics, className = "card") {
  const card = document.createElement("article");
  card.className = className;
  card.innerHTML = `
    <h3>${esc(strategy.displayName)}</h3>
    <div class="metric-list">
      ${metrics.map((m) => metricRow(m.label, m.value)).join("")}
    </div>
  `;
  return card;
}

function pickRange(history, range) {
  if (range === "1Y") return history.slice(-252);
  if (range === "3Y") return history.slice(-756);
  return history;
}

function renderOverviewChart(strategyId) {
  const strategy = state.strategies[strategyId];
  if (!strategy) return;
  const rows = pickRange(strategy.chart.history, state.activeRange);

  if (overviewChart) overviewChart.destroy();
  overviewChart = new Chart(byId("overview-chart").getContext("2d"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        { label: strategy.chart.sourceLabel, data: rows.map((r) => r.sourceOpen), yAxisID: "y", borderWidth: 2, tension: 0.15 },
        { label: "Strategy Equity", data: rows.map((r) => r.equity), yAxisID: "y1", borderWidth: 2, tension: 0.15 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false } },
  });
}

function renderCompareSection() {
  const container = byId("compare-cards");
  container.innerHTML = "";

  state.current.strategies.forEach((s) => {
    container.appendChild(strategyCard(s, [
      { label: "Current signal", value: s.currentSignal },
      { label: `Latest open (${s.tradedTicker})`, value: s.latestOpen.traded },
      { label: "Streak", value: `${fmt(s.streakType)} ${fmt(s.streakLength)}d` },
      { label: "CAGR", value: s.backtest.cagr },
      { label: "Max drawdown", value: s.backtest.maxDrawdown },
      { label: "Trade count", value: s.backtest.tradeCount },
    ], "card compare-card"));
  });

  const tqqq = state.strategies.tqqq?.chart?.history || [];
  const spxl = state.strategies.spxl?.chart?.history || [];
  if (compareChart) compareChart.destroy();
  compareChart = new Chart(byId("compare-chart").getContext("2d"), {
    type: "line",
    data: {
      labels: tqqq.map((r) => r.date),
      datasets: [
        { label: "TQQQ Strategy Equity", data: tqqq.map((r) => r.equity), borderWidth: 2, tension: 0.1 },
        { label: "SPXL Strategy Equity", data: spxl.map((r) => r.equity), borderWidth: 2, tension: 0.1 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

function renderHistoryTable(strategyId) {
  const rows = [...(state.strategies[strategyId].signalHistory || [])].reverse().slice(0, 180);
  const head = byId("history-head");
  const body = byId("history-body");

  const cols = Object.keys(rows[0] || { date: "", signalText: "", sourceOpen: "", tradedOpen: "" });
  head.innerHTML = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  body.innerHTML = rows
    .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join("")}</tr>`)
    .join("");
}

function renderUpdates() {
  const latestOk = [...state.refreshLog].reverse().find((r) => r.status === "OK");
  byId("refresh-highlight").innerHTML = `
    <div class="panel-head"><h2>Latest Successful Refresh</h2></div>
    ${metricRow("Timestamp", latestOk?.timestamp)}
    ${metricRow("Latest trading day", latestOk?.latestTradingDay)}
    ${metricRow("Source", latestOk?.source)}
    ${metricRow("Commit", latestOk?.commit)}`;

  byId("refresh-log").innerHTML = [...state.refreshLog].reverse().slice(0, 80).map((r) => {
    const cls = r.status === "OK" ? "ok" : r.status === "WARN" ? "warn" : "fail";
    return `<article class="log-item"><div class="kv"><strong>${esc(r.timestamp)}</strong><span class="badge ${cls}">${esc(r.status)}</span></div><p>${esc(r.type)} • ${esc(r.note)}</p><p>Latest day: ${esc(r.latestTradingDay)} • Commit: ${esc(r.commit)}</p></article>`;
  }).join("");

  byId("changelog").innerHTML = [...state.changelog].reverse().map((r) => {
    const details = (r.details || []).map((d) => `<li>${esc(d)}</li>`).join("");
    return `<article class="log-item"><div class="kv"><strong>v${esc(r.version)}</strong><span>${esc(r.date)}</span></div><p><strong>${esc(r.title)}</strong></p><ul>${details}</ul><p>Commit: ${esc(r.commit)}</p></article>`;
  }).join("");
}

function renderMethodology() {
  const container = byId("methodology-content");
  container.innerHTML = "";

  Object.values(state.strategies).forEach((s) => {
    const block = document.createElement("section");
    block.className = "panel";
    block.innerHTML = `
      <h2>${esc(s.displayName)}</h2>
      <p>${esc(s.subtitle)}</p>
      <details>
        <summary>Show formula</summary>
        <h4>Buy rule</h4>
        <ul>${(s.formula.buy || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No buy formula provided.</li>"}</ul>
        <h4>Sell rule</h4>
        <ul>${(s.formula.sell || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No sell formula provided.</li>"}</ul>
        <h4>Definitions</h4>
        <ul>${(s.formula.definitions || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No definitions provided.</li>"}</ul>
      </details>
      <h4>Plain-English explanation</h4>
      <ul>${(s.plainEnglish || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No explanation provided.</li>"}</ul>
      <h4>Backtest assumptions</h4>
      <ul>
        <li>Signal computed from prior data only (t-1 and earlier).</li>
        <li>Trades modeled at today's open and held open-to-open.</li>
        <li>No slippage/fees modeled in this static dashboard backtest.</li>
      </ul>
      <h4>Data assumptions</h4>
      <ul><li>Daily and intraday opens sourced from yFinance.</li></ul>`;
    container.appendChild(block);
  });
}

function bindControls() {
  const strategyIds = Object.keys(state.strategies);
  const overviewSelect = byId("overview-strategy");
  const historySelect = byId("history-strategy");

  [overviewSelect, historySelect].forEach((sel) => {
    sel.innerHTML = strategyIds.map((id) => `<option value="${id}">${state.strategies[id].displayName}</option>`).join("");
  });

  overviewSelect.addEventListener("change", () => renderOverviewChart(overviewSelect.value));
  historySelect.addEventListener("change", () => renderHistoryTable(historySelect.value));
  byId("range-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.activeRange = btn.dataset.range;
    byId("range-toggle").querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    renderOverviewChart(overviewSelect.value);
  });

  renderOverviewChart(strategyIds[0]);
  renderHistoryTable(strategyIds[0]);
}

async function loadData() {
  const v = `?v=${Date.now()}`;
  const [currentRes, tqqqRes, spxlRes, refreshRes, changeRes] = await Promise.all([
    fetch(`./data/current.json${v}`),
    fetch(`./data/strategies/tqqq.json${v}`),
    fetch(`./data/strategies/spxl.json${v}`),
    fetch(`./data/refresh_log.json${v}`),
    fetch(`./data/changelog.json${v}`),
  ]);

  if (![currentRes, tqqqRes, spxlRes, refreshRes, changeRes].every((r) => r.ok)) {
    throw new Error("Data files are not ready. Run the workflow once.");
  }

  state.current = await currentRes.json();
  state.strategies.tqqq = await tqqqRes.json();
  state.strategies.spxl = await spxlRes.json();
  state.refreshLog = await refreshRes.json();
  state.changelog = await changeRes.json();
}

async function init() {
  try {
    tabInit();
    await loadData();

    byId("latest-day").textContent = `Latest day: ${fmt(state.current.latestTradingDay)}`;
    byId("last-updated").textContent = `Last updated: ${fmt(state.current.lastUpdated)}`;

    buildHero();
    buildSummary();
    buildQuickCompare();
    renderCompareSection();
    renderUpdates();
    renderMethodology();
    bindControls();
  } catch (err) {
    byId("hero").innerHTML = `<div class="hero-main"><h2>Dashboard not ready</h2><p>${err.message}</p></div>`;
  }
}

init();
