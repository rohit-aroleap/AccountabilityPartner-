import { loadSettings } from './storage.js';

let cache = null;
let cachePromise = null;

export async function loadWorkoutData({ force = false } = {}) {
  if (!force && cache) return cache;
  if (!force && cachePromise) return cachePromise;

  const { workerUrl } = loadSettings();
  if (!workerUrl) throw new Error('Worker URL not configured');

  const base = workerUrl.replace(/\/+$/, '');
  cachePromise = fetch(`${base}/workout?includeExerciseDb=false`, {
    headers: { 'x-requested-with': 'AccountabilityPartner' },
  })
    .then(async res => {
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Worker /workout ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      cache = indexByPhone(data);
      cachePromise = null;
      return cache;
    })
    .catch(err => {
      cachePromise = null;
      throw err;
    });

  return cachePromise;
}

export function getCached() {
  return cache;
}

function indexByPhone(raw) {
  const users = [...(raw.users || []), ...(raw.cancelledUsers || [])];
  const byPhone = new Map();
  const byUid = new Map();
  for (const u of users) {
    byUid.set(u.uid, u);
    if (u.phone) byPhone.set(normalizePhone(u.phone), u);
  }
  return {
    raw,
    users,
    byPhone,
    byUid,
    userMonthlySummaries: raw.userMonthlySummaries || {},
    userHabitHistory: raw.userHabitHistory || {},
  };
}

export function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = String(phone).replace(/[\s\-()]/g, '');
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

export async function isPhoneInFerraExport(phone) {
  try {
    const idx = await loadWorkoutData();
    return !!idx.byPhone.get(normalizePhone(phone));
  } catch {
    return false;
  }
}

export function getDailyActivity(idx, uid, dateStr) {
  const months = idx.userMonthlySummaries[uid] || [];
  for (const m of months) {
    const day = m.dailyActivity?.[dateStr];
    if (day) return day;
  }
  return null;
}

export function getRecentDailyActivity(idx, uid, days = 14) {
  const months = idx.userMonthlySummaries[uid] || [];
  const all = {};
  for (const m of months) {
    Object.assign(all, m.dailyActivity || {});
  }
  const sorted = Object.entries(all).sort(([a], [b]) => (a < b ? 1 : -1));
  return sorted.slice(0, days).map(([date, info]) => ({ date, ...info }));
}

export function getRecentHabitScores(idx, uid, days = 14) {
  const months = idx.userHabitHistory[uid] || [];
  const flat = {};
  for (const m of months) {
    for (const [k, v] of Object.entries(m)) {
      if (k.startsWith('dailyScores.')) {
        flat[k.slice('dailyScores.'.length)] = v;
      }
    }
  }
  const sorted = Object.entries(flat).sort(([a], [b]) => (a < b ? 1 : -1));
  return sorted.slice(0, days).map(([date, info]) => ({ date, ...info }));
}
