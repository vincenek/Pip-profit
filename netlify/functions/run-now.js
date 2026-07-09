// Netlify function: run-now
// ---------------------------------------------------------------------------
// Manual one-click trigger for the signal engine. Scheduled functions only run
// on their cron, so this lets you force a run on demand (and see the result +
// any errors) by simply opening:
//   https://<your-site>.netlify.app/.netlify/functions/run-now
//
// It runs the SAME engine the schedule uses, then returns the freshest signals.
// Handy for testing right after deploy or after changing env vars.
// (Each run uses a little of your free Gemini/Twelve Data quota — both generous.)
// ---------------------------------------------------------------------------

const { getStore, connectLambda } = require("@netlify/blobs");
const engine = require("./signal-engine.js");

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Wire up Blobs for this Lambda-compat function (and, via the shared event,
  // for the engine handler we call below).
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }

  const qs = event && event.queryStringParameters;

  // ?reset=1 → wipe the track record + open trades for a clean, honest start.
  if (qs && (qs.reset === "1" || qs.reset === "true")) {
    try {
      const store = getStore("signals");
      await store.setJSON("ledger", { open: [], closed: [], stats: {}, sentAlerts: [] });
      await store.setJSON("latest", { generatedAt: new Date().toISOString(), signals: [], stats: {}, open: [], history: [] });
      return { statusCode: 200, headers, body: JSON.stringify({ reset: true, message: "Track record and open trades cleared. Next run starts fresh." }, null, 2) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }, null, 2) };
    }
  }

  // ?debugTimes=1 → ground-truth comparison of openedAt vs openedTs vs a fresh
  // re-parse of openedAt, for every closed+open trade. Used to diagnose whether
  // openedTs is stale/inconsistent (from older code versions) before trusting it
  // for anything destructive like the weekend cleanup below.
  if (qs && (qs.debugTimes === "1" || qs.debugTimes === "true")) {
    try {
      const store = getStore("signals");
      const ledger = (await store.get("ledger", { type: "json" })) || { open: [], closed: [] };
      const all = [...(ledger.closed || []), ...(ledger.open || [])];
      const rows = all.map((t) => {
        const freshTs = Date.parse(t.openedAt);
        const mismatch = t.openedTs != null && Math.abs(t.openedTs - freshTs) > 1000;
        return {
          pair: t.pair,
          openedAt: t.openedAt,
          openedTs: t.openedTs,
          freshParseOfOpenedAt: freshTs,
          diffMs: t.openedTs != null ? t.openedTs - freshTs : null,
          mismatch,
          dayFromOpenedTs: t.openedTs != null ? new Date(t.openedTs).getUTCDay() : null,
          dayFromOpenedAt: new Date(freshTs).getUTCDay(),
          marketOpenByOpenedTs: t.openedTs != null ? engine.forexMarketOpen(new Date(t.openedTs)) : null,
          marketOpenByOpenedAt: engine.forexMarketOpen(new Date(freshTs)),
        };
      });
      const mismatches = rows.filter((r) => r.mismatch);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ totalTrades: all.length, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 30), sample: rows.slice(0, 5) }, null, 2),
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }, null, 2) };
    }
  }

  // ?cleanupWeekend=1 → remove ONLY trades opened while forex was closed
  // (weekend). Every real weekday trade is left untouched. Add &dryRun=1 to
  // preview what would be removed without saving anything.
  if (qs && (qs.cleanupWeekend === "1" || qs.cleanupWeekend === "true")) {
    try {
      const store = getStore("signals");
      const ledger = (await store.get("ledger", { type: "json" })) || { open: [], closed: [], pending: [] };
      ledger.pending = ledger.pending || [];

      const wasWeekend = (t) => {
        const ts = t.openedTs != null ? t.openedTs : Date.parse(t.openedAt);
        return Number.isFinite(ts) && !engine.forexMarketOpen(new Date(ts));
      };
      const wasWeekendPending = (p) => {
        const ts = p.createdTs != null ? p.createdTs : Date.parse(p.createdAt);
        return Number.isFinite(ts) && !engine.forexMarketOpen(new Date(ts));
      };

      const removedClosed = ledger.closed.filter(wasWeekend);
      const removedOpen = ledger.open.filter(wasWeekend);
      const removedPending = ledger.pending.filter(wasWeekendPending);

      const dryRun = qs.dryRun === "1" || qs.dryRun === "true";
      // Keep the response payload SMALL and bounded (max 12 examples) — a large
      // JSON body gets corrupted/summarized unreliably by some read-back tools,
      // regardless of what's asked for. Counts are the trustworthy source of truth.
      const summary = {
        cleanupWeekend: true,
        dryRun,
        removed: {
          closed: removedClosed.length,
          open: removedOpen.length,
          pending: removedPending.length,
        },
        removedTradesSample: [...removedClosed, ...removedOpen].slice(0, 12).map((t) => ({
          pair: t.pair, direction: t.direction, openedAt: t.openedAt, outcome: t.outcome || "was open",
        })),
        remaining: {
          closed: ledger.closed.length - removedClosed.length,
          open: ledger.open.length - removedOpen.length,
        },
      };

      if (!dryRun) {
        ledger.closed = ledger.closed.filter((t) => !wasWeekend(t));
        ledger.open = ledger.open.filter((t) => !wasWeekend(t));
        ledger.pending = ledger.pending.filter((p) => !wasWeekendPending(p));
        engine.recomputeStats(ledger);
        await store.setJSON("ledger", ledger);

        // Keep "latest" (what the dashboard reads) in sync.
        const latest = (await store.get("latest", { type: "json" })) || {};
        latest.stats = ledger.stats;
        latest.open = ledger.open;
        latest.pending = ledger.pending;
        latest.history = ledger.closed;
        await store.setJSON("latest", latest);
        summary.newStats = ledger.stats;
      }

      return { statusCode: 200, headers, body: JSON.stringify(summary, null, 2) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }, null, 2) };
    }
  }

  // ?desktest=1 → convene the Desk Committee on live data right now (visible
  // deliberation, no trade, doesn't consume the desk's daily budget).
  if (qs && (qs.desktest === "1" || qs.desktest === "true")) {
    try {
      const result = await engine.deskTest();
      return { statusCode: 200, headers, body: JSON.stringify({ desktest: true, ...result }, null, 2) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }, null, 2) };
    }
  }

  // ?test=1 → just verify notification channels (no engine run, no quota used).
  if (qs && (qs.test === "1" || qs.test === "true")) {
    try {
      const channels = await engine.testAlert();
      return { statusCode: 200, headers, body: JSON.stringify({ test: true, channels }, null, 2) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }, null, 2) };
    }
  }

  try {
    // Run the full engine pipeline. manualRun: desk deliberations defer to the
    // scheduled run (30s budget) — this endpoint only has ~10s, and returning
    // the FULL latest blob here (250+ trade history) was blowing that budget.
    const result = await engine.handler({ ...(event || {}), manualRun: true });

    // Compact read-back — the dashboard reloads get-signal itself anyway.
    let summary = null;
    try {
      const latest = await getStore("signals").get("latest", { type: "json" });
      if (latest) {
        summary = {
          generatedAt: latest.generatedAt,
          stats: latest.stats,
          open: (latest.open || []).length,
          pending: (latest.pending || []).length,
          broker: latest.broker,
          signals: (latest.signals || []).map((s) => ({
            pair: s.pair, direction: s.direction, qualityScore: s.qualityScore,
            error: s.error, risk_block: s.risk_block,
          })),
        };
      }
    } catch (e) {
      /* blobs may be empty if the engine errored before saving */
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(
        {
          triggered: true,
          engineStatus: result && result.statusCode,
          engineResult: safeParse(result && result.body),
          latest: summary,
        },
        null,
        2
      ),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err) }, null, 2),
    };
  }
};

function safeParse(b) {
  try {
    return JSON.parse(b);
  } catch {
    return b;
  }
}
