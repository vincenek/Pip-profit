// Netlify function: backtest
// ---------------------------------------------------------------------------
// Institutional-style backtest: replays the EXACT live strategy code (imported
// from signal-engine.js — no reimplementation drift) over all available hourly
// history, with realistic spread costs charged on every trade.
//
//   GET /.netlify/functions/backtest?pair=EUR/USD   -> one pair (fast)
//   GET /.netlify/functions/backtest                -> all focus pairs (time-budgeted)
//
// What it replays, bar by completed bar:
//   deterministic bias (score >= +3 buy / <= -3 sell) -> quality gate (>= 65)
//   -> pullback pending (entry zone = 0.5 ATR, 6h expiry, cancel-on-flip,
//   anti-stacking) -> trigger -> TP1 partial + half-R trail + stop (the real
//   gradeWithTrailing) -> spread charged at close.
//
// HONEST LIMITATIONS (disclosed in the output):
//   - The AI direction/veto layer can't be replayed historically; this tests the
//     deterministic core the AI sits on top of.
//   - The news blackout can't be backtested (calendar is current-week only).
//   - Weekly-trend factors activate only once ~20 weeks of data accumulate,
//     same as a fresh live start.
//   - Per-pair simulation: cross-pair portfolio guards don't apply here.
// ---------------------------------------------------------------------------

const { connectLambda } = require("@netlify/blobs");
const engine = require("./signal-engine.js");
const C = engine.core;

const FOCUS = ["EUR/USD", "GBP/USD", "USD/JPY"];
const TF_SLICE = 400; // bars fed to analyse() per TF — plenty for every indicator

// ---------------------------------------------------------------------------
// COT (Commitments of Traders) — historical, point-in-time correct, for the
// ?cot=1 candidate filter. Reuses the SAME market mapping the live engine's
// getMarketContext() uses (C.COT_MARKETS/C.COT_DATASET), just fetched as a
// full history instead of "latest only".
// ---------------------------------------------------------------------------

// Which currency's COT contract governs this pair, and whether its sign needs
// inverting (base currency's own contract = direct; quote currency's = inverted,
// since e.g. USD/JPY strength tracks USD strength, i.e. JPY weakness/net-shorts).
function cotInfoFor(pair) {
  const [base, quote] = pair.split("/");
  if (C.COT_MARKETS[base]) return { market: C.COT_MARKETS[base], invert: false };
  if (C.COT_MARKETS[quote]) return { market: C.COT_MARKETS[quote], invert: true };
  return null;
}

// Weekly net non-commercial (large speculator) positioning, oldest-first, for
// the whole backtest window plus margin. One request, not one-per-bar.
async function fetchHistoricalCOT(market, limit) {
  const url = "https://publicreporting.cftc.gov/resource/" + C.COT_DATASET +
    ".json?$q=" + encodeURIComponent(market) +
    "&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=" + (limit || 60); // ~60 weeks, comfortably covers the backtest window
  const res = await fetch(url);
  if (!res.ok) throw new Error("CFTC " + res.status);
  const rows = await res.json();
  return rows
    .map((r) => ({
      ts: Date.parse(r.report_date_as_yyyy_mm_dd + "T00:00:00Z"),
      net: Number(r.noncomm_positions_long_all || 0) - Number(r.noncomm_positions_short_all || 0),
    }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.net))
    .sort((a, b) => a.ts - b.ts);
}

// Point-in-time lookup: the most recent report that would ACTUALLY have been
// public knowledge by time `ts` — CFTC releases a Tuesday-snapshot report the
// following Friday (~3 day lag), so using report_date alone would be look-ahead
// bias. Returns null if no report had been published yet that far back.
function cotAsOf(series, ts) {
  let val = null;
  for (const p of series) {
    if (p.ts + 3 * 86400000 <= ts) val = p;
    else break;
  }
  return val;
}

