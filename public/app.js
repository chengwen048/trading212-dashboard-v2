const state = {
  portfolio: null,
  selected: null,
  range: "1y",
  interval: "1d",
  refreshTimer: null,
  shareToken: "",
  detailRequestId: 0,
  detailAbort: null,
  selectedClickTimer: null,
  selectedClickQueued: null,
  analysisTimer: null
};

const el = {
  apiKey: document.querySelector("#apiKey"),
  secretKey: document.querySelector("#secretKey"),
  saveKey: document.querySelector("#saveKey"),
  refreshNow: document.querySelector("#refreshNow"),
  aiStockInput: document.querySelector("#aiStockInput"),
  analyzeStock: document.querySelector("#analyzeStock"),
  strategyButton: document.querySelector("#strategyButton"),
  statusText: document.querySelector("#statusText"),
  connectionDot: document.querySelector("#connectionDot"),
  modeBadge: document.querySelector("#modeBadge"),
  refreshBadge: document.querySelector("#refreshBadge"),
  lastUpdated: document.querySelector("#lastUpdated"),
  totalValue: document.querySelector("#totalValue"),
  todayChange: document.querySelector("#todayChange"),
  todayPercent: document.querySelector("#todayPercent"),
  totalGain: document.querySelector("#totalGain"),
  totalGainUsd: document.querySelector("#totalGainUsd"),
  totalPercent: document.querySelector("#totalPercent"),
  marketStrip: document.querySelector("#marketStrip"),
  portfolioInsights: document.querySelector("#portfolioInsights"),
  holdingCount: document.querySelector("#holdingCount"),
  holdingsList: document.querySelector("#holdingsList"),
  selectedTicker: document.querySelector("#selectedTicker"),
  selectedName: document.querySelector("#selectedName"),
  candleChart: document.querySelector("#candleChart"),
  chartMeta: document.querySelector("#chartMeta"),
  newsSymbol: document.querySelector("#newsSymbol"),
  newsList: document.querySelector("#newsList"),
  aiReviewTitle: document.querySelector("#aiReviewTitle"),
  aiDataSource: document.querySelector("#aiDataSource"),
  aiReviewSummary: document.querySelector("#aiReviewSummary"),
  aiScore: document.querySelector("#aiScore"),
  aiAction: document.querySelector("#aiAction"),
  aiTrend: document.querySelector("#aiTrend"),
  moodScore: document.querySelector("#moodScore"),
  moodLabel: document.querySelector("#moodLabel"),
  aiLevels: document.querySelector("#aiLevels")
};

const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 2
});

const number = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2
});

boot();

async function boot() {
  wireEvents();
  initShareToken();
  const status = await loadStatus();
  applyStatus(status);
  const savedKey = sessionStorage.getItem("trading212ApiKey") || "";
  const savedSecret = sessionStorage.getItem("trading212SecretKey") || "";
  if (status.hasApiKey) {
    await loadPortfolio();
  } else if (savedKey) {
    el.apiKey.value = savedKey;
    el.secretKey.value = savedSecret;
    await saveKey(false);
  } else {
    setStatus("需要 API key", "idle");
  }
  startAutoRefresh(status.refreshMs || 5000);
}

function initShareToken() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || sessionStorage.getItem("trading212ShareToken") || "";
  state.shareToken = token;
  if (token) sessionStorage.setItem("trading212ShareToken", token);
}

function wireEvents() {
  el.saveKey.addEventListener("click", () => saveKey(true));
  if (el.refreshNow) el.refreshNow.addEventListener("click", () => loadPortfolio());
  if (el.analyzeStock) el.analyzeStock.addEventListener("click", () => analyzeSearchStock());
  if (el.strategyButton) el.strategyButton.addEventListener("click", () => analyzeSearchStock(true));
  if (el.aiStockInput) {
    el.aiStockInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") analyzeSearchStock();
    });
  }
  document.querySelectorAll(".range-buttons button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".range-buttons button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.range = button.dataset.range;
      state.interval = button.dataset.interval;
      if (state.selected) loadSelectedDetails();
    });
  });

  window.addEventListener("resize", () => {
    const candles = state.lastCandles;
    if (candles) drawCandles(candles, state.lastCostPrice);
  });
}

