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
const oanda = require("./oanda.js");
const mt5 = require("./mt5.js");

// BROKER ROUTER — the engine emits generic intents; whichever executor has its
// env keys set carries them out. MT5 (Exness demo via MetaApi) takes priority,
// then OANDA practice; with neither configured the system stays paper-only.
function brokerModule() {
  if (mt5.enabled()) return { name: "Exness MT5 demo", mod: mt5 };
  if (oanda.enabled()) return { name: "OANDA practice", mod: oanda };
  return { name: "paper", mod: null };
}

// BROKER ACTION QUEUE — sync strategy code enqueues intents (place/cancel/
// partial/trail/close); they execute against the demo broker in one async
// pass at the end of the run. Dormant unless a broker's env vars are set.
let brokerQueue = [];
function bq(type, payload) { brokerQueue.push({ type, ...payload }); }

// Desk deliberations produced during this run — merged into the standalone
// "desklog" blob (its own key so nothing else can clobber it).
let deskNewEntries = [];
async function mergeDeskLog(store) {
  let log = [];
  try {
    log = (await store.get("desklog", { type: "json", consistency: "strong" })) || [];
  } catch (e) { /* first run or read hiccup — start fresh */ }
  if (deskNewEntries.length) {
    log = log.concat(deskNewEntries).slice(-10);
    await store.setJSON("desklog", log).catch((e) => console.warn("desklog save:", String(e)));
  }
  return log;
}

const PAIRS = (process.env.SIGNAL_PAIRS || "EUR/USD,GBP/USD,USD/JPY")
  .split(",")
  .map((p) => p.trim().toUpperCase())
  .filter(Boolean);
// 70b-versatile: meaningfully smarter reasoning than 8b-instant, still free —
// but its DAILY token budget (~100k) is much smaller than 8b's (~500k). At the
// current compact-prompt + 3-pair + 30-min schedule this should fit; if it
// starts 429ing on the daily cap, either widen the schedule (netlify.toml) or
// fall back to GROQ_MODEL=llama-3.1-8b-instant via env var.
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const TD_KEY = process.env.TWELVEDATA_API_KEY;
const NEWS_WINDOW_MIN = Number(process.env.NEWS_WINDOW_MIN || 60);
// Only alert (and surface as high-conviction) signals at/above this quality score.
const NOTIFY_MIN_SCORE = Number(process.env.NOTIFY_MIN_SCORE || 65);

// HONEST COSTS: typical retail round-trip spread per pair (price units). Every
// simulated trade pays this at close — perfect-price fills overstate the edge.
const SPREADS = {
  "EUR/USD": 0.00007, "GBP/USD": 0.00010, "USD/JPY": 0.010,
  "AUD/USD": 0.00009, "USD/CAD": 0.00012, "USD/CHF": 0.00012, "NZD/USD": 0.00012,
};
function spreadRFor(o) {
  const spread = SPREADS[o.pair] != null ? SPREADS[o.pair] : (o.entry || 1) * 0.0001;
  const risk = Math.abs(o.entry - o.sl) || 1e-9;
  return spread / risk; // cost expressed in R (typically ~0.02-0.05R)
}

// DATA-DRIVEN per-pair risk scaling (backtest 157d, 2026-07): GBP/USD is the
// measurably weakest pair — max drawdown 13.6R, an 8-loss streak, negative
// out-of-sample expectancy — so it trades at HALF money-risk. Signals/stats
// still tracked at full R fidelity; only the $ sizing is scaled.
const PAIR_RISK_MULT = { "GBP/USD": 0.5 };

// PORTFOLIO RISK (institutional guards):
const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES || 3);      // total concurrent positions
const MAX_SAME_SIDE_USD = Number(process.env.MAX_SAME_SIDE_USD || 2);  // same-direction USD exposure cap
const DD_WARN = Number(process.env.DD_WARN || 0.10);   // -10% equity -> email warning
const DD_PAUSE = Number(process.env.DD_PAUSE || 0.20); // -20% equity -> pause new trades
const DD_RESUME = Number(process.env.DD_RESUME || 0.15); // resume below -15% (hysteresis)

// Which way a position leans on USD: +1 long USD, -1 short USD, 0 no USD leg.
function usdSide(pair, direction) {
  const [base, quote] = pair.split("/");
  const buy = direction === "buy";
  if (base === "USD") return buy ? 1 : -1;
  if (quote === "USD") return buy ? -1 : 1;
  return 0;
}

// Pre-trade portfolio checks. Returns a human-readable block reason, or null.
function portfolioBlock(record, ledger) {
  if (ledger.ddState && ledger.ddState.paused) {
    return "drawdown circuit-breaker active — new trades paused until equity recovers";
  }
  if (ledger.open.length >= MAX_OPEN_TRADES) {
    return `max ${MAX_OPEN_TRADES} concurrent positions reached`;
  }
  const side = usdSide(record.pair, record.direction);
  if (side !== 0) {
    const same = [...ledger.open, ...(ledger.pending || [])]
      .filter((x) => usdSide(x.pair, x.direction) === side).length;
    if (same >= MAX_SAME_SIDE_USD) {
      return `USD correlation guard: already ${same} position${same === 1 ? "" : "s"} ${side > 0 ? "long" : "short"} USD — this would stack the same bet`;
    }
  }
  return null;
}
// Fallback risk config (env vars) — overridden by the persisted /settings the
// dashboard writes to, so the account $ you type in the app is what the whole
// system (dashboard AND emails) uses everywhere, not just a local display.
const ACCOUNT_SIZE = Number(process.env.ACCOUNT_SIZE || 0);
const RISK_PCT = Number(process.env.RISK_PCT || 0);
// Built-in fallback so sizing/balance tracking is never just blank before you
// configure your real numbers — clearly flagged (isDefault) so the dashboard
// and emails can label it as an example, not your actual account.
const DEFAULT_ACCOUNT = 1000;
const DEFAULT_RISK_PCT = 1;

async function getRiskSettings(store) {
  try {
    const s = await store.get("settings", { type: "json" });
    if (s && Number(s.account) > 0 && Number(s.riskPct) > 0) {
      // "account" = your last-set reference/starting balance. "equity" = the LIVE,
      // compounding balance (starts equal to account, then grows/shrinks as trades
      // close) — this is what actually drives position sizing, like a real account.
      const equity = Number.isFinite(Number(s.equity)) && Number(s.equity) > 0 ? Number(s.equity) : Number(s.account);
      return { account: Number(s.account), riskPct: Number(s.riskPct), equity };
    }
  } catch (e) { /* fall through to defaults below */ }
  if (ACCOUNT_SIZE > 0 && RISK_PCT > 0) {
    return { account: ACCOUNT_SIZE, riskPct: RISK_PCT, equity: ACCOUNT_SIZE };
  }
  // Nothing configured anywhere (no saved settings, no env vars) — use a
  // labeled example so sizing always shows something, not blank.
  return { account: DEFAULT_ACCOUNT, riskPct: DEFAULT_RISK_PCT, equity: DEFAULT_ACCOUNT, isDefault: true };
}

