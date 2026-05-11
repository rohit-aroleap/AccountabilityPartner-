const KEY = 'ap.settings.v1';

const DEFAULTS = {
  periskopeToken: '',
  periskopePhone: '',
  anthropicKey: '',
  workoutJsonUrl: '',
  anthropicModel: 'claude-opus-4-7',
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
  return Boolean(
    settings.periskopeToken &&
    settings.anthropicKey &&
    settings.workoutJsonUrl
  );
}
