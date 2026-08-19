// Netlify function: checkpoints
// ---------------------------------------------------------------------------
// Lets you mark "now" as a fresh starting line on the dashboard, so after a
// real fix (a bug squashed, a model swapped, a strategy change) you can judge
// results FROM THAT MOMENT FORWARD instead of averaging in the messy past.
// Nothing in the trade history is ever touched — this is purely a set of
// timestamps the dashboard uses to filter its OWN display.
//
//   GET /.netlify/functions/checkpoints                    -> list all
//   GET /.netlify/functions/checkpoints?add=1&label=...     -> add one "now"
//   GET /.netlify/functions/checkpoints?delete=1&id=...      -> remove one
// ---------------------------------------------------------------------------

const { getStore, connectLambda } = require("@netlify/blobs");

exports.handler = async (event) => {
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const store = getStore("signals");
  const qs = event.queryStringParameters || {};

  try {
    const list = (await store.get("checkpoints", { type: "json" })) || [];

    if (qs.add === "1" || qs.add === "true") {
      const label = String(qs.label || "").slice(0, 60) || `Checkpoint ${new Date().toISOString().slice(0, 10)}`;
      const cp = { id: `cp-${Date.now()}`, label, at: new Date().toISOString() };
      list.push(cp);
      list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      await store.setJSON("checkpoints", list);
      return { statusCode: 200, headers, body: JSON.stringify({ added: true, checkpoint: cp, checkpoints: list }) };
    }

    if (qs.delete === "1" || qs.delete === "true") {
      const kept = list.filter((c) => c.id !== qs.id);
      await store.setJSON("checkpoints", kept);
      return { statusCode: 200, headers, body: JSON.stringify({ deleted: true, checkpoints: kept }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ checkpoints: list }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }) };
  }
};