// Standard-lot position size for the majors (X/USD and USD/X). Sized off the
// LIVE equity (compounding balance), not the static starting account number.
// Returns null if account/risk aren't configured.
function positionSize(entry, stop, pair, risk) {
  const account = risk ? (risk.equity != null ? risk.equity : risk.account) : ACCOUNT_SIZE;
  const riskPct = risk ? risk.riskPct : RISK_PCT;
  if (!account || !riskPct || !entry || !stop) return null;
  const stopDist = Math.abs(entry - stop);
  if (stopDist <= 0) return null;
  const riskAmt = account * riskPct / 100 * (PAIR_RISK_MULT[pair] || 1);
  const [base, quote] = pair.split("/");
  const contract = 100000;
  const usdPerLotPerPrice = quote === "USD" ? contract : base === "USD" ? contract / entry : contract;
  const lots = riskAmt / (stopDist * usdPerLotPerPrice);
  const pips = stopDist / (/JPY/.test(pair) ? 0.01 : 0.0001);
  return { riskAmt, lots, units: lots * contract, pips };
}

// Realize a closed trade's dollar P&L (using the $ risk captured AT OPEN TIME,
// never recomputed later — a real account doesn't resize a position after entry)
// and compound it into the live equity. No-op (returns unchanged) if the trade
// was opened before risk tracking was configured (no riskAmt captured).
function realizePnl(closedRec, riskState) {
  if (closedRec.riskAmt == null || !Number.isFinite(closedRec.riskAmt)) return closedRec;
  const pnlUsd = Number((closedRec.rMultiple * closedRec.riskAmt).toFixed(2));
  closedRec.pnlUsd = pnlUsd;
  if (riskState) {
    const base = riskState.equity != null ? riskState.equity : riskState.account || 0;
    riskState.equity = Number((base + pnlUsd).toFixed(2));
  }
  return closedRec;
}

