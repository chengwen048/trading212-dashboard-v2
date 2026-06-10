import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadDotEnv();

const port = Number(process.env.PORT || 4312);
const host = process.env.HOST || "127.0.0.1";
const portfolioRefreshMs = Math.max(3000, Number(process.env.REFRESH_MS || 5000));
const publicDashboard = String(process.env.PUBLIC_DASHBOARD || "false").toLowerCase() === "true";
const shareToken = String(process.env.SHARE_TOKEN || "").trim();

let sessionApiKey = "";
let sessionSecretKey = "";
let cache = new Map();

const trading212Hosts = {
  live: "https://live.trading212.com",
  demo: "https://demo.trading212.com"
};

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function getApiKey(req) {
  const headerKey = req.headers["x-trading212-key"];
  return String(headerKey || sessionApiKey || process.env.TRADING212_API_KEY || "").trim();
}

function getSecretKey(req) {
  const headerKey = req.headers["x-trading212-secret"];
  return String(headerKey || sessionSecretKey || process.env.TRADING212_SECRET_KEY || "").trim();
}

function getBaseUrl() {
  const env = String(process.env.TRADING212_ENV || "live").toLowerCase();
  return trading212Hosts[env] || trading212Hosts.live;
}

function hasShareAccess(req, url) {
  if (!shareToken) return true;
  return req.headers["x-share-token"] === shareToken || url.searchParams.get("token") === shareToken;
}

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.value;
  try {
    const value = await loader();
    cache.set(key, { time: Date.now(), value });
    return value;
  } catch (error) {
    if (hit) return { ...hit.value, stale: true, staleReason: error.message };
    throw error;
  }
}

async function t212Fetch(req, endpoint) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    const err = new Error("Missing Trading 212 API key.");
    err.status = 401;
    throw err;
  }

  const url = `${getBaseUrl()}${endpoint}`;
  const secretKey = getSecretKey(req);
  const basicToken = secretKey ? Buffer.from(`${apiKey}:${secretKey}`).toString("base64") : "";
  const authAttempts = [
    ...(basicToken ? [{ Authorization: `Basic ${basicToken}` }] : []),
    { Authorization: apiKey },
    { Authorization: `Bearer ${apiKey}` },
    { "X-Trading212-Api-Key": apiKey }
  ];

  let response;
  let detail = "";
  for (const headers of authAttempts) {
    response = await fetch(url, { headers });
    if (response.ok || response.status !== 401) break;
    detail = await response.text();
  }

  if (!response.ok) {
    detail = detail || (await response.text());
    const err = new Error(`Trading 212 request failed: ${response.status}`);
    err.status = response.status;
    err.detail = detail.slice(0, 500);
    throw err;
  }

  return response.json();
}

