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
  const r = ref(db, `${ROOT_PATH}/automation/feed`);
  const q = query(r, limitToLast(n));
  const handler = (snap) => {
    const map = new Map();
    snap.forEach(child => {
      const v = child.val();
      if (v?.type !== 'webhook' || v.chat_id !== chatId || !v.message_id) return;
      const existing = map.get(v.message_id);
      // Prefer the message.created entry — that's the one our handler actually decided on.
      // Don't let later message.updated/ack events overwrite the real decision.
      if (!existing || (v.event === 'message.created' && existing.event !== 'message.created')) {
        map.set(v.message_id, { id: child.key, ...v });
      }
    });
    cb(map);
  };
  onValue(q, handler);
  return () => off(q, 'value', handler);
}
