// Netlify function: settings
// ---------------------------------------------------------------------------
// Persists your account size + risk % SERVER-SIDE (Netlify Blobs), so it's one
// shared setting used everywhere: the dashboard, the pending-setup emails, and
// the "ENTER NOW" trade emails all recommend the SAME lot size — not just a
// number shown in your browser. Set it once from any device, it sticks.
//
// Two numbers, two purposes:
//   account = your last-typed reference balance (editing this = "set/reset my
//             balance to X", like recording a deposit or correcting a number).
//   equity  = the LIVE, compounding balance. Starts equal to account, then the
//             signal engine grows/shrinks it automatically as trades close —
//             like a real trading account. Editing riskPct alone does NOT
//             reset equity; only a genuine change to `account` does.
//
//   GET  /.netlify/functions/settings                    -> {account, riskPct, equity, updatedAt}
//   POST /.netlify/functions/settings {account, riskPct}  -> saves + returns it
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
      const existing = (await store.get("settings", { type: "json" })) || {};
      // Only reset the live equity when the account number itself actually
      // changed (a deliberate "set my balance to X"). A pure risk% tweak keeps
      // your compounded balance intact.
      const accountChanged = !existing.account || Math.abs(Number(existing.account) - account) > 0.0001;
      const equity = accountChanged
        ? account
        : (Number.isFinite(Number(existing.equity)) && Number(existing.equity) > 0 ? Number(existing.equity) : account);
      const settings = { account, riskPct, equity, updatedAt: new Date().toISOString() };
      await store.setJSON("settings", settings);
      return { statusCode: 200, headers, body: JSON.stringify(settings) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }) };
    }
  }

  // GET
  try {
    const raw = (await store.get("settings", { type: "json" })) || { account: 0, riskPct: 0, equity: 0 };
    const equity = Number.isFinite(Number(raw.equity)) && Number(raw.equity) > 0 ? Number(raw.equity) : Number(raw.account) || 0;
    return { statusCode: 200, headers, body: JSON.stringify({ ...raw, equity }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }) };
  }
};
