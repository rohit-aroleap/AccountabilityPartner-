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
  minMinutesBetweenAutoTriggers: 180,
  sendWindowMin: 15,
  maxAutoTurnsPerSession: 4,
  sessionIdleMinutes: 60,
};

const OPT_OUT_KEYWORDS = [
  'stop messaging', 'stop texting', "don't message", "don't text", 'unsubscribe',
  'leave me alone', 'mat karo', 'mat bhejo', 'band karo', 'stop', 'pause',
];

// Onboarding questions, in order. Each question maps to a state name + next state.
const ONBOARDING_QUESTIONS = {
  goal: {
    label: 'Goal',
    state: 'awaiting-goal',
    nextState: 'awaiting-age',
    options: ['Lose weight', 'Get toned', 'Build muscle', 'Improve health & longevity', 'Train as an athlete or competitor', 'Not sure'],
  },
  age: {
    label: 'Age',
    state: 'awaiting-age',
    nextState: 'awaiting-gender',
    options: ['17 or younger', '18-29', '30-39', '40-49', '50-59', '60 or older'],
  },
  gender: {
    label: 'Coach gender preference',
    state: 'awaiting-gender',
    nextState: 'awaiting-style',
    options: ['Female', 'Male', 'No preference'],
  },
  style: {
    label: 'Coach style',
    state: 'awaiting-style',
    nextState: 'awaiting-intensity',
    options: ['High-energy', 'Knows when to give me tough love', 'Calm, cool and collected', 'Always Positive', 'Drill sergeant', 'Has a sense of humor', 'Analytical and results-driven', 'Strictly business', 'Goes the extra mile to personalize my workouts'],
  },
  intensity: {
    label: 'Coach intensity',
    state: 'awaiting-intensity',
    nextState: 'awaiting-language',
    options: ['Not intense', 'A little intense', 'Somewhat intense', 'Intense', 'Very intense'],
  },
  language: {
    label: 'Language preference',
    state: 'awaiting-language',
    nextState: 'complete',
    options: ['English', 'Hindi', 'Both (Hinglish)'],
  },
};

const ONBOARDING_QUESTION_ORDER = ['goal', 'age', 'gender', 'style', 'intensity', 'language'];

const STATE_TO_QKEY = Object.fromEntries(
  Object.entries(ONBOARDING_QUESTIONS).map(([k, v]) => [v.state, k])
);

const ONBOARDING_PROMPTS = {
  goal: `Quick setup so I can coach you the right way — only 6 short questions, takes a minute.\n\nWhat's your top fitness goal?\n\n1. Lose weight\n2. Get toned\n3. Build muscle\n4. Improve health & longevity\n5. Train as an athlete or competitor\n6. Not sure\n\nReply with just the number.`,
  age: `Got it. Q2 of 6 — what's your age range?\n\n1. 17 or younger\n2. 18-29\n3. 30-39\n4. 40-49\n5. 50-59\n6. 60 or older`,
  gender: `Q3 of 6 — would you prefer a male or female coach?\n\n1. Female\n2. Male\n3. No preference`,
  style: `Q4 of 6 — pick the coach style that fits you best:\n\n1. High-energy\n2. Knows when to give me tough love\n3. Calm, cool and collected\n4. Always Positive\n5. Drill sergeant\n6. Has a sense of humor\n7. Analytical and results-driven\n8. Strictly business\n9. Goes the extra mile to personalize my workouts`,
  intensity: `Q5 of 6 — what level of intensity do you want from your coach?\n\n1. Not intense\n2. A little intense\n3. Somewhat intense\n4. Intense\n5. Very intense`,
  language: `Last one — what language do you prefer?\n\n1. English\n2. Hindi\n3. Both (Hinglish)`,
};

const ONBOARDING_WRAPUP = `All set 🙌 Your coach is dialed in. I'll check in tomorrow morning — talk soon.`;

const INTENSITY_TO_NUMBER = {
  'Not intense': 1,
  'A little intense': 2,
  'Somewhat intense': 3,
  'Intense': 4,
  'Very intense': 5,
};

const LANGUAGE_LABELS = {
  'English': 'English',
  'Hindi': 'Hindi',
  'Both (Hinglish)': 'Both (mix English and Hindi naturally)',
};

const STYLE_TO_PERSONALITY = {
  'High-energy': 'highEnergy',
  'Always Positive': 'cheerleader',
  'Knows when to give me tough love': 'honest',
  'Drill sergeant': 'drillSergeant',
  'Calm, cool and collected': 'steady',
  'Has a sense of humor': 'friend',
  'Analytical and results-driven': 'analyst',
  'Strictly business': 'pro',
  'Goes the extra mile to personalize my workouts': 'personalTrainer',
};

const SYSTEM_COACH = `You are Rohit, founder of Ferra (a smart resistance-training machine). You run a personal WhatsApp accountability program for your customers. Every message you send moves them toward consistent training. This is not a generic chat — workouts are your mission.

How to decide what to say:
- If they trained recently, reference the SPECIFIC session — which exercises, duration, streak, how it compares to last week. Then ask about the next one.
- If they haven't trained in days/weeks, gently surface the gap and ask what's blocking them. Offer to schedule a short 10-min session.
- If they have NO workout history at all, your job is to get them onto the machine — ask what's making them hesitate, offer to walk them through setup, suggest the smallest possible first session.
- If the recent chat is on an unrelated topic (logistics, app issue, social), acknowledge it in ONE short line, then pivot to workouts.
- If they asked a real question (pricing, technical, scheduling), answer briefly first, then pivot.

Hard anti-hallucination rules (CRITICAL):
- NEVER invent facts about the customer. Only reference things stated in the visible chat history shown to you or in the workout data above.
- NEVER reference past conversations, prior sessions, or context you weren't shown in THIS prompt. If you don't see it above, it doesn't exist.
- If you're unsure about something specific (their schedule, situation, location, family), ASK in plain language rather than guessing or filling in plausible-sounding details.

Style:
- Warm, direct, brief — usually 1 to 3 short sentences
- Casual English suitable for Indian customers; mix in Hindi if natural ("kal", "aaj", "thoda")
- Be SPECIFIC — never generic praise or platitudes
- Sound like a human founder who's also their coach, not a marketing bot
- Don't open with "Hi <name>" if the last message is from them — it's mid-conversation
- No emojis unless they used them first
- Never claim to have called, met, or done anything you didn't actually do.

Output ONLY the WhatsApp message text. No quotes. No preamble. No "Here's a draft:" wrapper. No explanation.`;

