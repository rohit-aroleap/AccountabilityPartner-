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
  maxAutoTurnsPerSession: 4,
  sessionIdleMinutes: 60,
};

const OPT_OUT_KEYWORDS = [
  'stop messaging', 'stop texting', "don't message", "don't text", 'unsubscribe',
  'leave me alone', 'mat karo', 'mat bhejo', 'band karo', 'stop', 'pause',
];

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
  async fetch(request, env, ctx) {
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
      if (url.pathname === '/periskope/webhook') return handlePeriskopeWebhook(request, env, ctx, corsHeaders);
      if (url.pathname === '/periskope/webhook-setup') return handlePeriskopeWebhookSetup(request, env, corsHeaders);
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
// Webhook — inbound message auto-reply
// ============================================================

async function handlePeriskopeWebhook(request, env, ctx, corsHeaders) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, corsHeaders, 405);

  const t0 = Date.now();
  const rawBody = await request.text();
  const rawPreview = rawBody.slice(0, 2000);

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch {
    ctx.waitUntil(logAutomation({ type: 'webhook', ts: t0, error: 'invalid-json', raw: rawPreview }));
    return json({ error: 'Invalid JSON' }, corsHeaders, 400);
  }

  // Periskope's axios client times out after ~5s and cancels the request.
  // The LLM call alone takes 5-15s, so we MUST ack immediately and process in the background.
  // ctx.waitUntil keeps the worker running up to ~30s after the response is sent.
  ctx.waitUntil(processWebhookInBackground(env, payload, t0, rawPreview));

  return json({ ok: true, ack: true }, corsHeaders);
}

async function processWebhookInBackground(env, payload, t0, rawPreview) {
  let result, errorMsg;
  try {
    result = await processInboundReply(env, payload);
  } catch (err) {
    errorMsg = err.message;
    result = { error: err.message };
  }
  await logAutomation({
    type: 'webhook',
    ts: t0,
    event: payload?.event || payload?.eventType || payload?.type || null,
    chat_id: payload?.data?.chat_id,
    from_me: payload?.data?.from_me === true,
    message_id: payload?.data?.message_id,
    body_preview: typeof payload?.data?.body === 'string' ? payload.data.body.slice(0, 120) : '',
    message_type: payload?.data?.message_type,
    raw: rawPreview,
    result,
    duration_ms: Date.now() - t0,
    error: errorMsg,
  });
}

