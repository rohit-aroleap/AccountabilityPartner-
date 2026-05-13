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
