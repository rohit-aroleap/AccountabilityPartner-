// ============================================================
// Accountability Partner — Cloudflare Worker (single-file bundle)
// HTTP proxy + scheduled cron for morning check-ins.
// ============================================================

const FERRA_EXPORT_URL = 'https://asia-south1-aroleap-fa76f.cloudfunctions.net/exportFerraDashboard';
const PERISKOPE_BASE = 'https://api.periskope.app/v1';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

const FB_URL = 'https://motherofdashboard-default-rtdb.asia-southeast1.firebasedatabase.app';
const FB_ROOT = 'accountabilityPartner/v1';

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
const DEFAULT_MODEL = 'claude-opus-4-7';

const ALLOWED_ORIGINS = new Set([
  'https://rohit-aroleap.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const SAFETY = {
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  maxOutboundPerDay: 3,
  minMinutesBetweenOutbound: 240,
  sendWindowMin: 15,
};

const SYSTEM_COACH = `You are Rohit Patel, founder of Ferra (a smart resistance-training machine). You run a personal WhatsApp accountability program for your customers. Every message you send moves them toward consistent training. This is not a generic chat — workouts are your mission.

How to decide what to say:
- If they trained recently, reference the SPECIFIC session — which exercises, duration, streak, how it compares to last week. Then ask about the next one.
- If they haven't trained in days/weeks, gently surface the gap and ask what's blocking them. Offer to schedule a short 10-min session.
- If they have NO workout history at all, your job is to get them onto the machine — ask what's making them hesitate, offer to walk them through setup, suggest the smallest possible first session.
- If the recent chat is on an unrelated topic (logistics, app issue, social), acknowledge it in ONE short line, then pivot to workouts.
- If they asked a real question (pricing, technical, scheduling), answer briefly first, then pivot.

Style:
- Warm, direct, brief — usually 1 to 3 short sentences
- Casual English suitable for Indian customers; mix in Hindi if natural ("kal", "aaj", "thoda")
- Be SPECIFIC — never generic praise or platitudes
- Sound like a human founder who's also their coach, not a marketing bot
- Don't open with "Hi <name>" if the last message is from them — it's mid-conversation
- No emojis unless they used them first
- Never invent facts. Never claim to have called, met, or done anything you didn't actually do.

Output ONLY the WhatsApp message text. No quotes. No preamble. No "Here's a draft:" wrapper. No explanation.`;

// ============================================================
// Entrypoints
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const corsHeaders = buildCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === '/health') return json({ ok: true }, corsHeaders);
      if (url.pathname === '/workout' || url.pathname === '/workout/') return handleWorkout(request, env, corsHeaders);
      if (url.pathname === '/periskope/send') return handlePeriskopeSend(request, env, corsHeaders);
      if (url.pathname === '/periskope/messages') return handlePeriskopeMessages(request, env, corsHeaders);
      if (url.pathname === '/anthropic/messages') return handleAnthropic(request, env, corsHeaders);
      if (url.pathname === '/cron/run') {
        const result = await runCron(env);
        return json({ ok: true, ...result }, corsHeaders);
      }
      return json({ error: 'Not found', path: url.pathname }, corsHeaders, 404);
    } catch (err) {
      return json({ error: 'Worker exception', message: err.message }, corsHeaders, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).catch(err => console.error('Cron failed:', err)));
  },
};

// ============================================================
// HTTP handlers (proxy endpoints)
// ============================================================

