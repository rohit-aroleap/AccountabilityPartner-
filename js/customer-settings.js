import { readConfig, writeConfig, subscribeActivity } from './firebase-db.js';
import { SAFETY, checkOutboundSafety } from './safety.js';

const DEFAULT_CONFIG = {
  autoCoachMode: 'off',
  sendTimeIST: '08:00',
  paused: false,
  notes: '',
};

let modalEl;
let currentPhone = null;
let currentConfig = null;
let activityUnsub = null;
const listeners = new Set();

export function onConfigChanged(fn) {
  listeners.add(fn);
}

export function initCustomerSettings() {
  modalEl = document.createElement('div');
  modalEl.id = 'customer-settings-modal';
  modalEl.className = 'modal';
  modalEl.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="cs-title">Customer settings</h2>
        <button class="icon-btn" id="cs-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <form id="cs-form">
          <div class="field">
            <label>AI mode</label>
            <div class="radio-group">
              <label><input type="radio" name="autoCoachMode" value="off" /> Off — no AI</label>
              <label><input type="radio" name="autoCoachMode" value="draft-only" /> Draft-only — AI drafts, you approve & send</label>
              <label><input type="radio" name="autoCoachMode" value="auto-send" /> Auto-send — AI sends without approval</label>
            </div>
          </div>
          <div class="field field-row">
            <div>
              <label for="cs-sendTime">Morning check-in time (IST)</label>
              <input type="time" id="cs-sendTime" name="sendTimeIST" />
            </div>
            <div>
              <label for="cs-paused">Pause all sends</label>
              <input type="checkbox" id="cs-paused" name="paused" class="toggle" />
            </div>
          </div>
          <div class="field">
            <label for="cs-notes">Notes (private to you)</label>
            <textarea id="cs-notes" name="notes" rows="2" placeholder="e.g., shoulder injury, prefers evenings"></textarea>
          </div>
        </form>

        <div class="cs-section">
          <h3>Status</h3>
          <div id="cs-status" class="cs-status"></div>
        </div>

        <div class="cs-section">
          <h3>Recent activity</h3>
          <div id="cs-activity" class="cs-activity">Loading…</div>
        </div>
      </div>
      <div class="modal-footer">
        <span id="cs-save-status" class="status"></span>
        <button type="button" class="btn-ghost btn" id="cs-cancel">Close</button>
        <button type="submit" form="cs-form" class="btn" id="cs-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
  document.getElementById('cs-close').addEventListener('click', closeModal);
  document.getElementById('cs-cancel').addEventListener('click', closeModal);
  document.getElementById('cs-form').addEventListener('submit', onSave);
}

export async function openCustomerSettings(customer) {
  currentPhone = customer.phone;
  document.getElementById('cs-title').textContent = `Settings — ${customer.name || customer.phone}`;
  const saved = await readConfig(customer.phone);
  currentConfig = { ...DEFAULT_CONFIG, ...(saved || {}) };
  hydrateForm();
  renderStatus();
  if (activityUnsub) activityUnsub();
  activityUnsub = subscribeActivity(customer.phone, 20, renderActivity);
  modalEl.classList.add('open');
}

function closeModal() {
  modalEl.classList.remove('open');
  if (activityUnsub) { activityUnsub(); activityUnsub = null; }
  document.getElementById('cs-save-status').textContent = '';
}

function hydrateForm() {
  const f = document.getElementById('cs-form');
  for (const r of f.elements.autoCoachMode) {
    r.checked = r.value === currentConfig.autoCoachMode;
  }
  f.sendTimeIST.value = currentConfig.sendTimeIST || '08:00';
  f.paused.checked = !!currentConfig.paused;
  f.notes.value = currentConfig.notes || '';
}

async function onSave(e) {
  e.preventDefault();
  const f = e.target;
  const patch = {
    autoCoachMode: f.autoCoachMode.value,
    sendTimeIST: f.sendTimeIST.value || '08:00',
    paused: f.paused.checked,
    notes: f.notes.value,
  };
  try {
    await writeConfig(currentPhone, patch);
    currentConfig = { ...currentConfig, ...patch };
    document.getElementById('cs-save-status').textContent = 'Saved.';
    renderStatus();
    listeners.forEach(fn => { try { fn(currentPhone, currentConfig); } catch {} });
    setTimeout(() => { document.getElementById('cs-save-status').textContent = ''; }, 1500);
  } catch (err) {
    document.getElementById('cs-save-status').textContent = `Failed: ${err.message}`;
  }
}

function renderStatus() {
  const el = document.getElementById('cs-status');
  const safety = checkOutboundSafety(currentConfig);
  const parts = [];
  const mode = currentConfig.autoCoachMode || 'off';
  parts.push(`<div><strong>Mode:</strong> ${escapeHtml(mode)}</div>`);
  if (currentConfig.lastOutboundAt) {
    const d = new Date(currentConfig.lastOutboundAt);
    parts.push(`<div><strong>Last sent:</strong> ${d.toLocaleString()}</div>`);
  }
  if (currentConfig.outboundCountDate && currentConfig.outboundCountToday) {
    parts.push(`<div><strong>Sent today (IST):</strong> ${currentConfig.outboundCountToday} of ${SAFETY.maxOutboundPerDay}</div>`);
  }
  if (safety.blocks.length) {
    parts.push(`<div class="cs-block">Blocked: ${safety.blocks.map(escapeHtml).join(', ')}</div>`);
  }
  if (safety.warnings.length) {
    parts.push(`<div class="cs-warn">Warnings: ${safety.warnings.map(escapeHtml).join(', ')}</div>`);
  }
  el.innerHTML = parts.join('');
}

function renderActivity(events) {
  const el = document.getElementById('cs-activity');
  if (!events.length) {
    el.innerHTML = `<div class="cs-empty">No activity yet.</div>`;
    return;
  }
  el.innerHTML = events.map(e => {
    const ts = new Date(e.ts);
    const time = ts.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tag = `${e.direction || ''}${e.source ? ` · ${e.source}` : ''}${e.action ? ` · ${e.action}` : ''}`;
    const body = e.message ? `<div class="ev-msg">${escapeHtml(truncate(e.message, 160))}</div>` : '';
    const err = e.error ? `<div class="ev-err">${escapeHtml(e.error)}</div>` : '';
    return `
      <div class="ev">
        <div class="ev-top"><span class="ev-time">${escapeHtml(time)}</span><span class="ev-tag">${escapeHtml(tag)}</span></div>
        ${body}${err}
      </div>
    `;
  }).join('');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