const SYSTEM_GYM_COACH = `You are Rohit, founder of Ferra (a company that makes a smart resistance-training machine). This particular customer does NOT use the Ferra machine — they train at a gym or elsewhere. You're their online accountability partner.

Your job:
- Make sure they hit their stated weekly workout goal
- When they report a workout, acknowledge it specifically (e.g., "nice, that's leg day done — solid")
- When you haven't heard from them, ASK directly: "Did you train today?" / "Where are we with this week's count?"
- Reference their weekly goal explicitly: "you're at 2/4 for the week"
- If they're falling behind, surface it gently — never preachy
- Help them name what's blocking when they slip

Hard rules about Ferra (CRITICAL):
- This customer does NOT own or use a Ferra machine. NEVER ask "is the Ferra at your place?", "is the Ferra at someone else's place?", or anything about Ferra machine setup, location, or ownership.
- Even if your intro message mentioned Ferra (the company you work for), this customer trains at a GYM, not on Ferra. Treat that as fixed.
- You have NO automatic workout data for this customer — you only know what they've told you in the visible chat or what's been logged from their reports. Don't pretend to have other data.

Hard anti-hallucination rules (CRITICAL):
- NEVER invent specifics about the customer's situation, family, schedule, or past conversations.
- NEVER reference things like "morning batch", "group class", "previous sessions" unless you can see them in the visible chat above.
- If you don't know something specific, ASK in plain language. "How does your week usually look?" is fine; "How was the morning class?" is NOT (you don't know they have a morning class).
- If the chat is on an unrelated topic, acknowledge in one line, then pivot to training
- Never claim to have called, met, or done anything you didn't actually do

Style:
- Warm, direct, brief — usually 1 to 3 short sentences
- Casual English suitable for Indian customers; mix in Hindi if natural ("kal", "aaj", "bhai")
- Be SPECIFIC to what they actually reported in chat, not generic
- Sound like a human trainer-friend, not a marketing bot
- No emojis unless they used them first

Output ONLY the WhatsApp message text. No quotes. No preamble.`;

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
      if (url.pathname === '/periskope/replay') return handlePeriskopeReplay(request, env, ctx, corsHeaders);
      if (url.pathname === '/onboarding/begin') return handleOnboardingBegin(request, env, ctx, corsHeaders);
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
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) {
    const body = await res.text();
    return json({ error: 'Upstream failed', status: res.status, body: body.slice(0, 500) }, corsHeaders, 502);
  }
  return new Response(res.body, {
    status: 200,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=120' },
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
  const debugPrompt = result?.debugPrompt;
  const customerType = result?.debugCustomerType;
  const systemPromptType = result?.debugSystemType;
  if (result) {
    delete result.debugPrompt;
    delete result.debugCustomerType;
    delete result.debugSystemType;
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
    customerType,
    systemPromptType,
    userPrompt: typeof debugPrompt === 'string' ? debugPrompt.slice(0, 6000) : undefined,
    duration_ms: Date.now() - t0,
    error: errorMsg,
  });
}

async function handlePeriskopeReplay(request, env, ctx, corsHeaders) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, corsHeaders, 405);
  const t0 = Date.now();
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, corsHeaders, 400); }
  if (!body.chat_id || !body.message_id) {
    return json({ error: 'chat_id and message_id required' }, corsHeaders, 400);
  }
  const synthPayload = {
    event: 'message.created',
    data: {
      chat_id: body.chat_id,
      message_id: body.message_id,
      body: body.body || '',
      from_me: false,
      timestamp: body.timestamp || Date.now(),
      message_type: body.message_type || 'chat',
    },
    _replay: true,
  };
  const rawPreview = JSON.stringify({ replay: true, ...body }).slice(0, 2000);
  ctx.waitUntil(processWebhookInBackground(env, synthPayload, t0, rawPreview));
  return json({ ok: true, replayed: true }, corsHeaders);
}

async function handleOnboardingBegin(request, env, ctx, corsHeaders) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, corsHeaders, 405);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, corsHeaders, 400); }
  const phone = body?.phone || '';
  const phoneKey = String(phone).replace(/[^\d]/g, '');
  if (!phoneKey) return json({ error: 'phone required' }, corsHeaders, 400);

  const delayMs = Math.max(0, Math.min(parseInt(body?.delayMs, 10) || 10000, 25000));
  ctx.waitUntil((async () => {
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    try {
      await startOnboarding(env, phoneKey);
    } catch (err) {
      console.error('startOnboarding failed:', err.message);
    }
  })());
  return json({ ok: true, scheduledIn: delayMs }, corsHeaders);
}

async function startOnboarding(env, phoneKey) {
  const config = await fbGet(`customers/${phoneKey}/config`);
  if (!config) return;
  if (config.onboardingState !== 'pending') return;
  const global = await getGlobalConfig();
  if (global.killSwitch) return;

  const now = new Date();
  const ist = istParts(now);

  await fbPatch(`customers/${phoneKey}/config`, {
    onboardingState: ONBOARDING_QUESTIONS.goal.state,
    onboardingStartedAt: Date.now(),
  });
  await sendOnboardingMessage(env, phoneKey, 'goal', ist, global);
}

async function sendOnboardingMessage(env, phoneKey, qKey, ist, global) {
  const text = ONBOARDING_PROMPTS[qKey];
  if (!text) return;
  if (inQuietHours(ist.hm, global.safety)) {
    await fbPatch(`customers/${phoneKey}/config`, { onboardingPausedForQuiet: true });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'onboarding',
      action: 'paused-quiet-hours', message: qKey,
    });
    return;
  }
  const chatId = `${phoneKey}@c.us`;
  await sendViaPeriskope(env, chatId, text);
  await fbPatch(`customers/${phoneKey}/config`, {
    onboardingPausedForQuiet: null,
    lastOutboundAt: Date.now(),
  });
  await fbPush(`customers/${phoneKey}/activity`, {
    ts: Date.now(), direction: 'outbound', source: 'onboarding',
    action: `question-sent-${qKey}`, message: text,
  });
}

async function sendOnboardingWrapup(env, phoneKey, ist, global) {
  if (inQuietHours(ist.hm, global.safety)) {
    await fbPatch(`customers/${phoneKey}/config`, { onboardingWrapupPaused: true });
    return;
  }
  const chatId = `${phoneKey}@c.us`;
  await sendViaPeriskope(env, chatId, ONBOARDING_WRAPUP);
  await fbPatch(`customers/${phoneKey}/config`, { onboardingWrapupPaused: null, lastOutboundAt: Date.now() });
  await fbPush(`customers/${phoneKey}/activity`, {
    ts: Date.now(), direction: 'outbound', source: 'onboarding',
    action: 'wrapup-sent', message: ONBOARDING_WRAPUP,
  });
}

