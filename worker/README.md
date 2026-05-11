# Accountability Partner — Cloudflare Worker

Thin proxy holding API keys server-side and serving CORS-friendly JSON to the static dashboard.

## Endpoints

- `GET /health` — `{ ok: true }`
- `GET /workout?includeExerciseDb=true|false` — Ferra dashboard export (injects `x-api-key`)
- `POST /periskope/send` — body `{ chat_id, message, reply_to? }` → Periskope `/v1/message/send`
- `GET /periskope/messages?chat_id=<id>&limit=&offset=` → Periskope `/v1/chats/{id}/messages`
- `POST /anthropic/messages` — body `{ system, messages, model?, max_tokens? }` → Anthropic `/v1/messages`

## Required secrets

| Name | Value |
|---|---|
| `FERRA_API_KEY` | Ferra export key (`ferra-cust-data-27`) |
| `PERISKOPE_API_KEY` | The full `eyJ…` token from console.periskope.app |
| `PERISKOPE_PHONE` | Channel phone, country code + number, no `+`/spaces (e.g., `919187651332`) |
| `ANTHROPIC_API_KEY` | Anthropic API key from console.anthropic.com |

## Deploy

### A. Wrangler CLI (recommended)

```bash
npm install -g wrangler
cd worker
wrangler login                                # one-time
wrangler secret put FERRA_API_KEY              # if not set yet
wrangler secret put PERISKOPE_API_KEY          # if not set yet
wrangler secret put PERISKOPE_PHONE            # if not set yet
wrangler secret put ANTHROPIC_API_KEY          # new for v1.006
wrangler deploy
```

### B. Cloudflare dashboard (no CLI)

1. Workers & Pages → `accountability-partner` → Edit code → paste `worker.js` → Save and Deploy.
2. Settings → Variables → add any missing secrets above (Encrypted).

## Allowed origins

`worker.js` lists permitted CORS origins. Add yours if you serve the dashboard from elsewhere.