async function loadStatus() {
  return api("/api/status");
}

function applyStatus(status) {
  document.body.classList.toggle("public-dashboard", Boolean(status.publicDashboard));
  el.modeBadge.textContent = status.publicDashboard ? "公开只读" : "本机只读";
  el.refreshBadge.textContent = `${Math.round((status.refreshMs || 5000) / 1000)} 秒更新`;
}

async function saveKey(remember) {
  const apiKey = el.apiKey.value.trim();
  const secretKey = el.secretKey.value.trim();
  if (!apiKey) {
    setStatus("请输入 API key", "error");
    return;
  }
  if (!secretKey) {
    setStatus("请输入 secret key", "error");
    return;
  }

  await api("/api/session-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey, secretKey })
  });

  if (remember) {
    sessionStorage.setItem("trading212ApiKey", apiKey);
    sessionStorage.setItem("trading212SecretKey", secretKey);
  }
  await loadPortfolio();
}

function startAutoRefresh(refreshMs = 5000) {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (state.portfolio) loadPortfolio({ quiet: true });
  }, refreshMs);
}

async function loadPortfolio(options = {}) {
  try {
    const scrollY = window.scrollY;
    const selectedTicker = state.selected?.ticker;
    if (!options.quiet) setStatus("正在同步持仓", "idle");
    const data = await api("/api/portfolio");
    state.portfolio = data;
    if (selectedTicker) {
      state.selected = data.holdings.find((holding) => holding.ticker === selectedTicker) || state.selected;
    }
    if (!state.selected && data.holdings.length) state.selected = data.holdings[0];
    renderPortfolio({ preserveScroll: options.quiet, scrollY });
    if (state.selected && !options.quiet) await loadSelectedDetails();
    setStatus(data.stale ? "已连接，显示最近数据" : "已连接，5秒自动同步中", "live");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderPortfolio(options = {}) {
  const { holdings, totals, cash, updatedAt } = state.portfolio;
  const currency = totals.currencyCode || cash?.currencyCode || "GBP";
  document.body.classList.add("connected");
  el.totalValue.textContent = formatMoney(totals.marketValue, currency);
  el.todayChange.textContent = formatSignedMoney(totals.dayChange, currency);
  el.todayChange.className = totals.dayChange >= 0 ? "gain" : "loss";
  el.todayPercent.textContent = formatSignedPercent(totals.dayChangePercent);
  el.todayPercent.className = totals.dayChange >= 0 ? "gain" : "loss";
  el.totalGain.textContent = formatSignedMoney(totals.gainLoss, currency);
  el.totalGain.className = totals.gainLoss >= 0 ? "gain" : "loss";
  el.totalGainUsd.textContent = totals.gainLossUsd ? formatSignedMoney(totals.gainLossUsd, "USD") : "--";
  el.totalGainUsd.className = totals.gainLoss >= 0 ? "gain" : "loss";
  el.totalPercent.textContent = formatSignedPercent(totals.gainLossPercent);
  el.totalPercent.className = totals.gainLossPercent >= 0 ? "gain" : "loss";
  el.holdingCount.textContent = holdings.length;
  el.lastUpdated.textContent = `更新于 ${new Date(updatedAt).toLocaleString("zh-CN")}`;
  renderMarketStrip(holdings, currency);
  renderPortfolioInsights(holdings, totals, currency);

  if (!holdings.length) {
    el.holdingsList.innerHTML = '<p class="empty">没有读取到持仓。</p>';
    return;
  }

  el.holdingsList.innerHTML = "";
  holdings
    .slice()
    .sort((a, b) => Number(b.marketValue || 0) - Number(a.marketValue || 0))
    .forEach((holding) => {
      const itemCurrency = holding.displayCurrencyCode || holding.currencyCode || currency;
      const gainCurrency = holding.gainLossCurrencyCode || currency;
      const gainPercent = holding.costBasis > 0 ? (Number(holding.gainLoss || 0) / Number(holding.costBasis)) * 100 : holding.gainLossPercent;
      const row = document.createElement("button");
      row.className = `holding-row ${state.selected?.ticker === holding.ticker ? "active" : ""}`;
      row.type = "button";
      row.innerHTML = `
        <div class="holding-main">
          <div>
            <div class="ticker">${escapeHtml(holding.yahooSymbol || holding.ticker)}</div>
            <div class="name">${escapeHtml(holding.displayName || holding.ticker)}</div>
          </div>
          <strong>${formatMoney(holding.marketValue, itemCurrency)}</strong>
        </div>
        <div class="holding-numbers">
          <span class="${holding.gainLoss >= 0 ? "gain" : "loss"}">盈亏 ${formatSignedMoney(holding.gainLoss, gainCurrency)} · ${formatSignedPercent(gainPercent)}</span>
          <span>${formatNumber(holding.quantity)} 股 · ${escapeHtml(itemCurrency)}</span>
        </div>
      `;
      row.addEventListener("click", () => {
        selectHolding(holding);
      });
      el.holdingsList.append(row);
    });

  if (options.preserveScroll) {
    requestAnimationFrame(() => window.scrollTo(0, options.scrollY || 0));
  }
}

function renderMarketStrip(holdings, fallbackCurrency) {
  if (!el.marketStrip) return;
  el.marketStrip.innerHTML = "";
  holdings
    .slice()
    .sort((a, b) => Number(b.marketValue || 0) - Number(a.marketValue || 0))
    .slice(0, 10)
    .forEach((holding) => {
      const currency = holding.displayCurrencyCode || holding.currencyCode || fallbackCurrency;
      const gainPercent = holding.costBasis > 0 ? (Number(holding.gainLoss || 0) / Number(holding.costBasis)) * 100 : holding.gainLossPercent;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `ticker-chip ${Number(holding.gainLoss || 0) >= 0 ? "gain-border" : "loss-border"} ${state.selected?.ticker === holding.ticker ? "active" : ""}`;
      chip.innerHTML = `
        <span>${escapeHtml(holding.yahooSymbol || holding.ticker)}</span>
        <strong>${formatMoney(holding.marketValue, currency)}</strong>
        <em class="${Number(holding.gainLoss || 0) >= 0 ? "gain" : "loss"}">${formatSignedPercent(gainPercent)}</em>
      `;
      chip.addEventListener("click", () => {
        selectHolding(holding);
      });
      el.marketStrip.append(chip);
    });
}

function selectHolding(holding) {
  state.selected = holding;
  renderPortfolio({ preserveScroll: true, scrollY: window.scrollY });
  queueSelectedDetails(holding);
}

function queueSelectedDetails(holding) {
  state.selectedClickQueued = holding;
  clearTimeout(state.selectedClickTimer);
  state.selectedClickTimer = setTimeout(() => {
    if (state.selectedClickQueued) loadSelectedDetails(state.selectedClickQueued);
  }, 220);
}

function renderPortfolioInsights(holdings, totals, currency) {
  if (!el.portfolioInsights) return;
  if (!holdings.length) {
    el.portfolioInsights.innerHTML = '<p class="empty">暂无组合摘要。</p>';
    return;
  }

  const sortedByValue = holdings.slice().sort((a, b) => Number(b.marketValue || 0) - Number(a.marketValue || 0));
  const sortedByGain = holdings.slice().sort((a, b) => Number(b.gainLoss || 0) - Number(a.gainLoss || 0));
  const top = sortedByValue[0];
  const best = sortedByGain[0];
  const worst = sortedByGain[sortedByGain.length - 1];
  const topThreeValue = sortedByValue.slice(0, 3).reduce((sum, item) => sum + Number(item.marketValue || 0), 0);
  const concentration = Number(totals.marketValue) > 0 ? (topThreeValue / Number(totals.marketValue)) * 100 : null;

  el.portfolioInsights.innerHTML = `
    <article>
      <span>最大持仓</span>
      <strong>${escapeHtml(top.displayName || top.ticker)}</strong>
      <small>${formatMoney(top.marketValue, top.displayCurrencyCode || top.currencyCode || currency)}</small>
    </article>
    <article>
      <span>表现最好</span>
      <strong class="${Number(best.gainLoss || 0) >= 0 ? "gain" : "loss"}">${escapeHtml(best.yahooSymbol || best.ticker)} ${formatSignedMoney(best.gainLoss, best.gainLossCurrencyCode || currency)}</strong>
      <small>${escapeHtml(best.displayName || best.ticker)}</small>
    </article>
    <article>
      <span>表现最弱</span>
      <strong class="${Number(worst.gainLoss || 0) >= 0 ? "gain" : "loss"}">${escapeHtml(worst.yahooSymbol || worst.ticker)} ${formatSignedMoney(worst.gainLoss, worst.gainLossCurrencyCode || currency)}</strong>
      <small>${escapeHtml(worst.displayName || worst.ticker)}</small>
    </article>
    <article>
      <span>前三持仓占比</span>
      <strong>${formatSignedPercent(concentration).replace("+", "")}</strong>
      <small>${sortedByValue.slice(0, 3).map((item) => escapeHtml(item.yahooSymbol || item.ticker)).join(" / ")}</small>
    </article>
  `;
}

async function loadSelectedDetails(holding = state.selected) {
  if (!holding) return;
  const requestId = nextDetailRequest();
  el.selectedTicker.textContent = holding.yahooSymbol || holding.ticker;
  el.selectedName.textContent = holding.displayName || holding.ticker;
  el.newsSymbol.textContent = holding.yahooSymbol || holding.ticker;
  if (el.aiStockInput) el.aiStockInput.value = holding.yahooSymbol || holding.ticker;
  await Promise.allSettled([
    loadChart(holding, requestId),
    loadAiReview(holding, requestId)
  ]);
  scheduleAnalysis(holding.yahooSymbol || holding.ticker, requestId);
}

function nextDetailRequest() {
  state.detailRequestId += 1;
  clearTimeout(state.analysisTimer);
  if (state.detailAbort) state.detailAbort.abort();
  state.detailAbort = new AbortController();
  return state.detailRequestId;
}

function isCurrentDetailRequest(requestId) {
  return requestId === state.detailRequestId && !state.detailAbort?.signal.aborted;
}

function scheduleAnalysis(symbol, requestId) {
  clearTimeout(state.analysisTimer);
  el.newsList.innerHTML = '<p class="empty">停留片刻后加载分析师预期和重要消息。</p>';
  state.analysisTimer = setTimeout(() => {
    if (isCurrentDetailRequest(requestId)) loadAnalysis(symbol, requestId);
  }, 1200);
}

async function analyzeSearchStock(strategyOnly = false) {
  const symbol = el.aiStockInput?.value.trim();
  if (!symbol) {
    setStatus("请输入股票代码", "error");
    return;
  }
  const virtualHolding = {
    ticker: symbol,
    yahooSymbol: symbol,
    displayName: symbol,
    averagePrice: null,
    currentPrice: null,
    marketValue: null,
    displayCurrencyCode: symbol.includes(".") ? "USD" : "CNY"
  };
  state.selected = virtualHolding;
  const requestId = nextDetailRequest();
  el.selectedTicker.textContent = symbol;
  el.selectedName.textContent = strategyOnly ? `${symbol} 策略推演` : `${symbol} AI 分析`;
  el.newsSymbol.textContent = symbol;
  setStatus("正在生成 AI 股评", "idle");
  await Promise.allSettled([loadChart(virtualHolding, requestId), loadAiReview(virtualHolding, requestId)]);
  if (isCurrentDetailRequest(requestId)) setStatus("AI 股评已更新", "live");
}

async function loadChart(holding, requestId = state.detailRequestId) {
  const symbol = holding.yahooSymbol || holding.ticker;
  try {
    el.chartMeta.textContent = "正在读取 K 线";
    const data = await api(`/api/chart?symbol=${encodeURIComponent(symbol)}&range=${state.range}&interval=${state.interval}`, {
      signal: state.detailAbort?.signal
    });
    if (!isCurrentDetailRequest(requestId)) return;
    state.lastCandles = data.candles;
    state.lastCostPrice = Number(holding.averagePrice);
    drawCandles(data.candles, state.lastCostPrice);
    el.chartMeta.textContent = `${symbol} · ${data.range} · ${data.interval} · ${data.currency || ""}`;
  } catch (error) {
    if (isAbortError(error) || !isCurrentDetailRequest(requestId)) return;
    state.lastCandles = [];
    drawEmptyChart(error.message);
    el.chartMeta.textContent = error.message;
  }
}

async function loadAnalysis(symbol, requestId = state.detailRequestId) {
  try {
    el.newsList.innerHTML = '<p class="empty">正在读取分析师预期和重要消息。</p>';
    const data = await api(`/api/analysis?symbol=${encodeURIComponent(symbol)}`, {
      signal: state.detailAbort?.signal
    });
    if (!isCurrentDetailRequest(requestId)) return;
    const analyst = data.analyst || {};
    const analystHtml = analyst.available
      ? `
        <div class="analysis-card">
          <div class="analysis-grid">
            <div><span>平均目标价</span><strong>${formatPlainMoney(analyst.targetMeanPrice)}</strong></div>
            <div><span>目标区间</span><strong>${formatPlainMoney(analyst.targetLowPrice)} - ${formatPlainMoney(analyst.targetHighPrice)}</strong></div>
            <div><span>潜在空间</span><strong class="${analyst.upsidePercent >= 0 ? "gain" : "loss"}">${formatNumber(analyst.upsidePercent)}%</strong></div>
            <div><span>覆盖分析师</span><strong>${formatNumber(analyst.analystCount)}</strong></div>
          </div>
          <div class="analyst-strip">
            <span>强买 ${formatNumber(analyst.strongBuy)}</span>
            <span>买入 ${formatNumber(analyst.buy)}</span>
            <span>持有 ${formatNumber(analyst.hold)}</span>
            <span>卖出 ${formatNumber(analyst.sell + analyst.strongSell)}</span>
          </div>
          <p class="muted">来源：${escapeHtml(analyst.source || "公开数据源")} · 盈利预期 EPS：${formatNumber(analyst.earningsEstimateAvg)}，区间 ${formatNumber(analyst.earningsEstimateLow)} - ${formatNumber(analyst.earningsEstimateHigh)}</p>
        </div>
      `
      : `<div class="analysis-card"><p class="muted">${escapeHtml(analyst.note || "暂时没有分析师数据。")}</p></div>`;
    const sourceLinksHtml = `
      <div class="source-grid">
        ${(data.sourceLinks || [])
          .map((source) => `<a href="${escapeAttribute(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.name)}</a>`)
          .join("")}
      </div>
    `;
    const quickStatsHtml = renderQuickStats();
    const newsHtml = data.items.length
      ? data.items
      .map(
        (item) => `
          <a class="news-item ${newsDirectionClass(item.direction)}" href="${escapeAttribute(item.link)}" target="_blank" rel="noreferrer">
            <div class="news-badges">
              <span>${escapeHtml(item.direction || "中性")}</span>
              <span>重要度 ${formatNumber(item.importanceScore)}</span>
            </div>
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.source)} · ${escapeHtml(formatDate(item.publishedAt))}</span>
          </a>
        `
      )
      .join("")
      : '<p class="empty">暂时没有重要消息。</p>';
    el.newsList.innerHTML = analystHtml + sourceLinksHtml + quickStatsHtml + newsHtml;
  } catch (error) {
    if (isAbortError(error) || !isCurrentDetailRequest(requestId)) return;
    el.newsList.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

async function loadAiReview(holding, requestId = state.detailRequestId) {
  const symbol = holding.yahooSymbol || holding.ticker;
  try {
    if (isCurrentDetailRequest(requestId)) setAiLoading(symbol);
    const query = new URLSearchParams({
      symbol,
      range: state.range,
      interval: state.interval
    });
    if (Number.isFinite(Number(holding.averagePrice))) query.set("costPrice", String(holding.averagePrice));
    const data = await api(`/api/ai-review?${query.toString()}`, {
      signal: state.detailAbort?.signal
    });
    if (!isCurrentDetailRequest(requestId)) return;
    renderAiReview(data);
  } catch (error) {
    if (isAbortError(error) || !isCurrentDetailRequest(requestId)) return;
    el.aiReviewSummary.textContent = error.message;
    el.aiDataSource.textContent = "分析失败";
  }
}

function setAiLoading(symbol) {
  if (!el.aiReviewTitle) return;
  el.aiReviewTitle.textContent = `${symbol} 正在分析`;
  el.aiDataSource.textContent = "读取行情";
  el.aiReviewSummary.textContent = "正在读取 BaoStock/行情数据，计算趋势、波动、量能和关键点位。";
  el.aiScore.textContent = "--";
  el.aiAction.textContent = "--";
  el.aiTrend.textContent = "--";
  el.moodScore.textContent = "--";
  el.moodLabel.textContent = "计算中";
  el.aiLevels.innerHTML = "";
}

function renderAiReview(data) {
  const review = data.review || {};
  const levels = review.levels || {};
  const scoreClass = Number(review.score || 0) >= 60 ? "gain" : Number(review.score || 0) <= 40 ? "loss" : "";
  el.aiReviewTitle.textContent = `${data.name || data.symbol} ${formatSignedPercent(data.changePercent)}`;
  el.aiDataSource.textContent = data.source || "公开行情";
  el.aiReviewSummary.textContent = review.summary || "暂无完整股评。";
  el.aiScore.textContent = formatNumber(review.score);
  el.aiScore.className = scoreClass;
  el.aiAction.textContent = review.action || "--";
  el.aiAction.className = scoreClass;
  el.aiTrend.textContent = review.trend || "--";
  el.aiTrend.className = review.trend === "震荡偏弱" ? "loss" : review.trend === "强势多头" ? "gain" : "";
  el.moodScore.textContent = formatNumber(review.score);
  el.moodLabel.textContent = review.mood || "中性";
  el.aiLevels.innerHTML = `
    <div><span>理想买入点</span><strong class="gain">${formatPlainMoney(levels.idealBuy)}</strong></div>
    <div><span>次优买入点</span><strong>${formatPlainMoney(levels.secondaryBuy)}</strong></div>
    <div><span>止损价位</span><strong class="loss">${formatPlainMoney(levels.stopLoss)}</strong></div>
    <div><span>目标价位</span><strong class="gain">${formatPlainMoney(levels.target)}</strong></div>
  `;
}

function renderQuickStats() {
  const holding = state.selected;
  if (!holding) return "";
  const itemCurrency = holding.displayCurrencyCode || holding.currencyCode || "GBP";
  const costDistance = holding.averagePrice > 0 ? ((holding.currentPrice - holding.averagePrice) / holding.averagePrice) * 100 : null;
  return `
    <div class="quick-stats">
      <div><span>当前价</span><strong>${formatMoney(holding.currentPrice, itemCurrency)}</strong></div>
      <div><span>成本价</span><strong>${formatMoney(holding.averagePrice, itemCurrency)}</strong></div>
      <div><span>距成本</span><strong class="${costDistance >= 0 ? "gain" : "loss"}">${formatSignedPercent(costDistance)}</strong></div>
      <div><span>持仓市值</span><strong>${formatMoney(holding.marketValue, itemCurrency)}</strong></div>
    </div>
  `;
}

function newsDirectionClass(direction = "") {
  if (direction.includes("上涨")) return "news-up";
  if (direction.includes("下跌")) return "news-down";
  return "news-neutral";
}

function drawCandles(candles, costPrice) {
  const canvas = el.candleChart;
  const parent = canvas.parentElement;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.floor(parent.clientWidth * ratio);
  const height = Math.floor(Math.min(window.innerHeight * 0.54, 460) * ratio);
  canvas.width = width;
  canvas.height = Math.max(320 * ratio, height);

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(ratio, ratio);

  const w = canvas.width / ratio;
  const h = canvas.height / ratio;
  const pad = { top: 24, right: 62, bottom: 34, left: 48 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  if (!candles || candles.length < 2) {
    drawEmptyChart("没有足够的 K 线数据");
    return;
  }

  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = max - min || 1;
  const y = (price) => pad.top + ((max - price) / span) * plotH;
  const step = plotW / candles.length;
  const bodyWidth = Math.max(3, Math.min(13, step * 0.62));

  ctx.strokeStyle = "#d9e0e8";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#667085";
  ctx.font = "12px Inter, system-ui, sans-serif";

  for (let i = 0; i <= 4; i += 1) {
    const lineY = pad.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, lineY);
    ctx.lineTo(w - pad.right, lineY);
    ctx.stroke();
    const label = max - (span / 4) * i;
    ctx.fillText(number.format(label), w - pad.right + 8, lineY + 4);
  }

  candles.forEach((candle, index) => {
    const x = pad.left + index * step + step / 2;
    const up = candle.close >= candle.open;
    const color = up ? "#087443" : "#ba1a1a";
    const openY = y(candle.open);
    const closeY = y(candle.close);
    const highY = y(candle.high);
    const lowY = y(candle.low);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(closeY - openY));
    ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  });

  if (Number.isFinite(costPrice) && costPrice >= min && costPrice <= max) {
    const costY = y(costPrice);
    ctx.save();
    ctx.strokeStyle = "#1d4ed8";
    ctx.fillStyle = "#1d4ed8";
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(pad.left, costY);
    ctx.lineTo(w - pad.right, costY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(`成本 ${number.format(costPrice)}`, pad.left + 8, costY - 7);
    ctx.restore();
  }

  const first = new Date(candles[0].time).toLocaleDateString("zh-CN");
  const last = new Date(candles[candles.length - 1].time).toLocaleDateString("zh-CN");
  ctx.fillStyle = "#667085";
  ctx.fillText(first, pad.left, h - 12);
  ctx.fillText(last, Math.max(pad.left, w - pad.right - 82), h - 12);
}

function drawEmptyChart(message) {
  const canvas = el.candleChart;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#667085";
  ctx.font = "15px Inter, system-ui, sans-serif";
  ctx.fillText(message, 24, 48);
}

async function api(path, options) {
  const headers = new Headers(options?.headers || {});
  if (state.shareToken) headers.set("x-share-token", state.shareToken);
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error("这个分享链接缺少访问码，请使用完整分享链接打开。");
    }
    if (response.status === 401) {
      throw new Error("Trading 212 拒绝了这组 key。请确认 API key 和 secret key 是同一组，并且来自 live 账户。");
    }
    throw new Error(data.detail || data.error || `请求失败 ${response.status}`);
  }
  return data;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function setStatus(text, mode) {
  el.statusText.textContent = text;
  el.connectionDot.className = `dot ${mode === "live" ? "live" : mode === "error" ? "error" : ""}`;
}

function formatMoney(value, currency = "GBP") {
  if (!Number.isFinite(Number(value))) return "--";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency || "GBP",
    maximumFractionDigits: 2
  }).format(Number(value));
}

function formatSignedMoney(value, currency = "GBP") {
  if (!Number.isFinite(Number(value))) return "--";
  const amount = Math.abs(Number(value));
  const formatted = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency || "GBP",
    maximumFractionDigits: 2
  }).format(amount);
  return `${Number(value) >= 0 ? "+" : "-"}${formatted}`;
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return number.format(Number(value));
}

function formatPlainMoney(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return number.format(Number(value));
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("zh-CN");
}

function formatSignedPercent(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return `${Number(value) >= 0 ? "+" : ""}${formatNumber(value)}%`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