async function handleOnboardingMessage(env, config, phoneKey, chatId, data, text, ist) {
  const state = config.onboardingState;
  const qKey = STATE_TO_QKEY[state];
  if (!qKey) return { ignored: 'unknown-onboarding-state', state };

  const trimmed = (text || '').toLowerCase().trim();
  if (trimmed === 'skip' || trimmed === 'skip setup' || trimmed === 'skip onboarding') {
    await fbPatch(`customers/${phoneKey}/config`, {
      onboardingState: 'skipped',
      onboardingSkippedAt: Date.now(),
      lastInboundMessageId: data.message_id,
      lastInboundAt: Date.now(),
    });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'onboarding', action: 'skipped-by-customer',
    });
    const global = await getGlobalConfig();
    if (!inQuietHours(ist.hm, global.safety)) {
      await sendViaPeriskope(env, chatId, `Got it — skipping setup. Just talk to me normally and we'll figure it out together.`);
      await fbPatch(`customers/${phoneKey}/config`, { lastOutboundAt: Date.now() });
    }
    return { acted: 'onboarding-skipped' };
  }

  const question = ONBOARDING_QUESTIONS[qKey];
  const parsed = await parseOnboardingAnswer(env, qKey, question, text);
  if (!parsed.valid) {
    const questionsAhead = ONBOARDING_QUESTION_ORDER.length - ONBOARDING_QUESTION_ORDER.indexOf(qKey);
    const nudge = `Quick — ${questionsAhead} ${questionsAhead === 1 ? 'question' : 'questions'} left and we're set. We can chat after we finish.\n\n${ONBOARDING_PROMPTS[qKey]}`;
    const global = await getGlobalConfig();
    if (!inQuietHours(ist.hm, global.safety)) {
      await sendViaPeriskope(env, chatId, nudge);
      await fbPatch(`customers/${phoneKey}/config`, { lastOutboundAt: Date.now() });
    }
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'onboarding',
      action: 'unparseable-answer', message: text, reason: parsed.reason,
    });
    await fbPatch(`customers/${phoneKey}/config`, {
      lastInboundMessageId: data.message_id,
      lastInboundAt: Date.now(),
    });
    return { ignored: 'unparseable-answer', reason: parsed.reason };
  }

  // Save answer, advance state
  const answers = { ...(config.onboardingAnswers || {}) };
  answers[qKey] = parsed.value;
  const nextState = question.nextState;

  await fbPatch(`customers/${phoneKey}/config`, {
    onboardingAnswers: answers,
    onboardingState: nextState,
    lastInboundMessageId: data.message_id,
    lastInboundAt: Date.now(),
  });
  await fbPush(`customers/${phoneKey}/activity`, {
    ts: Date.now(), direction: 'system', source: 'onboarding',
    action: `answer-${qKey}`, message: parsed.value,
  });

  const global = await getGlobalConfig();

  if (nextState === 'complete') {
    const mapped = mapAnswersToPersonality(answers);
    await fbPatch(`customers/${phoneKey}/config`, {
      onboardingState: 'complete',
      onboardingCompletedAt: Date.now(),
      coachPersonality: mapped.personality,
      coachIntensity: mapped.intensity,
      coachLanguage: mapped.language,
      coachGenderPref: mapped.genderPref,
    });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'onboarding',
      action: 'completed', message: `personality=${mapped.personality} intensity=${mapped.intensity} lang=${mapped.language}`,
    });
    await sendOnboardingWrapup(env, phoneKey, ist, global);
    return { acted: 'onboarding-complete', personality: mapped.personality };
  }

  const nextQKey = STATE_TO_QKEY[nextState];
  if (nextQKey) await sendOnboardingMessage(env, phoneKey, nextQKey, ist, global);
  return { acted: 'onboarding-advanced', nextState };
}

async function parseOnboardingAnswer(env, qKey, question, userText) {
  if (!userText || userText.length < 1) return { valid: false, reason: 'empty' };
  // Fast path: if it's just a number in range, accept
  const numMatch = userText.trim().match(/^([0-9]+)$/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n >= 1 && n <= question.options.length) {
      return { valid: true, value: question.options[n - 1] };
    }
  }
  const optionsList = question.options.map((opt, i) => `${i+1}. ${opt}`).join('\n');
  const prompt = `Parse this WhatsApp reply against a multiple-choice question.

Question: ${question.label}
Options:
${optionsList}

Customer's reply: "${userText.slice(0, 300)}"

Map the reply to ONE option (1-${question.options.length}) if clear. Be permissive — "1" or "first option" or "lose weight" or "the first one" all map to option 1. Match semantic intent ("I want to bulk up" → "Build muscle").

Output ONLY JSON, no preamble:
{ "valid": true, "choice": <1-${question.options.length}> }
or
{ "valid": false, "reason": "off-topic" | "no-match" | "ambiguous" }

If the reply is off-topic (a question, complaint, unrelated chat) → valid: false, reason: "off-topic".
If it doesn't match any option → valid: false, reason: "no-match".
If genuinely ambiguous between options → valid: false, reason: "ambiguous".`;
  let text;
  try {
    text = await callAnthropicWithModel(env, '', prompt, 'claude-haiku-4-5-20251001', 100);
  } catch {
    return { valid: false, reason: 'llm-error' };
  }
  if (!text) return { valid: false, reason: 'empty-llm-response' };
  try {
    const cleaned = text.trim().replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.valid && Number.isInteger(parsed.choice) && parsed.choice >= 1 && parsed.choice <= question.options.length) {
      return { valid: true, value: question.options[parsed.choice - 1] };
    }
    return { valid: false, reason: parsed.reason || 'no-match' };
  } catch {
    return { valid: false, reason: 'parse-error' };
  }
}

function mapAnswersToPersonality(answers) {
  const personality = STYLE_TO_PERSONALITY[answers.style] || 'friend';
  const intensity = INTENSITY_TO_NUMBER[answers.intensity] || 3;
  const language = LANGUAGE_LABELS[answers.language] || 'English';
  const genderPref = answers.gender === 'Female' ? 'Female' : (answers.gender === 'Male' ? 'Male' : 'NoPreference');
  return { personality, intensity, language, genderPref };
}

function interpolatePersonality(template, config, global) {
  const personaName = config.coachGenderPref === 'Female'
    ? (global.personaFemale || 'Ashima')
    : (global.personaMale || 'Rohit');
  const intensity = config.coachIntensity || 3;
  const language = config.coachLanguage || 'English';
  return String(template)
    .replace(/\{\{personaName\}\}/g, personaName)
    .replace(/\{\{intensity\}\}/g, String(intensity))
    .replace(/\{\{language\}\}/g, language);
}