async function portfolioSnapshot(req) {
  const [positions, cash, instruments] = await Promise.all([
    t212Fetch(req, "/api/v0/equity/portfolio"),
    t212Fetch(req, "/api/v0/equity/account/cash").catch(() => null),
    cached("t212-instruments", 6 * 60 * 60 * 1000, () =>
      t212Fetch(req, "/api/v0/equity/metadata/instruments").catch(() => [])
    )
  ]);

  const instrumentByTicker = new Map(
    Array.isArray(instruments) ? instruments.map((item) => [item.ticker, item]) : []
  );

  const holdings = (Array.isArray(positions) ? positions : []).map((position) => {
    const instrument = instrumentByTicker.get(position.ticker) || {};
    const quantity = Number(position.quantity || 0);
    const currentPrice = Number(position.currentPrice || position.price || 0);
    const averagePrice = Number(position.averagePrice || position.avgPrice || 0);
    const currencyCode = instrument.currencyCode || position.currencyCode || cash?.currencyCode || "";
    const displayCurrencyCode = currencyCode === "GBX" ? "GBP" : currencyCode;
    const quoteScale = currencyCode === "GBX" ? 100 : 1;
    const value = (quantity * currentPrice) / quoteScale;
    const cost = (quantity * averagePrice) / quoteScale;
    const gainLoss = Number.isFinite(Number(position.ppl)) ? Number(position.ppl) : value - cost;
    const priceReturnPercent = averagePrice > 0 ? ((currentPrice - averagePrice) / averagePrice) * 100 : null;

    return {
      ...position,
      displayName: instrument.shortName || instrument.name || position.ticker,
      currencyCode,
      displayCurrencyCode,
      gainLossCurrencyCode: "GBP",
      isin: instrument.isin || "",
      exchange: instrument.exchange || "",
      yahooSymbol: yahooSymbolFromTicker(position.ticker, instrument),
      marketValue: Number.isFinite(value) ? value : null,
      costBasis: Number.isFinite(cost) ? cost : null,
      gainLoss: Number.isFinite(gainLoss) ? gainLoss : null,
      gainLossPercent: Number.isFinite(priceReturnPercent) ? priceReturnPercent : null
    };
  });

  const marketSnapshot = await portfolioMarketSnapshot(holdings).catch(() => ({
    dayChange: null,
    dayChangePercent: null,
    usdPerGbp: null
  }));

  const accountValue = Number(cash?.total);
  const accountInvested = Number(cash?.invested);
  const accountGainLoss = Number(cash?.ppl);
  const usdPerGbp = Number(marketSnapshot.usdPerGbp);
  const totals = Number.isFinite(accountValue)
    ? {
        marketValue: accountValue,
        costBasis: Number.isFinite(accountInvested) ? accountInvested : accountValue - accountGainLoss,
        gainLoss: Number.isFinite(accountGainLoss) ? accountGainLoss : 0,
        gainLossUsd: Number.isFinite(usdPerGbp) ? accountGainLoss * usdPerGbp : null,
        dayChange: marketSnapshot.dayChange,
        dayChangePercent: marketSnapshot.dayChangePercent,
        gainLossPercent: Number.isFinite(accountInvested) && accountInvested > 0 ? (accountGainLoss / accountInvested) * 100 : 0,
        currencyCode: "GBP",
        source: "Trading 212 account summary"
      }
    : holdings.reduce(
        (acc, item) => {
          acc.marketValue += Number(item.marketValue || 0);
          acc.costBasis += Number(item.costBasis || 0);
          acc.gainLoss += Number(item.gainLoss || 0);
          return acc;
        },
        { marketValue: 0, costBasis: 0, gainLoss: 0, gainLossPercent: 0, currencyCode: "GBP", source: "Local estimate" }
      );
  if (!Number.isFinite(accountValue)) {
    totals.gainLossPercent = totals.costBasis > 0 ? (totals.gainLoss / totals.costBasis) * 100 : 0;
  }

  return {
    updatedAt: new Date().toISOString(),
    environment: process.env.TRADING212_ENV || "live",
    cash,
    holdings,
    totals
  };
}

