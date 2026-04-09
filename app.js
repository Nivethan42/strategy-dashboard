let priceChart = null;

function byId(id) {
  return document.getElementById(id);
}

function safeText(value, fallback = "N/A") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function renderOverviewCards(cards) {
  const container = byId("overview-cards");
  container.innerHTML = "";

  cards.forEach((card) => {
    const div = document.createElement("div");
    div.className = "overview-card";
    div.innerHTML = `
      <div class="overview-label">${safeText(card.label)}</div>
      <div class="overview-value">${safeText(card.value)}</div>
    `;
    container.appendChild(div);
  });
}

function renderIndicators(indicators) {
  const container = byId("indicator-cards");
  container.innerHTML = "";

  indicators.forEach((item) => {
    const div = document.createElement("div");
    div.className = "indicator-card";
    div.innerHTML = `
      <div class="indicator-top">
        <div class="indicator-name">${safeText(item.label)}</div>
        <div class="badge ${item.passed ? "pass" : "fail"}">
          ${item.passed ? "PASS" : "FAIL"}
        </div>
      </div>
      <div class="indicator-value">${safeText(item.display_value)}</div>
      <div class="indicator-rule">Rule: ${safeText(item.rule)}</div>
      <div class="indicator-description">${safeText(item.description)}</div>
    `;
    container.appendChild(div);
  });
}

function renderStats(stats) {
  const container = byId("stats-grid");
  container.innerHTML = "";

  Object.entries(stats).forEach(([ticker, stat]) => {
    const div = document.createElement("div");
    div.className = "stat-card";
    div.innerHTML = `
      <div class="stat-label">${ticker} (Full Sample)</div>
      <div class="stat-main">CAGR: ${safeText(stat.cagr)}</div>
      <div class="indicator-rule">Max DD: ${safeText(stat.max_drawdown)}</div>
      <div class="indicator-rule">Trades: ${safeText(stat.trades)}</div>
      <div class="indicator-rule">Window: ${safeText(stat.window)}</div>
    `;
    container.appendChild(div);
  });
}

function renderList(elementId, items) {
  const el = byId(elementId);
  el.innerHTML = "";

  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    el.appendChild(li);
  });
}

function renderTable(history) {
  const body = byId("history-body");
  body.innerHTML = "";

  const recent = [...history].slice(-252).reverse();

  recent.forEach((row) => {
    const tr = document.createElement("tr");
    const isBuy = Number(row.signal) === 1;

    tr.innerHTML = `
      <td>${safeText(row.date)}</td>
      <td class="signal-cell ${isBuy ? "signal-buy" : "signal-cash"}">${safeText(row.signal_text)}</td>
      <td>${row.qqq_open ?? "N/A"}</td>
      <td>${row.sslp20_2 ?? "N/A"}</td>
      <td>${row.mom150 ?? "N/A"}</td>
      <td>${row.rv5 ?? "N/A"}</td>
      <td>${row.rv7 ?? "N/A"}</td>
      <td>${row.sr63_126 ?? "N/A"}</td>
    `;
    body.appendChild(tr);
  });
}

function renderChart(history) {
  const labels = history.map((row) => row.date);
  const qqqOpens = history.map((row) => row.qqq_open);
  const signalSeries = history.map((row) => row.signal);

  const ctx = byId("priceChart").getContext("2d");

  if (priceChart) {
    priceChart.destroy();
  }

  priceChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "QQQ Open",
          data: qqqOpens,
          borderWidth: 2,
          tension: 0.15,
          yAxisID: "y"
        },
        {
          label: "Signal (1=BUY, 0=CASH)",
          data: signalSeries,
          borderWidth: 2,
          stepped: true,
          yAxisID: "y1"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: {
        legend: {
          position: "top"
        }
      },
      scales: {
        y: {
          position: "left",
          title: {
            display: true,
            text: "QQQ Open"
          }
        },
        y1: {
          position: "right",
          min: -0.05,
          max: 1.05,
          grid: {
            drawOnChartArea: false
          },
          ticks: {
            callback: function(value) {
              if (value === 1) return "BUY";
              if (value === 0) return "CASH";
              return "";
            }
          },
          title: {
            display: true,
            text: "Signal"
          }
        }
      }
    }
  });
}

function renderHeader(latest) {
  byId("strategy-name").textContent = safeText(latest.strategy_name);
  byId("subtitle").textContent = safeText(latest.subtitle);
  byId("latest-day").textContent = `Latest trading day: ${safeText(latest.latest_trading_day)}`;
  byId("last-updated").textContent = `Last updated: ${safeText(latest.last_updated)}`;

  const pill = byId("signal-pill");
  pill.textContent = safeText(latest.market_signal);

  pill.classList.remove("buy", "sell", "neutral");
  if (latest.signal_is_buy === true) {
    pill.classList.add("buy");
  } else if (latest.signal_is_buy === false) {
    pill.classList.add("sell");
  } else {
    pill.classList.add("neutral");
  }
}

async function loadDashboard() {
  try {
    const cacheBust = `?v=${Date.now()}`;
    const [latestRes, historyRes] = await Promise.all([
      fetch(`./data/latest.json${cacheBust}`),
      fetch(`./data/history.json${cacheBust}`)
    ]);

    if (!latestRes.ok || !historyRes.ok) {
      throw new Error("Could not load dashboard data.");
    }

    const latest = await latestRes.json();
    const history = await historyRes.json();

    if (!latest || !history) {
      throw new Error("Data files are empty.");
    }

    renderHeader(latest);
    renderOverviewCards(latest.overview_cards || []);
    renderIndicators(latest.indicators || []);
    renderStats(latest.stats || {});
    renderList("formula-list", latest.formula_definitions || []);
    renderList("english-list", latest.plain_english || []);
    renderTable(history || []);
    renderChart(history || []);
  } catch (error) {
    byId("strategy-name").textContent = "Dashboard not ready yet";
    byId("subtitle").textContent = "Run the GitHub Action once, then refresh this page.";
    byId("signal-pill").textContent = "No data yet";
    byId("signal-pill").classList.remove("buy", "sell");
    byId("signal-pill").classList.add("neutral");
    console.error(error);
  }
}

loadDashboard();
setInterval(loadDashboard, 5 * 60 * 1000);
