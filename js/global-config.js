import { ref, get, set, onValue, off } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { db, ROOT_PATH } from './firebase-init.js';
import { DEFAULT_GLOBAL } from './defaults.js';

let cached = null;
const listeners = new Set();

export function globalConfigRef() {
  return ref(db, `${ROOT_PATH}/globalConfig`);
}

export async function loadGlobalConfig() {
  const snap = await get(globalConfigRef());
  cached = snap.exists() ? mergeWithDefaults(snap.val()) : { ...DEFAULT_GLOBAL };
  return cached;
}

export function getCachedGlobalConfig() {
  return cached;
}

export async function saveGlobalConfig(config) {
  await set(globalConfigRef(), config);
  cached = mergeWithDefaults(config);
  listeners.forEach(fn => { try { fn(cached); } catch (e) { console.error(e); } });
}

export function subscribeGlobalConfig(cb) {
  const r = globalConfigRef();
  const handler = (snap) => {
    cached = snap.exists() ? mergeWithDefaults(snap.val()) : { ...DEFAULT_GLOBAL };
    cb(cached);
    listeners.forEach(fn => { try { fn(cached); } catch (e) { console.error(e); } });
  };
  onValue(r, handler);
  return () => off(r, 'value', handler);
}

export function onConfigUpdate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function mergeWithDefaults(cfg) {
  return {
    killSwitch: cfg?.killSwitch === true,
    prompts: {
      coach: cfg?.prompts?.coach || DEFAULT_GLOBAL.prompts.coach,
      reply: cfg?.prompts?.reply || DEFAULT_GLOBAL.prompts.reply,
      gym: cfg?.prompts?.gym || DEFAULT_GLOBAL.prompts.gym,
    },
    safety: { ...DEFAULT_GLOBAL.safety, ...(cfg?.safety || {}) },
  };
}
