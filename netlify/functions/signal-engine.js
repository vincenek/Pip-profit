// Netlify SCHEDULED function: signal-engine
// ---------------------------------------------------------------------------
// The accuracy-focused forex signal brain. Scheduled function (30s budget on
// Netlify). All pairs run in parallel and Gemini Flash is fast, so a run
// completes comfortably inside the limit. (Scheduled BACKGROUND functions
// aren't supported, and background functions need a paid plan — a plain
// scheduled function is the correct, free choice here.)
//
// Pipeline, per scheduled run:
//   1. Fetch the week's economic calendar ONCE (free ForexFactory feed).
//   2. For each pair: fetch ONE 1h OHLC series, resample to 4h + Daily in code.
//   3. Compute real indicators on all three timeframes:
//        trend     SMA20/50, EMA20
//        momentum  RSI(14), MACD(12,26,9), Stochastic(14,3)
//        strength  ADX(14) + DI  (the "is it even trending?" gate)
//        vol       ATR(14), Bollinger(20,2)
//        structure swing high/low
//   4. Top-down bias: Daily trend -> 4h structure -> 1h trigger, ADX-gated.
//   5. News blackout: high-impact event for either currency within +/- window.
//   6. Claude synthesises one reasoned trade with NUMERIC levels.
//   7. Self-grade: evaluate previously-open signals against fresh candles,
//      update the win-rate / avg-R track record.
//   8. Save per-pair signal + combined "latest" (with stats) to Netlify Blobs.
//
// It writes the SIGNAL + REASONING + TRACK RECORD. It does NOT place trades.
//
// AI key (set ONE — Groq strongly recommended, far more generous free tier):
//   GROQ_API_KEY         FREE, no card, thousands of req/day. https://console.groq.com/keys
//   GEMINI_API_KEY       FREE but tiny quota (0-20 req/day per model) — used only
//                        if GROQ_API_KEY is absent. https://aistudio.google.com/apikey
// Data:
//   TWELVEDATA_API_KEY   recommended.  Free OHLC. Without it -> daily-close fallback.
//
// Optional:
//   SIGNAL_PAIRS  default "EUR/USD,GBP/USD,USD/JPY"
//   GROQ_MODEL    default "llama-3.3-70b-versatile"
//   GEMINI_MODEL  default "gemini-2.0-flash"
//   NEWS_WINDOW_MIN  minutes around a high-impact event to blackout (default 60)
// ---------------------------------------------------------------------------

const { getStore, connectLambda } = require("@netlify/blobs");

const PAIRS = (process.env.SIGNAL_PAIRS || "EUR/USD,GBP/USD,USD/JPY")
  .split(",")
  .map((p) => p.trim().toUpperCase())
  .filter(Boolean);
// 8b-instant has a much larger free DAILY TOKEN budget (~500k vs ~100k for 70b)
// and is fast — the engine's math does the heavy analysis, the AI just synthesises.
// Set GROQ_MODEL=llama-3.3-70b-versatile for max reasoning (lower daily token cap).
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const TD_KEY = process.env.TWELVEDATA_API_KEY;
const NEWS_WINDOW_MIN = Number(process.env.NEWS_WINDOW_MIN || 60);
// Only alert (and surface as high-conviction) signals at/above this quality score.
const NOTIFY_MIN_SCORE = Number(process.env.NOTIFY_MIN_SCORE || 65);

exports.handler = async (event) => {
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    console.error("signal-engine: no AI key set (GROQ_API_KEY or GEMINI_API_KEY)");
    return { statusCode: 500, body: "No AI key set — add GROQ_API_KEY (recommended) or GEMINI_API_KEY" };
  }

  // Lambda-compat functions must wire up Blobs from the event before getStore().
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }

  const store = getStore("signals");

  // Economic calendar once for the whole run.
  const calendar = await getCalendar().catch((e) => {
    console.warn("calendar fetch failed:", String(e));
    return [];
  });

  // Existing ledger (track record) we will update as signals resolve.
  const ledger = (await store.get("ledger", { type: "json" })) || {
    open: [],
    closed: [],
    stats: emptyStats(),
  };

  // ADAPT: the engine's real record, fed back so the AI learns from outcomes,
  // and per-pair calibration so the quality score reflects where it actually wins.
  const perfFeedback = performanceFeedback(ledger);
  const byPairStats = calibrationByPair(ledger);

  const justClosed = []; // trades resolved this run (for result alerts)
  const manageAlerts = []; // open trades turning bad / hitting +1R (exit mgmt)

  // 1. Build snapshots + grade open trades in parallel (NO AI yet — just data).
  const built = await Promise.all(
    PAIRS.map(async (pair) => {
      try {
        const snapshot = await buildSnapshot(pair, calendar);
        evaluateOpenSignals(pair, snapshot, ledger, justClosed, manageAlerts);
        return { pair, snapshot };
      } catch (err) {
        console.error(`${pair} data failed:`, err);
        return { pair, error: String(err) };
      }
    })
  );

  // 2. ONE Gemini call for ALL pairs — 3x fewer requests = stays in free quota.
  const okBuilt = built.filter((b) => !b.error);
  let signalByPair = {};
  let aiReviews = {};
  let aiError = null;
  if (okBuilt.length) {
    try {
      const res = await analyzePairs(okBuilt.map((b) => b.snapshot), perfFeedback, ledger.open);
      signalByPair = res.signals || {};
      aiReviews = res.reviews || {};
    } catch (err) {
      aiError = String(err);
      console.error("AI batch failed:", aiError);
    }
  }

  // 2b. BEST OF BOTH — apply the AI's judgement on OPEN trades: it can close one
  //     early when the reason has broken. Code still handles all stop-trailing.
  if (Object.keys(aiReviews).length) {
    const priceByPair = {};
    for (const b of okBuilt) priceByPair[b.pair] = b.snapshot.price;
    const stillOpen = [];
    for (const o of ledger.open) {
      const rv = aiReviews[o.pair.toUpperCase()];
      const price = priceByPair[o.pair];
      if (rv && rv.verdict === "close" && price) {
        const r = currentR(o, price);
        const closedRec = {
          ...o, closedAt: new Date().toISOString(),
          outcome: r > 0.01 ? "win" : r < -0.01 ? "loss" : "scratch",
          rMultiple: Number(r.toFixed(2)), exit: "ai-close", exitReason: rv.reason, exitPrice: price,
        };
        ledger.closed.unshift(closedRec);
        justClosed.push(closedRec);
        manageAlerts.push({ type: "close", pair: o.pair, direction: o.direction, entry: o.entry, reason: `AI review: ${rv.reason}`, rNow: r });
      } else {
        stillOpen.push(o);
      }
    }
    ledger.open = stillOpen;
  }

  // 3. Assemble records, score, track.
  const signals = [];
  const justOpened = []; // new actionable signals this run (for entry alerts)
  for (const b of built) {
    if (b.error) {
      signals.push({ pair: b.pair, error: b.error });
      continue;
    }
    const signal = signalByPair[b.pair];
    if (!signal) {
      signals.push({ pair: b.pair, error: aiError || "no signal returned for this pair" });
      continue;
    }
    // The AI decides DIRECTION + conviction + reasoning (what it's good at). We
    // compute the exact entry/stop/targets from ATR + structure (what code is
    // perfect at) — always valid, always proper R:R. No more "auto-rejected".
    if (signal.direction === "buy" || signal.direction === "sell") {
      applyComputedLevels(signal, b.snapshot);
    }
    // Final sanity guardrail (should always pass for computed levels).
    const invalid = validateSignal(signal, b.snapshot);
    if (invalid) {
      signal.direction = "no_trade";
      signal.headline = "Signal auto-rejected (failed validation)";
      signal.technical_reasoning = `Rejected: ${invalid}. ` + (signal.technical_reasoning || "");
    }
    // Per-pair calibration once we have a few samples; else overall.
    const pairCal = byPairStats[b.pair];
    const cal = pairCal && pairCal.total >= 5
      ? pairCal
      : { winRate: ledger.stats.winRate, total: ledger.stats.total };
    const quality = qualityScore(b.snapshot, signal, cal);
    const record = {
      ...signal,
      pair: b.pair,
      qualityScore: quality,
      generatedAt: new Date().toISOString(),
      snapshot: {
        price: b.snapshot.price,
        bias: b.snapshot.bias,
        biasScore: b.snapshot.biasScore,
        regime: b.snapshot.regime,
        newsBlackout: b.snapshot.newsBlackout,
        session: b.snapshot.session,
        upcomingEvents: b.snapshot.events.slice(0, 4),
      },
    };
    await store.setJSON(`pair:${keyFor(b.pair)}`, record);
    signals.push(record);

    if (trackNewSignal(record, b.snapshot, ledger)) justOpened.push(record);
  }

  recomputeStats(ledger);

  // Notifications first (dedup keys are recorded on the ledger), THEN persist the
  // ledger so a sent alert is never emailed twice.
  await dispatchAlerts(justOpened, justClosed, manageAlerts, ledger);

  await store.setJSON("ledger", ledger);
  await store.setJSON("latest", {
    generatedAt: new Date().toISOString(),
    signals,
    stats: ledger.stats,
    calibration: ledger.stats, // historical hit-rate the dashboard surfaces
    open: ledger.open,              // currently tracked trades (for duration)
    history: ledger.closed.slice(0, 25), // resolved trades: hit TP (win) vs SL (loss)
  });

  console.log(
    "signal-engine done:", signals.length, "pairs; winRate", ledger.stats.winRate,
    "| opened", justOpened.length, "closed", justClosed.length
  );
  return { statusCode: 200, body: JSON.stringify({ count: signals.length }) };
};

