import { loadSettings } from './storage.js';

function workerBase() {
  const { workerUrl } = loadSettings();
  if (!workerUrl) throw new Error('Worker URL not configured');
  return workerUrl.replace(/\/+$/, '');
}

export async function generateMessage({ system, userPrompt, model, maxTokens = 512 }) {
  const base = workerBase();
  const res = await fetch(`${base}/anthropic/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body.error?.message || body.error || body.message || `HTTP ${res.status}`;
    throw new Error(`Anthropic call failed: ${msg}`);
  }
  const out = (body.content || []).find(c => c.type === 'text')?.text || '';
  return out.trim();
}
