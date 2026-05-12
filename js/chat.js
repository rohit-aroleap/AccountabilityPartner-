import { phoneToChatId, listMessages, sendMessage } from './periskope.js';
import { generateMessage } from './anthropic.js';
import { buildDraftPrompt, getSystemForCustomer } from './prompt.js';
import { loadSettings } from './storage.js';
import { readConfig, writeConfig, logActivity, subscribePendingDraft, clearPendingDraft, subscribeWebhookEventsForChat, addScheduledReminder } from './firebase-db.js';
import { ref, get, query, limitToLast } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { db, ROOT_PATH } from './firebase-init.js';

async function loadRecentWorkoutLog(phone) {
  const key = String(phone).replace(/[^\d]/g, '');
  try {
    const r = query(ref(db, `${ROOT_PATH}/customers/${key}/workoutLog`), limitToLast(20));
    const snap = await get(r);
    const out = [];
    snap.forEach(child => { out.push({ id: child.key, ...child.val() }); });
    return out.reverse();
  } catch {
    return [];
  }
}
import { checkOutboundSafety, nextOutboundCount, istDateStr } from './safety.js';
import { openCustomerSettings } from './customer-settings.js';

const els = {};
let activeChatId = null;
let activeCustomer = null;
let currentMessages = [];
let pollTimer = null;
let pendingDraftUnsub = null;
let webhookEventsUnsub = null;
let activePendingDraft = null;
let webhookEventsByMessageId = new Map();

export function initChat() {
  els.pane = document.querySelector('.chat-pane');
  els.pane.addEventListener('click', onPaneClick);
}

function onPaneClick(e) {
  const badge = e.target.closest('.ai-badge');
  if (!badge) return;
  const bubble = badge.closest('.bubble');
  showAiBadgeDetails(bubble?.dataset.messageId);
}

function showAiBadgeDetails(messageId) {
  if (!messageId) {
    alert('No message id on this bubble.');
    return;
  }
  const ev = webhookEventsByMessageId.get(messageId);
  if (!ev) {
    alert(
      `No webhook event recorded for this message.\n\n` +
      `Possible reasons:\n` +
      `  • Periskope hasn't delivered the webhook yet (wait ~10s)\n` +
      `  • The message was sent before the webhook was set up\n` +
      `  • Webhook URL is misconfigured on Periskope's side`
    );
    return;
  }
  const lines = [
    `Webhook delivered at ${new Date(ev.ts).toLocaleString()}`,
    ``,
    `event field: ${ev.event || '(missing)'}`,
    `chat_id: ${ev.chat_id || ''}`,
    `message_id: ${ev.message_id || ''}`,
    `from_me: ${ev.from_me}`,
    `message_type: ${ev.message_type || '(missing)'}`,
    ``,
    `Decision:`,
    JSON.stringify(ev.result || {}, null, 2),
    ``,
    `Raw payload (first 2000 chars):`,
    ev.raw || '(not captured — only logged from worker v1.015+)',
  ];
  alert(lines.join('\n'));
}

export async function openChatFor(customer) {
  stopPolling();
  if (pendingDraftUnsub) { pendingDraftUnsub(); pendingDraftUnsub = null; }
  if (webhookEventsUnsub) { webhookEventsUnsub(); webhookEventsUnsub = null; }
  activeCustomer = customer;
  activeChatId = phoneToChatId(customer.phone);
  currentMessages = [];
  activePendingDraft = null;
  webhookEventsByMessageId = new Map();
  renderShell(customer);
  await refreshMessages({ scroll: true });
  startPolling();
  pendingDraftUnsub = subscribePendingDraft(customer.phone, onPendingDraftChange);
  webhookEventsUnsub = subscribeWebhookEventsForChat(activeChatId, 50, onWebhookEventsChange);
}

export function closeChat() {
  stopPolling();
  if (pendingDraftUnsub) { pendingDraftUnsub(); pendingDraftUnsub = null; }
  if (webhookEventsUnsub) { webhookEventsUnsub(); webhookEventsUnsub = null; }
  activeChatId = null;
  activeCustomer = null;
  currentMessages = [];
  activePendingDraft = null;
  webhookEventsByMessageId = new Map();
}