function keyFor(pair) {
  return pair.replace("/", "-");
}

// Parse a "YYYY-MM-DD HH:MM:SS" candle time as UTC, regardless of server timezone.
function tparseUTC(dt) {
  if (!dt) return NaN;
  const iso = dt.includes("T") ? dt : dt.replace(" ", "T");
  return Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
}

// ===========================================================================
// SNAPSHOT — data + indicators across three timeframes
// ===========================================================================
async function buildSnapshot(pair, calendar) {
  let d1, h4, h1, w1;

  if (TD_KEY) {
    const base = await getCandles(pair); // cached -> avoids Twelve Data 429s
    h1 = analyse(base);
    h4 = analyse(resample(base, h4Key));
    d1 = analyse(resample(base, d1Key));
    w1 = analyse(resample(base, w1Key));
  } else {
    const daily = await frankfurterDaily(pair, 300);
    d1 = analyse(daily);
    h4 = analyse(daily);
    h1 = analyse(daily);
    w1 = d1;
  }

  const price = h1.closes[h1.closes.length - 1];
  const { score, factors, regime } = scoreBias(w1, d1, h4, h1, price);

  // Nearest structural levels — used to reject entries with no room to target
  // (e.g. don't buy right under resistance).
  const levels = [h4.swingHigh, h4.swingLow, d1.swingHigh, d1.swingLow].filter(Number.isFinite);
  const above = levels.filter((l) => l > price).sort((a, b) => a - b);
  const below = levels.filter((l) => l < price).sort((a, b) => b - a);
  const nearestResistance = above[0] || null;
  const nearestSupport = below[0] || null;

  // News blackout: high-impact events for either currency, near now.
  const [c1, c2] = pair.split("/");
  const now = Date.now();
  const events = calendar
    .filter((e) => (e.country === c1 || e.country === c2))
    .filter((e) => e.impact === "High" || e.impact === "Medium")
    .map((e) => ({ ...e, minutesAway: Math.round((e.ts - now) / 60000) }))
    .filter((e) => e.minutesAway > -180 && e.minutesAway < 1440) // recent past .. next 24h
    .sort((a, b) => Math.abs(a.minutesAway) - Math.abs(b.minutesAway));
  const newsBlackout = events.some(
    (e) => e.impact === "High" && Math.abs(e.minutesAway) <= NEWS_WINDOW_MIN
  );

  return {
    pair,
    price,
    atr: h1.atr,
    w1: summarize(w1),
    d1: summarize(d1),
    h4: summarize(h4),
    h1: summarize(h1),
    biasScore: score,
    bias: score >= 3 ? "bullish" : score <= -3 ? "bearish" : "mixed",
    regime,
    confluence: factors,
    nearestResistance: r5(nearestResistance),
    nearestSupport: r5(nearestSupport),
    events,
    newsBlackout,
    session: sessionInfo(pair),
    hasIntraday: !!TD_KEY,
    // raw arrays kept for signal evaluation
    _h1raw: h1,
  };
}
function r5(n) { return n == null ? null : Number(n.toFixed(5)); }

// Liquidity / session awareness — spreads are tightest and moves cleanest when
// a major session for the pair's currencies is open. Trading dead hours is a
// common way to get chopped up, so we factor this into the quality score.
function sessionInfo(pair) {
  const h = new Date().getUTCHours();
  const london = h >= 7 && h < 16;   // London
  const ny = h >= 12 && h < 21;      // New York
  const tokyo = h >= 23 || h < 8;    // Tokyo
  const [b, q] = pair.split("/");
  const hasJPY = b === "JPY" || q === "JPY";
  const hasUSDorEUR = /USD|EUR|GBP|CHF|CAD/.test(pair);
  let active = false;
  const names = [];
  if (london) names.push("London");
  if (ny) names.push("New York");
  if (tokyo) names.push("Tokyo");
  if (hasJPY) active = tokyo || london || ny;
  else active = (london || ny) && hasUSDorEUR;
  const overlap = london && ny; // London/NY overlap = peak liquidity
  return { active, overlap, open: names.join("+") || "off-hours" };
}

// Cached candle fetch — reuse data for up to ~55 min so repeated runs (Run-now
// clicks, overlapping cron) don't burn Twelve Data's 8-calls/minute free limit.
const CANDLE_CACHE_MIN = Number(process.env.CANDLE_CACHE_MIN || 25);
async function getCandles(pair) {
  const store = getStore("signals");
  const key = `candles:${keyFor(pair)}`;
  const cached = await store.get(key, { type: "json" }).catch(() => null);
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < CANDLE_CACHE_MIN * 60000) {
    return cached.base;
  }
  const base = await twelveData(pair, "1h", 5000);
  await store.setJSON(key, { fetchedAt: Date.now(), base }).catch(() => {});
  return base;
}