function resolveSystemPrompt(config, global, customerType) {
  if (config?.onboardingState === 'complete' && config.coachPersonality && global.personalities?.[config.coachPersonality]) {
    return interpolatePersonality(global.personalities[config.coachPersonality], config, global);
  }
  if (customerType === 'gym') return global.prompts?.gym || SYSTEM_GYM_COACH;
  return global.prompts?.coach || SYSTEM_COACH;
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

  // Race-condition guard: mark this message_id as being processed BEFORE the slow path (LLM, Periskope send).
  // Without this, a duplicate webhook delivery during the ~15-30s processing window would slip past the dedup
  // above (which compares against the previous lastInboundMessageId) and trigger a second LLM call + send.
  // Mutating config in-memory too so later reads in this function see the updated value.
  if (data.message_id) {
    config.lastInboundMessageId = data.message_id;
    await fbPatch(`customers/${phoneKey}/config`, {
      lastInboundMessageId: data.message_id,
      lastInboundAt: Date.now(),
    });
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

  // Onboarding mode: route inbound to the questionnaire handler instead of the coach reply flow.
  // Only customers with onboardingState in the awaiting-* family qualify; pending/complete/skipped pass through.
  if (typeof config.onboardingState === 'string' && config.onboardingState.startsWith('awaiting-')) {
    const ist = istParts(new Date());
    return await handleOnboardingMessage(env, config, phoneKey, chatId, data, text, ist);
  }

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
  const customerType = resolveCustomerType(config, user);
  const messagesResp = await fetchPeriskopeMessages(env, chatId, 50);
  let messages = (messagesResp.messages || []).slice().sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));
  messages = filterByConversationStart(messages, config?.conversationStartTs);

  let userPrompt;
  if (customerType === 'gym') {
    const workoutLog = await fetchWorkoutLog(phoneKey, 20);
    userPrompt = buildGymPrompt({ phone: phoneKey, user, config, messages, istNow: ist, workoutLog, latestInbound: text, mode: 'reply' });
  } else {
    userPrompt = buildReplyPrompt({
      phone: phoneKey, user, raw: workout, messages, istNow: ist, latestInbound: text,
    });
  }
  const systemPrompt = resolveSystemPrompt(config, global, customerType);
  const draft = await callAnthropic(env, systemPrompt, userPrompt);
  if (!draft) throw new Error('Empty draft from Anthropic');

  // For gym customers, fire-and-forget Haiku call to extract workout if reported
  if (customerType === 'gym' && text) {
    extractAndLogWorkout(env, phoneKey, text, ist).catch(err => console.error('extract failed:', err.message));
  }
  // For both types, extract future-intent reminders from the inbound
  if (text) {
    extractAndScheduleReminders(env, phoneKey, text, config, ist).catch(err => console.error('reminder extract failed:', err.message));
  }

  if (config.autoCoachMode === 'auto-send') {
    const holdResult = await sendOrHold(env, phoneKey, chatId, draft, 'webhook');
    if (holdResult.acted === 'sent') {
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
    } else {
      // Held — counters not bumped, no outbound; pending draft already created
      await fbPatch(`customers/${phoneKey}/config`, {
        lastInboundAt: Date.now(),
        lastInboundMessageId: data.message_id,
      });
    }
    return { acted: holdResult.acted, autoTurnCount: autoTurnCount + (holdResult.acted === 'sent' ? 1 : 0), debugPrompt: userPrompt, debugCustomerType: customerType, debugSystemType: customerType === 'gym' ? 'gym' : 'coach' };
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
  return { acted: 'drafted', debugPrompt: userPrompt, debugCustomerType: customerType, debugSystemType: customerType === 'gym' ? 'gym' : 'coach' };
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
    const minGapMs = (global.safety.minMinutesBetweenAutoTriggers ?? SAFETY.minMinutesBetweenAutoTriggers) * 60 * 1000;
    if (config.lastOutboundAt && (Date.now() - config.lastOutboundAt) < minGapMs) {
      skipped.push({ phoneKey, why: 'min-gap' });
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

  // Resume any onboarding flows that were paused by quiet hours
  try {
    await resumeOnboardingAfterQuietHours(env, customers, ist, global);
  } catch (err) {
    console.error('resumeOnboarding failed:', err.message);
  }

  // After morning check-ins, seed automatic reminders and fire any due ones
  let seededCount = 0;
  let postWorkoutCount = 0;
  let firedCount = 0;
  let firedDetail = [];
  try {
    seededCount = await seedAutomaticReminders(env, customers, ist, today);
  } catch (err) {
    console.error('seedAutomaticReminders failed:', err.message);
  }
  try {
    postWorkoutCount = await seedPostWorkoutReminders(env, customers, ist, today);
  } catch (err) {
    console.error('seedPostWorkoutReminders failed:', err.message);
  }
  try {
    const fired = await scanAndFireReminders(env, customers, global, ist, today);
    firedCount = fired.length;
    firedDetail = fired;
  } catch (err) {
    console.error('scanAndFireReminders failed:', err.message);
  }

  await logAutomation({ type: 'cron', processed, acted, skipped: skipped.slice(0, 10), now: ist.iso, remindersSeeded: seededCount, postWorkoutSeeded: postWorkoutCount, remindersFired: firedCount, firedDetail });
  return { processed, acted, skipped, now: ist.iso, remindersSeeded: seededCount, postWorkoutSeeded: postWorkoutCount, remindersFired: firedCount };
}

async function resumeOnboardingAfterQuietHours(env, customers, ist, global) {
  if (inQuietHours(ist.hm, global.safety)) return; // still quiet, nothing to do
  for (const [phoneKey, data] of Object.entries(customers)) {
    const config = data?.config;
    if (!config) continue;
    // Wrap-up was paused
    if (config.onboardingWrapupPaused && config.onboardingState === 'complete') {
      await sendOnboardingWrapup(env, phoneKey, ist, global);
      continue;
    }
    // Question was paused
    if (config.onboardingPausedForQuiet) {
      const state = config.onboardingState;
      const qKey = STATE_TO_QKEY[state];
      if (qKey) {
        await sendOnboardingMessage(env, phoneKey, qKey, ist, global);
      } else {
        await fbPatch(`customers/${phoneKey}/config`, { onboardingPausedForQuiet: null });
      }
    }
  }
}

async function seedPostWorkoutReminders(env, customers, ist, today) {
  let count = 0;
  let workout = null;
  for (const [phoneKey, data] of Object.entries(customers)) {
    const config = data?.config;
    if (!config) continue;
    if (config.paused) continue;
    if (!['draft-only', 'auto-send'].includes(config.autoCoachMode)) continue;
    if (config.lastPostWorkoutDate === today) continue;

    if (!workout) {
      try { workout = await fetchWorkout(env); }
      catch { return count; }
    }
    const user = findUserInWorkout(workout, phoneKey);
    if (!user) continue;

    const todayActivity = getDailyActivityForDate(workout, user.uid, today);
    if (!todayActivity || !todayActivity.lastExerciseTs) continue;

    const ageMs = Date.now() - todayActivity.lastExerciseTs;
    if (ageMs < 0) continue;
    if (ageMs > 4 * 60 * 60 * 1000) continue;

    const fireAt = Date.now() + 10 * 60 * 1000;
    const exerciseCount = todayActivity.exerciseCount || 0;
    const mins = Math.round((todayActivity.totalDuration || 0) / 60);
    const ageMin = Math.floor(ageMs / 60000);
    let timingNote;
    if (ageMin < 30) timingNote = 'just finished';
    else if (ageMin < 90) timingNote = `finished about ${ageMin} min ago`;
    else timingNote = `finished about ${Math.round(ageMin / 60)} h ago — earlier today, not right now`;

    await fbPush(`customers/${phoneKey}/scheduledReminders`, {
      ts: Date.now(),
      fireAt,
      status: 'pending',
      source: 'post-workout',
      reason: `Customer ${timingNote}: a workout with ${exerciseCount} exercises, ${mins} min total. Acknowledge it specifically — reference the session size or duration if it stands out; reference the streak if continuing one. Match the timing — don't say "just now" if it was hours ago.`,
    });
    await fbPatch(`customers/${phoneKey}/config`, { lastPostWorkoutDate: today });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(),
      direction: 'system',
      source: 'reminder',
      action: 'post-workout-scheduled',
      message: `${exerciseCount} exercises, ${mins} min — scheduled ack in 10 min`,
    });
    count++;
  }
  return count;
}

