// MT5 (Exness demo) executor — the agent's hands on MetaTrader 5.
// ---------------------------------------------------------------------------
// MT5 has no native REST API, so this talks to your Exness MT5 DEMO account
// through MetaApi (metaapi.cloud) — a cloud bridge that runs the terminal for
// you and exposes clean REST endpoints. Free tier covers a demo account.
//
// Implements the SAME intent interface as oanda.js (place/cancel/resolve/
// partial/trail/close), so the engine doesn't care which broker is wired.
//
// SETUP (~15 min, one time):
//   1. In your Exness personal area create an MT5 DEMO account (note the
//      login number, password, and server name, e.g. "Exness-MT5Trial7").
//   2. Sign up free at https://app.metaapi.cloud → Trading accounts → add
//      account (paste the Exness demo login/password/server, deploy it).
//   3. Copy your MetaApi auth TOKEN (top right → API access) and the
//      ACCOUNT ID of the account you just added.
//   4. Netlify env vars:
//        META_API_TOKEN       the MetaApi token
//        META_API_ACCOUNT_ID  the MetaApi account id
//        META_API_REGION      region shown on the account (default "london")
//        MT5_CONFIRM_DEMO     must be exactly "yes" — a deliberate safety
//                             latch confirming this is a DEMO account
//        MT5_SYMBOL_SUFFIX    optional (some Exness account types use e.g.
//                             "m" → EURUSDm; leave unset for plain EURUSD)
//
// SAFETY: dormant unless all required vars are present AND MT5_CONFIRM_DEMO
// is "yes". Execution errors never break the engine — surfaced on dashboard.
// ---------------------------------------------------------------------------

function enabled() {
  return !!(
    process.env.META_API_TOKEN &&
    process.env.META_API_ACCOUNT_ID &&
    process.env.MT5_CONFIRM_DEMO === "yes"
  );
}

function base() {
  const region = process.env.META_API_REGION || "london";
  return (
    process.env.META_API_URL ||
    `https://mt-client-api-v1.${region}.agiliumtrade.ai`
  );
}

function symbol(pair) {
  return pair.replace("/", "") + (process.env.MT5_SYMBOL_SUFFIX || "");
}

// MT5 sizes in lots (1 lot = 100k units). Min 0.01, 2dp.
function unitsToLots(units) {
  return Math.max(0.01, Math.round((Math.abs(units) / 100000) * 100) / 100);
}

function px(price, pair) {
  return Number(Number(price).toFixed(/JPY/.test(pair) ? 3 : 5));
}