async function handleWorkout(request, env, corsHeaders) {
  if (!env.FERRA_API_KEY) return json({ error: 'FERRA_API_KEY secret not set' }, corsHeaders, 500);
  const includeExerciseDb = new URL(request.url).searchParams.get('includeExerciseDb') !== 'false';
  const upstream = new URL(FERRA_EXPORT_URL);
  upstream.searchParams.set('includeExerciseDb', String(includeExerciseDb));

  const res = await fetch(upstream.toString(), {
    headers: { 'x-api-key': env.FERRA_API_KEY },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) {
    const body = await res.text();
    return json({ error: 'Upstream failed', status: res.status, body: body.slice(0, 500) }, corsHeaders, 502);
  }
  return new Response(res.body, {
    status: 200,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=30' },
  });
}

async function handlePeriskopeSend(request, env, corsHeaders) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, corsHeaders, 405);
  const cfg = periskopeConfig(env);
  if (cfg.error) return json({ error: cfg.error }, corsHeaders, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, corsHeaders, 400); }
  if (!body.chat_id || !body.message) return json({ error: 'chat_id and message are required' }, corsHeaders, 400);

  const res = await fetch(`${PERISKOPE_BASE}/message/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'x-phone': cfg.phone,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: body.chat_id,
      message: body.message,
      ...(body.reply_to ? { reply_to: body.reply_to } : {}),
    }),
  });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' } });
}

async function handlePeriskopeMessages(request, env, corsHeaders) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, corsHeaders, 405);
  const cfg = periskopeConfig(env);
  if (cfg.error) return json({ error: cfg.error }, corsHeaders, 500);

  const params = new URL(request.url).searchParams;
  const chatId = params.get('chat_id');
  if (!chatId) return json({ error: 'chat_id query param required' }, corsHeaders, 400);

  const limit = Math.min(parseInt(params.get('limit') || '50', 10) || 50, 2000);
  const offset = parseInt(params.get('offset') || '0', 10) || 0;

  const upstream = new URL(`${PERISKOPE_BASE}/chats/${encodeURIComponent(chatId)}/messages`);
  upstream.searchParams.set('limit', String(limit));
  upstream.searchParams.set('offset', String(offset));

  const res = await fetch(upstream.toString(), {
    headers: { 'Authorization': `Bearer ${cfg.token}`, 'x-phone': cfg.phone },
  });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' } });
}

async function handleAnthropic(request, env, corsHeaders) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, corsHeaders, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set' }, corsHeaders, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, corsHeaders, 400); }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'messages array required' }, corsHeaders, 400);
  }

  const model = ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
  const maxTokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 512, 16), 2048);

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: body.system || '', messages: body.messages }),
  });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' } });
}

function periskopeConfig(env) {
  if (!env.PERISKOPE_API_KEY) return { error: 'PERISKOPE_API_KEY secret not set' };
  if (!env.PERISKOPE_PHONE) return { error: 'PERISKOPE_PHONE secret not set' };
  return { token: env.PERISKOPE_API_KEY, phone: env.PERISKOPE_PHONE };
}

// ============================================================
// Cron — scheduled morning check-ins
// ============================================================

async function runCron(env) {
  const customers = await fbGet('customers');
  if (!customers) return { processed: 0, acted: 0 };

  const now = new Date();
  const ist = istParts(now);
  const today = ist.iso.slice(0, 10);

  let workoutCache = null;
  let processed = 0;
  let acted = 0;
  const skipped = [];

  for (const [phoneKey, data] of Object.entries(customers)) {
    const config = data?.config;
    if (!config) continue;
    if (!['draft-only', 'auto-send'].includes(config.autoCoachMode)) { skipped.push({ phoneKey, why: 'mode-off' }); continue; }
    if (config.paused) { skipped.push({ phoneKey, why: 'paused' }); continue; }
    if (config.outboundCountDate === today && (config.outboundCountToday ?? 0) >= SAFETY.maxOutboundPerDay) {
      skipped.push({ phoneKey, why: 'daily-cap' });
      continue;
    }
    if (config.lastOutboundDate === today && config.lastOutboundReason === 'cron-checkin') {
      skipped.push({ phoneKey, why: 'already-cron-today' });
      continue;
    }
    const sendTime = config.sendTimeIST || '08:00';
    if (!isInSendWindow(ist.hm, sendTime, SAFETY.sendWindowMin)) {
      skipped.push({ phoneKey, why: 'outside-window', current: ist.hm, want: sendTime });
      continue;
    }
    if (inQuietHours(ist.hm)) { skipped.push({ phoneKey, why: 'quiet-hours' }); continue; }

    processed++;
    try {
      if (!workoutCache) workoutCache = await fetchWorkout(env);
      const didAct = await processCustomer(env, phoneKey, config, workoutCache, ist, today);
      if (didAct) acted++;
    } catch (err) {
      await fbPush(`customers/${phoneKey}/activity`, {
        ts: Date.now(),
        direction: 'system',
        source: 'cron',
        action: 'cron-failed',
        error: err.message,
      });
    }
  }

  return { processed, acted, skipped, now: ist.iso };
}

async function processCustomer(env, phoneKey, config, workout, ist, today) {
  const chatId = `${phoneKey}@c.us`;
  const user = findUserInWorkout(workout, phoneKey);

  const messagesResp = await fetchPeriskopeMessages(env, chatId, 50);
  const messages = (messagesResp.messages || []).slice().sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));

  const userPrompt = buildCronCheckinPrompt({ phone: phoneKey, user, raw: workout, messages, istNow: ist });
  const draft = await callAnthropic(env, SYSTEM_COACH, userPrompt);
  if (!draft) throw new Error('Empty draft from Anthropic');

  if (config.autoCoachMode === 'auto-send') {
    await sendViaPeriskope(env, chatId, draft);
    await fbPatch(`customers/${phoneKey}/config`, {
      lastOutboundAt: Date.now(),
      lastOutboundDate: today,
      lastOutboundReason: 'cron-checkin',
      outboundCountDate: today,
      outboundCountToday: nextOutboundCount(config, today),
    });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(),
      direction: 'outbound',
      source: 'cron',
      action: 'sent',
      message: draft,
    });
    return true;
  }

  await fbPut(`customers/${phoneKey}/pendingDraft`, {
    ts: Date.now(),
    message: draft,
    source: 'cron',
    reason: 'Morning check-in draft',
  });
  await fbPatch(`customers/${phoneKey}/config`, {
    lastOutboundDate: today,
    lastOutboundReason: 'cron-checkin',
  });
  await fbPush(`customers/${phoneKey}/activity`, {
    ts: Date.now(),
    direction: 'system',
    source: 'cron',
    action: 'drafted',
    message: draft,
  });
  return true;
}

function nextOutboundCount(config, today) {
  return config?.outboundCountDate === today ? (config.outboundCountToday ?? 0) + 1 : 1;
}

// ============================================================
// Upstream callers
// ============================================================

async function fetchWorkout(env) {
  const u = new URL(FERRA_EXPORT_URL);
  u.searchParams.set('includeExerciseDb', 'false');
  const r = await fetch(u.toString(), { headers: { 'x-api-key': env.FERRA_API_KEY } });
  if (!r.ok) throw new Error(`Workout fetch ${r.status}`);
  return r.json();
}

async function fetchPeriskopeMessages(env, chatId, limit) {
  const u = new URL(`${PERISKOPE_BASE}/chats/${encodeURIComponent(chatId)}/messages`);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('offset', '0');
  const r = await fetch(u.toString(), {
    headers: { 'Authorization': `Bearer ${env.PERISKOPE_API_KEY}`, 'x-phone': env.PERISKOPE_PHONE },
  });
  if (!r.ok) throw new Error(`Periskope messages ${r.status}`);
  return r.json();
}

async function sendViaPeriskope(env, chatId, message) {
  const r = await fetch(`${PERISKOPE_BASE}/message/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.PERISKOPE_API_KEY}`,
      'x-phone': env.PERISKOPE_PHONE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chat_id: chatId, message }),
  });
  if (!r.ok) throw new Error(`Periskope send ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function callAnthropic(env, system, userPrompt) {
  const r = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  const out = (body.content || []).find(c => c.type === 'text')?.text || '';
  return out.trim();
}

