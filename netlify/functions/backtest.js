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

exports.handler = async (event) => {
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  const qs = (event && event.queryStringParameters) || {};
  const pairs = qs.pair ? [qs.pair.toUpperCase()] : FOCUS;
  // ?gate=70 sweeps the quality threshold — parameter research without redeploys.
  const gate = Math.max(0, Math.min(100, Number(qs.gate) || C.NOTIFY_MIN_SCORE));
  const started = Date.now();
  const out = { generatedAt: new Date().toISOString(), qualityGate: gate, method: METHOD_NOTE, results: {} };

  for (const pair of pairs) {
    if (Date.now() - started > 8000) {
      out.results[pair] = { skipped: "time budget — run ?pair=" + pair + " individually" };
      continue;
    }
    try {
      const base = await C.getCandles(pair);
      out.results[pair] = backtestPair(pair, base, gate);
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

// ---------------------------------------------------------------------------
// Per-pair simulation
// ---------------------------------------------------------------------------
function backtestPair(pair, base, gate) {
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

    // ---- 3. New signal (deterministic core: bias direction + quality gate).
    const dir = snap.biasScore >= 3 ? "buy" : snap.biasScore <= -3 ? "sell" : null;
    if (dir) {
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