function getDailyActivityForDate(workout, uid, dateStr) {
  const months = workout?.userMonthlySummaries?.[uid] || [];
  for (const m of months) {
    const day = m?.dailyActivity?.[dateStr];
    if (day) return day;
  }
  return null;
}

async function scanAndFireReminders(env, customers, global, ist, today) {
  const now = Date.now();
  const fired = [];
  for (const [phoneKey, data] of Object.entries(customers)) {
    const config = data?.config;
    if (!config) continue;
    if (config.paused) continue;
    if (!['draft-only', 'auto-send'].includes(config.autoCoachMode)) continue;
    const reminders = data?.scheduledReminders || {};
    for (const [rid, rem] of Object.entries(reminders)) {
      if (!rem || rem.status !== 'pending') continue;
      if (!rem.fireAt || rem.fireAt > now) continue;
      if (config.outboundCountDate === today && (config.outboundCountToday ?? 0) >= global.safety.maxOutboundPerDay) continue;
      const minGapMs = (global.safety.minMinutesBetweenAutoTriggers ?? SAFETY.minMinutesBetweenAutoTriggers) * 60 * 1000;
      if (config.lastOutboundAt && (Date.now() - config.lastOutboundAt) < minGapMs) {
        // Don't fire if we sent another auto-trigger recently — log and keep pending
        await fbPush(`customers/${phoneKey}/activity`, {
          ts: Date.now(), direction: 'system', source: 'reminder',
          action: 'skipped-min-gap',
          message: `last outbound ${Math.round((Date.now() - config.lastOutboundAt) / 60000)} min ago, gap requires ${global.safety.minMinutesBetweenAutoTriggers ?? SAFETY.minMinutesBetweenAutoTriggers} min`,
          reminderSource: rem.source,
        });
        continue;
      }
      if (inQuietHours(ist.hm, global.safety)) continue;

      // No-show check: if customer already reported workout since the reminder was created, cancel
      if (rem.source === 'stated-intent-no-show') {
        const log = await fetchWorkoutLog(phoneKey, 10);
        const since = log.filter(w => (w.ts || 0) > (rem.ts || 0));
        if (since.length > 0) {
          await fbPatch(`customers/${phoneKey}/scheduledReminders/${rid}`, { status: 'cancelled', cancelledReason: 'workout-reported-after-creation' });
          continue;
        }
      }

      try {
        await fireScheduledReminder(env, phoneKey, rid, rem, config, global, ist, today);
        fired.push({ phone: phoneKey, source: rem.source });
      } catch (err) {
        await fbPush(`customers/${phoneKey}/activity`, {
          ts: Date.now(), direction: 'system', source: 'reminder', action: 'reminder-failed',
          error: err.message, reminderSource: rem.source,
        });
      }
    }
  }
  return fired;
}

async function fireScheduledReminder(env, phoneKey, rid, rem, config, global, ist, today) {
  const chatId = `${phoneKey}@c.us`;
  let workout = null;
  try { workout = await fetchWorkout(env); } catch {}
  const user = workout ? findUserInWorkout(workout, phoneKey) : null;
  const customerType = resolveCustomerType(config, user);

  let messages = [];
  try {
    const resp = await fetchPeriskopeMessages(env, chatId, 50);
    messages = (resp.messages || []).slice().sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));
  } catch {}
  messages = filterByConversationStart(messages, config?.conversationStartTs);

  let basePrompt;
  if (customerType === 'gym') {
    const workoutLog = await fetchWorkoutLog(phoneKey, 20);
    basePrompt = buildGymPrompt({ phone: phoneKey, user, config, messages, istNow: ist, workoutLog, mode: 'reminder' });
  } else {
    basePrompt = buildCronCheckinPrompt({ phone: phoneKey, user, raw: workout, messages, istNow: ist });
  }

  const reminderTail = [
    '',
    '— SCHEDULED REMINDER CONTEXT —',
    `This is a scheduled reminder, not a routine check-in.`,
    `Source: ${rem.source || 'manual'}`,
    `Reason: ${rem.reason || 'follow up'}`,
    ``,
    `Draft the message so it naturally references the reason. Do NOT mention that this was scheduled or that you set a reminder — the customer should just see a normal, well-timed message from you.`,
  ].join('\n');
  const userPrompt = basePrompt + '\n' + reminderTail;
  const systemPrompt = resolveSystemPrompt(config, global, customerType);

  const draft = await callAnthropic(env, systemPrompt, userPrompt);
  if (!draft) throw new Error('Empty draft for reminder');

  if (config.autoCoachMode === 'auto-send') {
    const holdResult = await sendOrHold(env, phoneKey, chatId, draft, 'reminder');
    if (holdResult.acted === 'sent') {
      await fbPatch(`customers/${phoneKey}/config`, {
        lastOutboundAt: Date.now(),
        outboundCountDate: today,
        outboundCountToday: nextOutboundCount(config, today),
      });
      await fbPatch(`customers/${phoneKey}/scheduledReminders/${rid}`, {
        status: 'sent', sentAt: Date.now(), sentMessage: draft,
      });
      await fbPush(`customers/${phoneKey}/activity`, {
        ts: Date.now(), direction: 'outbound', source: 'reminder',
        action: 'reminder-sent', message: draft, reminderSource: rem.source, reason: rem.reason,
      });
    } else {
      // Held — mark reminder as held so we don't fire it again
      await fbPatch(`customers/${phoneKey}/scheduledReminders/${rid}`, {
        status: 'held', sentAt: Date.now(), sentMessage: draft,
      });
    }
  } else {
    await fbPut(`customers/${phoneKey}/pendingDraft`, {
      ts: Date.now(), message: draft, source: 'reminder',
      reason: `Scheduled reminder: ${rem.reason || rem.source}`,
    });
    await fbPatch(`customers/${phoneKey}/scheduledReminders/${rid}`, {
      status: 'sent', sentAt: Date.now(), sentMessage: draft,
    });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'reminder',
      action: 'reminder-drafted', message: draft, reminderSource: rem.source, reason: rem.reason,
    });
  }
}