// --- Twelve Data ------------------------------------------------------------
async function twelveData(pair, interval, outputsize) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}` +
    `&interval=${interval}&outputsize=${outputsize}&apikey=${TD_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TwelveData ${res.status}`);
  const data = await res.json();
  if (data.status === "error") throw new Error(`TwelveData: ${data.message}`);
  const values = (data.values || []).slice().reverse(); // chronological
  if (values.length < 60) throw new Error(`TwelveData: too few candles for ${pair}`);
  return {
    datetimes: values.map((v) => v.datetime),
    opens: values.map((v) => +v.open),
    highs: values.map((v) => +v.high),
    lows: values.map((v) => +v.low),
    closes: values.map((v) => +v.close),
  };
}

// --- Frankfurter fallback (daily closes only, no key) ----------------------
async function frankfurterDaily(pair, days) {
  const [base, quote] = pair.split("/");
  const end = new Date();
  const start = new Date(end.getTime() - days * 2 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://api.frankfurter.dev/v1/${fmt(start)}..${fmt(end)}?base=${base}&symbols=${quote}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const data = await res.json();
  const dates = Object.keys(data.rates || {}).sort();
  const closes = dates.map((d) => data.rates[d][quote]);
  if (closes.length < 60) throw new Error(`Frankfurter: too few closes for ${pair}`);
  return { datetimes: dates, opens: closes, highs: closes, lows: closes, closes };
}

// --- Economic calendar (free ForexFactory weekly JSON) ---------------------
async function getCalendar() {
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: { "User-Agent": "PipProfit-Signal/1.0", accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Calendar ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((e) => ({
    title: e.title,
    country: e.country, // currency code, e.g. "USD"
    impact: e.impact, // "High" | "Medium" | "Low" | "Holiday"
    forecast: e.forecast,
    previous: e.previous,
    ts: Date.parse(e.date),
  }));
}

// --- timeframe resampling (1h -> 4h / daily / weekly) ----------------------
function h4Key(dt) {
  const day = dt.slice(0, 10);
  const hour = Number(dt.slice(11, 13)) || 0;
  return day + "#" + Math.floor(hour / 4);
}
function d1Key(dt) {
  return dt.slice(0, 10);
}
function w1Key(dt) {
  // ISO week bucket: year + week number (UTC).
  const d = new Date(dt.replace(" ", "T") + "Z");
  const onejan = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.floor((d.getTime() - onejan) / (7 * 86400000));
  return d.getUTCFullYear() + "W" + week;
}
function resample(series, keyFn) {
  const { opens, highs, lows, closes, datetimes } = series;
  const out = { opens: [], highs: [], lows: [], closes: [], datetimes: [] };
  let curKey = null;
  let o, h, l, c, dt;
  for (let i = 0; i < closes.length; i++) {
    const k = keyFn(datetimes[i]);
    if (k !== curKey) {
      if (curKey !== null) {
        out.opens.push(o); out.highs.push(h); out.lows.push(l); out.closes.push(c); out.datetimes.push(dt);
      }
      curKey = k; o = opens[i]; h = highs[i]; l = lows[i]; c = closes[i]; dt = datetimes[i];
    } else {
      h = Math.max(h, highs[i]); l = Math.min(l, lows[i]); c = closes[i];
    }
  }
  if (curKey !== null) {
    out.opens.push(o); out.highs.push(h); out.lows.push(l); out.closes.push(c); out.datetimes.push(dt);
  }
  return out;
}

// ===========================================================================
// INDICATOR ENGINE
// ===========================================================================
function analyse(series) {
  const { highs, lows, closes } = series;
  return {
    ...series,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    ema20: ema(closes, 20),
    rsi14: rsi(closes, 14),
    atr: atr(highs, lows, closes, 14),
    macd: macd(closes, 12, 26, 9),
    adx: adx(highs, lows, closes, 14),
    bb: bollinger(closes, 20, 2),
    stoch: stochastic(highs, lows, closes, 14, 3),
    swingHigh: Math.max(...highs.slice(-20)),
    swingLow: Math.min(...lows.slice(-20)),
  };
}

function summarize(tf) {
  const price = tf.closes[tf.closes.length - 1];
  return {
    price,
    sma20: r(tf.sma20), sma50: r(tf.sma50), ema20: r(tf.ema20),
    rsi14: r(tf.rsi14, 1),
    atr: r(tf.atr),
    macdHist: r(tf.macd.hist),
    adx: tf.adx ? r(tf.adx.adx, 1) : null,
    plusDI: tf.adx ? r(tf.adx.plusDI, 1) : null,
    minusDI: tf.adx ? r(tf.adx.minusDI, 1) : null,
    bbPctB: tf.bb ? r(tf.bb.pctB, 2) : null,
    bbUpper: tf.bb ? r(tf.bb.upper) : null,
    bbLower: tf.bb ? r(tf.bb.lower) : null,
    stochK: tf.stoch ? r(tf.stoch.k, 1) : null,
    stochD: tf.stoch ? r(tf.stoch.d, 1) : null,
    swingHigh: r(tf.swingHigh), swingLow: r(tf.swingLow),
    aboveSma50: price > tf.sma50,
  };
}

// Top-down confluence + regime (Weekly -> Daily -> 4H -> 1H).
function scoreBias(w1, d1, h4, h1, price) {
  let score = 0;
  const factors = [];
  const add = (cond, up, label) => {
    if (!cond) return;
    score += up ? 1 : -1;
    factors.push((up ? "▲ " : "▼ ") + label);
  };

  // Weekly = the dominant trend. Counts double (added twice) so trades that
  // fight the big-picture trend get a strong negative bias.
  if (Number.isFinite(w1.sma20)) {
    const wkClose = w1.closes[w1.closes.length - 1];
    const wkBull = wkClose > w1.sma20;
    add(wkBull, true, "Weekly above 20-wk MA");
    add(wkBull, true, "Weekly uptrend (confirmed)");
    add(!wkBull, false, "Weekly below 20-wk MA");
    add(!wkBull, false, "Weekly downtrend (confirmed)");
  }

  // Daily trend = the master intraday filter
  add(d1.sma20 > d1.sma50, true, "Daily uptrend (SMA20>SMA50)");
  add(d1.sma20 < d1.sma50, false, "Daily downtrend (SMA20<SMA50)");
  add(price > d1.sma50, true, "Above Daily SMA50");
  add(price < d1.sma50, false, "Below Daily SMA50");

  // 4h structure
  add(h4.sma20 > h4.sma50, true, "4h trend up");
  add(h4.sma20 < h4.sma50, false, "4h trend down");
  add(h4.macd.hist > 0, true, "4h MACD positive");
  add(h4.macd.hist < 0, false, "4h MACD negative");

  // 1h trigger
  add(h1.macd.hist > 0, true, "1h MACD positive");
  add(h1.macd.hist < 0, false, "1h MACD negative");
  add(h1.rsi14 > 50 && h1.rsi14 < 70, true, "1h RSI bullish");
  add(h1.rsi14 < 50 && h1.rsi14 > 30, false, "1h RSI bearish");
  if (h1.rsi14 >= 70) factors.push("⚠ 1h RSI overbought");
  if (h1.rsi14 <= 30) factors.push("⚠ 1h RSI oversold");

  // Regime from ADX (4h): >25 trending, <20 ranging.
  const adxVal = h4.adx ? h4.adx.adx : null;
  let regime = "unknown";
  if (adxVal != null) {
    if (adxVal >= 25) regime = "trending";
    else if (adxVal < 20) regime = "ranging";
    else regime = "transitional";
    factors.push(`ADX(4h)=${adxVal.toFixed(0)} → ${regime}`);
  }

  return { score, factors, regime };
}

// --- math ------------------------------------------------------------------
function sma(a, p) { if (a.length < p) return NaN; return a.slice(-p).reduce((x, y) => x + y, 0) / p; }
function ema(a, p) {
  if (a.length < p) return NaN;
  const k = 2 / (p + 1);
  let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}
function emaSeries(a, p) {
  const out = []; const k = 2 / (p + 1);
  let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p; out[p - 1] = e;
  for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsi(c, p) {
  if (c.length < p + 1) return NaN;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  const ag = g / p, al = l / p; if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function atr(h, l, c, p) {
  if (c.length < p + 1) return NaN;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  return sma(tr, p);
}
function macd(c, f, s, sig) {
  const ef = emaSeries(c, f), es = emaSeries(c, s);
  const line = [];
  for (let i = 0; i < c.length; i++) if (ef[i] != null && es[i] != null) line[i] = ef[i] - es[i];
  const compact = line.filter((v) => v != null);
  const sl = emaSeries(compact, sig);
  const m = compact[compact.length - 1], sg = sl[sl.length - 1];
  return { macd: m, signal: sg, hist: m - sg };
}
function adx(h, l, c, p) {
  const len = c.length; if (len < 2 * p + 1) return null;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  const sm = (arr) => { const o = []; let s = arr.slice(0, p).reduce((a, b) => a + b, 0); o[p - 1] = s; for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; o[i] = s; } return o; };
  const trS = sm(tr), pS = sm(pdm), mS = sm(mdm);
  const dx = [];
  for (let i = p - 1; i < tr.length; i++) {
    if (trS[i] == null || trS[i] === 0) continue;
    const pdi = 100 * pS[i] / trS[i], mdi = 100 * mS[i] / trS[i];
    const den = pdi + mdi; dx.push(den === 0 ? 0 : 100 * Math.abs(pdi - mdi) / den);
  }
  if (dx.length < p) return null;
  let a = dx.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < dx.length; i++) a = (a * (p - 1) + dx[i]) / p;
  const lastT = trS[trS.length - 1];
  return { adx: a, plusDI: 100 * pS[pS.length - 1] / lastT, minusDI: 100 * mS[mS.length - 1] / lastT };
}
function bollinger(c, p, mult) {
  if (c.length < p) return null;
  const s = c.slice(-p); const mean = s.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  const upper = mean + mult * sd, lower = mean - mult * sd, price = c[c.length - 1];
  return { mid: mean, upper, lower, pctB: (price - lower) / ((upper - lower) || 1), bandwidth: (upper - lower) / mean };
}
function stochastic(h, l, c, kP, dP) {
  if (c.length < kP + dP) return null;
  const ks = [];
  for (let i = c.length - dP; i < c.length; i++) {
    const hh = Math.max(...h.slice(i - kP + 1, i + 1));
    const ll = Math.min(...l.slice(i - kP + 1, i + 1));
    ks.push(hh === ll ? 50 : 100 * (c[i] - ll) / (hh - ll));
  }
  return { k: ks[ks.length - 1], d: ks.reduce((a, b) => a + b, 0) / ks.length };
}
function r(n, d = 5) { if (n == null || Number.isNaN(n)) return null; return Number(n.toFixed(d)); }

// ===========================================================================
// TRACK RECORD — self-grading against real price
// ===========================================================================
function emptyStats() {
  return { total: 0, wins: 0, losses: 0, breakeven: 0, open: 0, winRate: 0, avgR: 0, totalR: 0 };
}

function trackNewSignal(record, snapshot, ledger) {
  if (!record.direction || record.direction === "no_trade") return false;
  if (!record.entry_price || !record.stop_loss_price || !record.tp1_price) return false;
  // MINIMISE LOSSES: only actually "take" (track + alert) high-quality setups.
  if ((record.qualityScore || 0) < NOTIFY_MIN_SCORE) return false;
  // One open signal per pair at a time.
  if (ledger.open.some((o) => o.pair === record.pair)) return false;
  ledger.open.push({
    id: `${keyFor(record.pair)}-${Date.now()}`,
    pair: record.pair,
    direction: record.direction,
    entry: record.entry_price,
    sl: record.stop_loss_price,      // original (initial) stop
    tp1: record.tp1_price,
    tp2: record.tp2_price,           // final target (~3R)
    timeframe: record.timeframe,
    qualityScore: record.qualityScore,
    openedAt: record.generatedAt,
    openedTs: Date.parse(record.generatedAt),
    // Active-management state (the 24/7 manager):
    peakR: 0,                        // best favourable excursion reached
    lockedR: -1,                     // -1 = original stop; 0 = breakeven; 1 = +1R; ...
    currentStop: record.stop_loss_price,
    stage: "initial",
    alertedLockedR: -1,
  });
  return true;
}

function evaluateOpenSignals(pair, snapshot, ledger, justClosed, manageAlerts) {
  const raw = snapshot._h1raw;
  const still = [];
  for (const o of ledger.open) {
    if (o.pair !== pair) { still.push(o); continue; }

    // 1. Simulate the trade with the TRAILING stop (breakeven at +1R, trail 1R
    //    behind each milestone after). Returns a close, or updates live state.
    const graded = raw && raw.datetimes ? gradeWithTrailing(o, raw) : { closed: false };
    if (graded.closed) {
      const closedRec = { ...o, ...graded, closedAt: new Date().toISOString() };
      ledger.closed.unshift(closedRec);
      if (justClosed) justClosed.push(closedRec);
      continue;
    }

    // 2. Active management on the still-open trade.
    const action = manageOpenTrade(o, snapshot);
    if (action && action.type === "close") {
      // CUT EARLY: thesis broke — close now at current price (don't wait for stop).
      const r = currentR(o, snapshot.price);
      const closedRec = {
        ...o, closedAt: new Date().toISOString(),
        outcome: r > 0.01 ? "win" : r < -0.01 ? "loss" : "scratch",
        rMultiple: Number(r.toFixed(2)), exit: "managed-close", exitReason: action.reason,
        exitPrice: snapshot.price,
      };
      ledger.closed.unshift(closedRec);
      if (justClosed) justClosed.push(closedRec);
      if (manageAlerts) manageAlerts.push({ ...action, pair: o.pair, direction: o.direction, entry: o.entry });
      continue; // removed from open
    }
    if (action && action.type === "trail" && manageAlerts) {
      manageAlerts.push({ ...action, pair: o.pair, direction: o.direction, entry: o.entry });
    }
    still.push(o);
  }
  ledger.open = ledger.open.filter((o) => o.pair !== pair).concat(still.filter((o) => o.pair === pair));
  ledger.closed = ledger.closed.slice(0, 200);
}

function currentR(o, price) {
  const risk = Math.abs(o.entry - o.sl) || 1e-9;
  return (o.direction === "buy" ? price - o.entry : o.entry - price) / risk;
}

// Active management: cut early when the reason breaks; alert when the trailing
// stop (already moved by gradeWithTrailing) steps up.
function manageOpenTrade(o, s) {
  const buy = o.direction === "buy";
  const rNow = currentR(o, s.price);

  const biasAgainst = buy ? s.biasScore <= -2 : s.biasScore >= 2;
  const momAgainst = buy ? s.h1.macdHist < 0 : s.h1.macdHist > 0;
  const news = s.newsBlackout;

  // Only cut a trade that isn't already protected in profit (lockedR < 0 means
  // still on the original stop). Once trailed to breakeven+, let the stop work.
  if ((o.lockedR == null || o.lockedR < 0) &&
      (biasAgainst || (rNow < -0.7 && momAgainst) || (news && rNow < 0.3))) {
    const reasons = [];
    if (biasAgainst) reasons.push("higher-timeframe bias flipped against the trade");
    if (rNow < -0.7 && momAgainst) reasons.push("price moving toward your stop with momentum against");
    if (news) reasons.push("high-impact news now imminent");
    return { type: "close", reason: reasons.join("; "), rNow };
  }

  // Trailing-stop step-up alert (gradeWithTrailing already moved o.currentStop).
  const locked = o.lockedR == null ? -1 : o.lockedR;
  const alerted = o.alertedLockedR == null ? -1 : o.alertedLockedR;
  if (locked >= 0 && locked > alerted) {
    o.alertedLockedR = locked;
    return { type: "trail", lockedR: locked, rNow, newStop: o.currentStop };
  }
  return null;
}

// Simulate the trade candle-by-candle with the breakeven+trail stop. Returns
// {closed:true, outcome, rMultiple, ...} on exit, else {closed:false} and
// updates o.peakR / o.lockedR / o.currentStop / o.stage in place.
function gradeWithTrailing(o, raw) {
  const { datetimes, highs, lows } = raw;
  const buy = o.direction === "buy";
  const entry = o.entry;
  const risk = Math.abs(entry - o.sl) || 1e-9;
  const tp2 = o.tp2;
  const dp = entry >= 10 ? 3 : 5;
  const Rof = (p) => (buy ? p - entry : entry - p) / risk;
  const stopPrice = (lockedR) =>
    lockedR < 0 ? o.sl : buy ? entry + lockedR * risk : entry - lockedR * risk;

  let peakR = o.peakR || 0;
  let lockedR = o.lockedR == null ? -1 : o.lockedR;

  for (let i = 0; i < datetimes.length; i++) {
    if (tparseUTC(datetimes[i]) <= o.openedTs) continue;
    const hi = highs[i], lo = lows[i];
    const eff = stopPrice(lockedR);

    // a) Stop (uses the stop valid coming into this candle; stop-first tiebreak).
    const stopHit = buy ? lo <= eff : hi >= eff;
    if (stopHit) {
      const r = Rof(eff);
      return {
        closed: true,
        outcome: r > 0.01 ? "win" : r < -0.01 ? "loss" : "scratch",
        rMultiple: Number(r.toFixed(2)),
        exitPrice: Number(eff.toFixed(dp)),
        peakR: Number(peakR.toFixed(2)),
        exit: lockedR < 0 ? "stop" : lockedR === 0 ? "breakeven" : "trail +" + lockedR + "R",
      };
    }
    // b) Final target.
    const tpHit = buy ? hi >= tp2 : lo <= tp2;
    if (tpHit) {
      const r = Rof(tp2);
      return {
        closed: true, outcome: "win", rMultiple: Number(r.toFixed(2)),
        exitPrice: tp2, peakR: Number(Math.max(peakR, r).toFixed(2)), exit: "target",
      };
    }
    // c) Trail update for NEXT candle.
    const favR = buy ? Rof(hi) : Rof(lo);
    if (favR > peakR) peakR = favR;
    if (peakR >= 1) {
      const newLocked = Math.floor(peakR) - 1; // 0 at [1,2), 1 at [2,3), ...
      if (newLocked > lockedR) lockedR = newLocked;
    }
  }

  // Still open — persist live management state.
  o.peakR = Number(peakR.toFixed(2));
  o.lockedR = lockedR;
  o.currentStop = Number(stopPrice(lockedR).toFixed(dp));
  o.stage = lockedR < 0 ? "initial" : lockedR === 0 ? "breakeven" : "+" + lockedR + "R locked";
  return { closed: false };
}

function recomputeStats(ledger) {
  const closed = ledger.closed;
  const wins = closed.filter((c) => c.outcome === "win").length;
  const losses = closed.filter((c) => c.outcome === "loss").length;
  const scratch = closed.filter((c) => c.outcome === "scratch").length;
  const decisive = wins + losses; // scratches are neutral
  const totalR = closed.reduce((a, c) => a + (c.rMultiple || 0), 0);
  const total = closed.length;
  ledger.stats = {
    total,
    wins,
    losses,
    scratch,
    open: ledger.open.length,
    winRate: decisive ? Math.round((wins / decisive) * 100) : 0,
    totalR: Number(totalR.toFixed(2)),
    avgR: total ? Number((totalR / total).toFixed(2)) : 0,
  };
}

// Per-pair win-rate so the quality score can calibrate to where it actually wins.
function calibrationByPair(ledger) {
  const out = {};
  for (const c of ledger.closed) {
    const k = c.pair;
    out[k] = out[k] || { wins: 0, total: 0 };
    out[k].total++;
    if (c.outcome === "win") out[k].wins++;
  }
  for (const k of Object.keys(out)) {
    out[k].winRate = out[k].total ? Math.round((out[k].wins / out[k].total) * 100) : 0;
  }
  return out;
}

// Plain-language results summary fed back into the AI prompt so it ADAPTS —
// gets stricter where it's losing, leans into what's working.
function performanceFeedback(ledger) {
  const closed = ledger.closed;
  if (!closed.length) return "No closed trades yet — no performance history to learn from.";
  const byPair = {};
  for (const c of closed) {
    const k = c.pair;
    byPair[k] = byPair[k] || { w: 0, l: 0, r: 0 };
    if (c.outcome === "win") byPair[k].w++;
    else if (c.outcome === "loss") byPair[k].l++;
    byPair[k].r += c.rMultiple || 0;
  }
  const lines = Object.entries(byPair).map(([p, v]) => {
    const n = v.w + v.l;
    const wr = n ? Math.round((v.w / n) * 100) : 0;
    return `${p} ${v.w}W/${v.l}L (${wr}%, ${v.r >= 0 ? "+" : ""}${v.r.toFixed(1)}R)`;
  });
  const o = ledger.stats;
  return (
    `Overall ${o.winRate}% win, ${o.avgR >= 0 ? "+" : ""}${o.avgR}R avg over ${o.total} trades. ` +
    `By pair: ${lines.join(" · ")}.\n` +
    `Use this: be MORE selective (or no_trade) on pairs/directions with a poor recent record; ` +
    `keep taking the setups that have been working. Do not repeat losing patterns.`
  );
}

// Compute exact, always-valid entry/stop/targets from ATR + structure, so we
// never depend on a small model's arithmetic. Mutates the signal in place.
function applyComputedLevels(sig, s) {
  const price = s.price;
  const atr = s.atr && s.atr > 0 ? s.atr : price * 0.001;
  const buy = sig.direction === "buy";
  // Stop: ~1.5x ATR, but beyond the recent 1H swing against us; clamp 1.5–3.5 ATR.
  let stopDist = 1.5 * atr;
  const swing = buy ? s.h1.swingLow : s.h1.swingHigh;
  if (Number.isFinite(swing)) {
    const swingDist = Math.abs(price - swing) + 0.3 * atr;
    stopDist = Math.min(Math.max(stopDist, swingDist), 3.5 * atr);
  }
  const entry = price;
  const sl = buy ? entry - stopDist : entry + stopDist;
  const tp1 = buy ? entry + 1.8 * stopDist : entry - 1.8 * stopDist; // 1.8:1
  const tp2 = buy ? entry + 3.0 * stopDist : entry - 3.0 * stopDist; // 3:1
  const dp = price >= 10 ? 3 : 5; // JPY pairs ~3dp, others ~5dp
  const rd = (x) => Number(x.toFixed(dp));

  sig.entry_price = rd(entry); sig.stop_loss_price = rd(sl);
  sig.tp1_price = rd(tp1); sig.tp2_price = rd(tp2);
  sig.entry = String(rd(entry)); sig.stop_loss = String(rd(sl));
  sig.take_profit_1 = String(rd(tp1)); sig.take_profit_2 = String(rd(tp2));
  sig.risk_reward = "1:1.8";
}

// Deterministic guardrail — reject the AI's own inconsistent/illogical signals.
function validateSignal(sig, s) {
  if (!sig || sig.direction === "no_trade") return null;
  const e = sig.entry_price, sl = sig.stop_loss_price, t1 = sig.tp1_price, t2 = sig.tp2_price;
  for (const n of [e, sl, t1, t2]) {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "non-numeric / invalid price levels";
  }
  const buy = sig.direction === "buy";
  if (buy && !(sl < e && e < t1 && t1 <= t2)) return "buy levels out of order (need SL < entry < TP1 ≤ TP2)";
  if (!buy && !(sl > e && e > t1 && t1 >= t2)) return "sell levels out of order (need SL > entry > TP1 ≥ TP2)";
  const risk = Math.abs(e - sl);
  if (risk <= 0) return "zero risk (entry equals stop)";
  const rr = Math.abs(t1 - e) / risk;
  // Never risk more than the first target pays. Demand at least 1.5:1 to TP1.
  if (rr < 1.5) return `reward:risk too low (${rr.toFixed(2)}:1 — TP must be ≥1.5x the stop distance)`;
  if (s.price && Math.abs(e - s.price) / s.price > 0.03) return "entry too far from current price";
  if (s.atr) {
    const slAtr = risk / s.atr;
    if (slAtr < 0.3) return "stop too tight (<0.3 ATR — likely noise)";
    if (slAtr > 8) return "stop too wide (>8 ATR)";
  }
  return null;
}

// ===========================================================================
// THE BRAIN — ONE Gemini call analyses ALL pairs (quota-efficient)
// ===========================================================================
const NUM = { type: "NUMBER" };
const STR = { type: "STRING" };
const SIGNAL_PROPS = {
  pair: STR,
  direction: { type: "STRING", enum: ["buy", "sell", "no_trade"] },
  confidence: { type: "INTEGER" },
  timeframe: STR,
  headline: STR,
  entry: STR,
  entry_price: NUM,
  stop_loss: STR,
  stop_loss_price: NUM,
  take_profit_1: STR,
  tp1_price: NUM,
  take_profit_2: STR,
  tp2_price: NUM,
  risk_reward: STR,
  confluence: { type: "ARRAY", items: STR },
  technical_reasoning: STR,
  invalidation: STR,
  news_risk: STR,
  concerns: STR, // inline self-check: honest risks/weaknesses of this exact call
};
const SIGNAL_REQUIRED = [
  "pair", "direction", "confidence", "timeframe", "headline",
  "entry", "entry_price", "stop_loss", "stop_loss_price",
  "take_profit_1", "tp1_price", "take_profit_2", "tp2_price",
  "risk_reward", "confluence", "technical_reasoning", "invalidation", "news_risk", "concerns",
];

function perPairBlock(s) {
  const eventLines = s.events.length
    ? s.events
        .map((e) => `  - [${e.impact}] ${e.country} ${e.title} (${e.minutesAway >= 0 ? "in " + e.minutesAway + "m" : Math.abs(e.minutesAway) + "m ago"})`)
        .join("\n")
    : "  none in window";
  const trend = (t) => (Number.isFinite(t.sma20) ? (t.price > t.sma20 ? "up" : "down") : "?");
  const ev = s.events.length
    ? s.events.slice(0, 2).map((e) => `${(e.impact || "")[0]}:${e.country} ${e.minutesAway}m`).join(", ")
    : "none";
  // One compact line per pair — minimal tokens, only decision-relevant data.
  return (
    `${s.pair} px${s.price} atr${s.atr} | bias ${s.bias}(${s.biasScore}) regime ${s.regime} ` +
    `session ${s.session.active ? "ACTIVE" : "thin"}${s.session.overlap ? "+peak" : ""} news ${s.newsBlackout} | ` +
    `res ${s.nearestResistance} sup ${s.nearestSupport} | ` +
    `trend W:${trend(s.w1)} D:${trend(s.d1)} 4H:${trend(s.h4)} | ` +
    `1H rsi${s.h1.rsi14} macdH${s.h1.macdHist} stochK${s.h1.stochK} swHi${s.h1.swingHigh} swLo${s.h1.swingLow} | ` +
    `4H rsi${s.h4.rsi14} adx${s.h4.adx} swHi${s.h4.swingHigh} swLo${s.h4.swingLow} | events ${ev}`
  );
}

async function analyzePairs(snapshots, perfFeedback, openTrades = []) {
  const blocks = snapshots.map(perPairBlock).join("\n");
  const openBlock = openTrades.length
    ? `\nOPEN POSITIONS — review each (hold or close). The desk handles stop-trailing; ` +
      `your job is judgement: 'close' if the REASON for the trade has broken (trend ` +
      `flipped against it, momentum reversed, fresh news risk) — be willing to cut. ` +
      `Otherwise 'hold'.\n` +
      openTrades.map((o) =>
        `[${o.pair}] ${o.direction.toUpperCase()} entry ${o.entry} stop ${o.currentStop} ` +
        `stage ${o.stage} peak +${o.peakR}R`
      ).join("\n") + "\n"
    : "";
  const prompt =
    `You are a senior FX analyst on a rules-based desk. For EACH pair below, decide ` +
    `the single highest-probability trade from the computed indicators ONLY, and ` +
    `return one signal object per pair (include its "pair").\n\n` +
    (perfFeedback ? `PERFORMANCE FEEDBACK (learn from your own results):\n${perfFeedback}\n\n` : "") +
    openBlock + "\n" +
    `Your priority: PRECISION over quantity. Only output buy/sell when the setup is ` +
    `genuinely high-probability — otherwise no_trade. A missed trade costs nothing; a ` +
    `bad trade costs money.\n\n` +
    `HARD RULES (apply per pair):\n` +
    `1. Trade WITH the Weekly AND Daily trend. If Weekly and Daily disagree, or the ` +
    `trade fights the Weekly trend, return no_trade (unless an exceptional reversal at ` +
    `a Bollinger extreme with Stochastic + structure confirmation).\n` +
    `2. If Regime is "ranging" (ADX<20), avoid trend trades — prefer no_trade.\n` +
    `3. If NewsBlackout is true, return no_trade (event risk) unless conviction is ` +
    `overwhelming, and say why.\n` +
    `4. Prefer trades when the session is ACTIVE (tight spreads); be cautious in thin hours.\n` +
    `5. ROOM TO TARGET: a buy's TP must sit BELOW the nearest resistance (with room); a ` +
    `sell's TP ABOVE the nearest support. If price is right at opposing structure with no ` +
    `room, return no_trade.\n` +
    `6. Require multi-timeframe confluence (Weekly + Daily + 4H + 1H agree). Marginal = no_trade.\n` +
    `7. The desk computes exact entry/stop/targets from ATR + structure (always ≥1.8:1 ` +
    `reward) — you do NOT need to get prices right. Focus on DIRECTION, conviction, and ` +
    `the thesis. You may set the price fields to 0; they will be replaced.\n` +
    `8. SELF-CHECK: in "concerns", honestly state the biggest risk/weakness of THIS exact ` +
    `call (what would make it fail). If the concerns are serious, change it to no_trade. ` +
    `Don't rationalise a weak setup.\n\n` +
    `A skipped trade is a professional result. Technical research, not financial advice.\n\n` +
    blocks +
    `\n\nReturn ONLY a JSON object of this exact shape:\n` +
    `{"signals":[{"pair":"EUR/USD","direction":"buy|sell|no_trade","confidence":0-100,` +
    `"timeframe":"","headline":"","entry":"","entry_price":0,"stop_loss":"","stop_loss_price":0,` +
    `"take_profit_1":"","tp1_price":0,"take_profit_2":"","tp2_price":0,"risk_reward":"",` +
    `"confluence":[""],"technical_reasoning":"","invalidation":"","news_risk":"","concerns":""}]` +
    (openTrades.length
      ? `,"reviews":[{"pair":"EUR/USD","verdict":"hold|close","reason":""}]`
      : "") +
    `}`;

  const responseSchema = {
    type: "OBJECT",
    properties: {
      signals: { type: "ARRAY", items: { type: "OBJECT", properties: SIGNAL_PROPS, required: SIGNAL_REQUIRED } },
      reviews: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { pair: STR, verdict: { type: "STRING", enum: ["hold", "close"] }, reason: STR },
          required: ["pair", "verdict", "reason"],
        },
      },
    },
    required: ["signals"],
  };

  const parsed = await callAI(prompt, responseSchema);
  const out = {};
  for (const sig of parsed.signals || []) {
    if (!sig || !sig.pair) continue;
    // Smaller models sometimes return numbers as strings — coerce so valid
    // signals aren't wrongly rejected by validation.
    for (const f of ["entry_price", "stop_loss_price", "tp1_price", "tp2_price", "confidence"]) {
      if (sig[f] != null && typeof sig[f] !== "number") {
        const n = Number(sig[f]);
        if (Number.isFinite(n)) sig[f] = n;
      }
    }
    out[sig.pair.toUpperCase()] = sig;
  }
  const reviews = {};
  for (const rv of parsed.reviews || []) {
    if (rv && rv.pair) reviews[rv.pair.toUpperCase()] = rv;
  }
  return { signals: out, reviews };
}

