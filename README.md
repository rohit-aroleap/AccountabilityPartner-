# Accountability Partner

A WhatsApp-style dashboard that runs an AI accountability partner for Ferra customers — messages them on Rohit's behalf via Periskope, references their workout data, and keeps a per-customer conversation history.

Static site, no backend. Hosted on GitHub Pages.

## Architecture

- **Frontend:** Plain HTML/CSS/JS (no build step)
- **Shared state:** Firebase Realtime DB (`motherofdashboard` project, path `accountabilityPartner/v1`)
- **Messaging:** Periskope REST API, called direct from the browser
- **LLM:** Anthropic Claude API, called direct from the browser
- **Workout data:** Fetched from a configurable JSON URL (Ferra export shape)
- **Scheduling:** Claude Code routines (not a server cron)

API keys live in this device's `localStorage`. Don't open the dashboard on a shared machine.

## Milestones

- **v1.001** — Scaffold: shell UI, settings panel, Firebase wired
- **v1.002** — Load customer list from workout JSON
- **v1.003** — Chat UI + Periskope send
- **v1.004** — Anthropic-generated messages with workout + chat context
- **v1.005** — Periskope inbox polling + AI auto-reply with approval gate
- **v1.006** — Per-customer schedule + Claude Code morning routine

## Local development

Open `index.html` in a static server (e.g. `python -m http.server`) and visit the URL. The site is module-based; opening via `file://` will fail on CORS.