async function seedAutomaticReminders(env, customers, ist, today) {
  let count = 0;
  let workout = null;
  for (const [phoneKey, data] of Object.entries(customers)) {
    const config = data?.config;
    if (!config) continue;
    if (config.paused) continue;
    if (!['draft-only', 'auto-send'].includes(config.autoCoachMode)) continue;
    if (data.lastSeedDate === today) continue;

    if (!workout) { try { workout = await fetchWorkout(env); } catch {} }
    const user = workout ? findUserInWorkout(workout, phoneKey) : null;
    const customerType = resolveCustomerType(config, user);

    const seeded = [];

    // 1. End-of-week gym check: Sunday between 17:00 and 18:00 IST
    if (customerType === 'gym' && ist.dayName === 'Sunday' && ist.hm >= '17:00' && ist.hm < '18:00') {
      const log = await fetchWorkoutLog(phoneKey, 30);
      const mondayStr = getMondayStr(ist);
      const thisWeek = log.filter(w => (w.date || '') >= mondayStr);
      const goal = parseInt(config.weeklyGoal, 10) || 3;
      if (thisWeek.length < goal && !await hasPendingReminderOfSource(data, 'end-of-week-gym', today)) {
        const fireAt = combineISTDateTime(ist.iso.slice(0, 10), '18:30');
        await fbPush(`customers/${phoneKey}/scheduledReminders`, {
          ts: Date.now(), fireAt, status: 'pending',
          source: 'end-of-week-gym',
          reason: `Customer is at ${thisWeek.length}/${goal} workouts this week. Nudge to close the gap before Sunday ends.`,
        });
        seeded.push('end-of-week-gym');
      }
    }

    // 2. Streak saver: Ferra customer whose 7+ day streak just broke
    if (customerType === 'ferra' && user?.streak) {
      const s = user.streak;
      if (!s.active && s.days >= 7 && !await hasPendingReminderOfSource(data, 'streak-saver', today)) {
        const fireAt = combineISTDateTime(ist.iso.slice(0, 10), '10:00');
        if (fireAt > Date.now()) {
          await fbPush(`customers/${phoneKey}/scheduledReminders`, {
            ts: Date.now(), fireAt, status: 'pending',
            source: 'streak-saver',
            reason: `Their ${s.days}-day streak just broke. Encourage a restart without making them feel bad.`,
          });
          seeded.push('streak-saver');
        }
      }
    }

    // 3. Comeback: silent 5-10 days
    if (user && typeof user.daysSinceLastSession === 'number'
        && user.daysSinceLastSession >= 5 && user.daysSinceLastSession <= 10
        && !await hasPendingReminderOfSource(data, 'comeback', today)) {
      const fireAt = combineISTDateTime(nextDayISO(ist.iso.slice(0, 10)), config.sendTimeIST || '08:00');
      await fbPush(`customers/${phoneKey}/scheduledReminders`, {
        ts: Date.now(), fireAt, status: 'pending',
        source: 'comeback',
        reason: `Customer hasn't trained in ${user.daysSinceLastSession} days. Reach out warmly to bring them back.`,
      });
      seeded.push('comeback');
    }

    if (seeded.length > 0) {
      count += seeded.length;
      await fbPush(`customers/${phoneKey}/activity`, {
        ts: Date.now(), direction: 'system', source: 'reminder',
        action: 'reminders-seeded', message: seeded.join(', '),
      });
    }
    await fbPatch(`customers/${phoneKey}`, { lastSeedDate: today });
  }
  return count;
}

async function hasPendingReminderOfSource(customerData, source, today) {
  const reminders = customerData?.scheduledReminders || {};
  for (const [, r] of Object.entries(reminders)) {
    if (r?.status === 'pending' && r.source === source) {
      // also confirm it's for "today" — same calendar date as the today arg
      const d = new Date(r.fireAt || r.ts || 0);
      const istMs = d.getTime() + 5.5 * 60 * 60000;
      const dStr = new Date(istMs).toISOString().slice(0, 10);
      if (dStr === today) return true;
    }
  }
  return false;
}

function getMondayStr(ist) {
  const d = new Date(ist.iso.slice(0, 10) + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d.getTime() + diff * 86400000);
  return monday.toISOString().slice(0, 10);
}

function combineISTDateTime(dateStr, hmStr) {
  // dateStr: YYYY-MM-DD, hmStr: HH:MM, both in IST. Return ms epoch.
  const utcMs = Date.parse(`${dateStr}T${hmStr}:00.000Z`);
  return utcMs - 5.5 * 60 * 60000;
}

