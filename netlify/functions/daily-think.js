// Netlify function: daily-think — the agent's morning deep-think.
// ---------------------------------------------------------------------------
// Once every weekday (before London open), the agent steps back from the
// 30-minute grind and reflects properly:
//   - reads its raw journal lessons (written after every closed trade)
//   - distills them into <= 8 standing PLAYBOOK PRINCIPLES that every future
//     trading decision receives (this is how it durably learns a style)
//   - looks at the economic calendar for the next 24h + its open book
//   - writes a short DAY PLAN and emails it
//
// Manually triggerable for testing: /.netlify/functions/daily-think
// ---------------------------------------------------------------------------

const { getStore, connectLambda } = require("@netlify/blobs");
const engine = require("./signal-engine.js");
const C = engine.core;

exports.handler = async (event) => {
  try { if (event && event.blobs) connectLambda(event); } catch (e) { /* noop */ }
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const store = getStore("signals");
    const ledger = (await store.get("ledger", { type: "json" })) || { open: [], closed: [], stats: {} };
    const playbook = (await store.get("playbook", { type: "json" })) || { principles: [], lessons: [] };
    const calendar = await C.getCalendar().catch(() => []);

    // Next-24h high/medium-impact events for the focus currencies.
    const now = Date.now();
    const ccys = new Set(C.PAIRS.flatMap((p) => p.split("/")));
    const events = calendar
      .filter((e) => ccys.has(e.country) && (e.impact === "High" || e.impact === "Medium"))
      .filter((e) => e.ts > now && e.ts < now + 24 * 3600000)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 10);

    const last7 = ledger.closed.filter((c) => now - Date.parse(c.closedAt) < 7 * 86400000);
    const w = last7.filter((c) => c.outcome === "win").length;
    const l = last7.filter((c) => c.outcome === "loss").length;
    const r7 = last7.reduce((a, c) => a + (c.rMultiple || 0), 0);

    const prompt =
      `You are the trading agent of a small rules-based FX desk reviewing yourself before the session.\n\n` +
      `LAST 7 DAYS: ${w}W/${l}L, ${r7 >= 0 ? "+" : ""}${r7.toFixed(2)}R across ${last7.length} closed trades.\n\n` +
      `CURRENT PRINCIPLES:\n${(playbook.principles || []).map((p) => "- " + p).join("\n") || "(none yet)"}\n\n` +
      `RAW JOURNAL LESSONS (newest last):\n` +
      `${(playbook.lessons || []).slice(-15).map((x) => `- [${x.pair} ${x.direction} ${x.outcome} ${x.r}R] ${x.lesson}`).join("\n") || "(none yet)"}\n\n` +
      `OPEN BOOK:\n${ledger.open.map((o) => `- ${o.pair} ${o.direction} entry ${o.entry} stage ${o.stage}`).join("\n") || "(flat)"}\n\n` +
      `NEXT 24H CALENDAR:\n${events.map((e) => `- ${new Date(e.ts).toISOString().slice(5, 16)} ${e.country} ${e.impact}: ${e.title}`).join("\n") || "(quiet)"}\n\n` +
      `Task 1 — PRINCIPLES: rewrite the playbook as at most 8 principles (each <= 20 words), ` +
      `keeping only what the EVIDENCE in the lessons supports. Drop stale or contradicted ones. No platitudes.\n` +
      `Task 2 — DAY PLAN: <= 100 words. Concrete: what to favour, what to avoid, when to stand down (events!).\n\n` +
      `Return ONLY JSON: {"principles":["..."],"dayplan":"..."}`;

    const res = await C.callAI(prompt, {
      type: "OBJECT",
      properties: {
        principles: { type: "ARRAY", items: { type: "STRING" } },
        dayplan: { type: "STRING" },
      },
      required: ["principles", "dayplan"],
    });

    if (Array.isArray(res.principles) && res.principles.length) {
      playbook.principles = res.principles.slice(0, 8).map((p) => String(p).slice(0, 160));
      playbook.updatedAt = new Date().toISOString();
      await store.setJSON("playbook", playbook);
    }
    const dayplan = { text: String(res.dayplan || "").slice(0, 900), generatedAt: new Date().toISOString() };
    await store.setJSON("dayplan", dayplan);

    await C.sendEmail(
      "🧠 FX agent — day plan",
      `DAY PLAN\n${dayplan.text}\n\nPLAYBOOK\n${playbook.principles.map((p) => "• " + p).join("\n")}`
    ).catch((e) => console.warn("dayplan email:", String(e)));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, dayplan, principles: playbook.principles }, null, 2) };
  } catch (err) {
    console.error("daily-think failed:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err) }) };
  }
};
