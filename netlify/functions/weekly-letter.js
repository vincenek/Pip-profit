// Netlify function: weekly-letter — the agent's fund-manager letter.
// ---------------------------------------------------------------------------
// Every Friday after the close it:
//   - re-runs the backtest on fresh history (the benchmark)
//   - measures the LIVE week (its actual forward record)
//   - checks DRIFT: live performing meaningfully worse than backtest is the
//     #1 early-warning that something broke (data, regime, or the edge itself)
//   - emails the letter + saves it for the dashboard
//
// Deterministic by design (numbers, not vibes). Manually triggerable:
// /.netlify/functions/weekly-letter
// ---------------------------------------------------------------------------

const { getStore, connectLambda } = require("@netlify/blobs");
const engine = require("./signal-engine.js");
const backtest = require("./backtest.js");
const C = engine.core;

exports.handler = async (event) => {
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const store = getStore("signals");
    const ledger = (await store.get("ledger", { type: "json" })) || { open: [], closed: [], stats: {} };
    const settings = (await store.get("settings", { type: "json" })) || {};
    const now = Date.now();

    // ---- Live week ----
    const wk = ledger.closed.filter((c) => now - Date.parse(c.closedAt) < 7 * 86400000);
    const wins = wk.filter((c) => c.outcome === "win").length;
    const losses = wk.filter((c) => c.outcome === "loss").length;
    const scr = wk.filter((c) => c.outcome === "scratch").length;
    const rWeek = wk.reduce((a, c) => a + (c.rMultiple || 0), 0);
    const liveExp = wk.length ? rWeek / wk.length : 0;

    // ---- Benchmark (fresh backtest per pair) ----
    const bench = {};
    for (const pair of C.PAIRS) {
      try {
        const base = await C.getCandles(pair);
        const r = backtest._test.backtestPair(pair, base);
        bench[pair] = r.all ? r.all : { error: r.error };
      } catch (e) {
        bench[pair] = { error: String(e).slice(0, 120) };
      }
    }
    const benchExps = Object.values(bench).filter((b) => b.expectancyR != null).map((b) => b.expectancyR);
    const benchExp = benchExps.length ? benchExps.reduce((a, x) => a + x, 0) / benchExps.length : 0;

    // ---- Drift verdict ----
    let drift = "n/a — not enough live trades this week to judge.";
    if (wk.length >= 5) {
      const gap = liveExp - benchExp;
      drift =
        gap < -0.15
          ? `⚠️ WARNING: live expectancy (${liveExp.toFixed(2)}R) is well BELOW the backtest benchmark (${benchExp.toFixed(2)}R). If this repeats next week, reduce risk and investigate.`
          : gap > 0.15
          ? `Live (${liveExp.toFixed(2)}R) is running ABOVE benchmark (${benchExp.toFixed(2)}R) — fine, but don't extrapolate a hot week.`
          : `Live (${liveExp.toFixed(2)}R) is tracking the benchmark (${benchExp.toFixed(2)}R) — the system is behaving as measured.`;
    }

    const equityLine = settings.account > 0
      ? `Equity: $${Number(settings.equity || settings.account).toFixed(2)} (started $${Number(settings.account).toFixed(2)})`
      : "Equity tracking not configured.";

    const benchLines = Object.entries(bench).map(([p, b]) =>
      b.error
        ? `  ${p}: backtest error — ${b.error}`
        : `  ${p}: ${b.trades} trades, ${b.winRate}% win, ${b.expectancyR >= 0 ? "+" : ""}${b.expectancyR}R/trade, PF ${b.profitFactor}, maxDD ${b.maxDrawdownR}R`
    );

    const letter =
      `📊 WEEKLY LETTER — ${new Date().toISOString().slice(0, 10)}\n\n` +
      `THE WEEK (live, forward record)\n` +
      `  ${wk.length} closed: ${wins}W / ${losses}L / ${scr} scratch · ${rWeek >= 0 ? "+" : ""}${rWeek.toFixed(2)}R ` +
      `(${liveExp >= 0 ? "+" : ""}${liveExp.toFixed(3)}R/trade)\n  ${equityLine}\n  Open book: ${ledger.open.length} position(s)\n\n` +
      `THE BENCHMARK (strategy re-backtested on fresh history)\n${benchLines.join("\n")}\n\n` +
      `DRIFT CHECK\n  ${drift}\n\n` +
      `All-time: ${ledger.stats.total || 0} trades, ${ledger.stats.winRate || 0}% win, avg ${ledger.stats.avgR || 0}R.`;

    await store.setJSON("weeklyLetter", { text: letter, generatedAt: new Date().toISOString() });
    await C.sendEmail("📊 FX agent — weekly letter", letter).catch((e) => console.warn("letter email:", String(e)));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, letter }, null, 2) };
  } catch (err) {
    console.error("weekly-letter failed:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }) };
  }
};
