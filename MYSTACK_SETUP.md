# Mystack payment setup

The site now collects subscriptions by **bank transfer via Mystack** instead of
the Paystack card popup. The secret Mystack key lives only on the server (a
Netlify function), never in `index.html`.

## How the flow works

1. Customer fills email + name in the payment modal and taps **Get Account Details**.
2. The browser calls `/.netlify/functions/create-payment`.
3. That function (server-side) talks to Mystack using your secret key and returns
   a bank account number, bank name, amount and a unique reference.
4. The customer transfers the money and taps **I've Sent the Transfer**.
5. Mystack calls `/.netlify/functions/mystack-webhook` (`payment.received`) — this
   is how you actually confirm money arrived.

## Environment variables to set in Netlify

Site settings → Environment variables. **Never** commit these or put them in HTML.

| Variable | Required | What it is |
|---|---|---|
| `MYSTACK_SECRET_KEY` | yes | Your `msk_live_...` (or `msk_test_...`) key |
| `MYSTACK_WEBHOOK_SECRET` | recommended | Used to verify webhook signatures |
| `MYSTACK_API_BASE` | optional | Defaults to `https://api.mystack.app/v1` |
| `MYSTACK_ACCOUNT_NUMBER` | fallback | A static collection NUBAN, used if the API call isn't wired yet |
| `MYSTACK_BANK_NAME` | fallback | e.g. `Wema Bank` |
| `MYSTACK_ACCOUNT_NAME` | fallback | Name shown on the account |

If you only set the static `MYSTACK_ACCOUNT_*` vars, the site works immediately
by showing that fixed account to every customer.

## Two things still to confirm against your real docs (`/developers`)

I couldn't fully read your docs page (it renders as a JS app), so two spots are
marked with `CONFIRM` comments:

1. **`netlify/functions/create-payment.js`** — the request body sent to Mystack
   and the response field names (`accountNumber` / `bankName` / `accountName`).
   Adjust to match what Mystack actually accepts/returns.
2. **`netlify/functions/mystack-webhook.js`** — the webhook signature header name
   and hashing algorithm.

Then in the Mystack dashboard, point the webhook at:
`https://<your-site>.netlify.app/.netlify/functions/mystack-webhook`

## Heads-up: premium activation & currency

- **Activation is currently client-side only.** Tapping "I've Sent the Transfer"
  unlocks premium in that browser's `localStorage` — it's not verified against
  real money. To enforce it, record paid emails durably in the webhook (e.g.
  Netlify Blobs or a database) and check that on load.
- **Bank transfer is NGN only.** Mystack pays out to Nigerian accounts, so the
  function rejects non-NGN currencies. USD/GBP/EUR would need a card processor.
