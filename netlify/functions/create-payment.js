// Netlify serverless function: create-payment
// ---------------------------------------------------------------------------
// Why this exists:
//   Mystack's API key (msk_live_... / msk_test_...) is a SECRET key. It must
//   NEVER live in index.html, because anyone can read client-side source. This
//   function runs on Netlify's servers, reads the key from an environment
//   variable, and returns ONLY the bank-transfer details the customer needs.
//
// Mystack collects via bank transfer (NUBAN account), not a card popup, so the
// flow is: customer submits their details -> we hand back an account number,
// bank, amount and a unique reference -> customer transfers -> Mystack fires a
// `payment.received` webhook (see mystack-webhook.js) which is how you confirm.
//
// Set these in Netlify -> Site settings -> Environment variables:
//   MYSTACK_SECRET_KEY      your msk_live_ / msk_test_ key (server-side only)
//   MYSTACK_API_BASE        optional, defaults to https://api.mystack.app/v1
//   MYSTACK_ACCOUNT_NUMBER  your Mystack collection NUBAN (fallback / static)
//   MYSTACK_BANK_NAME       e.g. "Wema Bank"
//   MYSTACK_ACCOUNT_NAME    the name shown on the account
// ---------------------------------------------------------------------------

const API_BASE = process.env.MYSTACK_API_BASE || "https://api.mystack.app/v1";

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { email, name, phone, amount, currency } = payload;

  if (!email || !name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Email and name are required" }) };
  }

  // Mystack pays out to Nigerian bank accounts, so bank-transfer collection is
  // NGN only. Other currencies need a different processor.
  if (currency && currency !== "NGN") {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Bank transfer is only available for Naira (NGN). Please select Nigeria, or pick a card option.",
      }),
    };
  }

  // A unique reference the customer should put in their transfer narration so
  // the webhook can match the payment back to this subscriber.
  const reference = "PP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();

  try {
    const account = await getMystackAccount();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reference,
        amount,
        currency: currency || "NGN",
        accountNumber: account.accountNumber,
        bankName: account.bankName,
        accountName: account.accountName,
        expiresAt: account.expiresAt || null,
      }),
    };
  } catch (err) {
    console.error("create-payment failed:", err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Could not start payment. Please try again shortly." }),
    };
  }
};

// ---------------------------------------------------------------------------
// >>> CONFIRM THIS AGAINST YOUR REAL MYSTACK DOCS (/developers) <<<
//
// This is the ONE place the Mystack API is called. I couldn't fully read your
// docs page (it renders as a JS app), so the request/response shape below is a
// best guess based on what was visible. Adjust the endpoint, body fields, and
// the response field names to match what your account's balances endpoint
// actually returns.
//
// HOW MYSTACK ACTUALLY WORKS (from /developers):
//   Mystack has NO "charge a customer" endpoint. You create ONE account once
//   (POST /v1/accounts with your BVN + pots, done in the dashboard) and it owns
//   a fixed NUBAN. EVERY customer transfers to that SAME account number, and the
//   payment.received webhook tells you money landed. So this function does NOT
//   create an account per customer — it returns your single collection account.
//
// Configure it one of two ways in Netlify:
//   A) Simplest — set the fixed details directly (read them from your Mystack
//      dashboard):  MYSTACK_ACCOUNT_NUMBER, MYSTACK_BANK_NAME, MYSTACK_ACCOUNT_NAME
//   B) Dynamic — set MYSTACK_SECRET_KEY + MYSTACK_ACCOUNT_ID and we fetch the
//      NUBAN live via GET /v1/accounts/:id/balances.
// ---------------------------------------------------------------------------
async function getMystackAccount() {
  // A) Fixed details from env vars — reliable, no API call needed.
  const staticAccount = {
    accountNumber: process.env.MYSTACK_ACCOUNT_NUMBER,
    bankName: process.env.MYSTACK_BANK_NAME,
    accountName: process.env.MYSTACK_ACCOUNT_NAME,
  };
  if (staticAccount.accountNumber) return staticAccount;

  // B) Dynamic lookup of your account's NUBAN.
  const key = process.env.MYSTACK_SECRET_KEY;
  const accountId = process.env.MYSTACK_ACCOUNT_ID;
  if (!key || !accountId) {
    throw new Error(
      "Set MYSTACK_ACCOUNT_NUMBER/BANK/NAME, or MYSTACK_SECRET_KEY + MYSTACK_ACCOUNT_ID, in Netlify"
    );
  }

  const res = await fetch(`${API_BASE}/accounts/${accountId}/balances`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mystack API ${res.status}: ${text}`);
  }
  const data = await res.json();

  // >>> CONFIRM these field paths against the real balances response <<<
  // Mystack returns "bucket balances + NUBANs"; the first pot's NUBAN is used.
  const pot = (data.pots || data.buckets || data.data || [])[0] || data;
  return {
    accountNumber: pot.nuban || pot.accountNumber || pot.account_number,
    bankName: pot.bankName || pot.bank_name || pot.bank,
    accountName: pot.accountName || pot.account_name || data.fullName || data.name,
  };
}
