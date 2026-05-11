import {
  ref,
  get,
  set,
  update,
  push,
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
