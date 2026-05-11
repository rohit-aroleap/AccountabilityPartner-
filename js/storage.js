const KEY = 'ap.settings.v1';

const DEFAULTS = {
  workerUrl: '',
  periskopeToken: '',
  periskopePhone: '',
  anthropicKey: '',
  anthropicModel: 'claude-opus-4-7',
  customerPhonesRaw: '',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function isConfigured(settings = loadSettings()) {
  return Boolean(settings.workerUrl);
}

const PHONE_RE = /(\+?\d[\d\s\-]{6,}\d)/g;

export function parseCustomerPhones(raw = '') {
  const matches = raw.match(PHONE_RE) || [];
  const normalized = matches
    .map(p => p.replace(/[\s\-]/g, ''))
    .map(p => (p.startsWith('+') ? p : `+${p}`));
  return [...new Set(normalized)];
}