// SELF-CRITIQUE — a second pass where the AI acts as a strict risk manager and
// must justify (or veto) each proposed trade. Forces it to actually understand
// the signal before it counts. items: [{pair, signal, snapshot}].
async function critiqueSignals(items) {
  if (!items.length) return {};
  const lines = items.map(({ signal: g, snapshot: s }) => {
    const e = g.entry_price, sl = g.stop_loss_price, t1 = g.tp1_price;
    const rr = sl && e ? Math.abs(t1 - e) / (Math.abs(e - sl) || 1e-9) : 0;
    const wk = s.w1 && Number.isFinite(s.w1.sma20) ? (s.w1.sma20 > s.w1.sma50 ? "up" : "down") : "?";
    return (
      `[${g.pair}] ${g.direction.toUpperCase()} entry ${e} sl ${sl} tp1 ${t1} ` +
      `(R:R ${rr.toFixed(2)}:1) · weekly ${wk} · regime ${s.regime} · ` +
      `newsBlackout ${s.newsBlackout} · reason: "${(g.technical_reasoning || "").slice(0, 200)}"`
    );
  }).join("\n");

  const prompt =
    `You are a strict, skeptical FX risk manager doing the FINAL check before real ` +
    `money is risked. For EACH proposed trade, approve ONLY if you would personally ` +
    `take it. REJECT if any of these is true: it fights the weekly trend; reward:risk ` +
    `< 1.5; the entry/stop/targets are illogical; the stated reasoning is weak, generic, ` +
    `or contradicts the data; the regime is ranging; or it's a forced/low-conviction ` +
    `trade. Be honest — a rejected trade saves money.\n\n` +
    `Proposed trades:\n${lines}\n\n` +
    `Return ONLY JSON: {"reviews":[{"pair":"EUR/USD","verdict":"approve|reject",` +
    `"adjusted_confidence":0-100,"critique":"one short sentence"}]}`;

  const responseSchema = {
    type: "OBJECT",
    properties: {
      reviews: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            pair: STR,
            verdict: { type: "STRING", enum: ["approve", "reject"] },
            adjusted_confidence: { type: "INTEGER" },
            critique: STR,
          },
          required: ["pair", "verdict", "adjusted_confidence", "critique"],
        },
      },
    },
    required: ["reviews"],
  };

  const parsed = await callAI(prompt, responseSchema);
  const out = {};
  for (const r of parsed.reviews || []) {
    if (r && r.pair) out[r.pair.toUpperCase()] = r;
  }
  return out;
}