function nextDayISO(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function processCustomer(env, phoneKey, config, workout, ist, today, global) {
  const chatId = `${phoneKey}@c.us`;
  const user = findUserInWorkout(workout, phoneKey);
  const customerType = resolveCustomerType(config, user);

  const messagesResp = await fetchPeriskopeMessages(env, chatId, 50);
  let messages = (messagesResp.messages || []).slice().sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));
  messages = filterByConversationStart(messages, config?.conversationStartTs);

  let userPrompt;
  if (customerType === 'gym') {
    const workoutLog = await fetchWorkoutLog(phoneKey, 20);
    userPrompt = buildGymPrompt({ phone: phoneKey, user, config, messages, istNow: ist, workoutLog, mode: 'cron' });
  } else {
    userPrompt = buildCronCheckinPrompt({ phone: phoneKey, user, raw: workout, messages, istNow: ist });
  }
  const systemPrompt = resolveSystemPrompt(config, global, customerType);
  const draft = await callAnthropic(env, systemPrompt, userPrompt);
  if (!draft) throw new Error('Empty draft from Anthropic');

  if (config.autoCoachMode === 'auto-send') {
    const holdResult = await sendOrHold(env, phoneKey, chatId, draft, 'cron');
    if (holdResult.acted === 'sent') {
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
    } else {
      // Held — mark cron-checkin done for today so we don't retry this tick, draft already queued
      await fbPatch(`customers/${phoneKey}/config`, {
        lastOutboundDate: today,
        lastOutboundReason: 'cron-checkin',
      });
    }
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
  const r = await fetch(u.toString(), {
    headers: { 'x-api-key': env.FERRA_API_KEY },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
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
  if (!r.ok) {
    trackAiUsage(0, 0, DEFAULT_MODEL, true).catch(() => {});
    throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const body = await r.json();
  const usage = body.usage || {};
  trackAiUsage(usage.input_tokens || 0, usage.output_tokens || 0, body.model || DEFAULT_MODEL, false).catch(() => {});
  const out = (body.content || []).find(c => c.type === 'text')?.text || '';
  return out.trim();
}

async function trackAiUsage(inputTokens, outputTokens, model, errored) {
  const ist = istParts(new Date());
  const date = ist.iso.slice(0, 10);
  const path = `aiUsage/${date}`;
  try {
    const existing = (await fbGet(path)) || {};
    const next = {
      inputTokens: (existing.inputTokens || 0) + inputTokens,
      outputTokens: (existing.outputTokens || 0) + outputTokens,
      calls: (existing.calls || 0) + 1,
      errors: (existing.errors || 0) + (errored ? 1 : 0),
      lastModel: model,
      lastUpdated: Date.now(),
    };
    await fbPut(path, next);
  } catch (err) {
    console.error('trackAiUsage failed:', err.message);
  }
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
    // For webhook events with a chat_id, also write to the per-customer feed.
    // This gives the dashboard a much larger effective window per customer than the
    // shared global feed (which gets crowded by cron + other customers).
    if (event.type === 'webhook' && event.chat_id) {
      const phoneKey = String(event.chat_id).replace(/@c\.us$/, '').replace(/[^\d]/g, '');
      if (phoneKey) {
        await fbPush(`customers/${phoneKey}/webhookFeed`, { ts: Date.now(), ...event });
      }
    }
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

function filterByConversationStart(messages, startTs) {
  if (!startTs) return messages;
  return (messages || []).filter(m => tsMs(m.timestamp) >= startTs);
}

function resolveCustomerType(config, ferraUser) {
  const explicit = config?.customerType;
  if (explicit === 'ferra' || explicit === 'gym') return explicit;
  return ferraUser ? 'ferra' : 'gym';
}

async function fetchWorkoutLog(phoneKey, limit) {
  try {
    const r = await fetch(`${FB_URL}/${FB_ROOT}/customers/${phoneKey}/workoutLog.json?orderBy="$key"&limitToLast=${limit}`);
    if (!r.ok) return [];
    const data = await r.json();
    if (!data) return [];
    const entries = Object.entries(data).map(([id, v]) => ({ id, ...v }));
    entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return entries;
  } catch {
    return [];
  }
}

function buildGymPrompt({ phone, user, config, messages, istNow, workoutLog, latestInbound, mode }) {
  const todayStr = istNow.iso.slice(0, 10);
  const lines = [];
  lines.push(`Today: ${todayStr} (${istNow.dayName}), ${istNow.hm} IST`);
  lines.push('');
  lines.push(`Customer: ${user?.name || `+${phone}`}`);
  lines.push(`Phone: +${phone}`);
  lines.push(`Customer type: Gym / other (NOT Ferra machine — no automatic workout data)`);

  const weeklyGoal = parseInt(config?.weeklyGoal, 10) || 3;
  lines.push(`Weekly workout goal: ${weeklyGoal} sessions`);

  // Determine this Monday
  const today = new Date(istNow.iso.slice(0, 10) + 'T00:00:00Z');
  const day = today.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(today.getTime() + diff * 86400000);
  const mondayStr = monday.toISOString().slice(0, 10);

  const thisWeek = (workoutLog || []).filter(w => (w.date || '') >= mondayStr);
  lines.push(`Workouts reported this week (since ${mondayStr}): ${thisWeek.length} of ${weeklyGoal}`);
  if (thisWeek.length > 0) {
    lines.push('');
    lines.push('This week\'s sessions:');
    for (const w of thisWeek) {
      lines.push(`  ${w.date || formatMessageTs(w.ts)}: ${w.type || 'workout'}${w.details ? ' — ' + w.details : ''}`);
    }
  }

  const recentLog = (workoutLog || []).slice(0, 10);
  if (recentLog.length > 0) {
    lines.push('');
    lines.push('Recent workout log (last 10, newest first):');
    for (const w of recentLog) {
      lines.push(`  ${w.date || formatMessageTs(w.ts)}: ${w.type || 'workout'}${w.details ? ' — ' + w.details : ''}`);
    }
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
  if (mode === 'reply' && latestInbound) {
    lines.push(`Customer just sent: "${latestInbound.slice(0, 500)}"`);
    lines.push('');
    lines.push('Draft my reply. If they reported a workout, acknowledge it specifically and reference the weekly progress. If they asked something, answer briefly then anchor on training.');
  } else {
    lines.push('Draft an accountability check-in. Reference where they are on this week\'s goal. If they haven\'t reported in a day or two, ASK directly whether they trained.');
  }
  return lines.join('\n');
}

async function extractAndLogWorkout(env, phoneKey, messageBody, ist) {
  const prompt = `Did this WhatsApp message from a customer indicate they COMPLETED a physical workout/training session? Be conservative — only count clear past-tense reports of done workouts, not future intentions or vague mentions.

Message: "${messageBody}"

Output ONLY a JSON object with this exact shape, nothing else:
{ "logged": false }
or:
{ "logged": true, "type": "<one of: legs, push, pull, full-body, cardio, yoga, sports, general>", "details": "<short summary, max 80 chars>" }

Examples:
  "did legs today" → { "logged": true, "type": "legs", "details": "leg day" }
  "30 min cardio done" → { "logged": true, "type": "cardio", "details": "30 min cardio" }
  "feeling tired" → { "logged": false }
  "going to gym now" → { "logged": false }
  "just finished my workout, full body" → { "logged": true, "type": "full-body", "details": "full body workout" }
  "did upper today, chest and back" → { "logged": true, "type": "push", "details": "chest and back" }`;

  let text;
  try {
    text = await callAnthropicWithModel(env, '', prompt, 'claude-haiku-4-5-20251001', 200);
  } catch (err) {
    console.error('Haiku extract call failed:', err.message);
    return;
  }
  if (!text) return;

  let parsed;
  try {
    const cleaned = text.trim().replace(/^```json\s*|\s*```$/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return;
  }
  if (parsed?.logged !== true || !parsed.type) return;

  await fbPush(`customers/${phoneKey}/workoutLog`, {
    ts: Date.now(),
    date: ist.iso.slice(0, 10),
    type: parsed.type,
    details: (parsed.details || '').slice(0, 80),
    source: 'auto-extracted',
    raw: messageBody.slice(0, 200),
  });
  await fbPush(`customers/${phoneKey}/activity`, {
    ts: Date.now(),
    direction: 'system',
    source: 'webhook',
    action: 'workout-auto-logged',
    message: `${parsed.type}: ${parsed.details || ''}`,
  });
}

async function extractAndScheduleReminders(env, phoneKey, messageBody, config, ist) {
  const todayISO = ist.iso.slice(0, 10);
  const sendTime = config?.sendTimeIST || '08:00';
  const nowIST = `${todayISO}T${ist.hm}:00+05:30`;

  const prompt = `Analyze this WhatsApp message from a customer. Does it state a SPECIFIC future workout intent OR explicitly ask for a reminder at a specific time?

Today: ${todayISO} (${ist.dayName}). Current time: ${ist.hm} IST. Customer's morning check-in is at ${sendTime} IST.
Now: ${nowIST}

Message: "${messageBody}"

If YES, output a JSON with up to 2 reminders:
- a "followup" at the stated time (to ask how it's going)
- optionally a "no-show-check" 2 hours after the stated time (to verify they did it)

Be CONSERVATIVE — skip vague phrases ("maybe later", "soon", "we'll see", "I'll try").

Output ONLY JSON, no preamble:
{ "reminders": [ { "fireAt": "<ISO 8601 with +05:30>", "reason": "<short>", "type": "followup" | "no-show-check" } ] }

Examples:
- "I'll workout at 6pm" → followup at today 18:00 + no-show-check at today 20:00
- "Remind me tomorrow morning" → followup at tomorrow ${sendTime}
- "Doing it Saturday for sure" → followup at the next Saturday at ${sendTime}
- "Will hit the gym after work, around 8" → followup at today 20:00 + no-show-check at today 22:00
- "Did legs today" → { "reminders": [] }
- "Maybe tomorrow" → { "reminders": [] }
- "Going gym now" → { "reminders": [{ "fireAt": "<now + 90 min>", "reason": "check on workout after they said they're going now", "type": "no-show-check" }] }`;

  let text;
  try {
    text = await callAnthropicWithModel(env, '', prompt, 'claude-haiku-4-5-20251001', 500);
  } catch (err) {
    console.error('reminder extract LLM call failed:', err.message);
    return;
  }
  if (!text) return;

  let parsed;
  try {
    const cleaned = text.trim().replace(/^```json\s*|\s*```$/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return;
  }
  if (!Array.isArray(parsed?.reminders) || parsed.reminders.length === 0) return;

  const now = Date.now();
  for (const r of parsed.reminders) {
    if (!r?.fireAt || !r.reason) continue;
    const fireMs = Date.parse(r.fireAt);
    if (Number.isNaN(fireMs) || fireMs <= now) continue;
    if (fireMs > now + 14 * 24 * 60 * 60 * 1000) continue; // cap at 14 days out
    const sourceType = r.type === 'no-show-check' ? 'stated-intent-no-show' : 'stated-intent-followup';
    try {
      await fbPush(`customers/${phoneKey}/scheduledReminders`, {
        ts: Date.now(),
        fireAt: fireMs,
        status: 'pending',
        source: sourceType,
        reason: String(r.reason).slice(0, 240),
        extractedFrom: messageBody.slice(0, 200),
      });
    } catch (err) {
      console.error('failed to push reminder:', err.message);
    }
  }
  await fbPush(`customers/${phoneKey}/activity`, {
    ts: Date.now(), direction: 'system', source: 'reminder',
    action: 'reminders-extracted',
    message: `${parsed.reminders.length} reminder(s) extracted from inbound`,
  });
}

async function callAnthropicWithModel(env, system, userPrompt, model, maxTokens) {
  const r = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userPrompt }] }),
  });
  if (!r.ok) {
    trackAiUsage(0, 0, model, true).catch(() => {});
    throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const body = await r.json();
  const usage = body.usage || {};
  trackAiUsage(usage.input_tokens || 0, usage.output_tokens || 0, body.model || model, false).catch(() => {});
  return (body.content || []).find(c => c.type === 'text')?.text?.trim() || '';
}

async function fbPushAndGetKey(path, value) {
  const r = await fetch(`${FB_URL}/${FB_ROOT}/${path}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase POST ${path}: ${r.status}`);
  const body = await r.json();
  return body.name;
}

async function sendOrHold(env, phoneKey, chatId, message, source, holdMs = 10000) {
  const holdId = await fbPushAndGetKey(`customers/${phoneKey}/holdQueue`, {
    ts: Date.now(),
    message,
    source,
    sendAt: Date.now() + holdMs,
    status: 'pending',
  });
  await new Promise(resolve => setTimeout(resolve, holdMs));
  const entry = await fbGet(`customers/${phoneKey}/holdQueue/${holdId}`);
  if (entry?.held === true) {
    await fbPut(`customers/${phoneKey}/pendingDraft`, {
      ts: Date.now(),
      message,
      source: `held-${source}`,
      reason: `Held from auto-send (${source}) — review and Send when ready`,
    });
    await fbPatch(`customers/${phoneKey}/holdQueue/${holdId}`, { status: 'held' });
    await fbPush(`customers/${phoneKey}/activity`, {
      ts: Date.now(), direction: 'system', source: 'hold', action: 'held-by-user',
      message,
    });
    return { acted: 'held' };
  }
  await sendViaPeriskope(env, chatId, message);
  await fbPatch(`customers/${phoneKey}/holdQueue/${holdId}`, { status: 'sent' });
  return { acted: 'sent' };
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
        gym: cfg?.prompts?.gym || SYSTEM_GYM_COACH,
      },
      safety: { ...SAFETY, ...(cfg?.safety || {}) },
    };
    _globalConfigFetchedAt = Date.now();
  } catch (err) {
    console.error('getGlobalConfig failed, using defaults:', err.message);
    _globalConfigCache = { killSwitch: false, prompts: { coach: SYSTEM_COACH, reply: SYSTEM_REPLY, gym: SYSTEM_GYM_COACH }, safety: { ...SAFETY } };
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
