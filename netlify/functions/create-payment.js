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
    const account = await createMystackAccount({ email, name, phone, amount, reference });
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
// the response field names (accountNumber / bankName / accountName) to match
// what Mystack actually returns.
//
// If Mystack does NOT support generating a per-payment account via API, just
// set MYSTACK_ACCOUNT_NUMBER / MYSTACK_BANK_NAME / MYSTACK_ACCOUNT_NAME in
// Netlify and this function falls back to those static details automatically.
// ---------------------------------------------------------------------------
async function createMystackAccount({ email, name, phone, amount, reference }) {
  const key = process.env.MYSTACK_SECRET_KEY;

  // Fallback: a single static collection account configured via env vars.
  const staticAccount = {
    accountNumber: process.env.MYSTACK_ACCOUNT_NUMBER,
    bankName: process.env.MYSTACK_BANK_NAME,
    accountName: process.env.MYSTACK_ACCOUNT_NAME,
  };

  if (!key) {
    if (staticAccount.accountNumber) return staticAccount;
    throw new Error("MYSTACK_SECRET_KEY (or static MYSTACK_ACCOUNT_* env vars) not configured");
  }

  const res = await fetch(`${API_BASE}/accounts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fullName: name,
      email,
      phone,
      reference,
      amount, // smallest currency unit (kobo), matching the frontend
    }),
  });

  if (!res.ok) {
    // If the API call isn't right yet but you've set static env vars, use those.
    if (staticAccount.accountNumber) return staticAccount;
    const text = await res.text();
    throw new Error(`Mystack API ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Map Mystack's response fields to ours — rename these to match the real API.
  return {
    accountNumber: data.accountNumber || data.account_number || staticAccount.accountNumber,
    bankName: data.bankName || data.bank_name || staticAccount.bankName,
    accountName: data.accountName || data.account_name || staticAccount.accountName,
    expiresAt: data.expiresAt || data.expires_at,
  };
}
