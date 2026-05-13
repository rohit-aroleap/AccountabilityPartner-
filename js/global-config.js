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

function mergePersonalities(cfg) {
  const out = {};
  for (const key of Object.keys(DEFAULT_GLOBAL.personalities)) {
    const incoming = cfg?.[key];
    out[key] = (typeof incoming === 'string' && incoming.trim()) ? incoming : DEFAULT_GLOBAL.personalities[key];
  }
  return out;
}

function mergeWithDefaults(cfg) {
  return {
    killSwitch: cfg?.killSwitch === true,
    prompts: {
      coach: cfg?.prompts?.coach || DEFAULT_GLOBAL.prompts.coach,
      reply: cfg?.prompts?.reply || DEFAULT_GLOBAL.prompts.reply,
      gym: cfg?.prompts?.gym || DEFAULT_GLOBAL.prompts.gym,
    },
    introMessage: typeof cfg?.introMessage === 'string' && cfg.introMessage.length > 0
      ? cfg.introMessage : DEFAULT_GLOBAL.introMessage,
    introMessageFerra: typeof cfg?.introMessageFerra === 'string' && cfg.introMessageFerra.length > 0
      ? cfg.introMessageFerra : DEFAULT_GLOBAL.introMessageFerra,
    introMessageGym: typeof cfg?.introMessageGym === 'string' && cfg.introMessageGym.length > 0
      ? cfg.introMessageGym : DEFAULT_GLOBAL.introMessageGym,
    personaMale: (typeof cfg?.personaMale === 'string' && cfg.personaMale.trim()) || DEFAULT_GLOBAL.personaMale,
    personaFemale: (typeof cfg?.personaFemale === 'string' && cfg.personaFemale.trim()) || DEFAULT_GLOBAL.personaFemale,
    personalities: mergePersonalities(cfg?.personalities),
    safety: { ...DEFAULT_GLOBAL.safety, ...(cfg?.safety || {}) },
  };
}