async function api(method, path, body) {
  const res = await fetch(
    `${base()}/users/current/accounts/${process.env.META_API_ACCOUNT_ID}${path}`,
    {
      method,
      headers: {
        "auth-token": process.env.META_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );
  if (!res.ok) throw new Error(`MetaApi ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

async function execute(queue) {
  if (!enabled()) return { enabled: false, executed: 0, errors: [] };
  let executed = 0;
  const errors = [];

  for (const a of queue) {
    try {
      if (a.type === "place") {
        const p = a.pending;
        if (!a.units || !p || p.mt5OrderId) continue;
        const buy = p.direction === "buy";
        const r = await api("POST", "/trade", {
          actionType: buy ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_SELL_LIMIT",
          symbol: symbol(p.pair),
          volume: unitsToLots(a.units),
          openPrice: px(p.entryZone, p.pair),
          stopLoss: px(p.estSl, p.pair),
          ...(p.estTp2 ? { takeProfit: px(p.estTp2, p.pair) } : {}),
          expiration: { type: "ORDER_TIME_SPECIFIED", time: new Date(p.expiresAt).toISOString() },
          comment: "fx-desk",
        });
        p.mt5OrderId = r.orderId || (r.response && r.response.orderId) || null;
      } else if (a.type === "cancel") {
        if (a.pending && a.pending.mt5OrderId) {
          await api("POST", "/trade", { actionType: "ORDER_CANCEL", orderId: String(a.pending.mt5OrderId) });
        }
      } else if (a.type === "resolve") {
        // Internal trigger fired — find the position the limit order became.
        const o = a.open;
        if (!o || o.mt5PositionId) continue;
        const positions = await api("GET", "/positions");
        const want = symbol(o.pair);
        const wantType = o.direction === "buy" ? "POSITION_TYPE_BUY" : "POSITION_TYPE_SELL";
        const match = (Array.isArray(positions) ? positions : [])
          .filter((t) => t.symbol === want && t.type === wantType)
          .sort((x, y) => String(y.id).localeCompare(String(x.id)))[0];
        if (match) o.mt5PositionId = match.id;
        else o.mt5Miss = true; // order didn't fill at the broker — skip future actions
      } else if (a.type === "partial") {
        const o = a.open;
        if (!o || !o.mt5PositionId) continue;
        const positions = await api("GET", "/positions");
        const pos = (Array.isArray(positions) ? positions : []).find((t) => String(t.id) === String(o.mt5PositionId));
        if (pos && pos.volume >= 0.02) {
          const half = Math.max(0.01, Math.round((pos.volume / 2) * 100) / 100);
          await api("POST", "/trade", { actionType: "POSITION_PARTIAL", positionId: String(o.mt5PositionId), volume: half });
        }
        await api("POST", "/trade", {
          actionType: "POSITION_MODIFY", positionId: String(o.mt5PositionId),
          stopLoss: px(o.entry, o.pair),
        });
      } else if (a.type === "trail") {
        const o = a.open;
        if (!o || !o.mt5PositionId) continue;
        await api("POST", "/trade", {
          actionType: "POSITION_MODIFY", positionId: String(o.mt5PositionId),
          stopLoss: px(a.newStop, o.pair),
        });
      } else if (a.type === "close") {
        const o = a.open;
        if (!o || !o.mt5PositionId) continue;
        // If MT5's own SL/TP already closed it this errors — swallowed below.
        await api("POST", "/trade", { actionType: "POSITION_CLOSE_ID", positionId: String(o.mt5PositionId) });
      }
      executed++;
    } catch (err) {
      const msg = `${a.type}: ${String(err).slice(0, 160)}`;
      // Closing an already-closed position is expected noise, not a failure.
      if (a.type === "close" && /404|not found|POSITION_NOT_FOUND/i.test(msg)) { executed++; continue; }
      errors.push(msg);
    }
  }
  return { enabled: true, executed, errors };
}

// The demo account's actual balance — when connected, the agents size trades
// off THIS (the broker is the source of truth, exactly like MetaTrader).
async function getBalance() {
  if (!enabled()) return null;
  const r = await api("GET", "/accountInformation");
  const bal = Number(r && r.balance);
  return Number.isFinite(bal) && bal > 0 ? bal : null;
}

// Account state straight from MetaApi provisioning — the diagnosis endpoint:
// is the account DEPLOYED? CONNECTED to Exness? Which region is it actually in?
async function describe() {
  if (!enabled()) return null;
  const res = await fetch(
    `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${process.env.META_API_ACCOUNT_ID}`,
    { headers: { "auth-token": process.env.META_API_TOKEN } }
  );
  if (!res.ok) throw new Error(`provisioning ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const a = await res.json();
  return {
    name: a.name, login: a.login, server: a.server,
    state: a.state, connectionStatus: a.connectionStatus,
    region: a.region, reliability: a.reliability, type: a.type,
  };
}

// Deploy the account (spins up the cloud terminal that logs into the broker).
// Used to self-heal when describe() reports UNDEPLOYED.
async function deploy() {
  if (!enabled()) return false;
  const res = await fetch(
    `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${process.env.META_API_ACCOUNT_ID}/deploy`,
    { method: "POST", headers: { "auth-token": process.env.META_API_TOKEN } }
  );
  if (!res.ok && res.status !== 204) throw new Error(`deploy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

module.exports = { enabled, execute, getBalance, describe, deploy, _helpers: { symbol, unitsToLots, px, base } };
