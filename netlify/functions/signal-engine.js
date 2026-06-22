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
// Secrets / keys (Netlify env vars):
//   GEMINI_API_KEY       required.  FREE Google AI Studio key (no credit card).
//                        Get one at https://aistudio.google.com/apikey
//   TWELVEDATA_API_KEY   recommended.  Free OHLC. Without it -> daily-close fallback.
//
// Optional:
//   SIGNAL_PAIRS  default "EUR/USD,GBP/USD,USD/JPY"
//   GEMINI_MODEL  default "gemini-2.0-flash"  (free tier)
//   NEWS_WINDOW_MIN  minutes around a high-impact event to blackout (default 60)
// ---------------------------------------------------------------------------

const { getStore, connectLambda } = require("@netlify/blobs");

const PAIRS = (process.env.SIGNAL_PAIRS || "EUR/USD,GBP/USD,USD/JPY")
  .split(",")
  .map((p) => p.trim().toUpperCase())
  .filter(Boolean);
// gemini-2.0-flash has a large free daily quota; gemini-flash-latest now points
// to 3.5-flash whose free tier is only ~20 requests/day (causes 429s).
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const TD_KEY = process.env.TWELVEDATA_API_KEY;
const NEWS_WINDOW_MIN = Number(process.env.NEWS_WINDOW_MIN || 60);
// Only alert (and surface as high-conviction) signals at/above this quality score.
const NOTIFY_MIN_SCORE = Number(process.env.NOTIFY_MIN_SCORE || 65);

