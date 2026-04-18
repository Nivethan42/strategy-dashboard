let overviewChart;
let drawdownChart;
let rollingCagrChart;
let compareCharts = [];
let testChart;

const STRATEGY_PROFILES = [
  {
    id: "tqqq_tfsa",
    base: "tqqq",
    displayName: "TQQQ-TFSA",
    cardTitle: "Momentum v3",
    account: "TFSA",
    backtest: {
      cagr: "61.09%",
      maxDrawdown: "-49.64%",
      tradeCount: 131,
      window: "2010-02-11 to 2026-04-10",
    },
  },
  { id: "tqqq_rrsp", base: "tqqq", displayName: "TQQQ-RRSP", cardTitle: "Dip Hunter", account: "RRSP" },
  { id: "spxl_tfsa", base: "spxl", displayName: "SPXL-TFSA", cardTitle: "RV Filter", account: "TFSA" },
  { id: "spxl_rrsp", base: "spxl", displayName: "SPXL-RRSP", cardTitle: "MACD Cross", account: "RRSP" },
];

const state = {
  current: null,
  strategies: {},
  refreshLog: [],
  changelog: [],
  testData: null,
  activeRange: "FULL",
  selectedStrategyId: STRATEGY_PROFILES[0].id,
  testRange: "FULL",
  lastTestResult: null,
};

const TEST_EXAMPLES = [
  "(SSLP20_2 < -0.008 OR MOM150 > -0.01) AND RV5 < 0.03 AND RV7 < 0.03 AND SR63_126 < 1.05",
  "MACDH20_50 > -2 AND OPEN/MAX126 > 0.85 AND SMA_RATIO_50_200 > 0.95 AND RV7 < 0.03 AND SMA_RATIO_63_126 < 1.05",
  "COUNT_TRUE(MOM90 > 0, MOM100 > 0, ABVMA100, SLP5_1 > 0, SLP20_1 > 0, SLP20_3 > 0) >= 3 AND VR20_100 < 1.4",
];

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

function pickRange(history, range) {
  if (range === "1Y") return history.slice(-252);
  if (range === "3Y") return history.slice(-756);
  if (range === "5Y") return history.slice(-1260);
  if (range === "10Y") return history.slice(-2520);
  return history;
}

function cumulativeReturn(values) {
  if (!values.length) return [];
  const base = values[0];
  if (!base) return values.map(() => 0);
  return values.map((v) => ((v / base) - 1) * 100);
}

function daysBetween(a, b) {
  return Math.max(0, Math.floor((new Date(a) - new Date(b)) / (24 * 60 * 60 * 1000)));
}

function parseDashboardTimestamp(timestamp) {
  if (!timestamp) return null;
  const raw = String(timestamp).trim();
  const nativeParsed = new Date(raw);
  if (!Number.isNaN(nativeParsed.getTime())) return nativeParsed;

  const match = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z]{3})$/);
  if (!match) return null;
  const [, datePart, timePart, tzAbbr] = match;
  const tzOffsets = { EDT: "-04:00", EST: "-05:00", UTC: "+00:00" };
  const offset = tzOffsets[tzAbbr];
  if (!offset) return null;
  const isoLike = `${datePart}T${timePart}${offset}`;
  const parsed = new Date(isoLike);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatCurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return `$${numeric.toFixed(2)}`;
}