async function portfolioMarketSnapshot(holdings) {
  const [gbpUsd, eurGbp] = await Promise.all([
    cached("fx:GBPUSD=X", 60 * 1000, () => yahooChart("GBPUSD=X", "1d", "5m")).catch(() => null),
    cached("fx:EURGBP=X", 60 * 1000, () => yahooChart("EURGBP=X", "1d", "5m")).catch(() => null)
  ]);
  const usdPerGbp = Number(gbpUsd?.regularMarketPrice || gbpUsd?.previousClose);
  const gbpPerEur = Number(eurGbp?.regularMarketPrice || eurGbp?.previousClose);

  const snapshots = await Promise.allSettled(
    holdings.map((holding) =>
      cached(`chart-day:${holding.yahooSymbol}`, 60 * 1000, () => yahooChart(holding.yahooSymbol, "1d", "5m")).then((chart) => ({
        holding,
        chart
      }))
    )
  );

  let dayChange = 0;
  let previousValue = 0;
  let usable = 0;

  for (const result of snapshots) {
    if (result.status !== "fulfilled") continue;
    const { holding, chart } = result.value;
    const current = Number(chart.regularMarketPrice || holding.currentPrice);
    const previous = Number(chart.previousClose);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;

    const scale = holding.currencyCode === "GBX" ? 100 : 1;
    const localChange = ((current - previous) * Number(holding.quantity || 0)) / scale;
    const localPreviousValue = (previous * Number(holding.quantity || 0)) / scale;
    const gbpChange = convertToGbp(localChange, holding.displayCurrencyCode || holding.currencyCode, usdPerGbp, gbpPerEur);
    const gbpPreviousValue = convertToGbp(localPreviousValue, holding.displayCurrencyCode || holding.currencyCode, usdPerGbp, gbpPerEur);
    if (!Number.isFinite(gbpChange) || !Number.isFinite(gbpPreviousValue)) continue;
    dayChange += gbpChange;
    previousValue += gbpPreviousValue;
    usable += 1;
  }

  return {
    dayChange: usable ? dayChange : null,
    dayChangePercent: previousValue > 0 ? (dayChange / previousValue) * 100 : null,
    usdPerGbp: Number.isFinite(usdPerGbp) ? usdPerGbp : null
  };
}

function convertToGbp(value, currencyCode, usdPerGbp, gbpPerEur) {
  const currency = String(currencyCode || "GBP").toUpperCase();
  if (currency === "GBP") return value;
  if (currency === "GBX") return value / 100;
  if (currency === "USD" && Number.isFinite(usdPerGbp) && usdPerGbp > 0) return value / usdPerGbp;
  if (currency === "EUR" && Number.isFinite(gbpPerEur) && gbpPerEur > 0) return value * gbpPerEur;
  return NaN;
}

function yahooSymbolFromTicker(ticker = "", instrument = {}) {
  const raw = String(ticker || instrument.ticker || "").trim();
  const shortName = String(instrument.shortName || "").trim();

  if (raw.endsWith("_US_EQ") && /^[A-Z]{1,6}$/.test(shortName)) return shortName;
  if (/l_EQ$/.test(raw)) return raw.replace(/l_EQ$/, ".L");
  if (/d_EQ$/.test(raw)) return raw.replace(/d_EQ$/, ".DE");

  const compact = raw.replace(/_US_EQ$/, "").replace(/_EQ$/, "").replace(/_/, ".");
  const exchange = String(instrument.exchange || "").toUpperCase();

  if (exchange.includes("LSE") && !compact.endsWith(".L")) return `${compact}.L`;
  if (exchange.includes("XETRA") && !compact.endsWith(".DE")) return `${compact}.DE`;
  if (exchange.includes("EURONEXT") && instrument.currencyCode === "EUR") return compact;
  return compact;
}

async function yahooChart(symbol, range = "6mo", interval = "1d") {
  const allowedRanges = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "5y"]);
  const allowedIntervals = new Set(["5m", "15m", "30m", "1h", "1d", "1wk"]);
  const cleanRange = allowedRanges.has(range) ? range : "6mo";
  const cleanInterval = allowedIntervals.has(interval) ? interval : "1d";
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", cleanRange);
  url.searchParams.set("interval", cleanInterval);

  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 portfolio viewer" }
  });
  if (!response.ok) throw new Error(`Market data request failed: ${response.status}`);

  const data = await response.json();
  const result = data.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] || {};
  const timestamps = result?.timestamp || [];

  return {
    symbol,
    range: cleanRange,
    interval: cleanInterval,
    currency: result?.meta?.currency || "",
    regularMarketPrice: result?.meta?.regularMarketPrice || null,
    previousClose: result?.meta?.chartPreviousClose || result?.meta?.previousClose || null,
    candles: timestamps
      .map((time, index) => ({
        time: time * 1000,
        open: quote.open?.[index] ?? null,
        high: quote.high?.[index] ?? null,
        low: quote.low?.[index] ?? null,
        close: quote.close?.[index] ?? null,
        volume: quote.volume?.[index] ?? null
      }))
      .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
  };
}