// ============================================================
// Firebase REST helpers
// ============================================================

async function fbGet(path) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${path}: ${r.status}`);
  return r.json();
}
async function fbPut(path, value) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase PUT ${path}: ${r.status}`);
}
async function fbPatch(path, value) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase PATCH ${path}: ${r.status}`);
}
async function fbPush(path, value) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase POST ${path}: ${r.status}`);
}

// ============================================================
// Prompt builders
// ============================================================

function findUserInWorkout(raw, phoneDigits) {
  const all = [...(raw.users || []), ...(raw.cancelledUsers || [])];
  return all.find(u => String(u.phone || '').replace(/[^\d]/g, '') === phoneDigits) || null;
}

function getRecentDailyActivity(monthlySummaries, uid, days = 14) {
  const months = monthlySummaries[uid] || [];
  const all = {};
  for (const m of months) Object.assign(all, m.dailyActivity || {});
  return Object.entries(all).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, days).map(([date, info]) => ({ date, ...info }));
}

function getRecentHabitScores(habitHistory, uid, days = 14) {
  const months = habitHistory[uid] || [];
  const flat = {};
  for (const m of months) for (const [k, v] of Object.entries(m)) {
    if (k.startsWith('dailyScores.')) flat[k.slice('dailyScores.'.length)] = v;
  }
  return Object.entries(flat).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, days).map(([date, info]) => ({ date, ...info }));
}

