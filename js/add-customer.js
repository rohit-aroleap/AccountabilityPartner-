import { addCustomer, normalizePhoneInput } from './storage.js';
import { writeConfig, logActivity } from './firebase-db.js';
import { sendMessage, phoneToChatId } from './periskope.js';
import { loadGlobalConfig, getCachedGlobalConfig } from './global-config.js';
import { isPhoneInFerraExport } from './workout.js';
import { DEFAULT_INTRO_MESSAGE_FERRA, DEFAULT_INTRO_MESSAGE_GYM } from './defaults.js';

let modalEl;
let detectedType = null;
let detectDebounce = null;
const listeners = new Set();

export function onCustomerAdded(fn) {
  listeners.add(fn);
}

export function initAddCustomer() {
  modalEl = document.createElement('div');
  modalEl.id = 'add-customer-modal';
  modalEl.className = 'modal';
  modalEl.innerHTML = `
    <div class="modal-card add-cust-card">
      <div class="modal-header">
        <h2>Add customer</h2>
        <button class="icon-btn" id="ac-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <form id="ac-form">
          <div class="field">
            <label for="ac-name">Name (optional)</label>
            <input type="text" id="ac-name" name="name" placeholder="e.g. Rohit Patel" autocomplete="off" />
          </div>
          <div class="field">
            <label for="ac-phone">Phone number</label>
            <input type="tel" id="ac-phone" name="phone" placeholder="+919876543210" autocomplete="off" required />
            <div class="help" id="ac-detect-hint">International format with country code. Type the phone to auto-detect customer type.</div>
          </div>

          <div class="ac-section">
            <label class="ac-toggle-row">
              <input type="checkbox" id="ac-startFresh" name="startFresh" checked />
              <div>
                <div class="ac-toggle-title">Start fresh — AI ignores all messages before this point</div>
                <div class="ac-toggle-sub">Useful for resetting after an off-topic history. The dashboard still shows the full WhatsApp thread, but the AI's context starts from now.</div>
              </div>
            </label>
          </div>

          <div class="ac-section">
            <label class="ac-toggle-row">
              <input type="checkbox" id="ac-sendIntro" name="sendIntro" checked />
              <div>
                <div class="ac-toggle-title">Send an intro message right now</div>
                <div class="ac-toggle-sub">Goes out via Periskope from your number. Template auto-picked from <strong>Tune AI → Templates</strong> based on detected type.</div>
              </div>
            </label>
            <div class="field" id="ac-intro-wrap">
              <textarea id="ac-introMessage" name="introMessage" rows="6"></textarea>
            </div>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <span id="ac-status" class="status"></span>
        <button type="button" class="btn-ghost btn" id="ac-cancel">Cancel</button>
        <button type="submit" form="ac-form" class="btn">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  const openBtn = document.getElementById('add-customer-btn');
  if (openBtn) openBtn.addEventListener('click', openModal);
  modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
  document.getElementById('ac-close').addEventListener('click', closeModal);
  document.getElementById('ac-cancel').addEventListener('click', closeModal);
  document.getElementById('ac-form').addEventListener('submit', onSave);
  document.getElementById('ac-sendIntro').addEventListener('change', refreshIntroVisible);
  document.getElementById('ac-phone').addEventListener('input', onPhoneChange);
}

async function openModal() {
  document.getElementById('ac-form').reset();
  document.getElementById('ac-startFresh').checked = true;
  document.getElementById('ac-sendIntro').checked = true;
  document.getElementById('ac-status').textContent = '';
  document.getElementById('ac-detect-hint').textContent = 'International format with country code. Type the phone to auto-detect customer type.';
  detectedType = null;

  try {
    if (!getCachedGlobalConfig()) await loadGlobalConfig();
  } catch {}
  pickIntroTemplate(null);
  refreshIntroVisible();
  modalEl.classList.add('open');
  setTimeout(() => document.getElementById('ac-name').focus(), 50);
}

function closeModal() {
  modalEl.classList.remove('open');
  if (detectDebounce) { clearTimeout(detectDebounce); detectDebounce = null; }
}

function refreshIntroVisible() {
  const checked = document.getElementById('ac-sendIntro').checked;
  document.getElementById('ac-intro-wrap').hidden = !checked;
}

function onPhoneChange() {
  if (detectDebounce) clearTimeout(detectDebounce);
  detectDebounce = setTimeout(detectType, 500);
}

async function detectType() {
  const raw = document.getElementById('ac-phone').value;
  const phone = normalizePhoneInput(raw);
  const hintEl = document.getElementById('ac-detect-hint');
  if (!phone || phone.length < 8) {
    hintEl.textContent = 'International format with country code. Type the phone to auto-detect customer type.';
    detectedType = null;
    pickIntroTemplate(null);
    return;
  }
  try {
    const isFerra = await isPhoneInFerraExport(phone);
    detectedType = isFerra ? 'ferra' : 'gym';
    hintEl.textContent = isFerra
      ? `Detected: Ferra customer (phone is in the workout export) — using Ferra intro.`
      : `Detected: Gym / other customer (phone is NOT in the Ferra export) — using Gym intro.`;
    pickIntroTemplate(detectedType);
  } catch (err) {
    hintEl.textContent = `Detection failed: ${err.message}. Using Ferra intro as fallback.`;
    pickIntroTemplate('ferra');
  }
}

function pickIntroTemplate(type) {
  const cfg = getCachedGlobalConfig();
  const ferraTmpl = cfg?.introMessageFerra || DEFAULT_INTRO_MESSAGE_FERRA;
  const gymTmpl = cfg?.introMessageGym || DEFAULT_INTRO_MESSAGE_GYM;
  const intro = type === 'gym' ? gymTmpl : ferraTmpl;
  const ta = document.getElementById('ac-introMessage');
  // Only overwrite if user hasn't edited
  if (!ta.dataset.userEdited) ta.value = intro;
  if (!ta._listenerAttached) {
    ta.addEventListener('input', () => { ta.dataset.userEdited = '1'; });
    ta._listenerAttached = true;
  }
}

async function onSave(e) {
  e.preventDefault();
  const f = e.target;
  const name = f.name.value;
  const phone = f.phone.value;
  const startFresh = f.startFresh.checked;
  const sendIntro = f.sendIntro.checked;
  const introMessage = (f.introMessage.value || '').trim();
  const status = document.getElementById('ac-status');

  let normPhone;
  try {
    normPhone = addCustomer({ phone, name });
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  status.textContent = `Added ${normPhone}. Saving config…`;
  const now = Date.now();

  const configPatch = {};
  if (startFresh) configPatch.conversationStartTs = now;
  if (detectedType === 'ferra' || detectedType === 'gym') configPatch.customerType = detectedType;
  if (Object.keys(configPatch).length) {
    try {
      await writeConfig(normPhone, configPatch);
    } catch (err) {
      console.error('writeConfig failed:', err);
    }
  }

  if (sendIntro && introMessage) {
    status.textContent = 'Sending intro message…';
    try {
      await sendMessage(phoneToChatId(normPhone), introMessage);
      await writeConfig(normPhone, {
        lastOutboundAt: Date.now(),
        outboundCountDate: istDateStrToday(),
        outboundCountToday: 1,
      });
      await logActivity(normPhone, {
        direction: 'outbound', source: 'manual', action: 'intro-sent',
        message: introMessage,
      });
      status.textContent = `Done. Intro sent to ${normPhone}.`;
    } catch (err) {
      status.textContent = `Customer added, but intro send failed: ${err.message}`;
    }
  } else {
    status.textContent = `Added ${normPhone}.`;
  }

  // Reset edit flag for next use
  const ta = document.getElementById('ac-introMessage');
  delete ta.dataset.userEdited;

  listeners.forEach(fn => { try { fn(); } catch (err) { console.error(err); } });
  setTimeout(closeModal, 700);
}

function istDateStrToday() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60000);
  return ist.toISOString().slice(0, 10);
}