exports.handler = async (event) => {
  if (!process.env.GEMINI_API_KEY) {
    console.error("signal-engine: GEMINI_API_KEY is not set");
    return { statusCode: 500, body: "GEMINI_API_KEY missing" };
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

  // Calibration anchor = how the engine has actually done so far (prior stats).
  const calibration = { winRate: ledger.stats.winRate, total: ledger.stats.total };

  const justClosed = []; // trades resolved this run (for result alerts)

  // 1. Build snapshots + grade open trades in parallel (NO AI yet — just data).
  const built = await Promise.all(
    PAIRS.map(async (pair) => {
      try {
        const snapshot = await buildSnapshot(pair, calendar);
        evaluateOpenSignals(pair, snapshot, ledger, justClosed);
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
  let aiError = null;
  if (okBuilt.length) {
    try {
      signalByPair = await analyzePairs(okBuilt.map((b) => b.snapshot));
    } catch (err) {
      aiError = String(err);
      console.error("Gemini batch failed:", aiError);
    }
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
    const quality = qualityScore(b.snapshot, signal, calibration);
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
  await store.setJSON("ledger", ledger);
  await store.setJSON("latest", {
    generatedAt: new Date().toISOString(),
    signals,
    stats: ledger.stats,
    calibration: ledger.stats, // historical hit-rate the dashboard surfaces
    open: ledger.open,              // currently tracked trades (for duration)
    history: ledger.closed.slice(0, 25), // resolved trades: hit TP (win) vs SL (loss)
  });

  // Notifications: alert on result of closed trades + new high-quality entries.
  await dispatchAlerts(justOpened, justClosed);

  console.log(
    "signal-engine done:", signals.length, "pairs; winRate", ledger.stats.winRate,
    "| opened", justOpened.length, "closed", justClosed.length
  );
  return { statusCode: 200, body: JSON.stringify({ count: signals.length }) };
};

function keyFor(pair) {
  return pair.replace("/", "-");
}

// ===========================================================================
// SNAPSHOT — data + indicators across three timeframes
// ===========================================================================
async function buildSnapshot(pair, calendar) {
  let d1, h4, h1;

  if (TD_KEY) {
    const base = await twelveData(pair, "1h", 2200); // one call, then resample
    h1 = analyse(base);
    h4 = analyse(resample(base, h4Key));
    d1 = analyse(resample(base, d1Key));
  } else {
    const daily = await frankfurterDaily(pair, 200);
    d1 = analyse(daily);
    h4 = analyse(daily);
    h1 = analyse(daily);
  }

  const price = h1.closes[h1.closes.length - 1];
  const { score, factors, regime } = scoreBias(d1, h4, h1, price);

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
    d1: summarize(d1),
    h4: summarize(h4),
    h1: summarize(h1),
    biasScore: score,
    bias: score >= 3 ? "bullish" : score <= -3 ? "bearish" : "mixed",
    regime,
    confluence: factors,
    events,
    newsBlackout,
    session: sessionInfo(pair),
    hasIntraday: !!TD_KEY,
    // raw arrays kept for signal evaluation
    _h1raw: h1,
  };
}

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

// --- timeframe resampling (1h -> 4h / daily) -------------------------------
function h4Key(dt) {
  const day = dt.slice(0, 10);
  const hour = Number(dt.slice(11, 13)) || 0;
  return day + "#" + Math.floor(hour / 4);
}
function d1Key(dt) {
  return dt.slice(0, 10);
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

// Top-down confluence + regime.
function scoreBias(d1, h4, h1, price) {
  let score = 0;
  const factors = [];
  const add = (cond, up, label) => {
    if (!cond) return;
    score += up ? 1 : -1;
    factors.push((up ? "▲ " : "▼ ") + label);
  };

  // Daily trend = the master filter (weighted: counts toward score twice)
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
  // One open signal per pair at a time.
  if (ledger.open.some((o) => o.pair === record.pair)) return false;
  ledger.open.push({
    id: `${keyFor(record.pair)}-${Date.now()}`,
    pair: record.pair,
    direction: record.direction,
    entry: record.entry_price,
    sl: record.stop_loss_price,
    tp1: record.tp1_price,
    tp2: record.tp2_price,
    timeframe: record.timeframe,
    qualityScore: record.qualityScore,
    openedAt: record.generatedAt,
    openedTs: Date.parse(record.generatedAt),
  });
  return true;
}

function evaluateOpenSignals(pair, snapshot, ledger, justClosed) {
  const raw = snapshot._h1raw;
  if (!raw || !raw.datetimes) return;
  const still = [];
  for (const o of ledger.open) {
    if (o.pair !== pair) { still.push(o); continue; }
    const result = checkOutcome(o, raw);
    if (result) {
      const closedRec = { ...o, ...result, closedAt: new Date().toISOString() };
      ledger.closed.unshift(closedRec);
      if (justClosed) justClosed.push(closedRec);
    } else still.push(o);
  }
  ledger.open = ledger.open.filter((o) => o.pair !== pair).concat(still.filter((o) => o.pair === pair));
  // cap closed history
  ledger.closed = ledger.closed.slice(0, 200);
}

// Walk candles after the signal opened; first level touched wins/loses.
function checkOutcome(o, raw) {
  const { datetimes, highs, lows } = raw;
  const risk = Math.abs(o.entry - o.sl) || 1e-9;
  for (let i = 0; i < datetimes.length; i++) {
    if (Date.parse(datetimes[i]) <= o.openedTs) continue;
    const hi = highs[i], lo = lows[i];
    if (o.direction === "buy") {
      const hitSL = lo <= o.sl;
      const hitTP = hi >= o.tp1;
      if (hitSL && hitTP) return { outcome: "loss", rMultiple: -1 }; // ambiguous -> conservative
      if (hitSL) return { outcome: "loss", rMultiple: -1 };
      if (hitTP) return { outcome: "win", rMultiple: +Number(((o.tp1 - o.entry) / risk).toFixed(2)) };
    } else {
      const hitSL = hi >= o.sl;
      const hitTP = lo <= o.tp1;
      if (hitSL && hitTP) return { outcome: "loss", rMultiple: -1 };
      if (hitSL) return { outcome: "loss", rMultiple: -1 };
      if (hitTP) return { outcome: "win", rMultiple: +Number(((o.entry - o.tp1) / risk).toFixed(2)) };
    }
  }
  return null; // still open
}

function recomputeStats(ledger) {
  const closed = ledger.closed;
  const wins = closed.filter((c) => c.outcome === "win").length;
  const losses = closed.filter((c) => c.outcome === "loss").length;
  const be = closed.filter((c) => c.outcome === "breakeven").length;
  const totalR = closed.reduce((a, c) => a + (c.rMultiple || 0), 0);
  const total = closed.length;
  ledger.stats = {
    total,
    wins,
    losses,
    breakeven: be,
    open: ledger.open.length,
    winRate: total ? Math.round((wins / total) * 100) : 0,
    totalR: Number(totalR.toFixed(2)),
    avgR: total ? Number((totalR / total).toFixed(2)) : 0,
  };
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
};
const SIGNAL_REQUIRED = [
  "pair", "direction", "confidence", "timeframe", "headline",
  "entry", "entry_price", "stop_loss", "stop_loss_price",
  "take_profit_1", "tp1_price", "take_profit_2", "tp2_price",
  "risk_reward", "confluence", "technical_reasoning", "invalidation", "news_risk",
];

function perPairBlock(s) {
  const eventLines = s.events.length
    ? s.events
        .map((e) => `  - [${e.impact}] ${e.country} ${e.title} (${e.minutesAway >= 0 ? "in " + e.minutesAway + "m" : Math.abs(e.minutesAway) + "m ago"})`)
        .join("\n")
    : "  none in window";
  return (
    `=== ${s.pair} ===  PRICE ${s.price}\n` +
    `Bias: ${s.bias} (score ${s.biasScore}) · Regime: ${s.regime} · ` +
    `Session: ${s.session.open}${s.session.overlap ? " (peak)" : ""} ${s.session.active ? "ACTIVE" : "thin"} · ` +
    `NewsBlackout(${NEWS_WINDOW_MIN}m): ${s.newsBlackout}\n` +
    `Events:\n${eventLines}\n` +
    `Confluence: ${s.confluence.join("; ")}\n` +
    `Daily: ${JSON.stringify(s.d1)}\n4H: ${JSON.stringify(s.h4)}\n1H: ${JSON.stringify(s.h1)}\n`
  );
}

async function analyzePairs(snapshots) {
  const blocks = snapshots.map(perPairBlock).join("\n");
  const prompt =
    `You are a senior FX analyst on a rules-based desk. For EACH pair below, decide ` +
    `the single highest-probability trade from the computed indicators ONLY, and ` +
    `return one signal object per pair (include its "pair").\n\n` +
    `HARD RULES (apply per pair):\n` +
    `1. Trade WITH the Daily trend. Counter-trend = no_trade unless an exceptional ` +
    `mean-reversion setup at a Bollinger extreme with Stochastic confirmation.\n` +
    `2. If Regime is "ranging" (ADX<20), avoid trend trades — prefer no_trade.\n` +
    `3. If NewsBlackout is true, return no_trade (event risk) unless conviction is ` +
    `overwhelming, and say why.\n` +
    `4. Prefer trades when the session is ACTIVE (tight spreads); be cautious in thin hours.\n` +
    `5. Require multi-timeframe confluence (Daily + 4H + 1H agree). Marginal = no_trade.\n` +
    `6. Size the stop ~1.5x the 1H ATR beyond entry OR behind the nearest swing level; ` +
    `minimum 1.5:1 reward. Give NUMERIC entry/stop/target levels so outcomes can be graded.\n\n` +
    `A skipped trade is a professional result. Technical research, not financial advice.\n\n` +
    blocks;

  const responseSchema = {
    type: "OBJECT",
    properties: {
      signals: { type: "ARRAY", items: { type: "OBJECT", properties: SIGNAL_PROPS, required: SIGNAL_REQUIRED } },
    },
    required: ["signals"],
  };

  const parsed = await callGemini(prompt, responseSchema);
  const out = {};
  for (const sig of parsed.signals || []) {
    if (sig && sig.pair) out[sig.pair.toUpperCase()] = sig;
  }
  return out;
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
  let q = 50;
  q += Math.min(25, Math.abs(s.biasScore) * 2.5);          // confluence strength
  if (s.regime === "trending") q += 12;                    // trend strength
  else if (s.regime === "ranging") q -= 15;
  const biasBull = s.biasScore > 0;                        // direction agrees w/ bias
  if ((signal.direction === "buy") === biasBull) q += 6; else q -= 12;
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
async function dispatchAlerts(opened, closed) {
  const msgs = [];
  for (const c of closed) {
    const win = c.outcome === "win";
    msgs.push(
      `${win ? "✅ WIN" : "❌ LOSS"} ${c.pair} ${String(c.direction || "").toUpperCase()} ` +
      `${win ? "hit TP" : "hit SL"} (${c.rMultiple > 0 ? "+" : ""}${c.rMultiple}R)`
    );
  }
  for (const o of opened) {
    if ((o.qualityScore || 0) < NOTIFY_MIN_SCORE) continue; // only quality entries alert
    msgs.push(formatEntryAlert(o));
  }
  if (!msgs.length) return;
  const text = "📊 FX Signal Desk\n\n" + msgs.join("\n\n");
  await Promise.all([
    sendTelegram(text).catch((e) => console.warn("telegram:", String(e))),
    sendWhatsApp(text).catch((e) => console.warn("whatsapp:", String(e))),
    sendEmail("FX Signal Desk alert", text).catch((e) => console.warn("email:", String(e))),
  ]);
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
  if (!token || !chat) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function sendWhatsApp(text) {
  const phone = process.env.CALLMEBOT_PHONE;
  const key = process.env.CALLMEBOT_APIKEY;
  if (!phone || !key) return;
  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CallMeBot ${res.status}`);
}

async function sendEmail(subject, text) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!key || !to) return;
  const from = process.env.NOTIFY_EMAIL_FROM || "FX Signal Desk <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
