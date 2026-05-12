const KEY = 'ap.settings.v1';

const DEFAULTS = {
  workerUrl: '',
  anthropicModel: 'claude-opus-4-7',
  customerPhonesRaw: '',
  customerNames: {},
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

export function normalizePhoneInput(input = '') {
  const cleaned = String(input).replace(/[\s\-()]/g, '');
  if (!cleaned) return '';
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

export function addCustomer({ phone, name = '' }) {
  const settings = loadSettings();
  const normPhone = normalizePhoneInput(phone);
  if (!normPhone || !/^\+\d{7,}$/.test(normPhone)) {
    throw new Error('Phone must be in international format, e.g. +919876543210');
  }
  const phones = parseCustomerPhones(settings.customerPhonesRaw);
  if (!phones.includes(normPhone)) {
    phones.push(normPhone);
  }
  const newRaw = phones.join('\n');
  const newNames = { ...settings.customerNames };
  if (name.trim()) newNames[normPhone] = name.trim();
  else delete newNames[normPhone];
  saveSettings({ ...settings, customerPhonesRaw: newRaw, customerNames: newNames });
  return normPhone;
}

export function removeCustomer(phone) {
  const settings = loadSettings();
  const normPhone = normalizePhoneInput(phone);
  const phones = parseCustomerPhones(settings.customerPhonesRaw).filter(p => p !== normPhone);
  const names = { ...settings.customerNames };
  delete names[normPhone];
  saveSettings({ ...settings, customerPhonesRaw: phones.join('\n'), customerNames: names });
}

export function getCustomerName(phone) {
  const { customerNames } = loadSettings();
  return customerNames?.[normalizePhoneInput(phone)] || '';
}