async function yahooAnalysis(symbol) {
  const [newsData, summaryData, marketBeatData] = await Promise.all([
    yahooNews(symbol).catch(() => []),
    yahooQuoteSummary(symbol).catch(() => null),
    marketBeatAnalysis(symbol).catch(() => null)
  ]);
  const analyst = mergeAnalystSummary(normalizeAnalystSummary(summaryData), marketBeatData);
  return {
    symbol,
    updatedAt: new Date().toISOString(),
    analyst,
    sourceLinks: analystSourceLinks(symbol),
    items: newsData.map(scoreNews).sort((a, b) => b.importanceScore - a.importanceScore)
  };
}

async function marketBeatAnalysis(symbol) {
  const root = symbol.replace(/\..+$/, "").toUpperCase();
  const exchanges = ["NASDAQ", "NYSE", "NYSEARCA"];
  for (const exchange of exchanges) {
    const url = `https://www.marketbeat.com/stocks/${exchange}/${encodeURIComponent(root)}/price-target/`;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 portfolio viewer" }
    });
    if (!response.ok) continue;
    const html = await response.text();
    const text = decodeXml(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
    const targetMatch = text.match(/average price target is\s*\$?([0-9,.]+).*?highest price target .*?\$?([0-9,.]+).*?lowest price target .*?\$?([0-9,.]+).*?upside of\s*([-0-9.]+)%/i);
    if (!targetMatch) continue;
    const countMatch = text.match(/([0-9]+)\s+analysts?\s+(?:have\s+)?(?:issued|set|provided)/i);
    return {
      available: true,
      source: "MarketBeat",
      sourceUrl: url,
      targetMeanPrice: parseMoney(targetMatch[1]),
      targetHighPrice: parseMoney(targetMatch[2]),
      targetLowPrice: parseMoney(targetMatch[3]),
      upsidePercent: Number(targetMatch[4]),
      analystCount: countMatch ? Number(countMatch[1]) : null
    };
  }
  return null;
}

function parseMoney(value) {
  const number = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function mergeAnalystSummary(yahoo, marketBeat) {
  const hasYahoo = yahoo?.available;
  const hasMarketBeat = marketBeat?.available;
  if (!hasYahoo && !hasMarketBeat) {
    return {
      available: false,
      note: "暂时没有抓到完整分析师数据；下方提供多个免费权威入口和按重要程度排序的最新消息。"
    };
  }
  return {
    available: true,
    source: marketBeat?.source || "Yahoo Finance",
    sourceUrl: marketBeat?.sourceUrl || "",
    recommendation: yahoo?.recommendation || "",
    recommendationMean: yahoo?.recommendationMean ?? null,
    analystCount: marketBeat?.analystCount ?? yahoo?.analystCount ?? null,
    currentPrice: yahoo?.currentPrice ?? null,
    targetMeanPrice: marketBeat?.targetMeanPrice ?? yahoo?.targetMeanPrice ?? null,
    targetHighPrice: marketBeat?.targetHighPrice ?? yahoo?.targetHighPrice ?? null,
    targetLowPrice: marketBeat?.targetLowPrice ?? yahoo?.targetLowPrice ?? null,
    upsidePercent: marketBeat?.upsidePercent ?? yahoo?.upsidePercent ?? null,
    strongBuy: yahoo?.strongBuy ?? null,
    buy: yahoo?.buy ?? null,
    hold: yahoo?.hold ?? null,
    sell: yahoo?.sell ?? null,
    strongSell: yahoo?.strongSell ?? null,
    earningsEstimateAvg: yahoo?.earningsEstimateAvg ?? null,
    earningsEstimateLow: yahoo?.earningsEstimateLow ?? null,
    earningsEstimateHigh: yahoo?.earningsEstimateHigh ?? null,
    revenueEstimateAvg: yahoo?.revenueEstimateAvg ?? null
  };
}

function analystSourceLinks(symbol) {
  const root = symbol.replace(/\..+$/, "").toLowerCase();
  const upper = root.toUpperCase();
  return [
    { name: "MarketBeat 目标价", url: `https://www.marketbeat.com/stocks/NASDAQ/${upper}/price-target/` },
    { name: "TipRanks Forecast", url: `https://www.tipranks.com/stocks/${root}/forecast` },
    { name: "Nasdaq Analyst Research", url: `https://www.nasdaq.com/market-activity/stocks/${root}/analyst-research` },
    { name: "MarketWatch Analyst Estimates", url: `https://www.marketwatch.com/investing/stock/${root}/analystestimates` },
    { name: "Yahoo Analysis", url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/analysis` }
  ];
}

async function yahooQuoteSummary(symbol) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData,recommendationTrend,earningsTrend`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 portfolio viewer",
      accept: "application/json"
    }
  });
  if (!response.ok) throw new Error(`Analyst data request failed: ${response.status}`);
  const data = await response.json();
  const result = data.quoteSummary?.result?.[0];
  if (!result) throw new Error(data.quoteSummary?.error?.description || "No analyst data.");
  return result;
}