function formatRelativeAge(timestamp) {
  if (!timestamp) return "Updated: --";
  const parsed = parseDashboardTimestamp(timestamp);
  if (!parsed) return `Updated: ${timestamp}`;
  const diffMs = Date.now() - parsed.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return `Updated: ${timestamp}`;
  const hrs = Math.floor(diffMs / (60 * 60 * 1000));
  if (hrs < 24) return `Updated ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `Updated ${days}d ago`;
}

function refreshBadgeStatus(timestamp) {
  if (!timestamp) return "stale";
  const parsed = parseDashboardTimestamp(timestamp);
  if (!parsed) return "stale";
  const ageDays = (Date.now() - parsed.getTime()) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays) || ageDays < 0) return "stale";
  if (ageDays < 1) return "fresh";
  if (ageDays <= 3) return "warn";
  return "stale";
}

function findLastSignalChange(strategy) {
  const rows = strategy.signalHistory || [];
  for (let i = rows.length - 1; i > 0; i -= 1) {
    if (rows[i].signalText !== rows[i - 1].signalText) {
      return { date: rows[i].date, signal: rows[i].signalText, price: rows[i].tradedOpen };
    }
  }
  return null;
}

function deriveTradeStats(strategy) {
  const history = strategy.chart?.history || [];
  if (history.length < 2) return null;

  const trades = [];
  const signalHistory = strategy.signalHistory || [];
  let openTrade = null;
  for (let i = 1; i < signalHistory.length; i += 1) {
    const prev = signalHistory[i - 1].signalText;
    const curr = signalHistory[i].signalText;
    if (curr === "BUY" && prev !== "BUY") {
      openTrade = { entryDate: signalHistory[i].date, entryPrice: Number(signalHistory[i].tradedOpen) || null, idx: i };
    }
    if (curr !== "BUY" && prev === "BUY" && openTrade?.entryPrice) {
      const exitPrice = Number(signalHistory[i].tradedOpen) || null;
      if (exitPrice) {
        const tradeReturn = exitPrice / openTrade.entryPrice - 1;
        trades.push({ tradeReturn, holdingDays: i - openTrade.idx });
      }
      openTrade = null;
    }
  }

  const wins = trades.filter((t) => t.tradeReturn > 0);
  const losses = trades.filter((t) => t.tradeReturn <= 0);
  const avg = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);

  const avgWin = avg(wins.map((t) => t.tradeReturn));
  const avgLoss = avg(losses.map((t) => t.tradeReturn));
  const winRate = trades.length ? wins.length / trades.length : null;
  const expectancy = (winRate ?? 0) * (avgWin ?? 0) + (1 - (winRate ?? 0)) * (avgLoss ?? 0);
  const profitFactor = losses.length ? Math.abs(wins.reduce((a, t) => a + t.tradeReturn, 0) / losses.reduce((a, t) => a + t.tradeReturn, 0)) : null;

  return {
    totalTrades: trades.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.tradeReturn)) : null,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.tradeReturn)) : null,
    avgHoldingDays: avg(trades.map((t) => t.holdingDays)),
  };
}

function renderRefreshHealth() {
  const timestamp = state.current?.lastUpdated;
  const badge = byId("refresh-health");
  const status = refreshBadgeStatus(timestamp);
  badge.className = `health-badge ${status}`;
  badge.innerHTML = `<span class="dot"></span><span>${esc(formatRelativeAge(timestamp))}</span>`;
}


function parseIndicatorRule(rule) {
  if (!rule) return { operator: null, threshold: null };
  const match = String(rule).match(/(<=|>=|<|>)\s*(-?\d*\.?\d+)/);
  if (!match) return { operator: null, threshold: null };
  return { operator: match[1], threshold: Number(match[2]) };
}

function indicatorProgress(indicator) {
  const raw = Number(indicator?.rawValue);
  const { threshold } = parseIndicatorRule(indicator?.rule);
  if (!Number.isFinite(raw) || !Number.isFinite(threshold)) return indicator?.passed ? 100 : 40;

  const denom = Math.max(Math.abs(threshold), 1e-6);
  const distance = Math.abs(raw - threshold);
  const closeness = Math.max(0, 100 - (distance / denom) * 100);
  const nudged = indicator?.passed ? Math.max(closeness, 72) : Math.min(closeness, 68);
  return Math.min(100, Math.max(10, nudged));
}

function renderIndicatorSummary(strategy) {
  const indicators = Array.isArray(strategy?.indicators) ? strategy.indicators : [];
  if (!indicators.length) return '<div class="indicator-block mono"><div class="indicator-empty">Indicators unavailable.</div></div>';

  const passing = indicators.filter((x) => x.passed).length;
  const rows = indicators.slice(0, 5).map((ind) => {
    const passClass = ind.passed ? "pass" : "fail";
    const progress = indicatorProgress(ind);
    const currentValue = fmt(ind.displayValue, "N/A");
    const thresholdValue = fmt(ind.rule ? ind.rule.replace(/^(<=|>=|<|>)\s*/, "") : null, "N/A");

    return `
      <div class="indicator-row ${passClass}">
        <div class="indicator-line">
          <span class="indicator-name">${esc(ind.label || ind.key || "Indicator")}</span>
          <span class="indicator-values">${esc(currentValue)} / ${esc(thresholdValue)}</span>
        </div>
        <div class="indicator-track" role="presentation">
          <span class="indicator-fill" style="width:${progress.toFixed(1)}%"></span>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="indicator-block mono">
      <div class="indicator-header">
        <span>INDICATORS</span>
        <strong>${passing} / ${indicators.length} passing</strong>
      </div>
      ${rows}
    </div>`;
}
function buildStrategyCards() {
  const container = byId("strategy-card-grid");
  container.innerHTML = "";

  const groupedProfiles = [
    { id: "tqqq", title: "TQQQ Overview", subtitle: "TQQQ-TFSA and TQQQ-RRSP", profiles: STRATEGY_PROFILES.filter((p) => p.base === "tqqq") },
    { id: "spxl", title: "SPXL Overview", subtitle: "SPXL-TFSA and SPXL-RRSP", profiles: STRATEGY_PROFILES.filter((p) => p.base === "spxl") },
  ];

  groupedProfiles.forEach((group) => {
    const block = document.createElement("section");
    block.className = "strategy-overview-block";
    block.innerHTML = `
      <div class="strategy-overview-head">
        <h2>${esc(group.title)}</h2>
        <p>${esc(group.subtitle)}</p>
      </div>
      <div class="strategy-overview-cards"></div>`;

    const cardWrap = block.querySelector(".strategy-overview-cards");

    group.profiles.forEach((profile) => {
      const strategy = state.strategies[profile.id];
      const hasData = strategy?.hasData;
      const lastChange = hasData ? findLastSignalChange(strategy) : null;
      const signalText = hasData ? (strategy.signalIsBuy ? "HOLD LONG" : "IN CASH") : "No data yet";
      const shortSignalText = hasData ? (strategy.signalIsBuy ? "LONG" : "CASH") : "N/A";

      const card = document.createElement("article");
      card.className = `strategy-card ${state.selectedStrategyId === profile.id ? "is-active" : ""}`;
      card.dataset.strategyId = profile.id;
      card.innerHTML = `
        <div class="strategy-card-head">
          <div>
            <div class="ticker-meta mono">${esc(profile.displayName.replace("-", " • "))}</div>
            <h3>${esc(profile.cardTitle)}</h3>
          </div>
          <span class="signal-badge ${hasData ? (strategy.signalIsBuy ? "buy" : "cash") : "nodata"}">
            <span class="signal-full">${esc(signalText)}</span>
            <span class="signal-short">${esc(shortSignalText)}</span>
          </span>
        </div>
        <div class="days-line"><strong class="number">${esc(hasData ? strategy.streakLength : "—")}</strong> days in position</div>
        <div class="card-metrics mono">
          <div><span>CAGR</span><strong class="good">${esc(hasData ? strategy.backtest.cagr : "No data yet")}</strong></div>
          <div><span>MAX DD</span><strong class="bad">${esc(hasData ? strategy.backtest.maxDrawdown : "No data yet")}</strong></div>
        </div>
        ${renderIndicatorSummary(hasData ? strategy : null)}
        <div class="last-change mono">Last change: ${esc(lastChange ? `${lastChange.date} · ${lastChange.signal}${formatCurrency(lastChange.price) ? ` @ ${formatCurrency(lastChange.price)}` : ""}` : hasData ? "No recent change" : "No data yet")}</div>`;

      card.addEventListener("click", () => {
        state.selectedStrategyId = profile.id;
        renderOverview();
      });

      cardWrap.appendChild(card);
    });

    container.appendChild(block);
  });
}

function buildSelectorPills() {
  const container = byId("strategy-pill-selector");
  container.innerHTML = STRATEGY_PROFILES.map((profile) => {
    const active = state.selectedStrategyId === profile.id ? "is-active" : "";
    return `<button class="strategy-pill ${active}" data-strategy-pill="${profile.id}">${esc(profile.displayName.replace("-", " · "))}</button>`;
  }).join("");

  container.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedStrategyId = button.dataset.strategyPill;
      renderOverview();
    });
  });
}

function renderOverviewCharts(strategy) {
  if (!strategy?.hasData) {
    ["overview-chart", "drawdown-chart", "rolling-cagr-chart"].forEach((id) => {
      const ctx = byId(id).getContext("2d");
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    });
    return;
  }

  const rows = pickRange(strategy.chart.history, state.activeRange);
  const strategyReturns = cumulativeReturn(rows.map((r) => r.equity));
  const buyHoldReturns = cumulativeReturn(rows.map((r) => r.tradedOpen));

  if (overviewChart) overviewChart.destroy();
  overviewChart = new Chart(byId("overview-chart").getContext("2d"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        { label: "Strategy", data: strategyReturns, borderWidth: 2, borderColor: "#E7B77C", backgroundColor: "rgba(231,183,124,0.16)", tension: 0.22, fill: true },
        { label: "Buy & Hold", data: buyHoldReturns, borderWidth: 2, borderColor: "#8A96B2", tension: 0.22, borderDash: [4, 4] },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { ticks: { callback: (v) => `${v}%`, color: "#7785A5" }, grid: { color: "rgba(129,149,182,0.2)" } },
        x: { ticks: { color: "#7785A5", maxTicksLimit: 8 }, grid: { display: false } },
      },
      plugins: {
        legend: { labels: { color: "#A8B4D0" } },
        zoom: { pan: { enabled: true, mode: "x" }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" } },
      },
    },
  });

  const equity = rows.map((r) => r.equity);
  let peak = -Infinity;
  const drawdown = equity.map((v) => {
    peak = Math.max(peak, v);
    return ((v / peak) - 1) * 100;
  });

  if (drawdownChart) drawdownChart.destroy();
  drawdownChart = new Chart(byId("drawdown-chart").getContext("2d"), {
    type: "line",
    data: { labels: rows.map((r) => r.date), datasets: [{ label: "Drawdown", data: drawdown, borderColor: "#F17379", backgroundColor: "rgba(151,41,56,0.45)", fill: true, tension: 0.16, borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { ticks: { callback: (v) => `${v}%`, color: "#7785A5" }, grid: { color: "rgba(129,149,182,0.2)" } },
        x: { ticks: { color: "#7785A5", maxTicksLimit: 6 }, grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });

  const rolling = [];
  const labels = [];
  for (let i = 252; i < rows.length; i += 1) {
    const start = rows[i - 252].equity;
    const end = rows[i].equity;
    labels.push(rows[i].date);
    rolling.push(((end / start) ** (252 / 252) - 1) * 100);
  }
  if (rollingCagrChart) rollingCagrChart.destroy();
  rollingCagrChart = new Chart(byId("rolling-cagr-chart").getContext("2d"), {
    type: "line",
    data: { labels, datasets: [{ label: "Rolling 1Y CAGR", data: rolling, borderColor: "#67A8FF", tension: 0.18, borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { ticks: { callback: (v) => `${v}%`, color: "#7785A5" }, grid: { color: "rgba(129,149,182,0.2)" } },
        x: { ticks: { color: "#7785A5", maxTicksLimit: 6 }, grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderTradeStats(strategy) {
  const container = byId("trade-stats");
  const stats = strategy?.hasData ? deriveTradeStats(strategy) : null;
  const pct = (v) => (v == null ? "No data yet" : `${(v * 100).toFixed(2)}%`);
  const num = (v) => (v == null ? "No data yet" : Number(v).toFixed(1));

  const items = [
    ["Total trades", stats?.totalTrades],
    ["Win rate", pct(stats?.winRate)],
    ["Avg win", pct(stats?.avgWin)],
    ["Avg loss", pct(stats?.avgLoss)],
    ["Expectancy", pct(stats?.expectancy)],
    ["Profit factor", num(stats?.profitFactor)],
    ["Best trade", pct(stats?.bestTrade)],
    ["Worst trade", pct(stats?.worstTrade)],
    ["Avg holding days", num(stats?.avgHoldingDays)],
  ];

  container.innerHTML = items.map(([label, value]) => `<article class="stat-card"><span>${esc(label)}</span><strong class="mono">${esc(value)}</strong></article>`).join("");
}

function renderRecentSignals(strategy) {
  const container = byId("recent-signals");
  if (!strategy?.hasData) {
    container.innerHTML = '<article class="log-item"><p>No data yet.</p></article>';
    return;
  }
  const rows = strategy.signalHistory || [];
  const changes = [];
  for (let i = rows.length - 1; i > 0; i -= 1) {
    if (rows[i].signalText !== rows[i - 1].signalText) {
      changes.push(rows[i]);
      if (changes.length >= 6) break;
    }
  }
  container.innerHTML = changes.length
    ? changes.map((r) => `<article class="log-item dark"><div class="kv"><strong>${esc(r.date)}</strong><span class="badge ${r.signalText === "BUY" ? "ok" : "warn"}">${esc(r.signalText === "BUY" ? "HOLD LONG" : "IN CASH")}</span></div><p>${esc(strategy.displayName)} signal changed at traded open ${esc(r.tradedOpen)}</p></article>`).join("")
    : '<article class="log-item"><p>No signal changes found.</p></article>';
}

function renderOverview() {
  const strategy = state.strategies[state.selectedStrategyId];
  buildStrategyCards();
  buildSelectorPills();
  renderOverviewCharts(strategy);
  renderTradeStats(strategy);
  renderRecentSignals(strategy);
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

function renderCompareSection() {
  const container = byId("compare-cards");
  container.innerHTML = "";

  Object.values(state.strategies).forEach((s) => {
    if (!s.hasData) return;
    container.appendChild(strategyCard(s, [
      { label: "Current signal", value: s.currentSignal },
      { label: `Latest open (${s.tradedTicker})`, value: s.latestOpen.traded },
      { label: "Streak", value: `${fmt(s.streakType)} ${fmt(s.streakLength)}d` },
      { label: "CAGR", value: s.backtest.cagr },
      { label: "Max drawdown", value: s.backtest.maxDrawdown },
      { label: "Trade count", value: s.backtest.tradeCount },
    ], "card compare-card"));
  });

  compareCharts.forEach((chart) => chart.destroy());
  compareCharts = [];

  const tqqqHistory = pickRange(Object.values(state.strategies).find((s) => s.hasData && s.tradedTicker === "TQQQ")?.chart?.history || [], state.activeRange);
  const spxlHistory = pickRange(Object.values(state.strategies).find((s) => s.hasData && s.tradedTicker === "SPXL")?.chart?.history || [], state.activeRange);

  const chartConfigs = [
    { canvasId: "compare-chart-tqqq", title: "TQQQ", prices: tqqqHistory.map((r) => r.tradedOpen), labels: tqqqHistory.map((r) => r.date) },
    { canvasId: "compare-chart-spxl", title: "SPXL", prices: spxlHistory.map((r) => r.tradedOpen), labels: spxlHistory.map((r) => r.date) },
    { canvasId: "compare-chart-qqq", title: "QQQ", prices: tqqqHistory.map((r) => r.sourceOpen), labels: tqqqHistory.map((r) => r.date) },
    { canvasId: "compare-chart-spy", title: "SPY", prices: spxlHistory.map((r) => r.sourceOpen), labels: spxlHistory.map((r) => r.date) },
  ];

  chartConfigs.forEach(({ canvasId, title, prices, labels }) => {
    const canvas = byId(canvasId);
    if (!canvas || !labels.length) return;
    compareCharts.push(new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: `${title} Price`, data: prices, borderWidth: 2, tension: 0.1 },
          { label: `${title} Buy & Hold Cumulative Return (%)`, data: cumulativeReturn(prices), borderWidth: 2, tension: 0.1, yAxisID: "y1" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#A8B4D0" } },
        },
        scales: {
          y: {
            title: { display: true, text: "Price", color: "#A8B4D0" },
            ticks: { color: "#7785A5" },
            grid: { color: "rgba(129,149,182,0.2)" },
          },
          y1: {
            position: "right",
            grid: { drawOnChartArea: false },
            title: { display: true, text: "Cumulative Return", color: "#A8B4D0" },
            ticks: { callback: (value) => `${value}%`, color: "#7785A5" },
          },
          x: { ticks: { color: "#7785A5", maxTicksLimit: 8 }, grid: { display: false } },
        },
      },
    }));
  });
}

function renderUpdates() {
  const latestOk = [...state.refreshLog].reverse().find((r) => r.status === "OK");
  byId("refresh-highlight").innerHTML = `
    <div class="panel-head"><h2>Latest Successful Refresh</h2></div>
    ${metricRow("Timestamp", latestOk?.timestamp)}
    ${metricRow("Latest trading day", latestOk?.latestTradingDay)}
    ${metricRow("Source", latestOk?.source)}
    ${metricRow("Commit", latestOk?.commit)}`;

  const reversedLog = [...state.refreshLog].reverse();
  const latestDate = reversedLog.length ? new Date(reversedLog[0].timestamp) : null;
  const fiveDayLog = latestDate ? reversedLog.filter((entry) => {
    const diffMs = latestDate.getTime() - new Date(entry.timestamp).getTime();
    return diffMs >= 0 && diffMs < 5 * 24 * 60 * 60 * 1000;
  }) : [];

  byId("refresh-log").innerHTML = fiveDayLog.map((r) => {
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
    if (!s.hasData) return;
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

function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function std(values) { const m = mean(values); return Math.sqrt(mean(values.map((v) => (v - m) ** 2))); }

function tokenize(input) {
  const pattern = /\s*(>=|<=|==|!=|>|<|\(|\)|,|\/|\*|\+|-|AND\b|OR\b|[A-Za-z_][A-Za-z0-9_]*|-?\d*\.?\d+)\s*/g;
  const tokens = [];
  let match;
  while ((match = pattern.exec(input)) !== null) tokens.push(match[1]);
  return tokens;
}

function buildParser(tokens, ctx) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function parseExpression() { return parseOr(); }
  function parseOr() {
    let left = parseAnd();
    while (peek() === "OR") { take(); left = Boolean(left) || Boolean(parseAnd()); }
    return left;
  }
  function parseAnd() {
    let left = parseCompare();
    while (peek() === "AND") { take(); left = Boolean(left) && Boolean(parseCompare()); }
    return left;
  }
  function parseCompare() {
    let left = parseAddSub();
    const op = peek();
    if ([">", "<", ">=", "<=", "==", "!="].includes(op)) {
      take();
      const right = parseAddSub();
      if (op === ">") return left > right;
      if (op === "<") return left < right;
      if (op === ">=") return left >= right;
      if (op === "<=") return left <= right;
      if (op === "==") return left === right;
      return left !== right;
    }
    return left;
  }
  function parseAddSub() {
    let left = parseMulDiv();
    while (["+", "-"].includes(peek())) { const op = take(); const right = parseMulDiv(); left = op === "+" ? left + right : left - right; }
    return left;
  }
  function parseMulDiv() {
    let left = parsePrimary();
    while (["*", "/"].includes(peek())) { const op = take(); const right = parsePrimary(); left = op === "*" ? left * right : left / right; }
    return left;
  }
  function parsePrimary() {
    const tok = peek();
    if (tok === "(") { take(); const value = parseExpression(); if (peek() === ")") take(); return value; }
    if (/^-?\d*\.?\d+$/.test(tok || "")) { take(); return Number(tok); }
    if (/^[A-Za-z_]/.test(tok || "")) {
      const ident = take();
      if (peek() === "(") {
        take();
        const args = [];
        while (peek() && peek() !== ")") { args.push(parseExpression()); if (peek() === ",") take(); }
        if (peek() === ")") take();
        if (ident === "COUNT_TRUE") return args.filter(Boolean).length;
        throw new Error(`Unsupported function: ${ident}`);
      }
      return ctx.getIndicator(ident);
    }
    throw new Error(`Unexpected token: ${tok || "EOF"}`);
  }

  const parsed = parseExpression();
  if (pos !== tokens.length) throw new Error(`Unexpected token near: ${tokens[pos]}`);
  return parsed;
}

function buildIndicatorContext(source, traded, i) {
  const sourceReturns = source.map((v, idx) => (idx > 0 ? v / source[idx - 1] - 1 : null));
  const emaSeries = (period) => {
    const alpha = 2 / (period + 1);
    const out = new Array(source.length).fill(null);
    let prev = null;
    for (let idx = 0; idx < source.length; idx += 1) {
      const v = source[idx]; if (v == null) continue;
      if (prev == null) prev = v; else prev = alpha * v + (1 - alpha) * prev;
      out[idx] = prev;
    }
    return out;
  };

  const emaCache = {};
  const macdCache = {};
  const getLag = (name) => { const m = name.match(/^(.*)_L(\d+)$/); return m ? { base: m[1], lag: Number(m[2]) } : { base: name, lag: 0 }; };
  const withLag = (arr, lag = 1) => { const idx = i - lag; return idx < 0 ? null : arr[idx]; };
  const window = (arr, length, lag = 1) => {
    const end = i - lag; const start = end - length + 1;
    if (start < 0 || end < 0) return null;
    const vals = arr.slice(start, end + 1);
    return vals.some((v) => v === null || Number.isNaN(v)) ? null : vals;
  };
  const sma = (n, lag = 1) => { const vals = window(source, n, lag); return vals ? mean(vals) : null; };
  const momentum = (n, lag = 1) => { const a = withLag(source, lag); const b = withLag(source, lag + n); return !a || !b ? null : a / b - 1; };
  const rv = (n, lag = 1) => { const vals = window(sourceReturns, n, lag); return vals ? std(vals) : null; };
  const slp = (n, shift, lag = 1) => { const a = sma(n, lag); const b = sma(n, lag + shift); return !a || !b ? null : a / b - 1; };
  const maxN = (n, lag = 1) => { const vals = window(source, n, lag); return vals ? Math.max(...vals) : null; };
  const minN = (n, lag = 1) => { const vals = window(source, n, lag); return vals ? Math.min(...vals) : null; };

  const get = (name) => {
    const { base, lag } = getLag(name.toUpperCase());
    const liveLag = 1 + lag;
    if (base === "OPEN") return withLag(source, liveLag);
    if (base === "ABVMA100") { const o = withLag(source, liveLag); const m = sma(100, liveLag); return o != null && m != null ? o > m : null; }
    let m = base.match(/^MOM(\d+)$/); if (m) return momentum(Number(m[1]), liveLag);
    m = base.match(/^RV(\d+)$/); if (m) return rv(Number(m[1]), liveLag);
    m = base.match(/^MAX(\d+)$/); if (m) return maxN(Number(m[1]), liveLag);
    m = base.match(/^MIN(\d+)$/); if (m) return minN(Number(m[1]), liveLag);
    m = base.match(/^(SMA_RATIO|SR|TREND_RATIO)_(\d+)_(\d+)$/);
    if (m) { const a = sma(Number(m[2]), liveLag); const b = sma(Number(m[3]), liveLag); return a != null && b != null ? a / b : null; }
    m = base.match(/^(SLP|SSLP)(\d+)_(\d+)$/); if (m) return slp(Number(m[2]), Number(m[3]), liveLag);
    m = base.match(/^VR(\d+)_(\d+)$/);
    if (m) { const a = rv(Number(m[1]), liveLag); const b = rv(Number(m[2]), liveLag); return a != null && b != null ? a / b : null; }
    m = base.match(/^MACD(\d+)_(\d+)$/);
    if (m) {
      const key = `${Number(m[1])}_${Number(m[2])}`;
      if (!macdCache[key]) {
        const ef = emaCache[Number(m[1])] || (emaCache[Number(m[1])] = emaSeries(Number(m[1])));
        const es = emaCache[Number(m[2])] || (emaCache[Number(m[2])] = emaSeries(Number(m[2])));
        macdCache[key] = ef.map((v, idx) => (v != null && es[idx] != null ? v - es[idx] : null));
      }
      return withLag(macdCache[key], liveLag);
    }
    m = base.match(/^MACDH(\d+)_(\d+)$/);
    if (m) {
      const key = `${Number(m[1])}_${Number(m[2])}`;
      if (!macdCache[key]) {
        const ef = emaCache[Number(m[1])] || (emaCache[Number(m[1])] = emaSeries(Number(m[1])));
        const es = emaCache[Number(m[2])] || (emaCache[Number(m[2])] = emaSeries(Number(m[2])));
        macdCache[key] = ef.map((v, idx) => (v != null && es[idx] != null ? v - es[idx] : null));
      }
      const histKey = `hist_${key}`;
      if (!macdCache[histKey]) {
        const macd = macdCache[key];
        const alpha = 2 / 10;
        const signal = new Array(macd.length).fill(null);
        let prev = null;
        for (let idx = 0; idx < macd.length; idx += 1) {
          const v = macd[idx]; if (v == null) continue;
          if (prev == null) prev = v; else prev = alpha * v + (1 - alpha) * prev;
          signal[idx] = prev;
        }
        macdCache[histKey] = macd.map((v, idx) => (v != null && signal[idx] != null ? v - signal[idx] : null));
      }
      return withLag(macdCache[histKey], liveLag);
    }
    if (base === "RECOVERY" || base === "RECAPTURE") { const o = withLag(source, liveLag); const mn = minN(20, liveLag + 1); return o != null && mn != null ? o / mn - 1 : null; }
    if (base === "PERSISTENCE") return [1, 2, 3].every((k) => momentum(20, liveLag + k) > 0);
    if (base === "LEVEL52") { const o = withLag(source, liveLag); const high = maxN(252, liveLag); return o != null && high != null ? o / high : null; }
    if (base === "STRETCH") { const o = withLag(source, liveLag); const m50 = sma(50, liveLag); return o != null && m50 != null ? o / m50 : null; }
    throw new Error(`Unknown indicator: ${name}`);
  };

  return { getIndicator: get, traded };
}

function runCustomBacktest(mode, formula) {
  const rows = state.testData[mode] || [];
  if (!rows.length) throw new Error("No test dataset loaded.");

  const source = rows.map((r) => r.sourceOpen);
  const traded = rows.map((r) => r.tradedOpen);
  const dates = rows.map((r) => r.date);

  const signals = [];
  for (let i = 0; i < rows.length; i += 1) {
    const ctx = buildIndicatorContext(source, traded, i);
    let signal = false;
    try { signal = Boolean(buildParser(tokenize(formula.toUpperCase()), ctx)); } catch { signal = false; }
    signals.push(signal ? 1 : 0);
  }

  let equity = 1;
  let bh = 1;
  const curve = [];
  const trades = [];
  let openTrade = null;

  for (let i = 0; i < rows.length - 1; i += 1) {
    const pos = signals[i];
    const nextRet = traded[i + 1] / traded[i] - 1;
    equity *= 1 + pos * nextRet;
    bh *= 1 + nextRet;
    curve.push({ date: dates[i], strategy: equity, buyhold: bh, signal: pos });

    const prev = i > 0 ? signals[i - 1] : 0;
    if (pos === 1 && prev === 0) openTrade = { entryDate: dates[i], entryPrice: traded[i], entryIdx: i };
    if (pos === 0 && prev === 1 && openTrade) {
      trades.push({ ...openTrade, exitDate: dates[i], exitPrice: traded[i], tradeReturn: traded[i] / openTrade.entryPrice - 1, holdingDays: i - openTrade.entryIdx });
      openTrade = null;
    }
  }
  if (openTrade) {
    const lastIdx = rows.length - 1;
    trades.push({ ...openTrade, exitDate: dates[lastIdx], exitPrice: traded[lastIdx], tradeReturn: traded[lastIdx] / openTrade.entryPrice - 1, holdingDays: lastIdx - openTrade.entryIdx });
  }

  let peak = 1;
  let maxDrawdown = 0;
  curve.forEach((r) => { peak = Math.max(peak, r.strategy); maxDrawdown = Math.min(maxDrawdown, r.strategy / peak - 1); });

  const start = curve[0]?.date;
  const end = curve[curve.length - 1]?.date;
  const years = Math.max((new Date(end) - new Date(start)) / (365.25 * 24 * 60 * 60 * 1000), 1 / 252);
  const cagr = (curve[curve.length - 1]?.strategy || 1) ** (1 / years) - 1;

  const recentEvents = [];
  for (let i = Math.max(1, curve.length - 25); i < curve.length; i += 1) {
    if (curve[i].signal !== curve[i - 1].signal) recentEvents.push({ date: curve[i].date, event: curve[i].signal ? "Signal switched to BUY" : "Signal switched to CASH" });
  }

  return { mode, sourceTicker: mode.includes("tqqq") ? "QQQ" : "SPY", tradedTicker: mode.includes("tqqq") ? "TQQQ" : "SPXL", signal: signals[signals.length - 1] ? "BUY" : "CASH", cagr, maxDrawdown, tradeCount: trades.length, start, end, curve, trades, recentEvents };
}

function renderTestSummary(result) {
  const cards = [
    { label: "Current signal", value: result.signal },
    { label: "CAGR", value: `${(result.cagr * 100).toFixed(2)}%` },
    { label: "Max drawdown", value: `${(result.maxDrawdown * 100).toFixed(2)}%` },
    { label: "Trade count", value: result.tradeCount },
    { label: "Test start date", value: result.start },
    { label: "Test end date", value: result.end },
    { label: "Source ticker", value: result.sourceTicker },
    { label: "Traded ETF", value: result.tradedTicker },
  ];
  byId("test-summary").innerHTML = cards.map((c) => `<article class="card">${metricRow(c.label, c.value)}</article>`).join("");
}

function renderTestTradeLog(result) {
  byId("trade-log-body").innerHTML = result.trades.map((t) => `<tr><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td>${esc(t.entryPrice.toFixed(2))}</td><td>${esc(t.exitPrice.toFixed(2))}</td><td>${esc(`${(t.tradeReturn * 100).toFixed(2)}%`)}</td><td>${esc(t.holdingDays)}</td></tr>`).join("");
}

function renderRecentEvents(result) {
  byId("recent-events").innerHTML = result.recentEvents.length
    ? result.recentEvents.map((e) => `<article class="log-item"><div class="kv"><strong>${esc(e.date)}</strong><span class="badge ${e.event.includes("BUY") ? "ok" : "warn"}">${esc(e.event)}</span></div></article>`).join("")
    : '<article class="log-item"><p>No recent signal changes in the latest sample window.</p></article>';
}

function renderTestChart() {
  if (!state.lastTestResult) return;
  const rows = pickRange(state.lastTestResult.curve, state.testRange);
  const strategy = cumulativeReturn(rows.map((r) => r.strategy));
  const buyhold = cumulativeReturn(rows.map((r) => r.buyhold));
  if (testChart) testChart.destroy();
  testChart = new Chart(byId("test-chart").getContext("2d"), {
    type: "line",
    data: { labels: rows.map((r) => r.date), datasets: [{ label: "Strategy (%)", data: strategy, borderWidth: 2, tension: 0.14 }, { label: "Buy & Hold (%)", data: buyhold, borderWidth: 2, tension: 0.14 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: (v) => `${v}%` } } },
      plugins: { zoom: { pan: { enabled: true, mode: "x" }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" } } },
    },
  });
}

function initTestStrategy() {
  const formulaEl = byId("tester-formula");
  const modeEl = byId("tester-mode");
  const msg = byId("tester-message");

  formulaEl.value = TEST_EXAMPLES[0];
  byId("formula-examples").innerHTML = TEST_EXAMPLES.map((f, idx) => `<button class="example-pill" data-example="${idx}">Example ${idx + 1}</button>`).join("");

  byId("formula-examples").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-example]");
    if (!btn) return;
    formulaEl.value = TEST_EXAMPLES[Number(btn.dataset.example)];
  });

  byId("run-test").addEventListener("click", () => {
    try {
      const result = runCustomBacktest(modeEl.value, formulaEl.value.trim());
      state.lastTestResult = result;
      renderTestSummary(result);
      renderTestTradeLog(result);
      renderRecentEvents(result);
      renderTestChart();
      msg.textContent = `Backtest complete for ${result.tradedTicker} from ${result.start} to ${result.end}.`;
    } catch (err) {
      msg.textContent = `Could not run formula: ${err.message}`;
    }
  });

  byId("reset-test").addEventListener("click", () => {
    formulaEl.value = TEST_EXAMPLES[0];
    modeEl.value = "tqqq_tfsa";
    msg.textContent = "Formula reset to Example 1.";
  });

  byId("test-range-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.testRange = btn.dataset.range;
    byId("test-range-toggle").querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    renderTestChart();
  });

  byId("reset-zoom").addEventListener("click", () => { if (testChart) testChart.resetZoom(); });
  byId("run-test").click();
}

function bindControls() {
  byId("range-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.activeRange = btn.dataset.range;
    byId("range-toggle").querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    renderOverview();
  });

  byId("overview-reset-zoom").addEventListener("click", () => {
    if (overviewChart) overviewChart.resetZoom();
    if (drawdownChart) drawdownChart.resetZoom?.();
    if (rollingCagrChart) rollingCagrChart.resetZoom?.();
  });
}

function toModeRows(data, sourceKey, tradedKey) {
  return data.filter((r) => r[sourceKey] != null && r[tradedKey] != null).map((r) => ({ date: r.date, sourceOpen: r[sourceKey], tradedOpen: r[tradedKey] }));
}

function emptyStrategy(profile) {
  return {
    id: profile.id,
    displayName: profile.displayName,
    subtitle: "No data yet.",
    sourceTicker: profile.base === "tqqq" ? "QQQ" : "SPY",
    tradedTicker: profile.base === "tqqq" ? "TQQQ" : "SPXL",
    currentSignal: "NO_DATA",
    signalIsBuy: false,
    currentActionText: "No data yet",
    signalChangeSummary: "No data yet",
    streakType: "N/A",
    streakLength: "No data yet",
    latestOpen: { source: "No data yet", traded: "No data yet" },
    backtest: { cagr: "No data yet", maxDrawdown: "No data yet", tradeCount: "No data yet", window: "No data yet" },
    chart: { history: [] },
    signalHistory: [],
    formula: { buy: [], sell: [], definitions: [] },
    plainEnglish: [],
    hasData: false,
  };
}

async function loadData() {
  const v = `?v=${Date.now()}`;
  const [currentRes, tqqqRes, spxlRes, refreshRes, changeRes, testerRes] = await Promise.all([
    fetch(`./data/current.json${v}`),
    fetch(`./data/strategies/tqqq.json${v}`),
    fetch(`./data/strategies/spxl.json${v}`),
    fetch(`./data/refresh_log.json${v}`),
    fetch(`./data/changelog.json${v}`),
    fetch(`./data/test_strategy_data.json${v}`),
  ]);

  if (![currentRes, refreshRes, changeRes, testerRes].every((r) => r.ok)) throw new Error("Data files are not ready. Run the workflow once.");

  state.current = await currentRes.json();
  const baseStrategies = {
    tqqq: tqqqRes.ok ? await tqqqRes.json() : null,
    spxl: spxlRes.ok ? await spxlRes.json() : null,
  };

  state.strategies = Object.fromEntries(STRATEGY_PROFILES.map((profile) => {
    const base = baseStrategies[profile.base];
    if (!base) return [profile.id, emptyStrategy(profile)];
    const merged = {
      ...structuredClone(base),
      id: profile.id,
      displayName: profile.displayName,
      subtitle: profile.subtitle || base.subtitle,
      backtest: { ...base.backtest, ...(profile.backtest || {}) },
      hasData: true,
    };
    return [profile.id, merged];
  }));

  state.refreshLog = await refreshRes.json();
  state.changelog = await changeRes.json();

  const testerData = await testerRes.json();
  const tqqqRows = toModeRows(testerData.rows || [], "qqqOpen", "tqqqOpen");
  const spxlRows = toModeRows(testerData.rows || [], "spyOpen", "spxlOpen");
  state.testData = {
    tqqq_tfsa: tqqqRows,
    tqqq_rrsp: tqqqRows,
    spxl_tfsa: spxlRows,
    spxl_rrsp: spxlRows,
  };
}

async function init() {
  try {
    tabInit();
    await loadData();

    renderRefreshHealth();
    renderOverview();
    renderCompareSection();
    renderUpdates();
    renderMethodology();
    bindControls();
    initTestStrategy();
  } catch (err) {
    const grid = byId("strategy-card-grid");
    if (grid) grid.innerHTML = `<article class="strategy-card"><h3>Dashboard not ready</h3><p>${esc(err.message)}</p></article>`;
  }
}

init();