// Provider router — Groq if a key is set (generous free tier), else Gemini.
async function callAI(prompt, responseSchema) {
  if (process.env.GROQ_API_KEY) return callGroq(prompt);
  return callGemini(prompt, responseSchema);
}

async function callGroq(prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
      // Groq free tier counts prompt + max_tokens against the 6k/min limit, so
      // keep this modest — the compact JSON response fits well under 2k.
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`Groq API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("Groq returned no content");
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`Groq JSON parse failed: ${content.slice(0, 200)}`);
  }
}

async function callGemini(prompt, responseSchema) {
  const generationConfig = {
    temperature: 0.3,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
    responseSchema,
  };
  // Thinking-capable models (2.5 / 3.x / *-latest) burn the output budget on
  // hidden thinking — disable it. 2.0-flash has no thinking, so we omit the flag.
  if (/2\.5|gemini-3|3\.5|flash-latest|thinking/.test(GEMINI_MODEL)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`);
  }
  const cand = data.candidates && data.candidates[0];
  const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
  if (!part || !part.text) {
    throw new Error(`Gemini returned no text (finish: ${cand && cand.finishReason}) ${JSON.stringify(data).slice(0, 300)}`);
  }
  try {
    return JSON.parse(part.text);
  } catch (e) {
    throw new Error(`Gemini JSON parse failed: ${part.text.slice(0, 200)}`);
  }
}

