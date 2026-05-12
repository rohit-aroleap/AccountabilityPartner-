import { readConfig, writeConfig, subscribeActivity, subscribeWorkoutLog, subscribeScheduledReminders, cancelScheduledReminder } from './firebase-db.js';
import { SAFETY, checkOutboundSafety } from './safety.js';
import { isPhoneInFerraExport } from './workout.js';

const DEFAULT_CONFIG = {
  autoCoachMode: 'off',
  sendTimeIST: '08:00',
  paused: false,
  notes: '',
  customerType: '',
  weeklyGoal: 3,
  conversationStartTs: 0,
};

let modalEl;
let currentPhone = null;
let currentConfig = null;
let activityUnsub = null;
let workoutLogUnsub = null;
let remindersUnsub = null;
let autoDetectedType = '';
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
            <label for="cs-type">Customer type</label>
            <select id="cs-type" name="customerType">
              <option value="">Auto-detect</option>
              <option value="ferra">Ferra (uses the machine)</option>
              <option value="gym">Gym / other (online accountability only)</option>
            </select>
            <div class="help" id="cs-type-hint"></div>
          </div>
          <div class="field" id="cs-weekly-goal-field" hidden>
            <label for="cs-weeklyGoal">Weekly workout goal</label>
            <input type="number" id="cs-weeklyGoal" name="weeklyGoal" min="1" max="14" value="3" />
            <div class="help">Number of sessions per week this customer is aiming for. AI references this in every nudge.</div>
          </div>

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
          <div class="field">
            <label for="cs-conversationStart">Conversation start date (AI ignores messages before this)</label>
            <input type="datetime-local" id="cs-conversationStart" name="conversationStart" />
            <div class="help">Leave blank to include the entire WhatsApp history in AI context. Set this to "reset" the AI's view after off-topic chats. Dashboard shows everything regardless.</div>
          </div>
        </form>

        <div class="cs-section">
          <h3>Status</h3>
          <div id="cs-status" class="cs-status"></div>
        </div>

        <div class="cs-section" id="cs-workout-section" hidden>
          <h3>Recent workout log <span class="cs-hint">(auto-captured from chat for gym customers)</span></h3>
          <div id="cs-workout-log" class="cs-workout-log">Loading…</div>
        </div>

        <div class="cs-section">
          <h3>Scheduled reminders <span class="cs-hint">(AI-extracted, auto-seeded, or manual)</span></h3>
          <div id="cs-reminders" class="cs-reminders">Loading…</div>
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
  document.getElementById('cs-type').addEventListener('change', onTypeChange);
}

export async function openCustomerSettings(customer) {
  currentPhone = customer.phone;
  document.getElementById('cs-title').textContent = `Settings — ${customer.name || customer.phone}`;
  const saved = await readConfig(customer.phone);
  currentConfig = { ...DEFAULT_CONFIG, ...(saved || {}) };

  autoDetectedType = (await isPhoneInFerraExport(customer.phone)) ? 'ferra' : 'gym';
  hydrateForm();
  renderStatus();
  refreshTypeUI();
  if (activityUnsub) activityUnsub();
  if (workoutLogUnsub) workoutLogUnsub();
  if (remindersUnsub) remindersUnsub();
  activityUnsub = subscribeActivity(customer.phone, 20, renderActivity);
  workoutLogUnsub = subscribeWorkoutLog(customer.phone, 20, renderWorkoutLog);
  remindersUnsub = subscribeScheduledReminders(customer.phone, 20, renderReminders);
  modalEl.classList.add('open');
}

function closeModal() {
  modalEl.classList.remove('open');
  if (activityUnsub) { activityUnsub(); activityUnsub = null; }
  if (workoutLogUnsub) { workoutLogUnsub(); workoutLogUnsub = null; }
  if (remindersUnsub) { remindersUnsub(); remindersUnsub = null; }
  document.getElementById('cs-save-status').textContent = '';
}

function hydrateForm() {
  const f = document.getElementById('cs-form');
  f.customerType.value = currentConfig.customerType || '';
  f.weeklyGoal.value = currentConfig.weeklyGoal || 3;
  for (const r of f.elements.autoCoachMode) {
    r.checked = r.value === currentConfig.autoCoachMode;
  }
  f.sendTimeIST.value = currentConfig.sendTimeIST || '08:00';
  f.paused.checked = !!currentConfig.paused;
  f.notes.value = currentConfig.notes || '';
  if (currentConfig.conversationStartTs) {
    const d = new Date(currentConfig.conversationStartTs);
    const pad = n => String(n).padStart(2, '0');
    f.conversationStart.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } else {
    f.conversationStart.value = '';
  }
}

