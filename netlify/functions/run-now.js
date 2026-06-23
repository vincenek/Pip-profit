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
    // Run the full engine pipeline (fetch -> indicators -> news -> Gemini -> grade -> save).
    const result = await engine.handler(event || {});

    // Read back what it just saved so you see signals in this same response.
    let latest = null;
    try {
      latest = await getStore("signals").get("latest", { type: "json" });
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
          latest,
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