exports.handler = async (event) => {
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  const qs = (event && event.queryStringParameters) || {};
  const pairs = qs.pair ? [qs.pair.toUpperCase()] : FOCUS;
  // ?gate=70 sweeps the quality threshold — parameter research without redeploys.
  const gate = Math.max(0, Math.min(100, Number(qs.gate) || C.NOTIFY_MIN_SCORE));
  // ?mr=1 tests the MEAN-REVERSION candidate strategy (ranging regimes only)
  // instead of the trend strategy — evidence before it's allowed anywhere near live.
  const mr = qs.mr === "1" || qs.mr === "true";
  // ?sb=1 tests the ICT SILVER BULLET candidate — same evidence-gated discipline.
  const sb = qs.sb === "1" || qs.sb === "true";
  // ?minAdx=30 hard-requires a CONFIRMED strong trend (4h ADX >= N) before any
  // new signal — testing whether stricter trend confirmation actually helps,
  // in and out of sample, not just a hunch.
  const minAdx = Number(qs.minAdx) || 0;
  // ?cot=1 hard-requires REAL institutional positioning (CFTC COT, historical,
  // point-in-time correct) to agree with the trade direction — a genuinely
  // different information source than price-action indicators, not another
  // twist on the same signal.
  const useCot = qs.cot === "1" || qs.cot === "true";
  const started = Date.now();
  const strategy = (sb ? "ICT silver bullet (candidate)" : mr ? "mean-reversion (candidate)" : "trend (live)") +
    (useCot ? " + COT filter (candidate)" : "");
  const out = { generatedAt: new Date().toISOString(), qualityGate: gate, minAdx, cot: useCot, strategy, method: sb ? SB_METHOD_NOTE : METHOD_NOTE, results: {} };

  for (const pair of pairs) {
    if (Date.now() - started > 8000) {
      out.results[pair] = { skipped: "time budget — run ?pair=" + pair + " individually" };
      continue;
    }
    try {
      const base = await C.getCandles(pair);
      let cotSeries = null;
      if (useCot) {
        const info = cotInfoFor(pair);
        if (info) {
          try { cotSeries = await fetchHistoricalCOT(info.market, Number(qs.cotlimit) || 60); }
          catch (e) { out.results[pair] = { error: "COT fetch failed: " + String(e).slice(0, 150) }; continue; }
          if (qs.cotdebug === "1") {
            out.results[pair] = {
              cotDebug: true, market: info.market, invert: info.invert,
              seriesLength: cotSeries.length,
              first: cotSeries[0], last: cotSeries[cotSeries.length - 1],
            };
            continue;
          }
        } else {
          out.results[pair] = { error: "no COT market mapping for " + pair };
          continue;
        }
      }
      out.results[pair] = backtestPair(pair, base, gate, mr, sb, minAdx, useCot ? cotSeries : null);
    } catch (err) {
      out.results[pair] = { error: String(err) };
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
};

const METHOD_NOTE =
  "Replays the exact live strategy code (deterministic core: bias>=|3| + quality>=" +
  65 + " gate + pullback entries + TP1 partial + half-R trail), spread charged per trade. " +
  "AI layer + news filter not replayable historically; per-pair (no cross-pair guards).";

const SB_METHOD_NOTE =
  "ICT Silver Bullet candidate: trades ONLY inside the London (3-4am NY) / AM (10-11am NY) / " +
  "PM (2-3pm NY) kill-zone windows. Setup: price sweeps the prior 20-bar high/low (liquidity " +
  "grab), then within 3 bars a 3-candle Fair Value Gap confirms a reversal -> enter at the " +
  "confirming bar's close, stop just beyond the sweep wick, targets at 1.8R/3R via the same " +
  "grader (TP1 partial + half-R trail) as every other candidate. Spread charged. Same honest " +
  "limitations as the trend backtest (AI/news not replayable, per-pair, no cross-pair guards).";

// US DST: 2nd Sunday of March 07:00 UTC (2am EST) -> 1st Sunday of November 06:00 UTC (2am EDT).
function isUsDst(d) {
  const y = d.getUTCFullYear();
  const mar1Dow = new Date(Date.UTC(y, 2, 1)).getUTCDay();
  const dstStart = Date.UTC(y, 2, 1 + ((7 - mar1Dow) % 7) + 7, 7);
  const nov1Dow = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  const dstEnd = Date.UTC(y, 10, 1 + ((7 - nov1Dow) % 7), 6);
  const t = d.getTime();
  return t >= dstStart && t < dstEnd;
}
// London 3-4am / AM 10-11am / PM 2-3pm, all New York local time.
function inSilverBulletWindow(d) {
  const h = d.getUTCHours();
  return isUsDst(d) ? (h === 7 || h === 14 || h === 18) : (h === 8 || h === 15 || h === 19);
}

// ---------------------------------------------------------------------------
// Per-pair simulation
// ---------------------------------------------------------------------------
function backtestPair(pair, base, gate, mr, sb, minAdx, cotSeries) {
  if (gate == null) gate = C.NOTIFY_MIN_SCORE;
  const n = base.closes.length;
  if (n < 1400) return { error: "not enough history (" + n + " bars)" };

  // Precompute higher-TF composition ONCE (completed bars + running partials),
  // so each step reconstructs exactly what live resample(bars[0..i]) would see.
  const tf4 = precomputeTF(base, C.h4Key);
  const tfD = precomputeTF(base, C.d1Key);
  const tfW = precomputeTF(base, C.w1Key);

  // Warmup: daily SMA50 needs ~50 daily bars ≈ 1200 hourly bars.
  const warmup = 1250;
  const trades = [];
  let open = null;      // one open trade per pair+direction (anti-stacking) — matches live
  let pending = null;   // one pending setup (same pair+direction dedup)
  let sbWatch = null;    // silver-bullet: a liquidity sweep watching for FVG confirmation

  const dtms = base.datetimes;
  const ts = (i) => C.tparseUTC(dtms[i]);

  for (let i = warmup; i < n; i++) {
    const barTs = ts(i);
    const hi = base.highs[i], lo = base.lows[i];

    // ---- 1. Manage the open trade: step the REAL grader by exactly one bar.
    if (open) {
      const g = C.gradeWithTrailing(open, {
        datetimes: [dtms[i]], highs: [hi], lows: [lo],
      });
      if (g.closed) {
        trades.push(record(open, g, barTs));
        open = null;
      }
    }

    // Build this bar's snapshot (same fields live buildSnapshot produces).
    const snap = snapshotAt(pair, base, tf4, tfD, tfW, i);

    // ---- 1b. Early-close rule (live manageOpenTrade): losing + unprotected +
    //          decisive bias flip. (News leg not replayable.)
    if (open) {
      const rNow = C.currentR(open, snap.price);
      const buy = open.direction === "buy";
      const biasAgainst = buy ? snap.biasScore <= -3 : snap.biasScore >= 3;
      if ((open.lockedR == null || open.lockedR < 0) && rNow < 0 && biasAgainst) {
        const r = C.realizedR(open, rNow) - C.spreadRFor(open);
        trades.push(record(open, {
          outcome: r > 0.09 ? "win" : r < -0.09 ? "loss" : "scratch",
          rMultiple: Number(r.toFixed(2)), exit: "managed-close",
          exitPrice: snap.price, peakR: open.peakR, partial: !!open.partialTaken,
        }, barTs));
        open = null;
      }
    }

    // ---- 2. Pending: trigger or expire (live checkPending semantics).
    if (pending) {
      const buy = pending.direction === "buy";
      if (barTs > pending.createdTs && (buy ? lo <= pending.entryZone : hi >= pending.entryZone)) {
        const lv = C.computeLevels(pending.entryZone, buy, snap);
        open = {
          pair, direction: pending.direction,
          entry: lv.entry, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2,
          qualityScore: pending.qualityScore,
          openedTs: barTs, peakR: 0, lockedR: -1,
          partialTaken: false, bankedR: 0, gradedUpTo: barTs,
        };
        pending = null;
      } else if (barTs > pending.expiresAt) {
        pending = null; // expired without a pullback
      }
    }

    // ---- 3. New signal.
    if (sb) {
      // ICT SILVER BULLET (candidate, evidence-gated): only inside kill-zone
      // windows, a liquidity sweep of the recent 20-bar extreme followed within
      // 3 bars by a fair-value-gap reversal -> enter at the confirming close.
      if (sbWatch && i > sbWatch.expiresAtBar) sbWatch = null; // watch timed out
      if (sbWatch && !open && !pending) {
        const buy = sbWatch.direction === "buy";
        const gapConfirmed = buy ? base.highs[i - 2] < base.lows[i] : base.lows[i - 2] > base.highs[i];
        if (gapConfirmed) {
          const atr = snap.atr && snap.atr > 0 ? snap.atr : snap.price * 0.001;
          const dp = snap.price >= 10 ? 3 : 5;
          const rd = (x) => Number(x.toFixed(dp));
          const entry = snap.price;
          const buffer = 0.2 * atr;
          const sl = rd(buy ? sbWatch.sweepExtreme - buffer : sbWatch.sweepExtreme + buffer);
          const stopDist = Math.abs(entry - sl);
          if (stopDist > 0) {
            open = {
              pair, direction: sbWatch.direction,
              entry: rd(entry), sl,
              tp1: rd(buy ? entry + 1.8 * stopDist : entry - 1.8 * stopDist),
              tp2: rd(buy ? entry + 3 * stopDist : entry - 3 * stopDist),
              qualityScore: 66, openedTs: barTs, peakR: 0, lockedR: -1,
              partialTaken: false, bankedR: 0, gradedUpTo: barTs,
            };
          }
          sbWatch = null;
        }
      } else if (!open && !pending && !sbWatch && i >= 20 && inSilverBulletWindow(new Date(barTs))) {
        const recentHigh = Math.max(...base.highs.slice(i - 20, i));
        const recentLow = Math.min(...base.lows.slice(i - 20, i));
        if (hi > recentHigh) sbWatch = { direction: "sell", sweepExtreme: hi, expiresAtBar: i + 3 };
        else if (lo < recentLow) sbWatch = { direction: "buy", sweepExtreme: lo, expiresAtBar: i + 3 };
      }
    } else if (mr) {
      // MEAN-REVERSION CANDIDATE (evidence-gated): trade ONLY the chop the trend
      // strategy sits out. Ranging regime + price stretched to a Bollinger band
      // with stochastic agreement -> fade back toward the middle of the range.
      if (!open && !pending && snap.regime === "ranging" && snap.session && snap.session.active) {
        const h1 = snap.h1;
        const mid = h1.bbUpper != null && h1.bbLower != null ? (h1.bbUpper + h1.bbLower) / 2 : null;
        let dir = null;
        if (mid != null && h1.stochK != null) {
          if (snap.price <= h1.bbLower && h1.stochK < 25) dir = "buy";
          else if (snap.price >= h1.bbUpper && h1.stochK > 75) dir = "sell";
        }
        if (dir) {
          const buy = dir === "buy";
          const atr = snap.atr && snap.atr > 0 ? snap.atr : snap.price * 0.001;
          const dp = snap.price >= 10 ? 3 : 5;
          const rd = (x) => Number(x.toFixed(dp));
          const entry = snap.price; // fading the extreme IS the pullback — enter now
          const sl = rd(buy ? entry - 1.5 * atr : entry + 1.5 * atr);
          const band = rd(buy ? h1.bbUpper : h1.bbLower);
          open = {
            pair, direction: dir,
            entry: rd(entry), sl,
            tp1: rd(mid),          // first target: middle of the range
            tp2: band,             // runner: the opposite band
            qualityScore: 66, openedTs: barTs, peakR: 0, lockedR: -1,
            partialTaken: false, bankedR: 0, gradedUpTo: barTs,
          };
        }
      }
    } else {
      // TREND (the live strategy): bias direction + quality gate + pullback pending
      // + optional hard trend-strength requirement (minAdx sweep).
      const dir = snap.biasScore >= 3 ? "buy" : snap.biasScore <= -3 ? "sell" : null;
      const trendOk = !minAdx || (snap.h4 && snap.h4.adx != null && snap.h4.adx >= minAdx);
      let cotOk = true;
      if (dir && cotSeries) {
        const info = cotInfoFor(pair);
        const cv = cotAsOf(cotSeries, barTs);
        if (!cv) cotOk = false; // no COT data yet this far back -> don't trade on an unverified guess
        else {
          const bullish = info.invert ? cv.net < 0 : cv.net >= 0;
          cotOk = dir === "buy" ? bullish : !bullish;
        }
      }
      if (dir && trendOk && cotOk) {
        // cancel-on-flip
        if (pending && pending.direction !== dir) pending = null;
        const quality = C.qualityScore(snap, { direction: dir, confidence: 70 }, { total: 0 });
        const stacked =
          (open && open.direction === dir) || (pending && pending.direction === dir);
        if (quality >= gate && !stacked) {
          const buy = dir === "buy";
          const atr = snap.atr && snap.atr > 0 ? snap.atr : snap.price * 0.001;
          const dp = snap.price >= 10 ? 3 : 5;
          pending = {
            direction: dir,
            entryZone: Number((buy ? snap.price - C.PULLBACK_ATR * atr : snap.price + C.PULLBACK_ATR * atr).toFixed(dp)),
            qualityScore: quality,
            createdTs: barTs,
            expiresAt: barTs + C.ENTRY_WINDOW_HOURS * 3600000,
          };
        }
      }
    }
  }
  // Anything still open at the end is ignored (unresolved).

  return summarizeResults(pair, trades, ts(warmup), ts(n - 1));
}

function record(o, g, closedTs) {
  return {
    direction: o.direction, entry: o.entry, quality: o.qualityScore,
    outcome: g.outcome, r: g.rMultiple, exit: g.exit, partial: !!g.partial,
    peakR: g.peakR, openedTs: o.openedTs, closedTs,
  };
}

// ---------------------------------------------------------------------------
// Snapshot reconstruction — what live buildSnapshot would have seen at bar i
// ---------------------------------------------------------------------------
function snapshotAt(pair, base, tf4, tfD, tfW, i) {
  const h1a = C.analyse(sliceTF1h(base, i));
  const h4a = C.analyse(sliceTF(tf4, i));
  const d1a = C.analyse(sliceTF(tfD, i));
  const w1a = C.analyse(sliceTF(tfW, i));
  const price = base.closes[i];

  const { score, regime } = C.scoreBias(w1a, d1a, h4a, h1a, price);

  const levels = [h4a.swingHigh, h4a.swingLow, d1a.swingHigh, d1a.swingLow].filter(Number.isFinite);
  const above = levels.filter((l) => l > price).sort((a, b) => a - b);
  const below = levels.filter((l) => l < price).sort((a, b) => b - a);

  return {
    pair,
    price,
    atr: h1a.atr,
    w1: C.summarize(w1a), d1: C.summarize(d1a), h4: C.summarize(h4a), h1: C.summarize(h1a),
    biasScore: score,
    regime,
    nearestResistance: C.r5(above[0] || null),
    nearestSupport: C.r5(below[0] || null),
    newsBlackout: false, // not replayable historically — disclosed
    session: C.sessionInfo(pair, new Date(C.tparseUTC(base.datetimes[i]))),
  };
}

// Last TF_SLICE 1h bars up to and including i.
function sliceTF1h(base, i) {
  const s = Math.max(0, i - TF_SLICE + 1);
  return {
    opens: base.opens.slice(s, i + 1), highs: base.highs.slice(s, i + 1),
    lows: base.lows.slice(s, i + 1), closes: base.closes.slice(s, i + 1),
  };
}

// Precompute, for a higher TF: completed-bar arrays + per-1h-bar running
// partials, so sliceTF(tf, i) === resample(bars[0..i]) exactly, in O(slice).
function precomputeTF(base, keyFn) {
  const n = base.closes.length;
  const barIdx = new Array(n);   // which TF bar this 1h bar belongs to
  const pOpen = new Array(n), pHigh = new Array(n), pLow = new Array(n), pClose = new Array(n);
  const O = [], H = [], L = [], Cl = [];
  let curKey = null;
  for (let i = 0; i < n; i++) {
    const k = keyFn(base.datetimes[i]);
    if (k !== curKey) {
      curKey = k;
      O.push(base.opens[i]); H.push(base.highs[i]); L.push(base.lows[i]); Cl.push(base.closes[i]);
    } else {
      const j = O.length - 1;
      if (base.highs[i] > H[j]) H[j] = base.highs[i];
      if (base.lows[i] < L[j]) L[j] = base.lows[i];
      Cl[j] = base.closes[i];
    }
    const j = O.length - 1;
    barIdx[i] = j; pOpen[i] = O[j]; pHigh[i] = H[j]; pLow[i] = L[j]; pClose[i] = Cl[j];
  }
  return { barIdx, pOpen, pHigh, pLow, pClose, O, H, L, C: Cl };
}

// Completed TF bars before bar i's period + the partial bar as of i.
function sliceTF(tf, i) {
  const j = tf.barIdx[i]; // index of the (partial) current TF bar
  const s = Math.max(0, j - TF_SLICE + 1);
  const opens = tf.O.slice(s, j); const highs = tf.H.slice(s, j);
  const lows = tf.L.slice(s, j); const closes = tf.C.slice(s, j);
  opens.push(tf.pOpen[i]); highs.push(tf.pHigh[i]); lows.push(tf.pLow[i]); closes.push(tf.pClose[i]);
  return { opens, highs, lows, closes };
}

// ---------------------------------------------------------------------------
// Metrics — the numbers a desk actually judges a strategy by
// ---------------------------------------------------------------------------
function summarizeResults(pair, trades, fromTs, toTs) {
  const split = fromTs + (toTs - fromTs) * 0.6; // 60% in-sample / 40% out-of-sample
  const inS = trades.filter((t) => t.openedTs <= split);
  const outS = trades.filter((t) => t.openedTs > split);
  return {
    pair,
    window: {
      from: new Date(fromTs).toISOString().slice(0, 10),
      to: new Date(toTs).toISOString().slice(0, 10),
      days: Math.round((toTs - fromTs) / 86400000),
    },
    spreadCharged: C.SPREADS[pair],
    all: metrics(trades),
    inSample: metrics(inS),
    outOfSample: metrics(outS),
    lastTrades: trades.slice(-8).map((t) => ({
      dir: t.direction, r: t.r, outcome: t.outcome, exit: t.exit,
      opened: new Date(t.openedTs).toISOString().slice(0, 16),
    })),
  };
}

// Exposed for offline testing with synthetic candles.
exports._test = { backtestPair, snapshotAt, precomputeTF, sliceTF };

function metrics(trades) {
  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const scratches = trades.filter((t) => t.outcome === "scratch");
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  const grossWin = wins.reduce((a, t) => a + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.r, 0)) +
    Math.abs(scratches.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0));
  // Equity curve in R -> max drawdown + longest losing streak.
  let eq = 0, peak = 0, maxDD = 0, streak = 0, maxStreak = 0;
  for (const t of trades) {
    eq += t.r;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
    if (t.outcome === "loss") { streak++; if (streak > maxStreak) maxStreak = streak; }
    else if (t.outcome === "win") streak = 0;
  }
  const decisive = wins.length + losses.length;
  return {
    trades: trades.length,
    wins: wins.length, losses: losses.length, scratches: scratches.length,
    winRate: decisive ? Math.round((wins.length / decisive) * 100) : 0,
    totalR: Number(totalR.toFixed(2)),
    expectancyR: trades.length ? Number((totalR / trades.length).toFixed(3)) : 0,
    avgWinR: wins.length ? Number((grossWin / wins.length).toFixed(2)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? 99 : 0),
    maxDrawdownR: Number(maxDD.toFixed(2)),
    maxConsecutiveLosses: maxStreak,
  };
}
