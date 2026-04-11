let overviewChart;
let compareCharts = [];
let testChart;

const state = {
  current: null,
  strategies: {},
  refreshLog: [],
  changelog: [],
  testData: null,
  activeRange: "FULL",
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

function renderOverviewChart(strategyId) {
  const strategy = state.strategies[strategyId];
  if (!strategy) return;
  const rows = pickRange(strategy.chart.history, state.activeRange);

  const strategyReturns = cumulativeReturn(rows.map((r) => r.equity));
  const buyHoldReturns = cumulativeReturn(rows.map((r) => r.tradedOpen));

  if (overviewChart) overviewChart.destroy();
  overviewChart = new Chart(byId("overview-chart").getContext("2d"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        { label: `${strategy.tradedTicker} Strategy Cumulative Return (%)`, data: strategyReturns, borderWidth: 2, tension: 0.15 },
        { label: `${strategy.tradedTicker} Buy & Hold Cumulative Return (%)`, data: buyHoldReturns, borderWidth: 2, tension: 0.15 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: (value) => `${value}%` } } },
    },
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

  compareCharts.forEach((chart) => chart.destroy());
  compareCharts = [];

  const tqqqHistory = pickRange(state.strategies.tqqq?.chart?.history || [], state.activeRange);
  const spxlHistory = pickRange(state.strategies.spxl?.chart?.history || [], state.activeRange);

  const chartConfigs = [
    {
      canvasId: "compare-chart-tqqq",
      title: "TQQQ",
      prices: tqqqHistory.map((r) => r.tradedOpen),
      labels: tqqqHistory.map((r) => r.date),
    },
    {
      canvasId: "compare-chart-spxl",
      title: "SPXL",
      prices: spxlHistory.map((r) => r.tradedOpen),
      labels: spxlHistory.map((r) => r.date),
    },
    {
      canvasId: "compare-chart-qqq",
      title: "QQQ",
      prices: tqqqHistory.map((r) => r.sourceOpen),
      labels: tqqqHistory.map((r) => r.date),
    },
    {
      canvasId: "compare-chart-spy",
      title: "SPY",
      prices: spxlHistory.map((r) => r.sourceOpen),
      labels: spxlHistory.map((r) => r.date),
    },
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
        scales: {
          y: { title: { display: true, text: "Price" } },
          y1: {
            position: "right",
            grid: { drawOnChartArea: false },
            title: { display: true, text: "Cumulative Return" },
            ticks: { callback: (value) => `${value}%` },
          },
        },
      },
    }));
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

  const reversedLog = [...state.refreshLog].reverse();
  const latestDate = reversedLog.length ? new Date(reversedLog[0].timestamp) : null;
  const fiveDayLog = latestDate
    ? reversedLog.filter((entry) => {
      const diffMs = latestDate.getTime() - new Date(entry.timestamp).getTime();
      return diffMs >= 0 && diffMs < 5 * 24 * 60 * 60 * 1000;
    })
    : [];

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

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values) {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

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

  function parseExpression() {
    return parseOr();
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() === "OR") {
      take();
      const right = parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  function parseAnd() {
    let left = parseCompare();
    while (peek() === "AND") {
      take();
      const right = parseCompare();
      left = Boolean(left) && Boolean(right);
    }
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
    while (["+", "-"].includes(peek())) {
      const op = take();
      const right = parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseMulDiv() {
    let left = parsePrimary();
    while (["*", "/"].includes(peek())) {
      const op = take();
      const right = parsePrimary();
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parsePrimary() {
    const tok = peek();
    if (tok === "(") {
      take();
      const value = parseExpression();
      if (peek() === ")") take();
      return value;
    }

    if (/^-?\d*\.?\d+$/.test(tok || "")) {
      take();
      return Number(tok);
    }

    if (/^[A-Za-z_]/.test(tok || "")) {
      const ident = take();
      if (peek() === "(") {
        take();
        const args = [];
        while (peek() && peek() !== ")") {
          args.push(parseExpression());
          if (peek() === ",") take();
        }
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
      const v = source[idx];
      if (v == null) continue;
      if (prev == null) prev = v;
      else prev = alpha * v + (1 - alpha) * prev;
      out[idx] = prev;
    }
    return out;
  };

  const emaCache = {};
  const macdCache = {};

  const getLag = (name) => {
    const m = name.match(/^(.*)_L(\d+)$/);
    if (!m) return { base: name, lag: 0 };
    return { base: m[1], lag: Number(m[2]) };
  };

  const withLag = (arr, lag = 1) => {
    const idx = i - lag;
    if (idx < 0) return null;
    return arr[idx];
  };

  const window = (arr, length, lag = 1) => {
    const end = i - lag;
    const start = end - length + 1;
    if (start < 0 || end < 0) return null;
    const vals = arr.slice(start, end + 1);
    if (vals.some((v) => v === null || Number.isNaN(v))) return null;
    return vals;
  };

  const sma = (n, lag = 1) => {
    const vals = window(source, n, lag);
    return vals ? mean(vals) : null;
  };

  const momentum = (n, lag = 1) => {
    const a = withLag(source, lag);
    const b = withLag(source, lag + n);
    if (!a || !b) return null;
    return a / b - 1;
  };

  const rv = (n, lag = 1) => {
    const vals = window(sourceReturns, n, lag);
    return vals ? std(vals) : null;
  };

  const slp = (n, shift, lag = 1) => {
    const a = sma(n, lag);
    const b = sma(n, lag + shift);
    if (!a || !b) return null;
    return a / b - 1;
  };

  const maxN = (n, lag = 1) => {
    const vals = window(source, n, lag);
    return vals ? Math.max(...vals) : null;
  };

  const minN = (n, lag = 1) => {
    const vals = window(source, n, lag);
    return vals ? Math.min(...vals) : null;
  };

  const get = (name) => {
    const { base, lag } = getLag(name.toUpperCase());
    const liveLag = 1 + lag;

    if (base === "OPEN") return withLag(source, liveLag);
    if (base === "ABVMA100") {
      const o = withLag(source, liveLag);
      const m = sma(100, liveLag);
      return o != null && m != null ? o > m : null;
    }

    let m = base.match(/^MOM(\d+)$/);
    if (m) return momentum(Number(m[1]), liveLag);

    m = base.match(/^RV(\d+)$/);
    if (m) return rv(Number(m[1]), liveLag);

    m = base.match(/^MAX(\d+)$/);
    if (m) return maxN(Number(m[1]), liveLag);

    m = base.match(/^MIN(\d+)$/);
    if (m) return minN(Number(m[1]), liveLag);

    m = base.match(/^(SMA_RATIO|SR|TREND_RATIO)_(\d+)_(\d+)$/);
    if (m) {
      const a = sma(Number(m[2]), liveLag);
      const b = sma(Number(m[3]), liveLag);
      return a != null && b != null ? a / b : null;
    }

    m = base.match(/^(SLP|SSLP)(\d+)_(\d+)$/);
    if (m) return slp(Number(m[2]), Number(m[3]), liveLag);

    m = base.match(/^VR(\d+)_(\d+)$/);
    if (m) {
      const a = rv(Number(m[1]), liveLag);
      const b = rv(Number(m[2]), liveLag);
      return a != null && b != null ? a / b : null;
    }

    m = base.match(/^MACD(\d+)_(\d+)$/);
    if (m) {
      const fast = Number(m[1]);
      const slow = Number(m[2]);
      const key = `${fast}_${slow}`;
      if (!macdCache[key]) {
        const ef = emaCache[fast] || (emaCache[fast] = emaSeries(fast));
        const es = emaCache[slow] || (emaCache[slow] = emaSeries(slow));
        macdCache[key] = ef.map((v, idx) => (v != null && es[idx] != null ? v - es[idx] : null));
      }
      return withLag(macdCache[key], liveLag);
    }

    m = base.match(/^MACDH(\d+)_(\d+)$/);
    if (m) {
      const fast = Number(m[1]);
      const slow = Number(m[2]);
      const key = `${fast}_${slow}`;
      if (!macdCache[key]) {
        const ef = emaCache[fast] || (emaCache[fast] = emaSeries(fast));
        const es = emaCache[slow] || (emaCache[slow] = emaSeries(slow));
        macdCache[key] = ef.map((v, idx) => (v != null && es[idx] != null ? v - es[idx] : null));
      }
      const histKey = `hist_${key}`;
      if (!macdCache[histKey]) {
        const macd = macdCache[key];
        const alpha = 2 / (9 + 1);
        const signal = new Array(macd.length).fill(null);
        let prev = null;
        for (let idx = 0; idx < macd.length; idx += 1) {
          const v = macd[idx];
          if (v == null) continue;
          if (prev == null) prev = v;
          else prev = alpha * v + (1 - alpha) * prev;
          signal[idx] = prev;
        }
        macdCache[histKey] = macd.map((v, idx) => (v != null && signal[idx] != null ? v - signal[idx] : null));
      }
      return withLag(macdCache[histKey], liveLag);
    }

    if (base === "RECOVERY" || base === "RECAPTURE") {
      const o = withLag(source, liveLag);
      const mn = minN(20, liveLag + 1);
      return o != null && mn != null ? o / mn - 1 : null;
    }

    if (base === "PERSISTENCE") {
      return [1, 2, 3].every((k) => momentum(20, liveLag + k) > 0);
    }

    if (base === "LEVEL52") {
      const o = withLag(source, liveLag);
      const high = maxN(252, liveLag);
      return o != null && high != null ? o / high : null;
    }

    if (base === "STRETCH") {
      const o = withLag(source, liveLag);
      const m50 = sma(50, liveLag);
      return o != null && m50 != null ? o / m50 : null;
    }

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
    try {
      const val = buildParser(tokenize(formula.toUpperCase()), ctx);
      signal = Boolean(val);
    } catch {
      signal = false;
    }
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
    if (pos === 1 && prev === 0) {
      openTrade = { entryDate: dates[i], entryPrice: traded[i], entryIdx: i };
    }
    if (pos === 0 && prev === 1 && openTrade) {
      trades.push({
        ...openTrade,
        exitDate: dates[i],
        exitPrice: traded[i],
        tradeReturn: traded[i] / openTrade.entryPrice - 1,
        holdingDays: i - openTrade.entryIdx,
      });
      openTrade = null;
    }
  }

  if (openTrade) {
    const lastIdx = rows.length - 1;
    trades.push({
      ...openTrade,
      exitDate: dates[lastIdx],
      exitPrice: traded[lastIdx],
      tradeReturn: traded[lastIdx] / openTrade.entryPrice - 1,
      holdingDays: lastIdx - openTrade.entryIdx,
    });
  }

  const returns = curve.map((r, idx) => (idx === 0 ? 0 : r.strategy / curve[idx - 1].strategy - 1));
  let peak = 1;
  let maxDrawdown = 0;
  curve.forEach((r) => {
    peak = Math.max(peak, r.strategy);
    maxDrawdown = Math.min(maxDrawdown, r.strategy / peak - 1);
  });

  const start = curve[0]?.date;
  const end = curve[curve.length - 1]?.date;
  const years = Math.max((new Date(end) - new Date(start)) / (365.25 * 24 * 60 * 60 * 1000), 1 / 252);
  const cagr = (curve[curve.length - 1]?.strategy || 1) ** (1 / years) - 1;

  const recentEvents = [];
  for (let i = Math.max(1, curve.length - 25); i < curve.length; i += 1) {
    if (curve[i].signal !== curve[i - 1].signal) {
      recentEvents.push({ date: curve[i].date, event: curve[i].signal ? "Signal switched to BUY" : "Signal switched to CASH" });
    }
  }

  return {
    mode,
    sourceTicker: mode === "tqqq" ? "QQQ" : "SPY",
    tradedTicker: mode === "tqqq" ? "TQQQ" : "SPXL",
    signal: signals[signals.length - 1] ? "BUY" : "CASH",
    cagr,
    maxDrawdown,
    tradeCount: trades.length,
    start,
    end,
    curve,
    trades,
    recentEvents,
  };
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
  byId("trade-log-body").innerHTML = result.trades
    .map((t) => `<tr><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td>${esc(t.entryPrice.toFixed(2))}</td><td>${esc(t.exitPrice.toFixed(2))}</td><td>${esc(`${(t.tradeReturn * 100).toFixed(2)}%`)}</td><td>${esc(t.holdingDays)}</td></tr>`)
    .join("");
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
    data: {
      labels: rows.map((r) => r.date),
      datasets: [
        { label: "Strategy (%)", data: strategy, borderWidth: 2, tension: 0.14 },
        { label: "Buy & Hold (%)", data: buyhold, borderWidth: 2, tension: 0.14 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: (v) => `${v}%` } } },
      plugins: {
        zoom: {
          pan: { enabled: true, mode: "x" },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
        },
      },
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
    modeEl.value = "tqqq";
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

  byId("reset-zoom").addEventListener("click", () => {
    if (testChart) testChart.resetZoom();
  });

  byId("run-test").click();
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

function toModeRows(data, sourceKey, tradedKey) {
  return data
    .filter((r) => r[sourceKey] != null && r[tradedKey] != null)
    .map((r) => ({ date: r.date, sourceOpen: r[sourceKey], tradedOpen: r[tradedKey] }));
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

  if (![currentRes, tqqqRes, spxlRes, refreshRes, changeRes, testerRes].every((r) => r.ok)) {
    throw new Error("Data files are not ready. Run the workflow once.");
  }

  state.current = await currentRes.json();
  state.strategies.tqqq = await tqqqRes.json();
  state.strategies.spxl = await spxlRes.json();
  state.refreshLog = await refreshRes.json();
  state.changelog = await changeRes.json();

  const testerData = await testerRes.json();
  state.testData = {
    tqqq: toModeRows(testerData.rows || [], "qqqOpen", "tqqqOpen"),
    spxl: toModeRows(testerData.rows || [], "spyOpen", "spxlOpen"),
  };
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
    initTestStrategy();
  } catch (err) {
    byId("hero").innerHTML = `<div class="hero-main"><h2>Dashboard not ready</h2><p>${err.message}</p></div>`;
  }
}

init();