exports.handler = async (event) => {
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    console.error("signal-engine: no AI key set (GROQ_API_KEY or GEMINI_API_KEY)");
    return { statusCode: 500, body: "No AI key set — add GROQ_API_KEY (recommended) or GEMINI_API_KEY" };
  }

  // Lambda-compat functions must wire up Blobs from the event before getStore().
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }

  brokerQueue = []; // fresh queue per run (lambda containers get reused)
  deskNewEntries = [];
  const store = getStore("signals");
  const riskSettings = await getRiskSettings(store); // account $ + risk % (dashboard-set or env fallback)
  // Mutable copy — trades closing DURING this run compound into riskState.equity
  // live (e.g. pair A's win funds pair B's position size later in the same run,
  // just like a real account). Persisted back to Blobs at the end of the run.
  const riskState = { ...riskSettings };

  // Economic calendar once for the whole run.
  const calendar = await getCalendar().catch((e) => {
    console.warn("calendar fetch failed:", String(e));
    return [];
  });

  // Existing ledger (track record) we will update as signals resolve.
  const ledger = (await store.get("ledger", { type: "json", consistency: "strong" })) || {
    open: [],
    closed: [],
    stats: emptyStats(),
  };
  ledger.pending = ledger.pending || []; // setups waiting for a pullback entry

  // ADAPT: the engine's real record, fed back so the AI learns from outcomes,
  // and per-pair calibration so the quality score reflects where it actually wins.
  const perfFeedback = performanceFeedback(ledger);
  const byPairStats = calibrationByPair(ledger);

  // AGENT MEMORY: the playbook — distilled lessons from its own closed trades,
  // injected into every decision. Rewritten/curated by the daily deep-think.
  const playbook = (await store.get("playbook", { type: "json" })) || { principles: [], lessons: [] };
  const dayplan = (await store.get("dayplan", { type: "json" })) || null; // morning deep-think output

  const justClosed = [];     // trades resolved this run (for result alerts)
  const manageAlerts = [];   // open trades turning bad / hitting +1R (exit mgmt)
  const justEntered = [];    // pending setups that just TRIGGERED (enter-now alerts)
  const justPending = [];    // new setups created this run (heads-up alerts)
  const cancelledSetups = []; // setups that expired/invalidated
  const marketOpen = forexMarketOpen(); // no new signals when forex is closed (weekend)

  // We hunt NEW setups only on the focus pairs (PAIRS), but we MANAGE every open
  // trade / pending setup no matter its pair — so trades on pairs we've stopped
  // scanning (e.g. after narrowing the list) still get trailed, closed, and graded.
  const focusSet = new Set(PAIRS);
  const extraPairs = [
    ...new Set([
      ...ledger.open.map((o) => o.pair),
      ...ledger.pending.map((p) => p.pair),
    ]),
  ].filter((p) => !focusSet.has(p));
  const allPairs = [...PAIRS, ...extraPairs];

  // 1. Build snapshots + grade/manage open trades in parallel (NO AI yet).
  const built = await Promise.all(
    allPairs.map(async (pair) => {
      const isFocus = focusSet.has(pair);
      try {
        const snapshot = await buildSnapshot(pair, calendar);
        evaluateOpenSignals(pair, snapshot, ledger, justClosed, manageAlerts, riskState);
        checkPending(pair, snapshot, ledger, justEntered, cancelledSetups, riskState);
        return { pair, snapshot, isFocus };
      } catch (err) {
        console.error(`${pair} data failed:`, err);
        return { pair, error: String(err), isFocus };
      }
    })
  );

  // 2. ONE AI call — analyze ONLY the focus pairs for NEW signals; review ALL
  //    open trades; AND write journal lessons for trades that just closed —
  //    all in the same request (zero extra token cost for the learning loop).
  const okBuilt = built.filter((b) => !b.error);
  const focusBuilt = okBuilt.filter((b) => b.isFocus);
  let signalByPair = {};
  let aiReviews = {};
  let aiError = null;
  if (marketOpen && (focusBuilt.length || ledger.open.length || justClosed.length)) {
    try {
      const res = await analyzePairs(focusBuilt.map((b) => b.snapshot), perfFeedback, ledger.open, playbook, justClosed);
      signalByPair = res.signals || {};
      aiReviews = res.reviews || {};
      // Attach lessons to the closed trades + append to the playbook's raw list
      // (the daily deep-think distills these into standing principles).
      for (const ls of res.lessons || []) {
        const rec = justClosed.find((c) => c.id === ls.id) ||
          justClosed[Number(ls.id)] || null;
        if (rec && ls.lesson) {
          rec.lesson = String(ls.lesson).slice(0, 240);
          playbook.lessons.push({
            when: rec.closedAt, pair: rec.pair, direction: rec.direction,
            outcome: rec.outcome, r: rec.rMultiple, lesson: rec.lesson,
          });
        }
      }
      if (res.lessons && res.lessons.length) {
        playbook.lessons = playbook.lessons.slice(-30); // keep the recent raw set
        await store.setJSON("playbook", playbook).catch(() => {});
      }
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
      // The AI may only cut LOSING trades still on their original stop — winners
      // are managed mechanically (TP1 partial + trail). Early-closing winners at
      // tiny +R was measurably destroying the edge.
      const unprotected = o.lockedR == null || o.lockedR < 0;
      if (rv && rv.verdict === "close" && price && unprotected && currentR(o, price) < 0) {
        const r = realizedR(o, currentR(o, price)) - spreadRFor(o);
        const closedRec = realizePnl({
          ...o, closedAt: new Date().toISOString(),
          outcome: r > 0.09 ? "win" : r < -0.09 ? "loss" : "scratch",
          rMultiple: Number(r.toFixed(2)), exit: "ai-close", exitReason: rv.reason, exitPrice: price,
        }, riskState);
        ledger.closed.unshift(closedRec);
        justClosed.push(closedRec);
        manageAlerts.push({ type: "close", pair: o.pair, direction: o.direction, entry: o.entry, reason: `AI review: ${rv.reason}`, rNow: r });
        bq("close", { open: o }); // execute the AI-judged close at the broker
      } else {
        stillOpen.push(o);
      }
    }
    ledger.open = stillOpen;
  }

  // 2c. DRAWDOWN CIRCUIT-BREAKER — checked after all closes have settled equity.
  //     Warn at -DD_WARN, pause NEW trades at -DD_PAUSE, auto-resume with
  //     hysteresis below -DD_RESUME. Open trades keep being managed throughout.
  ledger.ddState = ledger.ddState || { warned: false, paused: false };
  if (!riskSettings.isDefault && riskState.account > 0) {
    const dd = 1 - riskState.equity / riskState.account;
    if (!ledger.ddState.paused && dd >= DD_PAUSE) {
      ledger.ddState.paused = true;
      manageAlerts.push({ type: "risk", level: "pause", dd });
    } else if (ledger.ddState.paused && dd < DD_RESUME) {
      ledger.ddState.paused = false;
      ledger.ddState.warned = false;
      manageAlerts.push({ type: "risk", level: "resume", dd });
    }
    if (!ledger.ddState.warned && !ledger.ddState.paused && dd >= DD_WARN) {
      ledger.ddState.warned = true;
      manageAlerts.push({ type: "risk", level: "warn", dd });
    } else if (ledger.ddState.warned && dd < DD_WARN / 2) {
      ledger.ddState.warned = false; // recovered well clear — re-arm the warning
    }
  }

  // 3. Assemble records, score, track NEW signals — focus pairs only.
  //    (Non-focus pairs are managed above but don't generate new signals.)
  const signals = [];
  for (const b of built) {
    if (!b.isFocus) continue; // manage-only pair — no new signal
    if (b.error) {
      signals.push({ pair: b.pair, error: b.error });
      continue;
    }
    if (!marketOpen) {
      // Forex closed (weekend) — show status, take no new setups.
      signals.push({
        pair: b.pair, direction: "no_trade", qualityScore: 0,
        headline: "Forex market closed (weekend) — no new signals",
        generatedAt: new Date().toISOString(),
        snapshot: { price: b.snapshot.price, session: b.snapshot.session, regime: b.snapshot.regime },
      });
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

    // DON'T CHASE: a fresh high-quality signal becomes a PENDING setup (waits for
    // a pullback), not an instant market entry. If the signal flipped against an
    // existing setup, cancel that setup.
    if (record.direction === "buy" || record.direction === "sell") {
      const opp = ledger.pending.find((p) => p.pair === b.pair && p.direction !== record.direction);
      if (opp) {
        ledger.pending = ledger.pending.filter((p) => p !== opp);
        cancelledSetups.push({ ...opp, reason: "signal flipped direction" });
        bq("cancel", { pending: opp }); // pull the broker's pending order too
      }
      // PORTFOLIO GUARDS — institutional pre-trade checks (drawdown pause,
      // concurrent-position cap, correlated-USD-exposure cap).
      const blocked = portfolioBlock(record, ledger);
      if (blocked) {
        record.risk_block = blocked; // surfaced on the dashboard card
      } else if ((record.qualityScore || 0) >= NOTIFY_MIN_SCORE && event && event.manualRun) {
        // Manual (Run now) invocations have a 10s budget — too tight for a
        // 3-agent deliberation. Defer to the next scheduled run (<=30 min),
        // which has 30s: every taken trade still gets desk-reviewed.
        record.risk_block = "🏛 desk review at the next scheduled run (within 30 min)";
      } else if ((record.qualityScore || 0) >= NOTIFY_MIN_SCORE) {
        // 🏛 THE DESK CONVENES — Analyst → Risk Manager → Head Trader deliberate
        // on this candidate. Only gated candidates reach here (a few per day).
        const desk = await deskReview(record, b.snapshot, playbook, ledger, riskState);
        record.desk = desk;
        if (desk.verdict === "veto") {
          record.risk_block = `Desk veto: ${desk.note || "risk objections upheld"}`;
        } else {
          const p = createPending(record, b.snapshot, ledger);
          if (p) {
            p.deskMult = desk.verdict === "take_half" ? 0.5 : 1;
            p.deskConviction = desk.conviction;
            p.deskNote = desk.note;
            justPending.push(p);
            // Mirror the setup as a real LIMIT order at the demo broker —
            // signed units from live risk sizing × the desk's size verdict.
            const ps = positionSize(p.entryZone, p.estSl, p.pair, riskState);
            if (ps) {
              const units = Math.max(1, Math.round(ps.units * p.deskMult)) * (p.direction === "buy" ? 1 : -1);
              bq("place", { pending: p, units });
            }
          }
        }
      }
    }
  }

  recomputeStats(ledger);

  // Notifications first (dedup keys recorded on the ledger), THEN persist.
  // Use riskState (post-run) so alerts after a close this run show fresh equity.
  await dispatchAlerts(
    { entered: justEntered, pending: justPending, cancelled: cancelledSetups, closed: justClosed, manage: manageAlerts },
    ledger,
    riskState
  );

  // BROKER EXECUTION — mirror this run's decisions onto the configured demo
  // broker (MT5/Exness via MetaApi, or OANDA practice; dormant without keys).
  // Runs BEFORE ledger persistence so the ids it writes onto objects are saved.
  const routed = brokerModule();
  let broker = { name: routed.name, enabled: !!routed.mod, executed: 0, errors: [] };
  if (routed.mod) {
    try {
      const r = await routed.mod.execute(brokerQueue);
      broker = { name: routed.name, ...r };
      if (broker.errors.length) console.warn("broker errors:", broker.errors.join(" | "));
    } catch (e) {
      broker.errors.push(String(e).slice(0, 160));
      console.warn("broker execute failed:", String(e));
    }
  }

  // Persist the compounded equity so the NEXT run (and the dashboard) picks up
  // where this one left off — only if risk tracking is actually configured (not
  // the unlabeled fallback default — that stays a pure example, never saved,
  // until you set your own numbers on the dashboard).
  if (!riskSettings.isDefault && riskState.account > 0 && riskState.riskPct > 0 && riskState.equity !== riskSettings.equity) {
    await store.setJSON("settings", {
      account: riskState.account, riskPct: riskState.riskPct, equity: riskState.equity,
      updatedAt: new Date().toISOString(),
    }).catch((e) => console.warn("failed to persist equity:", String(e)));
  }

  await store.setJSON("ledger", ledger);
  await store.setJSON("latest", {
    // Small, high-value fields FIRST, the potentially-huge `history` array LAST —
    // history keeps growing (every trade, nothing hidden, per design) and large
    // JSON bodies are where things after it risk getting lost in transit/tooling.
    generatedAt: new Date().toISOString(),
    riskSettings: riskState,        // account $ / risk % / LIVE equity driving position sizing
    broker,                          // OANDA practice execution status (enabled/executed/errors)
    agent: {                         // the agent's mind, for the dashboard
      principles: (playbook.principles || []).slice(0, 8),
      dayplan: dayplan ? dayplan.text : null,
      dayplanAt: dayplan ? dayplan.generatedAt : null,
      deskCallsToday: ledger.deskCalls ? ledger.deskCalls.count : 0,
      deskMax: DESK_MAX_PER_DAY,
    },
    deskLog: await mergeDeskLog(store), // recent committee deliberations (own blob key)
    drawdown: {
      paused: !!(ledger.ddState && ledger.ddState.paused),
      warned: !!(ledger.ddState && ledger.ddState.warned),
      dd: riskState.account > 0 ? Number((1 - riskState.equity / riskState.account).toFixed(4)) : 0,
    },
    stats: ledger.stats,
    calibration: ledger.stats, // historical hit-rate the dashboard surfaces
    open: ledger.open,              // currently tracked trades (for duration)
    pending: ledger.pending,        // setups waiting for a pullback entry
    signals,
    history: ledger.closed, // ALL resolved trades — nothing hidden — LAST
  });

  console.log(
    "signal-engine done:", signals.length, "pairs; winRate", ledger.stats.winRate,
    "| entered", justEntered.length, "pending", justPending.length, "closed", justClosed.length
  );
  return { statusCode: 200, body: JSON.stringify({ count: signals.length }) };
};

