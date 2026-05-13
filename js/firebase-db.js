import {
  ref,
  get,
  set,
  update,
  push,
  remove,
  onValue,
  off,
  query,
  limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { db, ROOT_PATH } from './firebase-init.js';

export function phoneToKey(phone) {
  return String(phone).replace(/[^\d]/g, '');
}

function customerRef(phone, suffix = '') {
  return ref(db, `${ROOT_PATH}/customers/${phoneToKey(phone)}${suffix}`);
}

export async function readConfig(phone) {
  const snap = await get(customerRef(phone, '/config'));
  return snap.exists() ? snap.val() : null;
}

export function subscribeConfig(phone, cb) {
  const r = customerRef(phone, '/config');
  const handler = (snap) => cb(snap.exists() ? snap.val() : null);
  onValue(r, handler);
  return () => off(r, 'value', handler);
}

export async function writeConfig(phone, patch) {
  await update(customerRef(phone, '/config'), patch);
}

export async function logActivity(phone, event) {
  const r = push(customerRef(phone, '/activity'));
  await set(r, { ts: Date.now(), ...event });
}

export function subscribeActivity(phone, n, cb) {
  const q = query(customerRef(phone, '/activity'), limitToLast(n));
  const handler = (snap) => {
    const out = [];
    snap.forEach(child => { out.push({ id: child.key, ...child.val() }); });
    cb(out.reverse());
  };
  onValue(q, handler);
  return () => off(q, 'value', handler);
}

export function subscribePendingDraft(phone, cb) {
  const r = customerRef(phone, '/pendingDraft');
  const handler = (snap) => cb(snap.exists() ? snap.val() : null);
  onValue(r, handler);
  return () => off(r, 'value', handler);
}

export async function clearPendingDraft(phone) {
  await remove(customerRef(phone, '/pendingDraft'));
}

export async function deleteCustomerData(phone) {
  await remove(customerRef(phone, ''));
}

// --- Excluded message IDs (hide from AI context + chat view) ---
// Stored as customers/<phoneKey>/excludedMessageIds/<messageId> = { ts, preview }
// Note: Firebase keys can't contain "." or "$" or "#" or "[" or "]" — Periskope
// message IDs use "_" so they're safe, but we sanitise just in case.
function sanitiseMessageIdKey(id) {
  return String(id || '').replace(/[.#$\[\]\/]/g, '_');
}

export async function addExcludedMessage(phone, messageId, { preview } = {}) {
  const key = sanitiseMessageIdKey(messageId);
  if (!key) throw new Error('messageId required');
  await set(customerRef(phone, `/excludedMessageIds/${key}`), {
    ts: Date.now(),
    originalId: messageId,
    preview: (preview || '').slice(0, 200),
  });
}

export async function removeExcludedMessage(phone, messageId) {
  const key = sanitiseMessageIdKey(messageId);
  if (!key) return;
  await remove(customerRef(phone, `/excludedMessageIds/${key}`));
}

export function subscribeExcludedMessages(phone, cb) {
  const r = customerRef(phone, '/excludedMessageIds');
  const handler = (snap) => {
    const ids = new Set();
    const meta = new Map();
    snap.forEach(child => {
      const v = child.val() || {};
      const id = v.originalId || child.key;
      ids.add(id);
      meta.set(id, v);
    });
    cb(ids, meta);
  };
  onValue(r, handler);
  return () => off(r, 'value', handler);
}

export async function backfillWebhookFeeds({ onLog, onProgress } = {}) {
  const log = onLog || (() => {});
  const progress = onProgress || (() => {});

  log('Reading global automation/feed…');
  const feedRef = ref(db, `${ROOT_PATH}/automation/feed`);
  const snap = await get(feedRef);
  if (!snap.exists()) {
    log('No automation/feed entries found.');
    return { total: 0, migrated: 0, skipped: 0, customers: 0 };
  }

  // Collect webhook entries with chat_id
  const entries = [];
  snap.forEach(child => {
    const v = child.val();
    if (v?.type === 'webhook' && v.chat_id && v.message_id) {
      entries.push({ id: child.key, data: v });
    }
  });

  log(`Found ${entries.length} webhook entries (with chat_id + message_id) in global feed.`);

  // Group by phoneKey
  const byPhone = new Map();
  for (const e of entries) {
    const phoneKey = String(e.data.chat_id).replace(/@c\.us$/, '').replace(/[^\d]/g, '');
    if (!phoneKey) continue;
    if (!byPhone.has(phoneKey)) byPhone.set(phoneKey, []);
    byPhone.get(phoneKey).push(e);
  }

  log(`Distinct customers: ${byPhone.size}.`);

  let migrated = 0;
  let skipped = 0;
  let processed = 0;
  const total = entries.length;

  for (const [phoneKey, custEntries] of byPhone) {
    const custRef = ref(db, `${ROOT_PATH}/customers/${phoneKey}/webhookFeed`);
    const custSnap = await get(custRef);
    const existing = new Set();
    if (custSnap.exists()) {
      custSnap.forEach(child => {
        const v = child.val();
        if (v?.message_id) existing.add(v.message_id);
      });
    }

    let custMigrated = 0;
    let custSkipped = 0;
    for (const e of custEntries) {
      processed++;
      if (existing.has(e.data.message_id)) {
        custSkipped++;
        skipped++;
      } else {
        const newRef = push(custRef);
        await set(newRef, e.data);
        existing.add(e.data.message_id);
        custMigrated++;
        migrated++;
      }
      if (processed % 25 === 0) progress(processed, total);
    }
    log(`  +${phoneKey}: migrated ${custMigrated}, skipped ${custSkipped}`);
  }

  progress(total, total);
  return { total, migrated, skipped, customers: byPhone.size };
}

export async function readPendingDraft(phone) {
  const snap = await get(customerRef(phone, '/pendingDraft'));
  return snap.exists() ? snap.val() : null;
}

export function subscribeHoldQueueForChat(phone, cb) {
  const r = customerRef(phone, '/holdQueue');
  const handler = (snap) => {
    const out = [];
    snap.forEach(child => { out.push({ id: child.key, ...child.val() }); });
    cb(out);
  };
  onValue(r, handler);
  return () => off(r, 'value', handler);
}

export async function markHoldHeld(phone, holdId) {
  await update(customerRef(phone, `/holdQueue/${holdId}`), { held: true });
}

export async function logAiRating(phone, entry) {
  const r = push(customerRef(phone, '/aiRatings'));
  await set(r, { ts: Date.now(), ...entry });
}

export function subscribeAiUsage(cb) {
  const r = ref(db, `${ROOT_PATH}/aiUsage`);
  const handler = (snap) => cb(snap.exists() ? snap.val() : {});
  onValue(r, handler);
  return () => off(r, 'value', handler);
}

export function subscribeAutomationFeed(n, cb) {
  const r = ref(db, `${ROOT_PATH}/automation/feed`);
  const q = query(r, limitToLast(n));
  const handler = (snap) => {
    const out = [];
    snap.forEach(child => { out.push({ id: child.key, ...child.val() }); });
    cb(out.reverse());
  };
  onValue(q, handler);
  return () => off(q, 'value', handler);
}

export function subscribeScheduledReminders(phone, n, cb) {
  const r = customerRef(phone, '/scheduledReminders');
  const q = query(r, limitToLast(n));
  const handler = (snap) => {
    const out = [];
    snap.forEach(child => { out.push({ id: child.key, ...child.val() }); });
    cb(out.reverse());
  };
  onValue(q, handler);
  return () => off(q, 'value', handler);
}

export async function addScheduledReminder(phone, entry) {
  const r = push(customerRef(phone, '/scheduledReminders'));
  await set(r, { ts: Date.now(), status: 'pending', ...entry });
  return r.key;
}

export async function cancelScheduledReminder(phone, id) {
  const r = customerRef(phone, `/scheduledReminders/${id}`);
  await update(r, { status: 'cancelled', cancelledAt: Date.now() });
}

export function subscribeWorkoutLog(phone, n, cb) {
  const r = customerRef(phone, '/workoutLog');
  const q = query(r, limitToLast(n));
  const handler = (snap) => {
    const out = [];
    snap.forEach(child => { out.push({ id: child.key, ...child.val() }); });
    cb(out.reverse());
  };
  onValue(q, handler);
  return () => off(q, 'value', handler);
}

export async function logWorkout(phone, entry) {
  const r = push(customerRef(phone, '/workoutLog'));
  await set(r, { ts: Date.now(), ...entry });
}

export function subscribeWebhookEventsForChat(chatId, n, cb) {
  const phoneKey = String(chatId).replace(/@c\.us$/, '').replace(/[^\d]/g, '');

  // Hybrid subscription:
  // - Per-customer feed (customers/<phoneKey>/webhookFeed) — large effective window because it's filtered server-side
  // - Global feed (automation/feed) — fallback for historical entries written before per-customer path existed
  // Results are merged; per-customer wins on conflicts since it's the canonical post-v1.034 source.

  let globalMap = new Map();
  let customerMap = new Map();

  const pickBetter = (incoming, existing) => {
    if (!existing) return true;
    const incomingHasPrompt = !!incoming.userPrompt;
    const existingHasPrompt = !!existing.userPrompt;
    if (incomingHasPrompt && !existingHasPrompt) return true;
    if (!incomingHasPrompt && existingHasPrompt) return false;
    const incomingIsCreated = incoming.event === 'message.created';
    const existingIsCreated = existing.event === 'message.created';
    if (incomingIsCreated && !existingIsCreated) return true;
    return false;
  };

  const merge = () => {
    const combined = new Map();
    // Per-customer first (preferred source)
    for (const [k, v] of customerMap) combined.set(k, v);
    // Global as fallback for ids not in customer feed
    for (const [k, v] of globalMap) {
      if (!combined.has(k) || pickBetter(v, combined.get(k))) combined.set(k, v);
    }
    cb(combined);
  };

  // Global feed subscription
  const globalRef = ref(db, `${ROOT_PATH}/automation/feed`);
  const globalQ = query(globalRef, limitToLast(n));
  const globalHandler = (snap) => {
    const next = new Map();
    snap.forEach(child => {
      const v = child.val();
      if (v?.type !== 'webhook' || v.chat_id !== chatId || !v.message_id) return;
      const existing = next.get(v.message_id);
      if (!existing || pickBetter(v, existing)) {
        next.set(v.message_id, { id: child.key, ...v });
      }
    });
    globalMap = next;
    merge();
  };
  onValue(globalQ, globalHandler);

  // Per-customer feed subscription
  let custUnsub = () => {};
  if (phoneKey) {
    const custRef = ref(db, `${ROOT_PATH}/customers/${phoneKey}/webhookFeed`);
    const custQ = query(custRef, limitToLast(n));
    const custHandler = (snap) => {
      const next = new Map();
      snap.forEach(child => {
        const v = child.val();
        if (!v || !v.message_id) return;
        const existing = next.get(v.message_id);
        if (!existing || pickBetter(v, existing)) {
          next.set(v.message_id, { id: child.key, ...v });
        }
      });
      customerMap = next;
      merge();
    };
    onValue(custQ, custHandler);
    custUnsub = () => off(custQ, 'value', custHandler);
  }

  return () => {
    off(globalQ, 'value', globalHandler);
    custUnsub();
  };
}