// ===========================================================================
// QUALITY SCORE — objective 0-100, computed in code, blended with real history
// ===========================================================================
function qualityScore(s, signal, calibration) {
  if (!signal || signal.direction === "no_trade") return 0;
  const buy = signal.direction === "buy";
  let q = 50;
  q += Math.min(25, Math.abs(s.biasScore) * 2);            // confluence strength
  if (s.regime === "trending") q += 12;                    // trend strength
  else if (s.regime === "ranging") q -= 15;
  const biasBull = s.biasScore > 0;                        // direction agrees w/ bias
  if (buy === biasBull) q += 6; else q -= 12;

  // Weekly (dominant) trend agreement — fighting it is a big penalty.
  if (s.w1 && Number.isFinite(s.w1.sma20)) {
    const wkBull = s.w1.price > s.w1.sma20;
    if (buy === wkBull) q += 8; else q -= 14;
  }
  // Room to target — penalize entering right into opposing structure.
  const atr = s.atr || 0;
  if (atr > 0) {
    if (buy && s.nearestResistance) {
      const room = (s.nearestResistance - s.price) / atr;
      if (room < 1) q -= 14; else if (room > 3) q += 4;
    } else if (!buy && s.nearestSupport) {
      const room = (s.price - s.nearestSupport) / atr;
      if (room < 1) q -= 14; else if (room > 3) q += 4;
    }
  }

  if (s.session && s.session.overlap) q += 8;              // liquidity / session
  else if (s.session && s.session.active) q += 3;
  else q -= 10;
  if (s.newsBlackout) q -= 18;                             // event risk
  if (typeof signal.confidence === "number") q += (signal.confidence - 60) * 0.15;
  if (calibration && calibration.total >= 10) {            // blend with real win-rate
    q = q * 0.7 + calibration.winRate * 0.3;
  }
  return Math.max(0, Math.min(100, Math.round(q)));
}

