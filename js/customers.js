import { loadSettings, parseCustomerPhones, getCustomerName, removeCustomer } from './storage.js';
import { loadWorkoutData, normalizePhone, getRecentDailyActivity } from './workout.js';
import { openChatFor, closeChat } from './chat.js';

const els = {};
let allCustomers = [];

export function initCustomers() {
  els.list = document.querySelector('.customer-list');
  els.chatPane = document.querySelector('.chat-pane');
  refresh();
}

export async function refresh() {
  closeChat();
  els.chatPane.innerHTML = `
    <div class="empty-chat">
      <h2>Pick a customer to start a conversation</h2>
      <p>Messages send via Periskope through your Worker proxy.</p>
    </div>
  `;

  const { workerUrl, customerPhonesRaw } = loadSettings();
  const phones = parseCustomerPhones(customerPhonesRaw);

  if (!workerUrl) {
    renderEmpty('Configure the Worker URL in settings.');
    return;
  }
  if (phones.length === 0) {
    renderEmpty('Add customer phone numbers in settings.');
    return;
  }

  renderEmpty('Loading customers…');

  try {
    const idx = await loadWorkoutData();
    allCustomers = phones.map(p => buildRow(idx, p));
    renderList(allCustomers);
  } catch (err) {
    renderEmpty(`Failed to load: ${err.message}`);
  }
}

function buildRow(idx, phone) {
  const customName = getCustomerName(phone);
  const user = idx.byPhone.get(normalizePhone(phone));
  if (!user) {
    return { phone, found: false, name: customName || '' };
  }
  const recent = getRecentDailyActivity(idx, user.uid, 1);
  return {
    phone,
    found: true,
    uid: user.uid,
    name: customName || user.name || phone,
    habitScore: user.habitScore,
    tierLabel: user.tierLabel,
    segment: user.segment,
    lastActiveDate: user.lastActiveDate,
    daysSinceLastSession: user.daysSinceLastSession,
    streak: user.streak,
    todayExercises: recent[0]?.exerciseCount ?? 0,
  };
}

function renderEmpty(msg) {
  els.list.innerHTML = `<div class="empty-list">${escapeHtml(msg)}</div>`;
}

function renderList(rows) {
  if (rows.length === 0) {
    renderEmpty('No customers to show.');
    return;
  }
  els.list.innerHTML = rows.map(rowHtml).join('');
  els.list.querySelectorAll('.cust-row').forEach(el => {
    el.addEventListener('click', () => onSelect(el.dataset.phone));
  });
}

function rowHtml(c) {
  if (!c.found) {
    const displayName = c.name || c.phone;
    const initial = (c.name || '?').trim().charAt(0).toUpperCase() || '?';
    const avatarCls = c.name ? 'avatar' : 'avatar avatar-missing';
    return `
      <div class="cust-row" data-phone="${escapeAttr(c.phone)}">
        <div class="${avatarCls}">${escapeHtml(initial)}</div>
        <div class="cust-body">
          <div class="cust-top">
            <span class="cust-name">${escapeHtml(displayName)}</span>
          </div>
          <div class="cust-sub"><span class="cust-segment">${escapeHtml(c.name ? c.phone + ' · no workout history yet' : 'No workout history yet')}</span></div>
        </div>
      </div>
    `;
  }
  const initial = (c.name || '?').trim().charAt(0).toUpperCase();
  const score = Math.round(c.habitScore ?? 0);
  const last = c.lastActiveDate || '—';
  const sub = c.daysSinceLastSession === 0
    ? 'Active today'
    : c.daysSinceLastSession > 900
      ? 'Never active'
      : `${c.daysSinceLastSession}d ago • ${c.segment || ''}`;
  return `
    <div class="cust-row" data-phone="${escapeAttr(c.phone)}">
      <div class="avatar">${escapeHtml(initial)}</div>
      <div class="cust-body">
        <div class="cust-top">
          <span class="cust-name">${escapeHtml(c.name)}</span>
          <span class="cust-meta">${escapeHtml(last)}</span>
        </div>
        <div class="cust-sub">
          <span class="badge">${score}</span>
          <span class="cust-segment">${escapeHtml(sub)}</span>
        </div>
      </div>
    </div>
  `;
}

function onSelect(phone) {
  els.list.querySelectorAll('.cust-row').forEach(el => {
    el.classList.toggle('active', el.dataset.phone === phone);
  });
  const c = allCustomers.find(x => x.phone === phone);
  if (!c) return;
  openChatFor(c);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}
