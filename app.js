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
      <h2>${fmt(best.displayName)}: ${fmt(best.currentSignal)}</h2>
      <p>${fmt(best.currentActionText)}</p>
      <p>${fmt(best.signalChangeSummary)} • ${fmt(best.streakType)} streak: ${fmt(best.streakLength)} day(s)</p>
    </div>
    <div class="hero-signal">
      <div>Current signal focus</div>
      <div class="signal-pill ${signalClass(best.currentSignal)}">${fmt(best.currentSignal)} / ${best.signalIsBuy ? "INVESTED" : "CASH"}</div>
      <div class="kv"><span>Latest open (${fmt(best.sourceTicker)})</span><strong>${fmt(best.latestOpen.source)}</strong></div>
      <div class="kv"><span>Latest open (${fmt(best.tradedTicker)})</span><strong>${fmt(best.latestOpen.traded)}</strong></div>
    </div>`;
}

function buildSummary() {
  const container = byId("summary-grid");
  container.innerHTML = "";
  state.current.strategies.forEach((s) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3>${fmt(s.displayName)}</h3>
      <div class="kv"><span>Signal</span><strong>${fmt(s.currentSignal)}</strong></div>
      <div class="kv"><span>Today</span><strong>${fmt(s.signalChangeSummary)}</strong></div>
      <div class="kv"><span>Action</span><strong>${fmt(s.currentActionText)}</strong></div>
      <div class="kv"><span>BUY/CASH streak</span><strong>${fmt(s.streakType)} ${fmt(s.streakLength)}d</strong></div>
      <div class="kv"><span>${fmt(s.tradedTicker)} Open</span><strong>${fmt(s.latestOpen.traded)}</strong></div>
      <div class="indicator-grid">${renderIndicatorsMini(state.strategies[s.id].indicators)}</div>
    `;
    container.appendChild(card);
  });
}

function renderIndicatorsMini(indicators) {
  return indicators
    .map((i) => `<div class="indicator-card"><div class="top"><strong>${fmt(i.label)}</strong><span class="badge ${i.passed ? "ok" : "fail"}">${i.passed ? "PASS" : "FAIL"}</span></div><div class="indicator-val">${fmt(i.displayValue)}</div><small>${fmt(i.rule)}</small></div>`)
    .join("");
}

function buildQuickCompare() {
  const container = byId("quick-compare");
  container.innerHTML = "";
  state.current.strategies.forEach((s) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3>${fmt(s.displayName)}</h3>
      <div class="kv"><span>Signal</span><strong>${fmt(s.currentSignal)}</strong></div>
      <div class="kv"><span>CAGR</span><strong>${fmt(s.backtest.cagr)}</strong></div>
      <div class="kv"><span>Max DD</span><strong>${fmt(s.backtest.maxDrawdown)}</strong></div>
      <div class="kv"><span>Trades</span><strong>${fmt(s.backtest.tradeCount)}</strong></div>
      <div class="kv"><span>Window</span><strong>${fmt(s.backtest.window)}</strong></div>`;
    container.appendChild(card);
  });
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
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3>${fmt(s.displayName)}</h3>
      <div class="kv"><span>Current signal</span><strong>${fmt(s.currentSignal)}</strong></div>
      <div class="kv"><span>Latest open (${s.tradedTicker})</span><strong>${fmt(s.latestOpen.traded)}</strong></div>
      <div class="kv"><span>Streak</span><strong>${fmt(s.streakType)} ${fmt(s.streakLength)}d</strong></div>
      <div class="kv"><span>CAGR</span><strong>${fmt(s.backtest.cagr)}</strong></div>
      <div class="kv"><span>Max drawdown</span><strong>${fmt(s.backtest.maxDrawdown)}</strong></div>
      <div class="kv"><span>Trade count</span><strong>${fmt(s.backtest.tradeCount)}</strong></div>`;
    container.appendChild(card);
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
  const rows = [...state.strategies[strategyId].signalHistory].reverse().slice(0, 180);
  const head = byId("history-head");
  const body = byId("history-body");

  const cols = Object.keys(rows[0] || { date: "", signalText: "", sourceOpen: "", tradedOpen: "" });
  head.innerHTML = cols.map((c) => `<th>${c}</th>`).join("");
  body.innerHTML = rows
    .map((r) => `<tr>${cols.map((c) => `<td>${fmt(r[c])}</td>`).join("")}</tr>`)
    .join("");
}

function renderUpdates() {
  const latestOk = [...state.refreshLog].reverse().find((r) => r.status === "OK");
  byId("refresh-highlight").innerHTML = `
    <div class="panel-head"><h2>Latest Successful Refresh</h2></div>
    <div class="kv"><span>Timestamp</span><strong>${fmt(latestOk?.timestamp)}</strong></div>
    <div class="kv"><span>Latest trading day</span><strong>${fmt(latestOk?.latestTradingDay)}</strong></div>
    <div class="kv"><span>Source</span><strong>${fmt(latestOk?.source)}</strong></div>
    <div class="kv"><span>Commit</span><strong>${fmt(latestOk?.commit)}</strong></div>`;

  byId("refresh-log").innerHTML = [...state.refreshLog].reverse().slice(0, 80).map((r) => {
    const cls = r.status === "OK" ? "ok" : r.status === "WARN" ? "warn" : "fail";
    return `<article class="log-item"><div class="kv"><strong>${fmt(r.timestamp)}</strong><span class="badge ${cls}">${fmt(r.status)}</span></div><p>${fmt(r.type)} • ${fmt(r.note)}</p><p>Latest day: ${fmt(r.latestTradingDay)} • Commit: ${fmt(r.commit)}</p></article>`;
  }).join("");

  byId("changelog").innerHTML = [...state.changelog].reverse().map((r) => {
    const details = (r.details || []).map((d) => `<li>${fmt(d)}</li>`).join("");
    return `<article class="log-item"><div class="kv"><strong>v${fmt(r.version)}</strong><span>${fmt(r.date)}</span></div><p><strong>${fmt(r.title)}</strong></p><ul>${details}</ul><p>Commit: ${fmt(r.commit)}</p></article>`;
  }).join("");
}

function renderMethodology() {
  const container = byId("methodology-content");
  container.innerHTML = "";

  Object.values(state.strategies).forEach((s) => {
    const block = document.createElement("section");
    block.className = "panel";
    block.innerHTML = `
      <h2>${fmt(s.displayName)}</h2>
      <p>${fmt(s.subtitle)}</p>
      <details>
        <summary>Show formula</summary>
        <h4>Buy rule</h4>
        <ul>${(s.formula.buy || []).map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>
        <h4>Sell rule</h4>
        <ul>${(s.formula.sell || []).map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>
        <h4>Definitions</h4>
        <ul>${(s.formula.definitions || []).map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>
      </details>
      <h4>Plain-English explanation</h4>
      <ul>${(s.plainEnglish || []).map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>
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
