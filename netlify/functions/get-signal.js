// Netlify function: get-signal
// ---------------------------------------------------------------------------
// The website calls this to read the latest signal produced by signal-engine.js.
// It just returns whatever the scheduled engine last saved to Netlify Blobs.
// No secrets here — it's safe to call from the browser.
// ---------------------------------------------------------------------------

const { getStore, connectLambda } = require("@netlify/blobs");

exports.handler = async (event) => {
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    // Let the browser cache briefly so we don't hammer Blobs on every load.
    "Cache-Control": "public, max-age=60",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    const store = getStore("signals");

    // ?pair=EUR/USD returns that pair's signal; no pair returns the full list.
    const pair = event.queryStringParameters && event.queryStringParameters.pair;

    if (pair) {
      const key = "pair:" + pair.toUpperCase().replace("/", "-");
      const signal = await store.get(key, { type: "json" });
      if (!signal) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: `No signal yet for ${pair}. The engine runs on a schedule — check back soon.` }),
        };
      }
      return { statusCode: 200, headers, body: JSON.stringify(signal) };
    }

    const latest = await store.get("latest", { type: "json" });
    if (!latest) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "No signals yet. The engine runs on a schedule — check back soon." }),
      };
    }
    return { statusCode: 200, headers, body: JSON.stringify(latest) };
  } catch (err) {
    console.error("get-signal failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Could not load the latest signal." }),
    };
  }
};
