const FERRA_EXPORT_URL =
  'https://asia-south1-aroleap-fa76f.cloudfunctions.net/exportFerraDashboard';

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

    if (url.pathname === '/workout' || url.pathname === '/workout/') {
      return handleWorkout(request, env, corsHeaders);
    }

    if (url.pathname === '/health') {
      return json({ ok: true }, corsHeaders);
    }

    return json({ error: 'Not found' }, corsHeaders, 404);
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