function normalizeAnalystSummary(data) {
  if (!data) {
    return {
      available: false,
      note: "免费数据源暂时没有返回分析师明细；下方仍按重要程度显示相关消息。"
    };
  }
  const financial = data.financialData || {};
  const trend = data.recommendationTrend?.trend?.[0] || {};
  const earnings = data.earningsTrend?.trend?.find((item) => item.period === "0q") || data.earningsTrend?.trend?.[0] || {};
  const mean = rawNumber(financial.targetMeanPrice);
  const current = rawNumber(financial.currentPrice);
  const upside = Number.isFinite(mean) && Number.isFinite(current) && current > 0 ? ((mean - current) / current) * 100 : null;

  return {
    available: true,
    recommendation: financial.recommendationKey || "",
    recommendationMean: rawNumber(financial.recommendationMean),
    analystCount: rawNumber(financial.numberOfAnalystOpinions),
    currentPrice: current,
    targetMeanPrice: mean,
    targetHighPrice: rawNumber(financial.targetHighPrice),
    targetLowPrice: rawNumber(financial.targetLowPrice),
    upsidePercent: upside,
    strongBuy: Number(trend.strongBuy || 0),
    buy: Number(trend.buy || 0),
    hold: Number(trend.hold || 0),
    sell: Number(trend.sell || 0),
    strongSell: Number(trend.strongSell || 0),
    earningsEstimateAvg: rawNumber(earnings.earningsEstimate?.avg),
    earningsEstimateLow: rawNumber(earnings.earningsEstimate?.low),
    earningsEstimateHigh: rawNumber(earnings.earningsEstimate?.high),
    revenueEstimateAvg: rawNumber(earnings.revenueEstimate?.avg)
  };
}

function rawNumber(value) {
  const raw = value?.raw ?? value;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function scoreNews(item) {
  const title = item.title || "";
  const lower = title.toLowerCase();
  const strongUp = ["upgrade", "raises", "beats", "surges", "bullish", "buy", "outperform", "record", "profit"];
  const strongDown = ["downgrade", "cuts", "misses", "falls", "bearish", "sell", "underperform", "probe", "lawsuit", "loss"];
  const important = ["earnings", "guidance", "forecast", "analyst", "price target", "rating", "revenue", "profit", "sec", "deal"];
  const upHits = strongUp.filter((word) => lower.includes(word)).length;
  const downHits = strongDown.filter((word) => lower.includes(word)).length;
  const importanceHits = important.filter((word) => lower.includes(word)).length;
  const direction = upHits > downHits ? "上涨倾向" : downHits > upHits ? "下跌倾向" : "中性";
  return {
    ...item,
    direction,
    importanceScore: importanceHits * 3 + Math.max(upHits, downHits) * 2
  };
}

async function yahooNews(symbol) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 portfolio viewer" }
  });
  if (!response.ok) throw new Error(`News request failed: ${response.status}`);

  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map(([, item]) => ({
    title: decodeXml(pickXml(item, "title")),
    link: decodeXml(pickXml(item, "link")),
    source: decodeXml(pickXml(item, "source")) || "Yahoo Finance",
    publishedAt: decodeXml(pickXml(item, "pubDate"))
  }));
}

function pickXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "") : "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return text(res, 403, "Forbidden");

  try {
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    text(res, 200, body, types[extension] || "application/octet-stream");
  } catch {
    text(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        hasApiKey: Boolean(sessionApiKey || process.env.TRADING212_API_KEY),
        hasSecretKey: Boolean(sessionSecretKey || process.env.TRADING212_SECRET_KEY),
        environment: process.env.TRADING212_ENV || "live",
        publicDashboard,
        refreshMs: portfolioRefreshMs,
        requiresShareToken: Boolean(shareToken)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        updatedAt: new Date().toISOString()
      });
    }

    if (url.pathname.startsWith("/api/") && !hasShareAccess(req, url)) {
      return json(res, 403, { error: "Missing or invalid share token." });
    }

    if (req.method === "POST" && url.pathname === "/api/session-key") {
      if (publicDashboard && process.env.TRADING212_API_KEY && process.env.TRADING212_SECRET_KEY) {
        return json(res, 403, { error: "Public dashboard uses server-side credentials." });
      }
      const body = JSON.parse(await readBody(req) || "{}");
      sessionApiKey = String(body.apiKey || "").trim();
      sessionSecretKey = String(body.secretKey || "").trim();
      cache.delete("portfolio");
      return json(res, 200, { ok: Boolean(sessionApiKey), hasSecretKey: Boolean(sessionSecretKey) });
    }

    if (req.method === "GET" && url.pathname === "/api/portfolio") {
      const snapshot = await cached(`portfolio:${getApiKey(req).slice(-6)}`, portfolioRefreshMs, () => portfolioSnapshot(req));
      return json(res, 200, snapshot);
    }

    if (req.method === "GET" && url.pathname === "/api/chart") {
      const symbol = String(url.searchParams.get("symbol") || "").trim();
      if (!symbol) return json(res, 400, { error: "Missing symbol." });
      const data = await cached(
        `chart:${symbol}:${url.searchParams.get("range")}:${url.searchParams.get("interval")}`,
        60 * 1000,
        () => yahooChart(symbol, url.searchParams.get("range") || "6mo", url.searchParams.get("interval") || "1d")
      );
      return json(res, 200, data);
    }

    if (req.method === "GET" && url.pathname === "/api/news") {
      const symbol = String(url.searchParams.get("symbol") || "").trim();
      if (!symbol) return json(res, 400, { error: "Missing symbol." });
      const data = await cached(`news:${symbol}`, 10 * 60 * 1000, () => yahooNews(symbol));
      return json(res, 200, { symbol, items: data });
    }

    if (req.method === "GET" && url.pathname === "/api/analysis") {
      const symbol = String(url.searchParams.get("symbol") || "").trim();
      if (!symbol) return json(res, 400, { error: "Missing symbol." });
      const data = await cached(`analysis:${symbol}`, 10 * 60 * 1000, () => yahooAnalysis(symbol));
      return json(res, 200, data);
    }

    return serveStatic(req, res);
  } catch (error) {
    json(res, error.status || 500, {
      error: error.message || "Unexpected error",
      detail: error.detail || undefined
    });
  }
});

server.listen(port, host, () => {
  console.log(`Trading 212 portfolio viewer running at http://${host}:${port}`);
});
