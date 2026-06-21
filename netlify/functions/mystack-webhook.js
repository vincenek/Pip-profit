// Netlify serverless function: mystack-webhook
// ---------------------------------------------------------------------------
// Mystack calls this URL when a bank transfer lands (event: payment.received).
// This is the ONLY reliable way to know a customer paid, because a bank
// transfer has no synchronous "success" callback in the browser.
//
// Point your Mystack dashboard webhook at:
//   https://<your-site>.netlify.app/.netlify/functions/mystack-webhook
//
// IMPORTANT — verifying the signature:
//   Mystack signs webhooks (check your /developers docs for the header name and
//   algorithm). Verify it so nobody can fake a "payment.received" and unlock
//   premium for free. Set MYSTACK_WEBHOOK_SECRET in Netlify and confirm the
//   header name / hashing below against the docs.
//
// NOTE — activating premium:
//   This site has no database, so a webhook can only LOG the payment here. To
//   actually flip a user to premium you need somewhere to record "this email
//   paid" (e.g. Netlify Blobs, a database, or an email to yourself). The
//   frontend currently activates premium in localStorage on the same device,
//   which is fine for a demo but not enforceable. See MYSTACK_SETUP.md.
// ---------------------------------------------------------------------------

const crypto = require("crypto");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const raw = event.body || "";

  // --- Signature verification (confirm header name + algorithm in your docs) ---
  const secret = process.env.MYSTACK_WEBHOOK_SECRET;
  if (secret) {
    const signature =
      event.headers["x-mystack-signature"] || event.headers["X-Mystack-Signature"];
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (!signature || signature !== expected) {
      console.warn("mystack-webhook: signature mismatch — rejecting");
      return { statusCode: 401, body: "Invalid signature" };
    }
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  if (body.event === "payment.received" || body.type === "payment.received") {
    const data = body.data || body;
    console.log("Payment received:", {
      reference: data.reference,
      amount: data.amount,
      email: data.email,
    });
    // TODO: record this payment somewhere durable and activate the subscriber.
  }

  // Always 200 quickly so Mystack doesn't keep retrying.
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
