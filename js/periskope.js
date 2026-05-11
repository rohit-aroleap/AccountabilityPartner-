import { loadSettings } from './storage.js';

export function phoneToChatId(phone) {
  if (!phone) return '';
  const cleaned = String(phone).replace(/[\s\-()+]/g, '');
  return `${cleaned}@c.us`;
}

function workerBase() {
  const { workerUrl } = loadSettings();
  if (!workerUrl) throw new Error('Worker URL not configured');
  return workerUrl.replace(/\/+$/, '');
}

export async function listMessages(chatId, { limit = 50, offset = 0 } = {}) {
  const base = workerBase();
  const url = new URL(`${base}/periskope/messages`);
  url.searchParams.set('chat_id', chatId);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));

  const res = await fetch(url.toString());
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!res.ok) {
    const msg = body.error || body.message || `HTTP ${res.status}`;
    throw new Error(`Periskope list-messages failed: ${msg}`);
  }
  return body;
}

export async function sendMessage(chatId, message, { replyTo } = {}) {
  const base = workerBase();
  const res = await fetch(`${base}/periskope/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body.error || body.message || `HTTP ${res.status}`;
    throw new Error(`Periskope send failed: ${msg}`);
  }
  return body;
}
