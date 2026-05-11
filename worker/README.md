# Accountability Partner — Cloudflare Worker

Thin proxy holding API keys server-side and serving CORS-friendly JSON to the static dashboard.

## Endpoints

- `GET /health` — `{ ok: true }`
- `GET /workout?includeExerciseDb=true|false` — Ferra dashboard export (injects `x-api-key`)
- `POST /periskope/send` — body `{ chat_id, message, reply_to? }` → Periskope `/v1/message/send`
- `GET /periskope/messages?chat_id=<id>&limit=&offset=` → Periskope `/v1/chats/{id}/messages`

## Required secrets

| Name | Value |
|---|---|
| `FERRA_API_KEY` | Ferra export key (`ferra-cust-data-27`) |
| `PERISKOPE_API_KEY` | The full `eyJ…` token from console.periskope.app |
| `PERISKOPE_PHONE` | Your channel phone, country code + number, no `+`/spaces (e.g., `919187651332`) |

## Deploy

### A. Wrangler CLI (recommended)

```bash
npm install -g wrangler
cd worker
wrangler login                                # one-time
wrangler secret put FERRA_API_KEY              # paste: ferra-cust-data-27
wrangler secret put PERISKOPE_API_KEY          # paste full eyJ… token
wrangler secret put PERISKOPE_PHONE            # paste: 919187651332
wrangler deploy
```

### B. Cloudflare dashboard (no CLI)

1. Cloudflare → Workers & Pages → your `accountability-partner` worker → Edit code → replace with `worker.js` → Save and Deploy.
2. Settings → Variables → add the three secrets above (Encrypt).

## Allowed origins

`worker.js` lists permitted origins for CORS. Add yours to `ALLOWED_ORIGINS` if you serve the dashboard from elsewhere.
