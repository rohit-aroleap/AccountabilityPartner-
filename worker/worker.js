const FERRA_EXPORT_URL =
  'https://asia-south1-aroleap-fa76f.cloudfunctions.net/exportFerraDashboard';
const PERISKOPE_BASE = 'https://api.periskope.app/v1';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
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
      if (url.pathname === '/workout' || url.pathname === '/workout/') {
        return handleWorkout(request, env, corsHeaders);
      }
      if (url.pathname === '/periskope/send') {
        return handlePeriskopeSend(request, env, corsHeaders);
      }
      if (url.pathname === '/periskope/messages') {
        return handlePeriskopeMessages(request, env, corsHeaders);
      }
      if (url.pathname === '/anthropic/messages') {
        return handleAnthropic(request, env, corsHeaders);
      }
      return json({ error: 'Not found', path: url.pathname }, corsHeaders, 404);
    } catch (err) {
      return json({ error: 'Worker exception', message: err.message }, corsHeaders, 500);
    }
  },
};

async function handleWorkout(request, env, corsHeaders) {
  if (!env.FERRA_API_KEY) {
    return json({ error: 'FERRA_API_KEY secret not set on Worker' }, corsHeaders, 500);
  }
  const includeExerciseDb =
    new URL(request.url).searchParams.get('includeExerciseDb') !== 'false';
  const upstream = new URL(FERRA_EXPORT_URL);
  upstream.searchParams.set('includeExerciseDb', String(includeExerciseDb));

  const res = await fetch(upstream.toString(), {
    headers: { 'x-api-key': env.FERRA_API_KEY },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) {
    const body = await res.text();
    return json(
      { error: 'Upstream failed', status: res.status, body: body.slice(0, 500) },
      corsHeaders,
      502,
    );
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, max-age=30',
    },
  });
}

async function handlePeriskopeSend(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, corsHeaders, 405);
  }
  const cfg = periskopeConfig(env);
  if (cfg.error) return json({ error: cfg.error }, corsHeaders, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, corsHeaders, 400);
  }
  if (!body.chat_id || !body.message) {
    return json({ error: 'chat_id and message are required' }, corsHeaders, 400);
  }

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
  return new Response(text, {
    status: res.status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handlePeriskopeMessages(request, env, corsHeaders) {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, corsHeaders, 405);
  }
  const cfg = periskopeConfig(env);
  if (cfg.error) return json({ error: cfg.error }, corsHeaders, 500);

  const params = new URL(request.url).searchParams;
  const chatId = params.get('chat_id');
  if (!chatId) return json({ error: 'chat_id query param required' }, corsHeaders, 400);

  const limit = Math.min(parseInt(params.get('limit') || '50', 10) || 50, 2000);
  const offset = parseInt(params.get('offset') || '0', 10) || 0;

  const upstream = new URL(
    `${PERISKOPE_BASE}/chats/${encodeURIComponent(chatId)}/messages`,
  );
  upstream.searchParams.set('limit', String(limit));
  upstream.searchParams.set('offset', String(offset));

  const res = await fetch(upstream.toString(), {
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'x-phone': cfg.phone,
    },
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleAnthropic(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, corsHeaders, 405);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY secret not set on Worker' }, corsHeaders, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, corsHeaders, 400);
  }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'messages array required' }, corsHeaders, 400);
  }

  const model = ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
  const maxTokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 512, 16), 2048);

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: body.system || '',
      messages: body.messages,
    }),
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });
}

function periskopeConfig(env) {
  if (!env.PERISKOPE_API_KEY) return { error: 'PERISKOPE_API_KEY secret not set on Worker' };
  if (!env.PERISKOPE_PHONE) return { error: 'PERISKOPE_PHONE secret not set on Worker' };
  return { token: env.PERISKOPE_API_KEY, phone: env.PERISKOPE_PHONE };
}

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
