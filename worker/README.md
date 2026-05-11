# Accountability Partner — Cloudflare Worker

Thin proxy + scheduled coach engine.

## HTTP endpoints (called from the dashboard)

- `GET /health` — `{ ok: true }`
- `GET /workout?includeExerciseDb=true|false` — Ferra dashboard export
- `POST /periskope/send` — body `{ chat_id, message, reply_to? }`
- `GET /periskope/messages?chat_id=<id>&limit=&offset=`
- `POST /anthropic/messages` — body `{ system, messages, model?, max_tokens? }`
- `GET /cron/run` — manually trigger the cron handler (debugging)

## Scheduled (cron) trigger

Runs every 15 min via `[triggers] crons = ["*/15 * * * *"]` in `wrangler.toml`. For each customer at `accountabilityPartner/v1/customers/<phoneDigits>/config` whose `autoCoachMode` is `draft-only` or `auto-send` and whose `sendTimeIST` falls in the current 15-min slot, the worker:

1. Reads workout data, recent WhatsApp messages, and config
2. Calls Claude with the coach system prompt + the customer's context
3. If `auto-send`: sends via Periskope, updates counters, logs activity
4. If `draft-only`: writes the draft to `customers/<phoneDigits>/pendingDraft` and logs activity. The dashboard surfaces it next time you open the chat.

Guards: skips paused customers, daily cap (3/day), and quiet hours (21:00–08:00 IST).

## Required secrets

| Name | Value |
|---|---|
| `FERRA_API_KEY` | `ferra-cust-data-27` |
| `PERISKOPE_API_KEY` | The full `eyJ…` token |
| `PERISKOPE_PHONE` | Channel phone digits (e.g., `919187651332`) |
| `ANTHROPIC_API_KEY` | Anthropic API key |

## Deploy

### A. Wrangler CLI (recommended)

```bash
cd worker
wrangler login                                # one-time
wrangler secret put FERRA_API_KEY
wrangler secret put PERISKOPE_API_KEY
wrangler secret put PERISKOPE_PHONE
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

### B. Cloudflare dashboard (no CLI)

The dashboard route only handles `worker.js`. Multi-file imports (`cron.js`, `prompt.js`) need wrangler. If you must use the UI, paste all three files contents inlined into `worker.js` (delete the import lines and prepend the contents of `cron.js` and `prompt.js`).

## Firebase DB rules

The worker reads/writes `accountabilityPartner/v1/customers/...` via Firebase REST without auth. The Realtime DB at `motherofdashboard-default-rtdb.asia-southeast1.firebasedatabase.app` must allow public read+write under that path. If your rules tighten this, the worker will need an auth token added.

## Manual cron test

```
curl https://accountability-partner.<your-subdomain>.workers.dev/cron/run
```

Returns `{ ok: true, processed: <count>, acted: <count> }`. `acted` is the number of customers actually sent/drafted to.
