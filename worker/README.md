# Accountability Partner — Cloudflare Worker

Single-file proxy + scheduled coach engine. Everything lives in `worker.js`.

## HTTP endpoints

- `GET /health`
- `GET /workout?includeExerciseDb=true|false`
- `POST /periskope/send` — `{ chat_id, message, reply_to? }`
- `GET /periskope/messages?chat_id=<id>&limit=&offset=`
- `POST /anthropic/messages` — `{ system, messages, model?, max_tokens? }`
- `POST /periskope/webhook` — receives `message.created` events from Periskope; auto-replies or queues drafts
- `POST /periskope/webhook-setup` — one-shot subscription registrar; tells Periskope to send `message.created` to this worker
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

## Webhook for inbound replies

Once the worker is deployed, register the webhook with Periskope so inbound messages flow to `/periskope/webhook`. One-time:

```
curl -X POST https://accountability-partner.<your-subdomain>.workers.dev/periskope/webhook-setup
```

The worker calls Periskope's `POST /v1/webhooks` on your behalf using `PERISKOPE_API_KEY` and `PERISKOPE_PHONE` (already as secrets). Response is the Periskope API response — confirm you see a webhook id and `integrationName: "message.created"`.

After that, every WhatsApp message a customer sends to your number reaches `/periskope/webhook`. The worker:

1. Ignores group chats, outbound (`from_me === true`), and duplicate `message_id`.
2. Looks up the customer config at `accountabilityPartner/v1/customers/<phoneDigits>/config`. No config or `autoCoachMode === 'off'` → ignored.
3. Logs the inbound to the activity log.
4. Detects opt-out keywords (`stop`, `pause`, `mat karo`, etc.) → auto-sets `paused: true` and exits.
5. Runs safety guards: daily cap, quiet hours, max auto-turns per session (4 with 60-min idle reset).
6. Fetches workout data + recent chat, generates a reply with Claude.
7. `auto-send` → sends via Periskope + logs. `draft-only` → writes to `pendingDraft` (dashboard surfaces it).

## Manual cron test

```
curl https://accountability-partner.<your-subdomain>.workers.dev/cron/run
```

Returns `{ ok, processed, acted, skipped, now }`. `skipped` is a per-customer reason list — useful for debugging why someone wasn't sent to (`mode-off`, `paused`, `daily-cap`, `quiet-hours`, `outside-window`, `already-cron-today`).
