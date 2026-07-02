// Netlify function: settings
// ---------------------------------------------------------------------------
// Persists your account size + risk % SERVER-SIDE (Netlify Blobs), so it's one
// shared setting used everywhere: the dashboard, the pending-setup emails, and
// the "ENTER NOW" trade emails all recommend the SAME lot size — not just a
// number shown in your browser. Set it once from any device, it sticks.
//
//   GET  /.netlify/functions/settings            -> { account, riskPct, updatedAt }
//   POST /.netlify/functions/settings  {account, riskPct}  -> saves + returns it
// ---------------------------------------------------------------------------

const { getStore, connectLambda } = require("@netlify/blobs");

exports.handler = async (event) => {
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const store = getStore("signals");

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const account = Number(body.account);
      const riskPct = Number(body.riskPct);
      if (!Number.isFinite(account) || account < 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "account must be a non-negative number" }) };
      }
      if (!Number.isFinite(riskPct) || riskPct < 0 || riskPct > 100) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "riskPct must be 0-100" }) };
      }
      const settings = { account, riskPct, updatedAt: new Date().toISOString() };
      await store.setJSON("settings", settings);
      return { statusCode: 200, headers, body: JSON.stringify(settings) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }) };
    }
  }

  // GET
  try {
    const settings = (await store.get("settings", { type: "json" })) || { account: 0, riskPct: 0 };
    return { statusCode: 200, headers, body: JSON.stringify(settings) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }) };
  }
};