function buildCronCheckinPrompt({ phone, user, raw, messages, istNow }) {
  const todayStr = istNow.iso.slice(0, 10);
  const lines = [];
  lines.push(`Today: ${todayStr} (${istNow.dayName}), ${istNow.hm} IST`);
  lines.push('');
  if (user) {
    lines.push(`Customer: ${user.name}`);
    lines.push(`Phone: +${phone}`);
    lines.push(`Habit score: ${Math.round(user.habitScore ?? 0)} / 100`);
    lines.push(`Tier: ${user.tierLabel || '—'}`);
    lines.push(`Segment: ${user.segment || '—'}`);
    lines.push(`Last active: ${user.lastActiveDate || '—'} (${user.daysSinceLastSession === 999 ? 'never' : `${user.daysSinceLastSession}d ago`})`);
    if (user.streak) lines.push(`Streak: ${user.streak.days} days (${user.streak.active ? 'active' : 'broken'})`);
    const activity = getRecentDailyActivity(raw.userMonthlySummaries || {}, user.uid, 14);
    const scores = getRecentHabitScores(raw.userHabitHistory || {}, user.uid, 14);
    if (activity.length) {
      lines.push('');
      lines.push('Last 14 days of training:');
      for (const a of activity) {
        const mins = Math.round((a.totalDuration || 0) / 60);
        lines.push(`  ${a.date}: ${a.exerciseCount} exercises, ${mins} min${a.progressiveOverloadCount ? `, ${a.progressiveOverloadCount} progressive overload sets` : ''}`);
      }
    } else {
      lines.push('');
      lines.push('No training in the last 14 days.');
    }
    if (scores.length) {
      lines.push('');
      lines.push('Last 14 days habit scores:');
      for (const s of scores) lines.push(`  ${s.date}: ${Math.round(s.score)} (tier ${s.tier})`);
    }
  } else {
    lines.push(`Customer phone: +${phone}`);
    lines.push(`This customer is not yet in the Ferra workout export. They may be brand new, pre-onboarding, or haven't set up the machine. No workout data available.`);
    lines.push(`COACH PRIORITY: Get them onto the machine. Ask about blockers. Offer to help with setup or their first session.`);
  }
  lines.push('');
  lines.push('Recent WhatsApp messages (oldest first, last 20):');
  const last20 = (messages || []).slice(-20);
  if (last20.length === 0) lines.push('  (no prior conversation)');
  else for (const m of last20) {
    const who = m.from_me ? 'me' : (user?.name || 'them');
    const ts = formatMessageTs(m.timestamp);
    const body = (m.body || '').replace(/\s+/g, ' ').trim();
    lines.push(`  [${ts} | ${who}] ${body}`);
  }
  lines.push('');
  lines.push('This is the morning accountability check-in. Lead with workouts. Be specific to their data. If they replied last, acknowledge that briefly, then pivot to training.');
  return lines.join('\n');
}

function formatMessageTs(ts) {
  if (!ts) return '';
  let ms;
  if (typeof ts === 'number') ms = ts < 1e12 ? ts * 1000 : ts;
  else {
    const n = Number(ts);
    if (!Number.isNaN(n) && n > 0) ms = n < 1e12 ? n * 1000 : n;
    else ms = Date.parse(ts);
  }
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

// ============================================================
// Time / safety helpers
// ============================================================

function istParts(date) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60000);
  const iso = ist.toISOString();
  const dayName = ist.toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
  return { iso, date: iso.slice(0, 10), hm: iso.slice(11, 16), dayName };
}

function isInSendWindow(currentHM, sendTimeHM, windowMin) {
  const [sh, sm] = sendTimeHM.split(':').map(Number);
  const [ch, cm] = currentHM.split(':').map(Number);
  const sendMin = sh * 60 + sm;
  const currMin = ch * 60 + cm;
  return currMin >= sendMin && currMin < sendMin + windowMin;
}

function inQuietHours(hm) {
  const { quietHoursStart: s, quietHoursEnd: e } = SAFETY;
  if (s <= e) return hm >= s && hm < e;
  return hm >= s || hm < e;
}

function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const n = Number(ts);
  if (!Number.isNaN(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const p = Date.parse(ts);
  return Number.isNaN(p) ? 0 : p;
}

// ============================================================
// HTTP misc
// ============================================================

function buildCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : '*';
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-requested-with',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

function json(payload, corsHeaders, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });
}
