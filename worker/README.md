# Accountability Partner — Cloudflare Worker

Thin proxy that holds the Ferra workout-export API key server-side and serves CORS-friendly JSON to the static dashboard.

## Endpoints

- `GET /workout?includeExerciseDb=true|false` — fetches the Ferra dashboard export with `x-api-key` injected from the Worker secret. Defaults to `includeExerciseDb=true`.
- `GET /health` — `{ ok: true }`.

## Deploy

Two paths.

### A. Wrangler CLI (recommended)

```bash
npm install -g wrangler
cd worker
wrangler login                                # one-time
wrangler secret put FERRA_API_KEY              # paste: ferra-cust-data-27
wrangler deploy                                # prints the URL, e.g.
                                               # https://accountability-partner.<your-subdomain>.workers.dev
```

### B. Cloudflare dashboard (no CLI)

1. Cloudflare → Workers & Pages → Create → Worker → name it `accountability-partner`.
2. "Edit code" → paste the contents of `worker.js` → Save and Deploy.
3. Worker → Settings → Variables → "Add variable" → encrypt → `FERRA_API_KEY = ferra-cust-data-27`.
4. Note the worker URL (`https://accountability-partner.<your-subdomain>.workers.dev`).

## Wire to dashboard

In the dashboard's Settings modal, paste the Worker URL into the "Worker URL" field.

## Allowed origins

`worker.js` lists permitted origins for CORS. If you serve the dashboard elsewhere (custom domain, different port), add it to `ALLOWED_ORIGINS` in `worker.js` and redeploy.