// ===========================================================================
// NOTIFICATIONS — Telegram / WhatsApp(CallMeBot) / Email(Resend), all optional
// ===========================================================================
// Each alert carries a stable key; we skip any key already sent (stored on the
// ledger) so the SAME alert never emails twice — even if two runs overlap.
async function dispatchAlerts(opened, closed, manage = [], ledger = null) {
  const sent = new Set((ledger && ledger.sentAlerts) || []);
  const items = []; // { key, text }

  for (const m of manage) {
    const dir = String(m.direction || "").toUpperCase();
    if (m.type === "close") {
      items.push({
        key: `M:close:${m.pair}:${m.entry}`,
        text:
          `⚠️ CLOSE / REASSESS ${m.pair} ${dir}\n` +
          `Reason: ${m.reason}.\nNow ${m.rNow >= 0 ? "+" : ""}${m.rNow.toFixed(1)}R (entry ${m.entry}).\n` +
          `Consider exiting early or tightening your stop.`,
      });
    } else if (m.type === "trail") {
      items.push({
        key: `M:trail:${m.pair}:${m.entry}:${m.lockedR}`,
        text: m.lockedR === 0
          ? `🎯 TAKE ACTION ${m.pair} ${dir} is +${m.rNow.toFixed(1)}R\n` +
            `You've hit +1R. Lock it in: take partial profit and move your stop to ` +
            `breakeven (${m.newStop}) so the rest runs risk-free — or close to bank it.`
          : `📈 TRAIL ${m.pair} ${dir} now +${m.rNow.toFixed(1)}R\n` +
            `Move your stop up to ${m.newStop} to lock in +${m.lockedR}R and keep riding toward TP.`,
      });
    }
  }
  for (const c of closed) {
    const icon = c.outcome === "win" ? "✅ WIN" : c.outcome === "loss" ? "❌ LOSS" : "⚪ SCRATCH";
    const rtxt = `${c.rMultiple > 0 ? "+" : ""}${c.rMultiple}R`;
    const ex = c.exit || "";
    const how =
      ex === "target" ? "hit final target" :
      ex === "stop" ? "hit stop" :
      ex === "breakeven" ? "stopped at breakeven — protected from a loss" :
      ex.startsWith("trail") ? `trailed out, profit locked (${ex})` :
      ex === "managed-close" || ex === "ai-close" ? `closed early — ${c.exitReason || "reason broke"}` :
      "closed";
    items.push({
      key: `R:${c.id || c.pair + ":" + c.openedTs}`,
      text: `${icon} ${c.pair} ${String(c.direction || "").toUpperCase()} ${how} (${rtxt})`,
    });
  }
  for (const o of opened) {
    if ((o.qualityScore || 0) < NOTIFY_MIN_SCORE) continue; // only quality entries alert
    items.push({ key: `E:${o.pair}:${o.entry_price}`, text: formatEntryAlert(o) });
  }

  const fresh = items.filter((it) => !sent.has(it.key));
  if (!fresh.length) return;

  const text = "📊 FX Signal Desk\n\n" + fresh.map((it) => it.text).join("\n\n");
  await Promise.all([
    sendTelegram(text).catch((e) => console.warn("telegram:", String(e))),
    sendWhatsApp(text).catch((e) => console.warn("whatsapp:", String(e))),
    sendEmail("FX Signal Desk alert", text).catch((e) => console.warn("email:", String(e))),
  ]);

  // Record what we sent so it never goes out again.
  if (ledger) {
    for (const it of fresh) sent.add(it.key);
    ledger.sentAlerts = Array.from(sent).slice(-300);
  }
}

