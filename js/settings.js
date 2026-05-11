import { loadSettings, saveSettings, isConfigured } from './storage.js';

const els = {};
const listeners = new Set();

export function onSettingsSaved(fn) {
  listeners.add(fn);
}

export function initSettings() {
  els.modal = document.getElementById('settings-modal');
  els.openBtn = document.getElementById('open-settings');
  els.closeBtn = document.getElementById('close-settings');
  els.form = document.getElementById('settings-form');
  els.status = document.getElementById('settings-status');
  els.banner = document.getElementById('config-banner');

  els.openBtn.addEventListener('click', openModal);
  els.closeBtn.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) closeModal();
  });
  els.form.addEventListener('submit', onSave);

  hydrateForm();
  refreshBanner();
}

function openModal() {
  hydrateForm();
  els.modal.classList.add('open');
}

function closeModal() {
  els.modal.classList.remove('open');
  els.status.textContent = '';
}

function hydrateForm() {
  const s = loadSettings();
  els.form.workerUrl.value = s.workerUrl;
  els.form.periskopeToken.value = s.periskopeToken;
  els.form.periskopePhone.value = s.periskopePhone;
  els.form.anthropicKey.value = s.anthropicKey;
  els.form.anthropicModel.value = s.anthropicModel;
  els.form.customerPhonesRaw.value = s.customerPhonesRaw;
}

function onSave(e) {
  e.preventDefault();
  const data = new FormData(els.form);
  saveSettings({
    workerUrl: data.get('workerUrl').trim().replace(/\/+$/, ''),
    periskopeToken: data.get('periskopeToken').trim(),
    periskopePhone: data.get('periskopePhone').trim(),
    anthropicKey: data.get('anthropicKey').trim(),
    anthropicModel: data.get('anthropicModel').trim() || 'claude-opus-4-7',
    customerPhonesRaw: data.get('customerPhonesRaw'),
  });
  els.status.textContent = 'Saved.';
  refreshBanner();
  listeners.forEach(fn => {
    try { fn(); } catch (err) { console.error(err); }
  });
  setTimeout(closeModal, 600);
}

function refreshBanner() {
  els.banner.hidden = isConfigured();
}
