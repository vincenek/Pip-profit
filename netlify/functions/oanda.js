// OANDA practice-account executor — the agent's HANDS.
// ---------------------------------------------------------------------------
// Mirrors the engine's internal decisions onto a real (demo) broker:
//   place  — LIMIT order at the pullback zone with stop + target attached,
//            expiring with the setup (OANDA fills it in REAL TIME, even
//            between our 30-minute runs — better than the internal sim).
//   cancel — setup expired or flipped -> cancel the pending order.
//   resolve— internal trigger detected -> find the matching OANDA trade id.
//   partial— TP1 hit -> close half the position, move stop to breakeven.
//   trail  — trail step -> move the stop.
//   close  — early close / final exit -> close the remaining position.
//
// SAFETY:
//   - The base URL is HARD-CODED to OANDA's PRACTICE endpoint. This module
//     cannot touch a live account no matter what env vars are set.
//   - Without OANDA_API_TOKEN + OANDA_ACCOUNT_ID it is completely dormant
//     (the engine stays paper-only, exactly as before).
//   - Execution errors never break the engine — they're collected and surfaced
//     on the dashboard (latest.broker).
//
// Setup (~10 min): create a free practice account at oanda.com -> Manage API
// Access -> generate a personal token. In Netlify env vars set:
//   OANDA_API_TOKEN   the token
//   OANDA_ACCOUNT_ID  e.g. 101-004-1234567-001
// ---------------------------------------------------------------------------

const BASE = "https://api-fxpractice.oanda.com/v3"; // PRACTICE ONLY — by design

function enabled() {
  return !!(process.env.OANDA_API_TOKEN && process.env.OANDA_ACCOUNT_ID);
}

function instr(pair) { return pair.replace("/", "_"); }
function fmt(price, pair) { return Number(price).toFixed(/JPY/.test(pair) ? 3 : 5); }

async function api(method, path, body) {
  const res = await fetch(`${BASE}/accounts/${process.env.OANDA_ACCOUNT_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.OANDA_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`OANDA ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Executes the run's queued broker actions in order. Mutates the referenced
// pending/open objects (stores oandaOrderId / oandaTradeId) — call BEFORE the
// ledger is persisted so the ids stick.
async function execute(queue) {
  if (!enabled()) return { enabled: false, executed: 0, errors: [] };
  let executed = 0;
  const errors = [];

  for (const a of queue) {
    try {
      if (a.type === "place") {
        const p = a.pending;
        if (!a.units || !p || p.oandaOrderId) continue;
        const body = {
          order: {
            type: "LIMIT",
            instrument: instr(p.pair),
            units: String(a.units), // signed: + buy, - sell
            price: fmt(p.entryZone, p.pair),
            timeInForce: "GTD",
            gtdTime: new Date(p.expiresAt).toISOString(),
            positionFill: "DEFAULT",
            stopLossOnFill: { price: fmt(p.estSl, p.pair), timeInForce: "GTC" },
            ...(p.estTp2 ? { takeProfitOnFill: { price: fmt(p.estTp2, p.pair), timeInForce: "GTC" } } : {}),
          },
        };
        const r = await api("POST", "/orders", body);
        p.oandaOrderId = r.orderCreateTransaction && r.orderCreateTransaction.id;
      } else if (a.type === "cancel") {
        if (a.pending && a.pending.oandaOrderId) {
          await api("PUT", `/orders/${a.pending.oandaOrderId}/cancel`);
        }
      } else if (a.type === "resolve") {
        // Internal trigger fired — locate the OANDA trade the limit order became.
        const o = a.open;
        if (!o || o.oandaTradeId) continue;
        const r = await api("GET", "/openTrades");
        const want = instr(o.pair);
        const buy = o.direction === "buy";
        const match = (r.trades || [])
          .filter((t) => t.instrument === want && (Number(t.currentUnits) > 0) === buy)
          .sort((x, y) => Number(y.id) - Number(x.id))[0];
        if (match) o.oandaTradeId = match.id;
        else o.oandaMiss = true; // order didn't fill at the broker — skip future actions
      } else if (a.type === "partial") {
        const o = a.open;
        if (!o || !o.oandaTradeId) continue;
        const t = await api("GET", `/trades/${o.oandaTradeId}`);
        const cur = Number(t.trade && t.trade.currentUnits || 0);
        const half = Math.trunc(Math.abs(cur) / 2);
        if (half >= 1) await api("PUT", `/trades/${o.oandaTradeId}/close`, { units: String(half) });
        await api("PUT", `/trades/${o.oandaTradeId}/orders`, {
          stopLoss: { price: fmt(o.entry, o.pair), timeInForce: "GTC" },
        });
      } else if (a.type === "trail") {
        const o = a.open;
        if (!o || !o.oandaTradeId) continue;
        await api("PUT", `/trades/${o.oandaTradeId}/orders`, {
          stopLoss: { price: fmt(a.newStop, o.pair), timeInForce: "GTC" },
        });
      } else if (a.type === "close") {
        const o = a.open;
        if (!o || !o.oandaTradeId) continue;
        // If OANDA's own SL/TP already closed it, this 404s — swallowed below.
        await api("PUT", `/trades/${o.oandaTradeId}/close`, { units: "ALL" });
      }
      executed++;
    } catch (err) {
      const msg = `${a.type}: ${String(err).slice(0, 160)}`;
      // A close on an already-closed trade is expected noise, not a failure.
      if (a.type === "close" && /404/.test(msg)) { executed++; continue; }
      errors.push(msg);
    }
  }
  return { enabled: true, executed, errors };
}

// The practice account's actual balance — when connected, the agents size
// trades off THIS (the broker is the source of truth, like MetaTrader).
async function getBalance() {
  if (!enabled()) return null;
  const r = await api("GET", "/summary");
  const bal = r && r.account && Number(r.account.balance);
  return Number.isFinite(bal) && bal > 0 ? bal : null;
}

module.exports = { enabled, execute, getBalance };