function keyFor(pair) {
  return pair.replace("/", "-");
}

// Forex is open Sun ~21:00 UTC → Fri ~21:00 UTC. Don't generate signals off
// stale weekend data. (Management still runs; it's a no-op without new candles.)
function forexMarketOpen(d = new Date()) {
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const hour = d.getUTCHours();
  if (day === 6) return false;               // Saturday
  if (day === 0 && hour < 21) return false;  // Sunday before open
  if (day === 5 && hour >= 21) return false; // Friday after close
  return true;
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
function sessionInfo(pair, at) {
  const h = (at || new Date()).getUTCHours(); // `at` lets the backtest ask "what session was it at bar time?"
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

function evaluateOpenSignals(pair, snapshot, ledger, justClosed, manageAlerts, riskState) {
  const raw = snapshot._h1raw;
  const still = [];
  for (const o of ledger.open) {
    if (o.pair !== pair) { still.push(o); continue; }

    // 1. Simulate the trade with the TRAILING stop (breakeven at +1R, trail 1R
    //    behind each milestone after). Returns a close, or updates live state.
    const graded = raw && raw.datetimes ? gradeWithTrailing(o, raw) : { closed: false };
    if (graded.closed) {
      const closedRec = realizePnl({ ...o, ...graded, closedAt: new Date().toISOString() }, riskState);
      ledger.closed.unshift(closedRec);
      if (justClosed) justClosed.push(closedRec);
      // Broker: its own SL/TP usually closed this already — belt-and-braces.
      bq("close", { open: o });
      continue;
    }

    // 2. Active management on the still-open trade.
    const action = manageOpenTrade(o, snapshot);
    if (action && action.type === "close") {
      // CUT EARLY: losing trade + strong evidence — close now, don't wait for stop.
      const r = realizedR(o, currentR(o, snapshot.price)) - spreadRFor(o);
      const closedRec = realizePnl({
        ...o, closedAt: new Date().toISOString(),
        outcome: r > 0.09 ? "win" : r < -0.09 ? "loss" : "scratch",
        rMultiple: Number(r.toFixed(2)), exit: "managed-close", exitReason: action.reason,
        exitPrice: snapshot.price,
      }, riskState);
      ledger.closed.unshift(closedRec);
      if (justClosed) justClosed.push(closedRec);
      if (manageAlerts) manageAlerts.push({ ...action, pair: o.pair, direction: o.direction, entry: o.entry });
      bq("close", { open: o }); // execute the early close at the broker too
      continue; // removed from open
    }
    if (action && action.type === "partial") {
      bq("partial", { open: o }); // bank half + stop to breakeven at the broker
    }
    if (action && action.type === "trail") {
      bq("trail", { open: o, newStop: action.newStop }); // move the broker stop
    }
    if (action && (action.type === "trail" || action.type === "partial") && manageAlerts) {
      manageAlerts.push({ ...action, pair: o.pair, direction: o.direction, entry: o.entry });
    }
    still.push(o);
  }
  ledger.open = ledger.open.filter((o) => o.pair !== pair).concat(still.filter((o) => o.pair === pair));
  ledger.closed = ledger.closed.slice(0, 5000); // keep essentially everything
}

function currentR(o, price) {
  const risk = Math.abs(o.entry - o.sl) || 1e-9;
  return (o.direction === "buy" ? price - o.entry : o.entry - price) / risk;
}

// Full-position realized R for a trade closed at raw price-R `r`: after the
// TP1 partial, half is already banked and the runner is half-size.
function realizedR(o, r) {
  return o.partialTaken ? (o.bankedR || 0) + r / 2 : r;
}

// Active management. Philosophy (measured, not vibes): early-closes may ONLY
// cut LOSING, unprotected trades on strong evidence — never snatch small
// profits from winners. Winners are managed mechanically (TP1 partial + trail).
// The old triggers closed winners at +0.2R and booked them as "wins", which is
// exactly how avg win fell to ~0.79R while the win-rate looked great.
function manageOpenTrade(o, s) {
  const buy = o.direction === "buy";
  const rNow = currentR(o, s.price);

  // Strong evidence only: a decisive higher-timeframe bias flip (clear majority
  // of factors reversed), or imminent high-impact news — and the trade must be
  // LOSING and still on its original stop.
  const biasAgainst = buy ? s.biasScore <= -3 : s.biasScore >= 3;
  const news = s.newsBlackout;
  if ((o.lockedR == null || o.lockedR < 0) && rNow < 0 && (biasAgainst || news)) {
    const reasons = [];
    if (biasAgainst) reasons.push("higher-timeframe bias decisively flipped against the trade");
    if (news) reasons.push("high-impact news imminent while the trade is underwater");
    return { type: "close", reason: reasons.join("; "), rNow };
  }

  // TP1 partial banked (gradeWithTrailing set it) — alert once.
  if (o.partialTaken && !o.partialAlerted) {
    o.partialAlerted = true;
    return { type: "partial", rNow, tp1: o.tp1, bankedR: o.bankedR || 0.9 };
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

// Simulate the trade candle-by-candle. Exit plan:
//   - TP1 (1.8R): bank HALF (+0.9R on the full-position scale), stop -> breakeven,
//     runner continues toward TP2 (3R).
//   - Trail: once peak >= +1R, stop trails ~1R behind in HALF-R steps.
//   - Stop-first tiebreak within a candle (conservative).
// INCREMENTAL: only candles after o.gradedUpTo are processed. (Re-walking old
// candles with an already-tightened stop was retroactively "stopping out" trades
// on candles they had already survived — e.g. the entry candle itself always
// touches the entry zone, so any trade trailed to breakeven instantly became a
// phantom scratch on the next run. That bug polluted the historical stats.)
// Returns {closed:true, ...} on exit, else {closed:false} and updates
// o.peakR / o.lockedR / o.currentStop / o.stage / o.partialTaken / o.gradedUpTo.
function gradeWithTrailing(o, raw) {
  const { datetimes, highs, lows } = raw;
  const buy = o.direction === "buy";
  const entry = o.entry;
  const risk = Math.abs(entry - o.sl) || 1e-9;
  const tp1 = o.tp1, tp2 = o.tp2;
  const dp = entry >= 10 ? 3 : 5;
  const Rof = (p) => (buy ? p - entry : entry - p) / risk;
  const stopPrice = (lockedR) =>
    lockedR < 0 ? o.sl : buy ? entry + lockedR * risk : entry - lockedR * risk;

  let peakR = o.peakR || 0;
  let lockedR = o.lockedR == null ? -1 : o.lockedR;
  let partialTaken = !!o.partialTaken;
  let bankedR = o.bankedR || 0;
  const fromTs = Math.max(o.openedTs || 0, o.gradedUpTo || 0);
  let lastProcessedTs = 0;

  const finish = (rawR, exitPrice, exit) => {
    // Charge the round-trip spread — a breakeven-price exit is a small real loss
    // in money terms, exactly like at a broker.
    const total = (partialTaken ? bankedR + rawR / 2 : rawR) - spreadRFor(o);
    return {
      closed: true,
      // ±0.09R band: spread-only outcomes still read "scratch" (the negative R
      // is fully counted in totals/equity either way).
      outcome: total > 0.09 ? "win" : total < -0.09 ? "loss" : "scratch",
      rMultiple: Number(total.toFixed(2)),
      exitPrice: Number(exitPrice.toFixed(dp)),
      peakR: Number(Math.max(peakR, rawR).toFixed(2)),
      partial: partialTaken,
      exit,
    };
  };

  for (let i = 0; i < datetimes.length; i++) {
    const ts = tparseUTC(datetimes[i]);
    if (ts <= fromTs) continue;
    // Only grade COMPLETED hourly candles — the forming one can still move.
    if (ts + 3600000 > Date.now()) continue;
    lastProcessedTs = Math.max(lastProcessedTs, ts);
    const hi = highs[i], lo = lows[i];
    const eff = stopPrice(lockedR);

    // a) Stop (uses the stop valid coming into this candle; stop-first tiebreak).
    const stopHit = buy ? lo <= eff : hi >= eff;
    if (stopHit) {
      const exit = lockedR < 0 ? "stop"
        : lockedR === 0 ? (partialTaken ? "runner breakeven" : "breakeven")
        : "trail +" + lockedR + "R";
      return finish(Rof(eff), eff, exit);
    }
    // b) TP1 — bank half, protect the runner at breakeven.
    if (!partialTaken && (buy ? hi >= tp1 : lo <= tp1)) {
      partialTaken = true;
      bankedR = Number((Rof(tp1) / 2).toFixed(2)); // ~+0.9R banked
      if (lockedR < 0) lockedR = 0;
      if (Rof(tp1) > peakR) peakR = Rof(tp1);
    }
    // c) Final target for the runner (or full position if TP1 not yet hit —
    //    a single huge candle can pass both; both are favourable).
    if (buy ? hi >= tp2 : lo <= tp2) {
      return finish(Rof(tp2), tp2, "target");
    }
    // d) Trail update for the NEXT candle: ~1R behind peak, in half-R steps.
    const favR = buy ? Rof(hi) : Rof(lo);
    if (favR > peakR) peakR = favR;
    if (peakR >= 1 - 1e-9) {
      // 0 at [1,1.5), 0.5 at [1.5,2), 1 at [2,2.5)... epsilon guards float edges
      // (e.g. (156.20-155.60)/0.30 === 1.99999... would otherwise miss the 2R step).
      const newLocked = Math.floor((peakR - 1) * 2 + 1e-9) / 2;
      if (newLocked > lockedR) lockedR = newLocked;
    }
  }

  // Still open — persist live management state (incremental high-water mark).
  o.peakR = Number(peakR.toFixed(2));
  o.lockedR = lockedR;
  o.partialTaken = partialTaken;
  o.bankedR = bankedR;
  o.currentStop = Number(stopPrice(lockedR).toFixed(dp));
  o.stage = (partialTaken ? "TP1 banked +" + bankedR + "R · " : "") +
    (lockedR < 0 ? "initial" : lockedR === 0 ? "breakeven" : "+" + lockedR + "R locked");
  if (lastProcessedTs > 0) o.gradedUpTo = lastProcessedTs;
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

// Compute exact, always-valid stop/targets from a given ENTRY price + ATR +
// structure. Reused for both market entries and pullback (don't-chase) entries.
function computeLevels(entry, buy, s) {
  const atr = s.atr && s.atr > 0 ? s.atr : entry * 0.001;
  let stopDist = 1.5 * atr;
  const swing = buy ? s.h1.swingLow : s.h1.swingHigh;
  if (Number.isFinite(swing)) {
    const swingDist = Math.abs(entry - swing) + 0.3 * atr;
    stopDist = Math.min(Math.max(stopDist, swingDist), 3.5 * atr);
  }
  const dp = entry >= 10 ? 3 : 5;
  const rd = (x) => Number(x.toFixed(dp));
  return {
    entry: rd(entry),
    sl: rd(buy ? entry - stopDist : entry + stopDist),
    tp1: rd(buy ? entry + 1.8 * stopDist : entry - 1.8 * stopDist),
    tp2: rd(buy ? entry + 3.0 * stopDist : entry - 3.0 * stopDist),
  };
}

// Mutates a signal in place with computed levels (entry = current price).
function applyComputedLevels(sig, s) {
  const lv = computeLevels(s.price, sig.direction === "buy", s);
  sig.entry_price = lv.entry; sig.stop_loss_price = lv.sl;
  sig.tp1_price = lv.tp1; sig.tp2_price = lv.tp2;
  sig.entry = String(lv.entry); sig.stop_loss = String(lv.sl);
  sig.take_profit_1 = String(lv.tp1); sig.take_profit_2 = String(lv.tp2);
  sig.risk_reward = "1:1.8";
}

// ===========================================================================
// DON'T CHASE — pending pullback entries.
// A new high-quality setup doesn't enter at market; it WAITS for price to pull
// back to a better level. We email a heads-up now, then email "ENTER NOW" the
// moment price reaches the level (any time of day). Expires if it never pulls back.
// ===========================================================================
const PULLBACK_ATR = Number(process.env.PULLBACK_ATR || 0.5);     // how deep a pullback to wait for
const ENTRY_WINDOW_HOURS = Number(process.env.ENTRY_WINDOW_HOURS || 6); // setup validity

function createPending(record, snapshot, ledger) {
  const dir = record.direction;
  if (dir !== "buy" && dir !== "sell") return null;
  if ((record.qualityScore || 0) < NOTIFY_MIN_SCORE) return null;
  // ANTI-STACKING: don't open a second bet on the same pair+direction while one
  // is already active (open or waiting to trigger). This is what allows
  // "multiple trades per pair" (a genuine reversal, or a new trade after the
  // last one closed) WITHOUT letting the engine restack the identical call
  // every 30-60 min during a sustained trend (was inflating trade counts).
  if ((ledger.pending || []).some((p) => p.pair === record.pair && p.direction === record.direction)) return null;
  if ((ledger.open || []).some((o) => o.pair === record.pair && o.direction === record.direction)) return null;

  const buy = dir === "buy";
  const price = snapshot.price;
  const atr = snapshot.atr && snapshot.atr > 0 ? snapshot.atr : price * 0.001;
  const dp = price >= 10 ? 3 : 5;
  const entryZone = Number((buy ? price - PULLBACK_ATR * atr : price + PULLBACK_ATR * atr).toFixed(dp));
  const estLevels = computeLevels(entryZone, buy, snapshot); // preview only — real levels are recomputed at trigger

  const p = {
    id: `${keyFor(record.pair)}-P-${Date.now()}`,
    pair: record.pair,
    direction: dir,
    entryZone,
    estSl: estLevels.sl,
    estTp1: estLevels.tp1,
    estTp2: estLevels.tp2,
    refPrice: price,
    qualityScore: record.qualityScore,
    timeframe: record.timeframe,
    headline: record.headline,
    reasoning: record.technical_reasoning,
    createdAt: record.generatedAt,
    createdTs: Date.parse(record.generatedAt),
    expiresAt: Date.parse(record.generatedAt) + ENTRY_WINDOW_HOURS * 3600000,
  };
  ledger.pending = ledger.pending || [];
  ledger.pending.push(p);
  return p;
}

// Per run: trigger pendings whose pullback level was reached → open the trade;
// expire ones that never pulled back. Returns via the accumulators.
function checkPending(pair, snapshot, ledger, justEntered, cancelled, riskState) {
  ledger.pending = ledger.pending || [];
  const raw = snapshot._h1raw;
  const keep = [];
  for (const p of ledger.pending) {
    if (p.pair !== pair) { keep.push(p); continue; }
    const buy = p.direction === "buy";

    // Did price reach the entry zone since the setup was created?
    let triggerTs = null;
    if (raw && raw.datetimes) {
      for (let i = 0; i < raw.datetimes.length; i++) {
        if (tparseUTC(raw.datetimes[i]) <= p.createdTs) continue;
        if (buy ? raw.lows[i] <= p.entryZone : raw.highs[i] >= p.entryZone) {
          triggerTs = tparseUTC(raw.datetimes[i]);
          break;
        }
      }
    }

    if (triggerTs != null) {
      // ENTER: open the trade at the pullback level, sized from that entry.
      const lv = computeLevels(p.entryZone, buy, snapshot);
      // Lock in the $ size NOW, off the current live equity — a real account
      // doesn't resize a position after it's opened, so this never changes again.
      // The desk's take_half verdict scales the money risk (not the R tracking).
      const psRaw = positionSize(lv.entry, lv.sl, pair, riskState);
      const dm = p.deskMult || 1;
      const ps = psRaw ? { ...psRaw, riskAmt: psRaw.riskAmt * dm, lots: psRaw.lots * dm, units: psRaw.units * dm } : null;
      const o = {
        id: `${keyFor(pair)}-${Date.now()}`,
        pair, direction: p.direction,
        entry: lv.entry, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2,
        timeframe: p.timeframe, qualityScore: p.qualityScore,
        openedAt: new Date(triggerTs).toISOString(), openedTs: triggerTs,
        peakR: 0, lockedR: -1, currentStop: lv.sl, stage: "initial", alertedLockedR: -1,
        partialTaken: false, bankedR: 0, gradedUpTo: triggerTs,
        viaPullback: true,
        riskAmt: ps ? ps.riskAmt : null,
        sizeLots: ps ? ps.lots : null,
        deskMult: dm,
        equityAtOpen: riskState ? riskState.equity : null,
      };
      // Carry the broker order id across so we can find the filled trade.
      if (p.oandaOrderId) o.oandaOrderId = p.oandaOrderId;
      ledger.open.push(o);
      if (justEntered) justEntered.push(o);
      bq("resolve", { open: o }); // locate the filled OANDA trade for this position
      continue; // removed from pending
    }

    if (Date.now() > p.expiresAt) {
      if (cancelled) cancelled.push({ ...p, reason: "no pullback within " + ENTRY_WINDOW_HOURS + "h" });
      bq("cancel", { pending: p }); // GTD would expire anyway; cancel is belt-and-braces
      continue; // expired, dropped
    }
    keep.push(p);
  }
  ledger.pending = keep;
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

// ===========================================================================
// THE DESK — a three-agent committee that convenes ONLY when a candidate setup
// has already passed the quality gate + portfolio guards (a few times a day at
// most, so it fits the free token budget). Analyst builds the case, Risk
// Manager attacks it, Head Trader concludes: take / take_half / veto.
// Everything is stored so the dashboard can SHOW the deliberation.
// ===========================================================================
const DESK_MAX_PER_DAY = Number(process.env.DESK_MAX_PER_DAY || 8);

async function deskReview(record, s, playbook, ledger, riskState, opts = {}) {
  // Budget: cap convenings per UTC day (test deliberations don't count).
  const today = new Date().toISOString().slice(0, 10);
  if (!ledger.deskCalls || ledger.deskCalls.date !== today) {
    ledger.deskCalls = { date: today, count: 0 };
  }
  if (!opts.test) {
    if (ledger.deskCalls.count >= DESK_MAX_PER_DAY) {
      return { verdict: "take", conviction: record.confidence || 60, note: "desk capped today — gate-only approval", capped: true };
    }
    ledger.deskCalls.count++;
  }

  try {
    const dir = record.direction.toUpperCase();
    const pairLine = perPairBlock(s);
    const pb = (playbook && playbook.principles || []).slice(0, 8).map((p) => "- " + p).join("\n");

    // 1) 📈 ANALYST — build the case.
    const analyst = await callAI(
      `You are the ANALYST on an FX desk. Build the honest case for this proposal from the data line only.\n` +
      `PROPOSAL: ${dir} ${record.pair} (quality score ${record.qualityScore}).\nDATA: ${pairLine}\n` +
      (pb ? `PLAYBOOK (your desk's learned principles):\n${pb}\n` : "") +
      `Return ONLY JSON {"thesis":"<=50 words","strength":0-100,"invalidation":"<=15 words"}`,
      { type: "OBJECT", properties: { thesis: STR, strength: NUM, invalidation: STR }, required: ["thesis", "strength"] }
    );

    // 2) 🛡 RISK MANAGER — attack the trade.
    const last5 = ledger.closed.slice(0, 5).map((c) => c.outcome).join(",") || "none yet";
    const openBook = ledger.open.map((o) => `${o.pair} ${o.direction}`).join("; ") || "flat";
    const dd = riskState && riskState.account > 0 ? Math.round((1 - riskState.equity / riskState.account) * 1000) / 10 : 0;
    const ev = (s.events || []).slice(0, 3).map((e) => `${e.impact} ${e.country} ${e.title} in ${e.minutesAway}min`).join("; ") || "none";
    const risk = await callAI(
      `You are the RISK MANAGER on an FX desk. Your job is to ATTACK this proposal — find the real reasons NOT to take it. No rubber-stamping; if the objections are weak, say approve.\n` +
      `PROPOSAL: ${dir} ${record.pair} q${record.qualityScore}.\nANALYST CASE (strength ${analyst.strength}): ${analyst.thesis}\n` +
      `PORTFOLIO: open [${openBook}] · last 5 outcomes [${last5}] · drawdown ${dd}%\nUPCOMING EVENTS: ${ev}\n` +
      `Return ONLY JSON {"objections":["<=15 words each, max 3"],"severity":"low|medium|high","recommendation":"approve|reduce|veto"}`,
      {
        type: "OBJECT",
        properties: {
          objections: { type: "ARRAY", items: STR },
          severity: { type: "STRING", enum: ["low", "medium", "high"] },
          recommendation: { type: "STRING", enum: ["approve", "reduce", "veto"] },
        },
        required: ["severity", "recommendation"],
      }
    );

    // 3) 👔 HEAD TRADER — conclude.
    const trader = await callAI(
      `You are the HEAD TRADER on an FX desk. Conclude on this proposal — you have final authority.\n` +
      `PROPOSAL: ${dir} ${record.pair} q${record.qualityScore}\n` +
      `ANALYST (strength ${analyst.strength}): ${analyst.thesis}\n` +
      `RISK MANAGER (severity ${risk.severity}, recommends ${risk.recommendation}): ${(risk.objections || []).join("; ") || "no material objections"}\n` +
      `Rules: honour a credible high-severity objection with veto; medium severity usually means take_half; ` +
      `low severity with a strong thesis means take. Be decisive — no hedging.\n` +
      `Return ONLY JSON {"verdict":"take|take_half|veto","conviction":0-100,"note":"<=25 words"}`,
      {
        type: "OBJECT",
        properties: {
          verdict: { type: "STRING", enum: ["take", "take_half", "veto"] },
          conviction: NUM,
          note: STR,
        },
        required: ["verdict", "conviction"],
      }
    );

    const verdict = ["take", "take_half", "veto"].includes(trader.verdict) ? trader.verdict : "take";
    const desk = {
      verdict,
      conviction: Math.max(0, Math.min(100, Number(trader.conviction) || 50)),
      note: String(trader.note || "").slice(0, 160),
      analyst: {
        thesis: String(analyst.thesis || "").slice(0, 240),
        strength: Math.max(0, Math.min(100, Number(analyst.strength) || 0)),
        invalidation: String(analyst.invalidation || "").slice(0, 90),
      },
      risk: {
        severity: risk.severity,
        recommendation: risk.recommendation,
        objections: (risk.objections || []).slice(0, 3).map((x) => String(x).slice(0, 90)),
      },
    };
    // Deliberation log — collected per run, merged into its OWN blob key at
    // the end. (Living inside the big ledger blob got clobbered by concurrent
    // runs: Netlify Blobs reads are eventually consistent, last-writer-wins.)
    deskNewEntries.push({
      when: new Date().toISOString(), pair: record.pair, direction: record.direction,
      quality: record.qualityScore, test: !!opts.test, ...desk,
    });
    return desk;
  } catch (err) {
    console.warn("desk unavailable:", String(err).slice(0, 120));
    return { verdict: "take", conviction: record.confidence || 60, note: "desk unavailable — gate-only approval", fallback: true };
  }
}
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

async function analyzePairs(snapshots, perfFeedback, openTrades = [], playbook = null, justClosed = []) {
  const blocks = snapshots.map(perPairBlock).join("\n");
  const openBlock = openTrades.length
    ? `\nOPEN POSITIONS — review each (hold or close). The desk manages exits ` +
      `mechanically (partial profit at TP1, stop to breakeven, trailing) — do NOT ` +
      `close to lock in a small gain; that is measured to destroy this desk's edge. ` +
      `Recommend 'close' ONLY for a LOSING trade whose thesis is decisively broken ` +
      `(clear higher-timeframe reversal against it, or major news risk while it is ` +
      `underwater). A wobble, pullback, or loss of momentum is NOT enough — the ` +
      `stop-loss already caps the risk. Default to 'hold'.\n` +
      openTrades.map((o) =>
        `[${o.pair}] ${o.direction.toUpperCase()} entry ${o.entry} stop ${o.currentStop} ` +
        `stage ${o.stage} peak +${o.peakR}R`
      ).join("\n") + "\n"
    : "";
  // AGENT PLAYBOOK — standing principles distilled from its own trade history.
  const playbookBlock = playbook && playbook.principles && playbook.principles.length
    ? `\nYOUR PLAYBOOK (principles you learned from your own past trades — apply them):\n- ` +
      playbook.principles.slice(0, 8).join("\n- ") + "\n"
    : "";
  // JOURNAL — trades that just closed; write one honest lesson each.
  const closedBlock = justClosed.length
    ? `\nJUST-CLOSED TRADES — for EACH, write ONE short honest lesson (max 25 words: ` +
      `what the setup was and why it worked/failed; no platitudes). Return in "lessons" ` +
      `keyed by id.\n` +
      justClosed.map((c) =>
        `id:${c.id} ${c.pair} ${String(c.direction).toUpperCase()} q${c.qualityScore} ` +
        `${c.outcome} ${c.rMultiple}R exit:${c.exit} peak:+${c.peakR || 0}R`
      ).join("\n") + "\n"
    : "";
  const prompt =
    `You are a senior FX analyst on a rules-based desk. For EACH pair below, decide ` +
    `the single highest-probability trade from the computed indicators ONLY, and ` +
    `return one signal object per pair (include its "pair").\n\n` +
    (perfFeedback ? `PERFORMANCE FEEDBACK (learn from your own results):\n${perfFeedback}\n\n` : "") +
    playbookBlock + openBlock + closedBlock + "\n" +
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
    (justClosed.length
      ? `,"lessons":[{"id":"<the id given>","lesson":""}]`
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
      lessons: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { id: STR, lesson: STR },
          required: ["id", "lesson"],
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
  return { signals: out, reviews, lessons: parsed.lessons || [] };
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
// RESILIENCE: if the primary (70B) model hits its rate/daily-token limit, the
// agent auto-retries on the 8B model (5x larger budget) instead of going dark.
async function callAI(prompt, responseSchema) {
  if (process.env.GROQ_API_KEY) {
    try {
      return await callGroq(prompt, GROQ_MODEL);
    } catch (err) {
      if (String(err).includes("429") && GROQ_MODEL !== "llama-3.1-8b-instant") {
        console.warn("Groq 70B rate-limited — falling back to 8B for this run");
        return await callGroq(prompt, "llama-3.1-8b-instant");
      }
      throw err;
    }
  }
  return callGemini(prompt, responseSchema);
}

async function callGroq(prompt, model) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: model || GROQ_MODEL,
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
async function dispatchAlerts(events, ledger = null, riskSettings = null) {
  const { entered = [], pending = [], cancelled = [], closed = [], manage = [] } = events || {};
  const sent = new Set((ledger && ledger.sentAlerts) || []);
  const items = []; // { key, text }

  const sizeLineFor = (entry, stop, pair, mult) => {
    const ps = positionSize(entry, stop, pair, riskSettings);
    if (!ps) return "";
    const m = mult || 1;
    return `\n📐 Size: ${(ps.lots * m).toFixed(2)} lots (${Math.round(ps.units * m).toLocaleString()} units) · risk $${(ps.riskAmt * m).toFixed(2)} · ${ps.pips.toFixed(0)} pips`;
  };

  // ENTER NOW — a pending setup pulled back to its level and triggered.
  for (const o of entered) {
    const arrow = o.direction === "buy" ? "🟢 ENTER BUY" : "🔴 ENTER SELL";
    items.push({
      key: `ENT:${o.id}`,
      text:
        `${arrow} ${o.pair} NOW @ ${o.entry}  (score ${o.qualityScore})\n` +
        `Stop ${o.sl}\nTP1 ${o.tp1}   TP2 ${o.tp2}\nR:R 1:1.8 · ${o.timeframe || ""}${sizeLineFor(o.entry, o.sl, o.pair, o.deskMult)}\n` +
        `Plan: bank HALF at TP1 → stop to breakeven → runner to TP2 (I'll email each step).\n` +
        `Price pulled back to the level — place the trade now.`,
    });
  }
  // SETUP heads-up — watching for a pullback.
  for (const p of pending) {
    const arrow = p.direction === "buy" ? "👀 BUY SETUP" : "👀 SELL SETUP";
    items.push({
      key: `PEN:${p.id}`,
      text:
        `${arrow} ${p.pair}  (score ${p.qualityScore})\n` +
        (p.deskNote ? `🏛 Desk verdict: ${p.deskMult === 0.5 ? "TAKE HALF SIZE" : "TAKE"} (${p.deskConviction || "?"}% conviction) — ${p.deskNote}\n` : "") +
        `Waiting for a pullback to ~${p.entryZone} to enter (valid ${ENTRY_WINDOW_HOURS}h). ` +
        `I'll email you the moment it triggers.${sizeLineFor(p.entryZone, p.estSl, p.pair, p.deskMult)}\n${p.reasoning || p.headline || ""}`,
    });
  }
  // SETUP cancelled.
  for (const p of cancelled) {
    items.push({
      key: `CAN:${p.id}`,
      text: `✖ SETUP CANCELLED ${p.pair} ${String(p.direction || "").toUpperCase()} — ${p.reason || "no longer valid"}`,
    });
  }

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
    } else if (m.type === "partial") {
      items.push({
        key: `M:partial:${m.pair}:${m.entry}`,
        text:
          `🎯 TP1 HIT ${m.pair} ${dir} @ ${m.tp1}\n` +
          `Bank HALF the position now (+${m.bankedR}R locked) and move your stop to ` +
          `breakeven (${m.entry}). The runner now rides risk-free toward TP2.`,
      });
    } else if (m.type === "trail") {
      items.push({
        key: `M:trail:${m.pair}:${m.entry}:${m.lockedR}`,
        text: m.lockedR === 0
          ? `🛡️ PROTECT ${m.pair} ${dir} is +${m.rNow.toFixed(1)}R\n` +
            `Move your stop to breakeven (${m.newStop}) — worst case is now a scratch, not a loss.`
          : `📈 TRAIL ${m.pair} ${dir} now +${m.rNow.toFixed(1)}R\n` +
            `Move your stop up to ${m.newStop} to lock in +${m.lockedR}R and keep riding toward TP.`,
      });
    } else if (m.type === "risk") {
      const pct = (m.dd * 100).toFixed(1);
      items.push({
        key: `RISK:${m.level}:${pct}`,
        text:
          m.level === "pause"
            ? `🛑 DRAWDOWN BREAKER TRIPPED — equity is down ${pct}% from your starting balance.\n` +
              `NEW trades are PAUSED (open trades still managed). Auto-resumes if equity recovers ` +
              `to within ${(DD_RESUME * 100).toFixed(0)}%. This is the capital-protection kill-switch doing its job.`
            : m.level === "warn"
            ? `⚠️ DRAWDOWN WARNING — equity is down ${pct}% from your starting balance.\n` +
              `If it reaches ${(DD_PAUSE * 100).toFixed(0)}%, the circuit-breaker pauses all new trades.`
            : `✅ DRAWDOWN RECOVERED — equity is back within ${(DD_RESUME * 100).toFixed(0)}% of start. New trades resumed.`,
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
// Exposed for one-off maintenance tools (e.g. run-now?cleanupWeekend=1).
exports.forexMarketOpen = forexMarketOpen;
exports.recomputeStats = recomputeStats;

// DESK TEST — convene the committee on live data RIGHT NOW (run-now?desktest=1)
// so the deliberation is visible on demand. Doesn't trade, doesn't count against
// the desk's daily budget; the deliberation is logged (flagged test) for the UI.
exports.deskTest = async () => {
  const store = getStore("signals");
  deskNewEntries = []; // fresh collector for this invocation
  const ledger = (await store.get("ledger", { type: "json", consistency: "strong" })) || { open: [], closed: [], pending: [] };
  const playbook = (await store.get("playbook", { type: "json" })) || { principles: [], lessons: [] };
  const riskSettings = await getRiskSettings(store);
  const calendar = await getCalendar().catch(() => []);
  const pair = PAIRS[0];
  const snapshot = await buildSnapshot(pair, calendar);
  const direction = snapshot.biasScore >= 0 ? "buy" : "sell"; // test on the leaning side
  const record = {
    pair, direction, confidence: 65,
    qualityScore: qualityScore(snapshot, { direction, confidence: 65 }, { total: 0 }),
  };
  const desk = await deskReview(record, snapshot, playbook, ledger, riskSettings, { test: true });
  // Persist to the standalone desklog blob — its own key, so nothing (e.g. a
  // concurrent scheduled run rewriting the ledger) can clobber it.
  await mergeDeskLog(store);
  return { pair, direction, quality: record.qualityScore, desk };
};

// STRATEGY CORE — exported so backtest.js replays the EXACT code the live
// engine trades with (no reimplementation drift; institutional requirement).
exports.core = {
  tparseUTC, resample, h4Key, d1Key, w1Key,
  analyse, summarize, scoreBias, computeLevels, qualityScore,
  sessionInfo, getCandles, spreadRFor, usdSide, r5,
  gradeWithTrailing, realizedR, currentR,
  getCalendar, callAI, sendEmail, dispatchAlerts,
  NOTIFY_MIN_SCORE, PULLBACK_ATR, ENTRY_WINDOW_HOURS, SPREADS, PAIR_RISK_MULT, PAIRS,
};

exports.testAlert = async () => {
  const text = "✅ FX Signal Desk test — your alerts are working.";
  return {
    telegram: await sendTelegram(text).then((r) => r).catch((e) => "ERROR: " + String(e)),
    whatsapp: await sendWhatsApp(text).then((r) => r).catch((e) => "ERROR: " + String(e)),
    email: await sendEmail("FX Signal Desk test", text).then((r) => r).catch((e) => "ERROR: " + String(e)),
  };
};