function renderShell(c) {
  const initial = c.found
    ? (c.name || c.phone || '?').trim().charAt(0).toUpperCase()
    : '?';
  const avatarCls = c.found ? 'avatar' : 'avatar avatar-missing';
  const sub = c.found
    ? `Habit ${Math.round(c.habitScore ?? 0)} • ${escapeHtml(c.tierLabel || '')} • Last ${escapeHtml(c.lastActiveDate || '—')}`
    : `${escapeHtml(c.phone)} • No workout history yet`;
  els.pane.innerHTML = `
    <div class="chat">
      <header class="chat-header">
        <div class="${avatarCls}">${escapeHtml(initial)}</div>
        <div class="chat-header-info">
          <div class="chat-header-name">${escapeHtml(c.name || c.phone)}</div>
          <div class="chat-header-sub">${sub}</div>
        </div>
        <button class="icon-btn" id="chat-settings" title="Customer settings">&#9881;</button>
        <button class="icon-btn" id="chat-refresh" title="Refresh">&#x21bb;</button>
      </header>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-status">Loading messages…</div>
      </div>
      <div id="pending-draft-banner" class="pending-draft" hidden></div>
      <form class="chat-composer" id="chat-composer">
        <div class="draft-btns">
          <button type="button" class="draft-btn coach" id="chat-draft-coach" title="Coach: workout accountability (Ctrl/Cmd+J)">&#x1F4AA;</button>
          <button type="button" class="draft-btn" id="chat-draft-reply" title="Reply: natural continuation">&#x1F4AC;</button>
          <button type="button" class="draft-btn" id="chat-remind-later" title="Schedule a reminder for later">&#x23F0;</button>
        </div>
        <textarea
          id="chat-input"
          placeholder="Type a message, or click 💪 / 💬 to draft with AI…"
          rows="1"
          autocomplete="off"
        ></textarea>
        <button type="submit" class="btn" id="chat-send">Send</button>
      </form>
      <div class="remind-popover" id="remind-popover" hidden>
        <div class="rp-title">Schedule a reminder</div>
        <div class="rp-presets">
          <button type="button" class="rp-preset" data-preset="3h">In 3 hours</button>
          <button type="button" class="rp-preset" data-preset="evening">This evening (7 PM)</button>
          <button type="button" class="rp-preset" data-preset="tomorrow-am">Tomorrow morning (8 AM)</button>
          <button type="button" class="rp-preset" data-preset="tomorrow-pm">Tomorrow evening (7 PM)</button>
          <button type="button" class="rp-preset" data-preset="custom">Custom…</button>
        </div>
        <div class="rp-custom" id="rp-custom" hidden>
          <input type="datetime-local" id="rp-when" />
        </div>
        <div class="field" style="margin-top:8px;">
          <label for="rp-reason">Reason (optional)</label>
          <input type="text" id="rp-reason" placeholder="e.g., check if they trained" />
        </div>
        <div class="rp-actions">
          <button type="button" class="btn-ghost btn" id="rp-cancel">Cancel</button>
          <button type="button" class="btn" id="rp-save">Schedule</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('chat-refresh').addEventListener('click', () => refreshMessages({ scroll: true }));
  document.getElementById('chat-settings').addEventListener('click', () => openCustomerSettings(c));
  document.getElementById('chat-composer').addEventListener('submit', onSend);
  document.getElementById('chat-draft-coach').addEventListener('click', () => onDraft('coach'));
  document.getElementById('chat-draft-reply').addEventListener('click', () => onDraft('reply'));
  document.getElementById('chat-remind-later').addEventListener('click', openRemindPopover);
  document.getElementById('rp-cancel').addEventListener('click', closeRemindPopover);
  document.getElementById('rp-save').addEventListener('click', saveReminder);
  document.querySelectorAll('.rp-preset').forEach(btn => {
    btn.addEventListener('click', () => selectPreset(btn.dataset.preset));
  });
  const input = document.getElementById('chat-input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('chat-composer').requestSubmit();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      onDraft('coach');
    }
  });
}

function onPendingDraftChange(draft) {
  activePendingDraft = draft;
  const banner = document.getElementById('pending-draft-banner');
  const input = document.getElementById('chat-input');
  if (!banner || !input) return;

  if (!draft) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const when = new Date(draft.ts);
  const timeStr = when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  banner.hidden = false;
  banner.innerHTML = `
    <span class="pd-label">🤖 AI draft from ${escapeHtml(draft.source || 'cron')} · ${escapeHtml(timeStr)}${draft.reason ? ' · ' + escapeHtml(draft.reason) : ''}</span>
    <button type="button" class="pd-discard" id="pd-discard">Discard</button>
  `;
  document.getElementById('pd-discard').addEventListener('click', discardPendingDraft);

  if (!input.value.trim()) {
    input.value = draft.message || '';
    autosize.call(input);
  }
}

async function discardPendingDraft() {
  if (!activeCustomer || !activePendingDraft) return;
  const draft = activePendingDraft;
  try {
    await clearPendingDraft(activeCustomer.phone);
    await logActivity(activeCustomer.phone, {
      direction: 'system',
      source: 'manual',
      action: 'draft-discarded',
      message: draft.message,
    });
    const input = document.getElementById('chat-input');
    if (input && input.value.trim() === (draft.message || '').trim()) {
      input.value = '';
      autosize.call(input);
    }
  } catch (err) {
    showError(`Discard failed: ${err.message}`);
  }
}

async function refreshMessages({ scroll = false } = {}) {
  if (!activeChatId) return;
  const container = document.getElementById('chat-messages');
  try {
    const [data, config] = await Promise.all([
      listMessages(activeChatId, { limit: 100, offset: 0 }),
      readConfig(activeCustomer.phone).catch(() => null),
    ]);
    const messages = (data.messages || []).slice().sort((a, b) => {
      return parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp);
    });
    currentMessages = messages;
    if (messages.length === 0) {
      container.innerHTML = `<div class="chat-status">No messages yet.</div>`;
      return;
    }
    const startTs = config?.conversationStartTs || 0;
    const html = [];
    let dividerInserted = false;
    for (const m of messages) {
      if (startTs && !dividerInserted && parseTimestamp(m.timestamp) >= startTs) {
        html.push(renderDivider(startTs));
        dividerInserted = true;
      }
      html.push(renderBubble(m));
    }
    if (startTs && !dividerInserted) {
      html.push(renderDivider(startTs));
    }
    container.innerHTML = html.join('');
    if (scroll) container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = `<div class="chat-status error">${escapeHtml(err.message)}</div>`;
  }
}

let selectedPreset = null;

function openRemindPopover() {
  selectedPreset = null;
  const pop = document.getElementById('remind-popover');
  document.getElementById('rp-custom').hidden = true;
  document.getElementById('rp-reason').value = '';
  document.querySelectorAll('.rp-preset').forEach(b => b.classList.remove('active'));
  pop.hidden = false;
}

function closeRemindPopover() {
  document.getElementById('remind-popover').hidden = true;
}

function selectPreset(preset) {
  selectedPreset = preset;
  document.querySelectorAll('.rp-preset').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === preset);
  });
  document.getElementById('rp-custom').hidden = preset !== 'custom';
}

async function saveReminder() {
  if (!activeCustomer) return;
  const reason = document.getElementById('rp-reason').value.trim() || 'manual reminder';
  let fireAt;
  const now = new Date();
  if (selectedPreset === '3h') {
    fireAt = now.getTime() + 3 * 60 * 60 * 1000;
  } else if (selectedPreset === 'evening') {
    const d = new Date(now); d.setHours(19, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    fireAt = d.getTime();
  } else if (selectedPreset === 'tomorrow-am') {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0);
    fireAt = d.getTime();
  } else if (selectedPreset === 'tomorrow-pm') {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(19, 0, 0, 0);
    fireAt = d.getTime();
  } else if (selectedPreset === 'custom') {
    const v = document.getElementById('rp-when').value;
    if (!v) { alert('Pick a date and time.'); return; }
    fireAt = new Date(v).getTime();
    if (fireAt <= now.getTime()) { alert('Pick a time in the future.'); return; }
  } else {
    alert('Pick a preset.');
    return;
  }
  try {
    await addScheduledReminder(activeCustomer.phone, {
      fireAt, reason, source: 'manual',
    });
    closeRemindPopover();
  } catch (err) {
    alert(`Schedule failed: ${err.message}`);
  }
}

function renderDivider(ts) {
  const d = new Date(ts);
  const label = `AI context starts here · ${d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  return `<div class="chat-divider"><span>${escapeHtml(label)}</span></div>`;
}

function renderBubble(m) {
  const cls = m.from_me ? 'out' : 'in';
  const ts = formatTime(m.timestamp);
  const body = m.body || mediaLabel(m);
  const aiBadge = m.from_me ? '' : renderAiBadge(m.message_id);
  return `
    <div class="bubble ${cls}" data-message-id="${escapeAttr(m.message_id || '')}">
      <div class="bubble-text">${escapeHtml(body)}</div>
      <div class="bubble-meta">${escapeHtml(ts)}</div>
      ${aiBadge}
    </div>
  `;
}

function renderAiBadge(messageId) {
  if (!messageId) return '';
  const ev = webhookEventsByMessageId.get(messageId);
  if (!ev) return `<div class="ai-badge pending" title="No AI decision recorded yet">AI: …</div>`;

  const r = ev.result || {};
  let cls = 'idle', text = 'AI: —', tooltip = '';
  if (r.error || ev.error) {
    cls = 'err';
    text = `AI: error`;
    tooltip = r.error || ev.error;
  } else if (r.acted === 'sent') {
    cls = 'ok'; text = 'AI: ✓ replied'; tooltip = 'Auto-sent via Periskope';
  } else if (r.acted === 'drafted') {
    cls = 'ok'; text = 'AI: drafted'; tooltip = 'Draft queued — review in composer';
  } else if (r.acted === 'auto-paused') {
    cls = 'warn'; text = 'AI: paused customer'; tooltip = 'Opt-out keyword detected';
  } else if (r.ignored === 'wrong-event') {
    cls = 'skip';
    const got = r.got || ev.event || '(missing)';
    text = `AI: skip · wrong-event (${got})`;
    tooltip = `Periskope delivered event "${got}" — webhook handler only acts on "message.created". This usually means Periskope is also pushing message.updated/ack events to the same URL.`;
  } else if (r.ignored) {
    cls = 'skip'; text = `AI: skip · ${r.ignored}`; tooltip = explainSkip(r.ignored);
  } else {
    cls = 'idle'; text = 'AI: no action';
  }
  return `<div class="ai-badge ${cls}" title="${escapeAttr(tooltip)}">${escapeHtml(text)}</div>`;
}

function explainSkip(reason) {
  const map = {
    'mode-off': 'Customer AI mode is off — turn on Draft-only or Auto-send in ⚙',
    'paused': 'Customer is paused (manual or auto-opt-out)',
    'no-config-for-customer': 'No Firebase config for this phone — open ⚙ and Save once',
    'daily-cap': 'Already sent 3 messages to this customer today',
    'quiet-hours': 'Inbound arrived during quiet hours (21:00–08:00 IST)',
    'max-auto-turns': 'Already replied 4 times this session',
    'duplicate': 'Same message_id already processed',
    'group-chat': 'Group chats are ignored',
    'outbound': 'Message was sent by you (not customer)',
    'wrong-event': 'Webhook event type was not message.created',
  };
  return map[reason] || reason;
}

function onWebhookEventsChange(map) {
  webhookEventsByMessageId = map;
  // Re-render badges in-place without scrolling
  document.querySelectorAll('.bubble.in[data-message-id]').forEach(el => {
    const id = el.dataset.messageId;
    if (!id) return;
    const oldBadge = el.querySelector('.ai-badge');
    const newHtml = renderAiBadge(id);
    if (oldBadge) oldBadge.outerHTML = newHtml;
    else el.insertAdjacentHTML('beforeend', newHtml);
  });
}

function mediaLabel(m) {
  if (m.media?.type) return `[${m.media.type}]`;
  if (m.message_type && m.message_type !== 'chat') return `[${m.message_type}]`;
  return '';
}

async function onSend(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send');
  const text = input.value.trim();
  if (!text || !activeChatId || !activeCustomer) return;

  const phone = activeCustomer.phone;
  const config = (await readConfig(phone)) || {};
  const safety = checkOutboundSafety(config);

  if (!safety.ok) {
    const proceed = confirm(`Safety blocks:\n  • ${safety.blocks.join('\n  • ')}\n\nSend anyway?`);
    if (!proceed) return;
  } else if (safety.warnings.length) {
    const proceed = confirm(`Heads-up:\n  • ${safety.warnings.join('\n  • ')}\n\nSend?`);
    if (!proceed) return;
  }

  const wasDraftApproval = activePendingDraft && (activePendingDraft.message || '').trim() === text;

  btn.disabled = true;
  try {
    await sendMessage(activeChatId, text);
    await Promise.all([
      writeConfig(phone, {
        lastOutboundAt: Date.now(),
        outboundCountDate: istDateStr(),
        outboundCountToday: nextOutboundCount(config),
      }),
      logActivity(phone, {
        direction: 'outbound',
        source: wasDraftApproval ? 'approved' : 'manual',
        action: wasDraftApproval ? 'approved-draft-sent' : 'sent',
        message: text,
      }),
    ]).catch(err => console.warn('Activity log failed:', err));
    if (activePendingDraft) await clearPendingDraft(phone).catch(() => {});
    input.value = '';
    autosize.call(input);
    setTimeout(() => refreshMessages({ scroll: true }), 800);
  } catch (err) {
    logActivity(phone, { direction: 'outbound', source: 'manual', action: 'send-failed', error: err.message }).catch(() => {});
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function onDraft(mode) {
  if (!activeCustomer) return;
  const input = document.getElementById('chat-input');
  const coachBtn = document.getElementById('chat-draft-coach');
  const replyBtn = document.getElementById('chat-draft-reply');
  const sendBtn = document.getElementById('chat-send');
  const intent = input.value.trim();
  const activeBtn = mode === 'coach' ? coachBtn : replyBtn;

  coachBtn.disabled = true;
  replyBtn.disabled = true;
  sendBtn.disabled = true;
  activeBtn.classList.add('busy');
  const previousValue = input.value;
  input.value = '';
  input.placeholder = mode === 'coach' ? 'Coaching…' : 'Drafting reply…';

  try {
    const { anthropicModel } = loadSettings();
    const config = (await readConfig(activeCustomer.phone)) || {};
    const workoutLog = await loadRecentWorkoutLog(activeCustomer.phone);
    const userPrompt = await buildDraftPrompt(activeCustomer, currentMessages, { intent, mode, config, workoutLog });
    const draft = await generateMessage({
      system: getSystemForCustomer(activeCustomer, mode, config),
      userPrompt,
      model: anthropicModel,
      maxTokens: 600,
    });
    input.value = draft || previousValue;
    autosize.call(input);
    input.focus();
    logActivity(activeCustomer.phone, {
      direction: 'system',
      source: 'manual',
      action: `drafted-${mode}`,
      message: draft,
    }).catch(() => {});
  } catch (err) {
    input.value = previousValue;
    showError(err.message);
    logActivity(activeCustomer.phone, {
      direction: 'system',
      source: 'manual',
      action: `draft-${mode}-failed`,
      error: err.message,
    }).catch(() => {});
  } finally {
    coachBtn.disabled = false;
    replyBtn.disabled = false;
    sendBtn.disabled = false;
    activeBtn.classList.remove('busy');
    input.placeholder = 'Type a message, or click 💪 / 💬 to draft with AI…';
  }
}

function showError(msg) {
  const container = document.getElementById('chat-messages');
  const banner = document.createElement('div');
  banner.className = 'chat-status error';
  banner.textContent = msg;
  container.appendChild(banner);
  container.scrollTop = container.scrollHeight;
}

function autosize() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
}

function startPolling() {
  pollTimer = setInterval(() => refreshMessages({ scroll: false }), 20_000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function parseTimestamp(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const asNum = Number(ts);
  if (!Number.isNaN(asNum) && asNum > 0) return asNum < 1e12 ? asNum * 1000 : asNum;
  const d = Date.parse(ts);
  return Number.isNaN(d) ? 0 : d;
}

function formatTime(ts) {
  const ms = parseTimestamp(ts);
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
