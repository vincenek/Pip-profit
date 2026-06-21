# Live Forex Signal Engine — setup

PipProfit's signal brain. On a schedule it analyses each pair top-down across
three timeframes, filters for trend strength and news risk, has the AI (Gemini) write a
fully-reasoned trade, and **grades its own past calls against real price** so you
get a live win-rate. Results show in the in-calculator Insights and in the new
**Live Signals** dashboard section.

> ⚠️ It produces SIGNALS + REASONING + a self-graded TRACK RECORD. It does **not**
> place trades. Prove the edge first (bottom of this doc), then wire execution.

## What makes these signals accurate (not vibes)

Everything is computed in code from real OHLC, then handed to the AI (Gemini) as an anchor:

- **Top-down multi-timeframe** — Daily (master trend) → 4H (structure) → 1H
  (trigger). Trades must align with the higher-timeframe trend, or it's `no_trade`.
- **ADX regime filter** — ADX(14)+DI classifies trending / ranging / transitional.
  In chop (ADX<20) it avoids trend trades. This alone kills a lot of false signals.
- **Economic-calendar awareness** — pulls the week's high/medium-impact events
  (free ForexFactory feed) and **blacks out** signals within ±60 min of a
  high-impact release for either currency (NFP, CPI, FOMC, etc.).
- **Confirming indicators** — SMA20/50, EMA20, RSI(14), MACD, Stochastic(14,3),
  Bollinger(20,2), ATR(14) for stop sizing, swing high/low for structural stops.
- **Self-grading** — each run checks open signals against fresh candles (hit SL /
  hit TP) and updates win rate, average R, and total R. The dashboard shows it.

## Files

| File | Job |
|---|---|
| `netlify/functions/signal-engine.js` | Scheduled function (30s budget). Data → indicators → news → AI → track record. Saves to Netlify Blobs. |
| `netlify/functions/get-signal.js` | Reads `?pair=EUR/USD` (one) or no param (all signals + stats). |
| `netlify/functions/run-now.js` | One-click manual trigger — open `/.netlify/functions/run-now` to force a run. |
| `package.json` | `@netlify/blobs` (free Netlify storage). |
| `netlify.toml` | Schedules the engine hourly. |
| `index.html` | Personal **FX Signal Desk** dashboard — all pairs, full trade plans, track record, “Run now” button, auto-refresh. No payments, no gating. |

## Set your keys in Netlify, then redeploy

**Site settings → Environment variables → Add a variable.** Both keys below are
**FREE** and need **no credit card**.

| Variable | Required? | What it is |
|---|---|---|
| `GEMINI_API_KEY` | **Yes** | **Free** Google AI Studio key — get one in ~30 sec at https://aistudio.google.com/apikey (no card). Free tier allows ~1,500 requests/day; this engine uses ~72/day. Server-side only. |
| `TWELVEDATA_API_KEY` | Strongly recommended | **Free** key from https://twelvedata.com — gives intraday OHLC so the multi-timeframe engine + ATR work. Without it, falls back to daily-close data (frankfurter.dev): fewer indicators, no intraday, no real ATR. |

The economic calendar needs **no key** — it's a free public feed.

> 💰 **Total cost to run this: $0.** All three data/AI sources are on free tiers.
> If you ever want maximum reasoning quality you can swap the AI to Claude later
> (paid) — but the free Gemini setup is genuinely good enough to run and prove it.

## Optional knobs

| Variable | Default | Does |
|---|---|---|
| `SIGNAL_PAIRS` | `EUR/USD,GBP/USD,USD/JPY` | Pairs to analyse. |
| `GEMINI_MODEL` | `gemini-flash-latest` | The free Gemini model (auto-tracks the current Flash). `gemini-2.5-flash` / `gemini-2.0-flash` also work. |
| `NEWS_WINDOW_MIN` | `60` | Minutes around a high-impact event to black out signals. |

> **Data efficiency:** one Twelve Data call per pair (the engine fetches 1H and
> resamples to 4H/Daily in code), so 3 pairs/run sits well inside the free tier
> (~8 req/min, 800/day). Adding many more pairs may need a paid Twelve Data plan.
> Pairs not in `SIGNAL_PAIRS` fall back to the old static hints — nothing breaks.

## Test it

- **All signals + track record:** `https://<site>.netlify.app/.netlify/functions/get-signal`
- **One pair:** `…/get-signal?pair=EUR/USD`
- **Force a run now (easiest):** open `https://<site>.netlify.app/.netlify/functions/run-now`
  — runs the engine and shows the result. Or use the **Run now** button on the dashboard.
- **On the site:** the homepage is the FX Signal Desk — all pairs with full trade
  plans (entry/SL/TP1/TP2/R:R + reasoning), the track record, and news/regime tags.

## Schedule

In `netlify.toml`: `"@hourly"` (default), `"*/30 * * * *"` (30 min), `"*/15 * * * *"` (15 min, more cost).

## Even more accuracy (future upgrades)

- **Backtest seeding** — pre-load months of history to build the track record fast.
- **Per-pair confidence calibration** — weight the AI's confidence by historical
  hit-rate per pair/regime.
- **Correlation guard** — warn when EUR/USD + GBP/USD signals stack the same USD risk.
- **Sentiment/COT data** — add positioning data as another confluence factor.

## Going live later (only after the track record proves itself)

Research/paper only right now — by design. Before real money:
1. Let the self-graded win rate + avg R accumulate over weeks. If avg R isn't
   solidly positive, the signals aren't ready — don't fund them.
2. If the edge is real, add a separate execution function against a broker API
   (OANDA / MetaTrader) in **demo** mode first, with hard position-size and
   stop-loss limits baked in.

The dashboard's win-rate is exactly the proof you need before risking a cent.