function onTypeChange() {
  refreshTypeUI();
}

function refreshTypeUI() {
  const f = document.getElementById('cs-form');
  const selected = f.customerType.value;
  const effective = selected || autoDetectedType;
  const hint = document.getElementById('cs-type-hint');
  hint.textContent = selected
    ? `Override active — using "${selected}" prompts.`
    : `Auto-detected as "${autoDetectedType}" (phone ${autoDetectedType === 'ferra' ? 'IS' : 'is NOT'} in the Ferra workout export).`;

  const showGymFields = effective === 'gym';
  document.getElementById('cs-weekly-goal-field').hidden = !showGymFields;
  document.getElementById('cs-workout-section').hidden = !showGymFields;
}

async function onSave(e) {
  e.preventDefault();
  const f = e.target;
  const convStart = f.conversationStart.value
    ? new Date(f.conversationStart.value).getTime()
    : 0;
  const patch = {
    customerType: f.customerType.value || '',
    weeklyGoal: parseInt(f.weeklyGoal.value, 10) || 3,
    autoCoachMode: f.autoCoachMode.value,
    sendTimeIST: f.sendTimeIST.value || '08:00',
    paused: f.paused.checked,
    notes: f.notes.value,
    conversationStartTs: convStart || 0,
  };
  try {
    await writeConfig(currentPhone, patch);
    currentConfig = { ...currentConfig, ...patch };
    document.getElementById('cs-save-status').textContent = 'Saved.';
    renderStatus();
    refreshTypeUI();
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
  const type = currentConfig.customerType || `auto: ${autoDetectedType}`;
  parts.push(`<div><strong>Type:</strong> ${escapeHtml(type)}</div>`);
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

function renderReminders(entries) {
  const el = document.getElementById('cs-reminders');
  if (!entries || !entries.length) {
    el.innerHTML = `<div class="cs-empty">No scheduled reminders. AI extracts them from chat ("remind me at 6") and the daily scan seeds streak/comeback/end-of-week ones.</div>`;
    return;
  }
  el.innerHTML = entries.map(r => {
    const fire = new Date(r.fireAt || r.ts);
    const fireStr = fire.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const statusCls = r.status === 'pending' ? 'pending' : (r.status === 'sent' ? 'sent' : 'cancelled');
    const source = r.source || 'manual';
    const sentInfo = r.status === 'sent' && r.sentMessage
      ? `<div class="rem-msg">${escapeHtml(truncate(r.sentMessage, 140))}</div>` : '';
    const cancelBtn = r.status === 'pending'
      ? `<button type="button" class="rem-cancel" data-rid="${escapeAttr(r.id)}">Cancel</button>` : '';
    return `
      <div class="rem-row rem-${statusCls}">
        <div class="rem-top">
          <span class="rem-time">${escapeHtml(fireStr)}</span>
          <span class="rem-status">${escapeHtml(r.status || 'pending')} · ${escapeHtml(source)}</span>
          ${cancelBtn}
        </div>
        <div class="rem-reason">${escapeHtml(r.reason || '')}</div>
        ${sentInfo}
      </div>
    `;
  }).join('');
  el.querySelectorAll('.rem-cancel').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const rid = btn.dataset.rid;
      try {
        await cancelScheduledReminder(currentPhone, rid);
      } catch (err) {
        alert(`Cancel failed: ${err.message}`);
      }
    });
  });
}

function renderWorkoutLog(entries) {
  const el = document.getElementById('cs-workout-log');
  if (!entries || !entries.length) {
    el.innerHTML = `<div class="cs-empty">No workouts logged yet. The AI will auto-capture future reports from chat.</div>`;
    return;
  }
  el.innerHTML = entries.map(w => {
    const date = w.date || new Date(w.ts || 0).toISOString().slice(0, 10);
    const type = w.type || 'workout';
    const details = w.details ? ` — ${truncate(w.details, 80)}` : '';
    const src = w.source === 'auto-extracted' ? '<span class="wl-tag">auto</span>' : '<span class="wl-tag">manual</span>';
    return `<div class="wl-row"><span class="wl-date">${escapeHtml(date)}</span><span class="wl-type">${escapeHtml(type)}${escapeHtml(details)}</span>${src}</div>`;
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
