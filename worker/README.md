# Accountability Partner — Cloudflare Worker

Single-file proxy + scheduled coach engine. Everything lives in `worker.js`.

## HTTP endpoints

- `GET /health`
- `GET /workout?includeExerciseDb=true|false`
- `POST /periskope/send` — `{ chat_id, message, reply_to? }`
- `GET /periskope/messages?chat_id=<id>&limit=&offset=`
- `POST /anthropic/messages` — `{ system, messages, model?, max_tokens? }`
- `GET /cron/run` — manually trigger the cron handler (debugging)

## Scheduled trigger

Runs every 15 min (`[triggers] crons = ["*/15 * * * *"]`). For each customer at `accountabilityPartner/v1/customers/<phoneDigits>/config` whose `autoCoachMode` is `draft-only` or `auto-send` and whose `sendTimeIST` falls in the current 15-min slot, the worker fetches workout + recent WhatsApp messages, calls Claude with the coach prompt, then either sends via Periskope (`auto-send`) or writes to `customers/<phoneDigits>/pendingDraft` (`draft-only`). Both paths log to `customers/<phoneDigits>/activity`.

Guards: skips paused customers, daily cap (3/day), quiet hours (21:00–08:00 IST).

## Required secrets

| Name | Value |
|---|---|
| `FERRA_API_KEY` | `ferra-cust-data-27` |
| `PERISKOPE_API_KEY` | The full `eyJ…` token |
| `PERISKOPE_PHONE` | Channel phone digits (e.g., `919187651332`) |
| `ANTHROPIC_API_KEY` | Anthropic API key |

## Deploy

### A. Wrangler CLI

```bash
cd worker
wrangler login
wrangler secret put FERRA_API_KEY
wrangler secret put PERISKOPE_API_KEY
wrangler secret put PERISKOPE_PHONE
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

### B. Cloudflare dashboard (no CLI)

1. Workers & Pages → `accountability-partner` → **Edit code**
2. Replace the entire contents of `worker.js` with [worker/worker.js](https://github.com/rohit-aroleap/accountabilityPartner-/blob/main/worker/worker.js) → **Save and Deploy**
3. Back → Settings → **Triggers** → Cron Triggers → **Add** → `*/15 * * * *` → Save
4. Settings → **Variables** → add the four secrets above (Encrypted)

## Manual cron test

```
curl https://accountability-partner.<your-subdomain>.workers.dev/cron/run
```

Returns `{ ok, processed, acted, skipped, now }`. `skipped` is a per-customer reason list — useful for debugging why someone wasn't sent to (`mode-off`, `paused`, `daily-cap`, `quiet-hours`, `outside-window`, `already-cron-today`).