async function handlePeriskopeWebhookSetup(request, env, corsHeaders) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, corsHeaders, 405);
  const cfg = periskopeConfig(env);
  if (cfg.error) return json({ error: cfg.error }, corsHeaders, 500);

  const selfOrigin = new URL(request.url).origin;
  const hookUrl = `${selfOrigin}/periskope/webhook`;

  const res = await fetch(`${PERISKOPE_BASE}/webhooks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'x-phone': cfg.phone,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      hookUrl,
      integrationName: 'message.created',
      name: 'AccountabilityPartner',
    }),
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });
}

async function processInboundReply(env, payload) {
  if (!payload) return { ignored: 'no-payload' };
  const data = payload.data || payload;
  if (!data || typeof data !== 'object') return { ignored: 'no-data' };

  const global = await getGlobalConfig();
  if (global.killSwitch) return { ignored: 'kill-switch-on' };

  const eventName = payload.event || payload.eventType || payload.type;
  if (eventName && !['message.created', 'message.create', 'message-created', 'created'].includes(eventName)) {
    return { ignored: 'wrong-event', got: eventName };
  }

  if (!data.message_id || !data.chat_id) {
    return { ignored: 'no-message-shape', got: eventName || '(missing)', keys: Object.keys(data).slice(0, 10) };
  }
  if (data.from_me === true) return { ignored: 'outbound' };

  const chatId = data.chat_id;
  if (chatId.endsWith('@g.us')) return { ignored: 'group-chat' };

  const phoneKey = chatId.replace(/@c\.us$/, '').replace(/[^\d]/g, '');
  if (!phoneKey) return { ignored: 'no-phone' };

  const config = await fbGet(`customers/${phoneKey}/config`);
  if (!config) return { ignored: 'no-config-for-customer' };
  if (!['draft-only', 'auto-send'].includes(config.autoCoachMode)) return { ignored: 'mode-off' };

  if (data.message_id && data.message_id === config.lastInboundMessageId) {
    return { ignored: 'duplicate' };
  }

  if (config.paused) {
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'inbound', source: 'webhook', action: 'received-while-paused',
      message: data.body || '',
    });
    await fbPatch(`customers/${phoneKey}/config`, { lastInboundMessageId: data.message_id, lastInboundAt: Date.now() });
    return { ignored: 'paused' };
  }

  const text = (data.body || '').trim();
  await fbPush(`customers/${phoneKey}/activity`, {
    ts: Date.now(), direction: 'inbound', source: 'webhook', action: 'received',
    message: text || `[${data.message_type || 'media'}]`,
  });

  if (text && detectOptOutKeywords(text)) {
    await fbPatch(`customers/${phoneKey}/config`, {
      paused: true,
      pausedReason: `Opt-out keyword detected: "${text.slice(0, 80)}"`,
      lastInboundMessageId: data.message_id,
      lastInboundAt: Date.now(),
    });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'webhook', action: 'auto-paused-opt-out',
      message: text,
    });
    return { acted: 'auto-paused' };
  }

  const now = new Date();
  const ist = istParts(now);
  const today = ist.iso.slice(0, 10);

  if (config.outboundCountDate === today && (config.outboundCountToday ?? 0) >= global.safety.maxOutboundPerDay) {
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'webhook', action: 'skipped-daily-cap',
    });
    await fbPatch(`customers/${phoneKey}/config`, { lastInboundMessageId: data.message_id, lastInboundAt: Date.now() });
    return { ignored: 'daily-cap' };
  }
  if (inQuietHours(ist.hm, global.safety)) {
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'webhook', action: 'skipped-quiet-hours',
    });
    await fbPatch(`customers/${phoneKey}/config`, { lastInboundMessageId: data.message_id, lastInboundAt: Date.now() });
    return { ignored: 'quiet-hours' };
  }

  const lastInbound = config.lastInboundAt || 0;
  const sessionIdleMs = global.safety.sessionIdleMinutes * 60 * 1000;
  let autoTurnCount = config.autoTurnCount ?? 0;
  if (Date.now() - lastInbound > sessionIdleMs) autoTurnCount = 0;
  if (autoTurnCount >= global.safety.maxAutoTurnsPerSession) {
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'webhook', action: 'skipped-max-auto-turns',
    });
    await fbPatch(`customers/${phoneKey}/config`, { lastInboundMessageId: data.message_id, lastInboundAt: Date.now() });
    return { ignored: 'max-auto-turns' };
  }

  const workout = await fetchWorkout(env);
  const user = findUserInWorkout(workout, phoneKey);
  const messagesResp = await fetchPeriskopeMessages(env, chatId, 50);
  const messages = (messagesResp.messages || []).slice().sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));

  const userPrompt = buildReplyPrompt({
    phone: phoneKey, user, raw: workout, messages, istNow: ist, latestInbound: text,
  });
  const systemPrompt = global.prompts?.coach || SYSTEM_COACH;
  const draft = await callAnthropic(env, systemPrompt, userPrompt);
  if (!draft) throw new Error('Empty draft from Anthropic');

  if (config.autoCoachMode === 'auto-send') {
    await sendViaPeriskope(env, chatId, draft);
    await fbPatch(`customers/${phoneKey}/config`, {
      lastOutboundAt: Date.now(),
      outboundCountDate: today,
      outboundCountToday: nextOutboundCount(config, today),
      lastInboundAt: Date.now(),
      lastInboundMessageId: data.message_id,
      autoTurnCount: autoTurnCount + 1,
    });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'outbound', source: 'webhook', action: 'auto-replied',
      message: draft,
    });
    return { acted: 'sent', autoTurnCount: autoTurnCount + 1 };
  }

  // draft-only
  await fbPut(`customers/${phoneKey}/pendingDraft`, {
    ts: Date.now(),
    message: draft,
    source: 'webhook',
    reason: 'Reply to inbound message',
  });
  await fbPatch(`customers/${phoneKey}/config`, {
    lastInboundAt: Date.now(),
    lastInboundMessageId: data.message_id,
  });
  await fbPush(`customers/${phoneKey}/activity`, {
    ts: Date.now(), direction: 'system', source: 'webhook', action: 'drafted-reply',
    message: draft,
  });
  return { acted: 'drafted' };
}

function detectOptOutKeywords(text) {
  if (!text) return false;
  const t = String(text).toLowerCase().trim();
  if (t.length > 80) return false;
  return OPT_OUT_KEYWORDS.some(k => t === k || t.startsWith(k + ' ') || t.endsWith(' ' + k) || t.includes(' ' + k + ' '));
}

// ============================================================
// Cron — scheduled morning check-ins
// ============================================================

async function runCron(env) {
  const global = await getGlobalConfig();
  if (global.killSwitch) {
    await logAutomation({ type: 'cron', processed: 0, acted: 0, skipped: [], note: 'kill-switch-on' });
    return { processed: 0, acted: 0, killSwitch: true };
  }

  const customers = await fbGet('customers');
  if (!customers) {
    await logAutomation({ type: 'cron', processed: 0, acted: 0, skipped: [], note: 'no-customers' });
    return { processed: 0, acted: 0 };
  }

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
    if (config.outboundCountDate === today && (config.outboundCountToday ?? 0) >= global.safety.maxOutboundPerDay) {
      skipped.push({ phoneKey, why: 'daily-cap' });
      continue;
    }
    if (config.lastOutboundDate === today && config.lastOutboundReason === 'cron-checkin') {
      skipped.push({ phoneKey, why: 'already-cron-today' });
      continue;
    }
    const sendTime = config.sendTimeIST || '08:00';
    if (!isInSendWindow(ist.hm, sendTime, global.safety.sendWindowMin)) {
      skipped.push({ phoneKey, why: 'outside-window', current: ist.hm, want: sendTime });
      continue;
    }
    if (inQuietHours(ist.hm, global.safety)) { skipped.push({ phoneKey, why: 'quiet-hours' }); continue; }

    processed++;
    try {
      if (!workoutCache) workoutCache = await fetchWorkout(env);
      const didAct = await processCustomer(env, phoneKey, config, workoutCache, ist, today, global);
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

  await logAutomation({ type: 'cron', processed, acted, skipped: skipped.slice(0, 10), now: ist.iso });
  return { processed, acted, skipped, now: ist.iso };
}

async function processCustomer(env, phoneKey, config, workout, ist, today, global) {
  const chatId = `${phoneKey}@c.us`;
  const user = findUserInWorkout(workout, phoneKey);

  const messagesResp = await fetchPeriskopeMessages(env, chatId, 50);
  const messages = (messagesResp.messages || []).slice().sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));

  const userPrompt = buildCronCheckinPrompt({ phone: phoneKey, user, raw: workout, messages, istNow: ist });
  const systemPrompt = global?.prompts?.coach || SYSTEM_COACH;
  const draft = await callAnthropic(env, systemPrompt, userPrompt);
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

async function logAutomation(event) {
  try {
    await fbPush('automation/feed', { ts: Date.now(), ...event });
  } catch (err) {
    console.error('logAutomation failed:', err.message);
  }
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

function buildReplyPrompt({ phone, user, raw, messages, istNow, latestInbound }) {
  // Same context as cron check-in, but framed as "customer just messaged, draft my reply"
  const base = buildCronCheckinPrompt({ phone, user, raw, messages, istNow });
  const withoutFinalInstruction = base.split('\n').slice(0, -2).join('\n');
  const tail = [
    '',
    `Customer just sent: "${(latestInbound || '').slice(0, 500)}"`,
    '',
    'Draft my reply. Acknowledge briefly if they raised something specific, then anchor on workouts. Keep it short and human.',
  ].join('\n');
  return withoutFinalInstruction + tail;
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

function inQuietHours(hm, safety = SAFETY) {
  const s = safety.quietHoursStart;
  const e = safety.quietHoursEnd;
  if (s <= e) return hm >= s && hm < e;
  return hm >= s || hm < e;
}

let _globalConfigCache = null;
let _globalConfigFetchedAt = 0;
const GLOBAL_CONFIG_TTL_MS = 20_000;

async function getGlobalConfig() {
  if (_globalConfigCache && Date.now() - _globalConfigFetchedAt < GLOBAL_CONFIG_TTL_MS) {
    return _globalConfigCache;
  }
  try {
    const cfg = await fbGet('globalConfig');
    _globalConfigCache = {
      killSwitch: cfg?.killSwitch === true,
      prompts: {
        coach: cfg?.prompts?.coach || SYSTEM_COACH,
        reply: cfg?.prompts?.reply || SYSTEM_REPLY,
      },
      safety: { ...SAFETY, ...(cfg?.safety || {}) },
    };
    _globalConfigFetchedAt = Date.now();
  } catch (err) {
    console.error('getGlobalConfig failed, using defaults:', err.message);
    _globalConfigCache = { killSwitch: false, prompts: { coach: SYSTEM_COACH, reply: SYSTEM_REPLY }, safety: { ...SAFETY } };
    _globalConfigFetchedAt = Date.now();
  }
  return _globalConfigCache;
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
