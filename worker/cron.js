import { SYSTEM_COACH, buildCronCheckinPrompt, findUserInWorkout } from './prompt.js';

const FB_URL = 'https://motherofdashboard-default-rtdb.asia-southeast1.firebasedatabase.app';
const FB_ROOT = 'accountabilityPartner/v1';
const FERRA_EXPORT_URL = 'https://asia-south1-aroleap-fa76f.cloudfunctions.net/exportFerraDashboard';
const PERISKOPE_BASE = 'https://api.periskope.app/v1';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

const SAFETY = {
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  maxOutboundPerDay: 3,
  minMinutesBetweenOutbound: 240,
  sendWindowMin: 15,
};

export async function runCron(env) {
  const customers = await fbGet('customers');
  if (!customers) return { processed: 0 };

  const now = new Date();
  const ist = istParts(now);
  const today = ist.iso.slice(0, 10);

  let workoutCache = null;
  let processed = 0;
  let acted = 0;

  for (const [phoneKey, data] of Object.entries(customers)) {
    const config = data?.config;
    if (!config) continue;
    if (!['draft-only', 'auto-send'].includes(config.autoCoachMode)) continue;
    if (config.paused) continue;
    if (config.outboundCountDate === today && (config.outboundCountToday ?? 0) >= SAFETY.maxOutboundPerDay) continue;

    const sendTime = config.sendTimeIST || '08:00';
    if (!isInSendWindow(ist.hm, sendTime, SAFETY.sendWindowMin)) continue;
    if (config.lastOutboundDate === today && config.lastOutboundReason === 'cron-checkin') continue;
    if (inQuietHours(ist.hm)) continue;

    processed++;
    try {
      if (!workoutCache) workoutCache = await fetchWorkout(env);
      const acted_now = await processCustomer(env, phoneKey, config, workoutCache, ist, today);
      if (acted_now) acted++;
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

  return { processed, acted };
}

async function processCustomer(env, phoneKey, config, workout, ist, today) {
  const chatId = `${phoneKey}@c.us`;
  const user = findUserInWorkout(workout, phoneKey);

  const messagesResp = await fetchPeriskopeMessages(env, chatId, 50);
  const messages = (messagesResp.messages || []).slice().sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));

  const userPrompt = buildCronCheckinPrompt({
    phone: phoneKey,
    user,
    raw: workout,
    messages,
    istNow: ist,
  });

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

  // draft-only
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
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-7',
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

async function fbGet(path) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${path}: ${r.status}`);
  return r.json();
}
async function fbPut(path, value) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase PUT ${path}: ${r.status}`);
}
async function fbPatch(path, value) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase PATCH ${path}: ${r.status}`);
}
async function fbPush(path, value) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase POST ${path}: ${r.status}`);
}

export function istParts(date) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const ist = new Date(utcMs + 5.5 * 60 * 60000);
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