function formatEntryAlert(s) {
  const arrow = s.direction === "buy" ? "🟢 BUY" : "🔴 SELL";
  return (
    `${arrow} ${s.pair}  (score ${s.qualityScore})\n` +
    `Entry ${s.entry}\nStop ${s.stop_loss}\nTP1 ${s.take_profit_1}   TP2 ${s.take_profit_2}\n` +
    `R:R ${s.risk_reward}  ·  ${s.timeframe || ""}\n${s.technical_reasoning || s.headline || ""}`
  );
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return "skipped (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)";
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  return "sent";
}

async function sendWhatsApp(text) {
  const phone = process.env.CALLMEBOT_PHONE;
  const key = process.env.CALLMEBOT_APIKEY;
  if (!phone || !key) return "skipped (set CALLMEBOT_PHONE + CALLMEBOT_APIKEY)";
  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CallMeBot ${res.status}`);
  return "sent";
}

async function sendEmail(subject, text) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!key) return "skipped (set RESEND_API_KEY)";
  if (!to) return "skipped (set NOTIFY_EMAIL_TO to your Resend signup email)";
  const from = process.env.NOTIFY_EMAIL_FROM || "FX Signal Desk <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return "sent";
}

// Exposed so run-now?test=1 can verify each notification channel directly.
exports.testAlert = async () => {
  const text = "✅ FX Signal Desk test — your alerts are working.";
  return {
    telegram: await sendTelegram(text).then((r) => r).catch((e) => "ERROR: " + String(e)),
    whatsapp: await sendWhatsApp(text).then((r) => r).catch((e) => "ERROR: " + String(e)),
    email: await sendEmail("FX Signal Desk test", text).then((r) => r).catch((e) => "ERROR: " + String(e)),
  };
};
