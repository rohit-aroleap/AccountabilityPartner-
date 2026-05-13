import { phoneToChatId, listMessages, sendMessage } from './periskope.js';
import { generateMessage } from './anthropic.js';
import { buildDraftPrompt, getSystemForCustomer } from './prompt.js';
import { loadSettings } from './storage.js';
import { readConfig, writeConfig, logActivity, subscribePendingDraft, clearPendingDraft, subscribeWebhookEventsForChat, addScheduledReminder, subscribeHoldQueueForChat, markHoldHeld, logAiRating, subscribeConfig, subscribeScheduledReminders } from './firebase-db.js';
import { getCachedGlobalConfig, subscribeGlobalConfig } from './global-config.js';
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
let holdQueueUnsub = null;
let configUnsub = null;
let remindersUnsub = null;
let nextUpTimer = null;
let holdCountdownTimer = null;
let activePendingDraft = null;
let activeHold = null;
let activeCustomerConfig = null;
let activeReminders = [];
let webhookEventsByMessageId = new Map();
let replayedMessageIds = new Set();
let webhookSubLoaded = false;

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
  showInspectorModal(ev);
}

function showInspectorModal(ev) {
  let modal = document.getElementById('ai-inspect-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ai-inspect-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-card inspect-card">
        <div class="modal-header">
          <h2>AI decision inspector</h2>
          <button class="icon-btn" id="inspect-close">&times;</button>
        </div>
        <div class="modal-body inspect-body" id="inspect-body"></div>
        <div class="modal-footer">
          <button type="button" class="btn" id="inspect-ok">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    document.getElementById('inspect-close').addEventListener('click', () => modal.classList.remove('open'));
    document.getElementById('inspect-ok').addEventListener('click', () => modal.classList.remove('open'));
  }
  const body = document.getElementById('inspect-body');
  const summary = [
    `<div class="ins-row"><span class="ins-k">Delivered:</span> ${escapeHtml(new Date(ev.ts).toLocaleString())}</div>`,
    `<div class="ins-row"><span class="ins-k">event:</span> ${escapeHtml(ev.event || '(missing)')}</div>`,
    `<div class="ins-row"><span class="ins-k">chat_id:</span> ${escapeHtml(ev.chat_id || '')}</div>`,
    `<div class="ins-row"><span class="ins-k">message_id:</span> <code>${escapeHtml(ev.message_id || '')}</code></div>`,
    `<div class="ins-row"><span class="ins-k">from_me:</span> ${escapeHtml(String(ev.from_me))}</div>`,
    `<div class="ins-row"><span class="ins-k">message_type:</span> ${escapeHtml(ev.message_type || '(missing)')}</div>`,
    `<div class="ins-row"><span class="ins-k">customerType:</span> ${escapeHtml(ev.customerType || '(unknown)')}</div>`,
    `<div class="ins-row"><span class="ins-k">duration:</span> ${escapeHtml(String(ev.duration_ms || ''))} ms</div>`,
  ].join('');
  const decision = `<pre class="ins-pre">${escapeHtml(JSON.stringify(ev.result || {}, null, 2))}</pre>`;
  const userPromptBlock = ev.userPrompt
    ? `<details open><summary class="ins-summary">User prompt sent to Anthropic (${ev.userPrompt.length} chars)</summary><pre class="ins-pre">${escapeHtml(ev.userPrompt)}</pre></details>`
    : `<div class="ins-row ins-muted">User prompt not captured for this event (early-exit before prompt was built, or pre-v1.022 worker).</div>`;
  const systemPromptHint = ev.systemPromptType
    ? `<div class="ins-row"><span class="ins-k">system prompt:</span> ${escapeHtml(ev.systemPromptType)}</div>`
    : '';
  const rawBlock = ev.raw
    ? `<details><summary class="ins-summary">Raw Periskope payload (${ev.raw.length} chars)</summary><pre class="ins-pre">${escapeHtml(ev.raw)}</pre></details>`
    : '';
  body.innerHTML = `
    ${summary}
    ${systemPromptHint}
    <h3 class="ins-h">Decision</h3>
    ${decision}
    <h3 class="ins-h">Context the AI saw</h3>
    ${userPromptBlock}
    ${rawBlock}
  `;
  modal.classList.add('open');
}

export async function openChatFor(customer) {
  stopPolling();
  if (pendingDraftUnsub) { pendingDraftUnsub(); pendingDraftUnsub = null; }
  if (webhookEventsUnsub) { webhookEventsUnsub(); webhookEventsUnsub = null; }
  if (holdQueueUnsub) { holdQueueUnsub(); holdQueueUnsub = null; }
  if (configUnsub) { configUnsub(); configUnsub = null; }
  if (remindersUnsub) { remindersUnsub(); remindersUnsub = null; }
  if (holdCountdownTimer) { clearInterval(holdCountdownTimer); holdCountdownTimer = null; }
  if (nextUpTimer) { clearInterval(nextUpTimer); nextUpTimer = null; }
  activeCustomer = customer;
  activeChatId = phoneToChatId(customer.phone);
  currentMessages = [];
  activePendingDraft = null;
  activeHold = null;
  activeCustomerConfig = null;
  activeReminders = [];
  webhookEventsByMessageId = new Map();
  replayedMessageIds = new Set();
  webhookSubLoaded = false;
  renderShell(customer);
  await refreshMessages({ scroll: true });
  startPolling();
  pendingDraftUnsub = subscribePendingDraft(customer.phone, onPendingDraftChange);
  webhookEventsUnsub = subscribeWebhookEventsForChat(activeChatId, 300, onWebhookEventsChange);
  holdQueueUnsub = subscribeHoldQueueForChat(customer.phone, onHoldQueueChange);
  configUnsub = subscribeConfig(customer.phone, onConfigChange);
  remindersUnsub = subscribeScheduledReminders(customer.phone, 20, onRemindersChange);
  nextUpTimer = setInterval(renderNextUpBanner, 30_000);
}

export function closeChat() {
  stopPolling();
  if (pendingDraftUnsub) { pendingDraftUnsub(); pendingDraftUnsub = null; }
  if (webhookEventsUnsub) { webhookEventsUnsub(); webhookEventsUnsub = null; }
  if (holdQueueUnsub) { holdQueueUnsub(); holdQueueUnsub = null; }
  if (configUnsub) { configUnsub(); configUnsub = null; }
  if (remindersUnsub) { remindersUnsub(); remindersUnsub = null; }
  if (holdCountdownTimer) { clearInterval(holdCountdownTimer); holdCountdownTimer = null; }
  if (nextUpTimer) { clearInterval(nextUpTimer); nextUpTimer = null; }
  activeChatId = null;
  activeCustomer = null;
  currentMessages = [];
  activePendingDraft = null;
  activeHold = null;
  activeCustomerConfig = null;
  activeReminders = [];
  webhookEventsByMessageId = new Map();
  replayedMessageIds = new Set();
}

function onConfigChange(config) {
  activeCustomerConfig = config;
  renderNextUpBanner();
}

function onRemindersChange(entries) {
  activeReminders = entries || [];
  renderNextUpBanner();
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
      <div id="hold-banner" class="hold-banner" hidden></div>
      <div id="pending-draft-banner" class="pending-draft" hidden></div>
      <div id="next-up-banner" class="next-up" hidden></div>
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
    <button type="button" class="pd-rate" id="pd-rate-up" title="Good draft — log positive rating">👍</button>
    <button type="button" class="pd-rate" id="pd-rate-down" title="Bad draft — log negative rating with reason">👎</button>
    <button type="button" class="pd-discard" id="pd-discard">Discard</button>
  `;
  document.getElementById('pd-discard').addEventListener('click', discardPendingDraft);
  document.getElementById('pd-rate-up').addEventListener('click', () => rateDraft('up'));
  document.getElementById('pd-rate-down').addEventListener('click', () => rateDraft('down'));

  if (!input.value.trim()) {
    input.value = draft.message || '';
    autosize.call(input);
  }
}

async function rateDraft(rating) {
  if (!activeCustomer || !activePendingDraft) return;
  let reason = '';
  if (rating === 'down') {
    reason = prompt('What was wrong with this draft? (optional — helps tune the prompt)') || '';
    if (reason === null) return; // cancelled
  }
  try {
    await logAiRating(activeCustomer.phone, {
      rating,
      reason: reason.slice(0, 500),
      draft: (activePendingDraft.message || '').slice(0, 500),
      source: activePendingDraft.source || '',
      draftReason: activePendingDraft.reason || '',
    });
    await logActivity(activeCustomer.phone, {
      direction: 'system', source: 'manual',
      action: `ai-rated-${rating}`,
      message: reason || (activePendingDraft.message || '').slice(0, 100),
    });
    const btn = document.getElementById(rating === 'up' ? 'pd-rate-up' : 'pd-rate-down');
    if (btn) {
      btn.disabled = true;
      btn.textContent = rating === 'up' ? '✓' : '✓';
      setTimeout(() => { if (btn) btn.disabled = false; }, 1500);
    }
  } catch (err) {
    alert(`Rating failed: ${err.message}`);
  }
}

function onHoldQueueChange(entries) {
  if (holdCountdownTimer) { clearInterval(holdCountdownTimer); holdCountdownTimer = null; }
  const pending = (entries || []).find(e =>
    e.status === 'pending' && !e.held && (e.sendAt || 0) > Date.now()
  );
  activeHold = pending || null;
  renderHoldBanner();
  if (pending) {
    holdCountdownTimer = setInterval(() => {
      if (!activeHold || activeHold.sendAt <= Date.now()) {
        clearInterval(holdCountdownTimer);
        holdCountdownTimer = null;
        const banner = document.getElementById('hold-banner');
        if (banner) banner.hidden = true;
        return;
      }
      renderHoldBanner();
    }, 250);
  }
}

function renderHoldBanner() {
  const banner = document.getElementById('hold-banner');
  if (!banner) return;
  if (!activeHold) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const remainingMs = Math.max(0, activeHold.sendAt - Date.now());
  const remainingSec = Math.ceil(remainingMs / 1000);
  banner.hidden = false;
  banner.innerHTML = `
    <span class="hold-label">⏸ Auto-sending in ${remainingSec}s · "${escapeHtml((activeHold.message || '').slice(0, 80))}${(activeHold.message || '').length > 80 ? '…' : ''}"</span>
    <button type="button" class="hold-btn" id="hold-action">Hold &amp; review</button>
  `;
  const btn = document.getElementById('hold-action');
  btn.addEventListener('click', () => holdAutoSend());
}

async function holdAutoSend() {
  if (!activeCustomer || !activeHold) return;
  const id = activeHold.id;
  try {
    await markHoldHeld(activeCustomer.phone, id);
    // The worker will see held:true after its timer fires and convert to pendingDraft
    activeHold = null;
    renderHoldBanner();
  } catch (err) {
    alert(`Hold failed: ${err.message}`);
  }
}

function renderNextUpBanner() {
  const banner = document.getElementById('next-up-banner');
  if (!banner) return;
  const html = computeNextUp(activeCustomerConfig, activeReminders, activeCustomer);
  if (!html) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = html;
}

function computeNextUp(config, reminders, customer) {
  const globalCfg = getCachedGlobalConfig();
  if (globalCfg?.killSwitch) {
    return `<span class="nu-icon">⛔</span><span class="nu-text">Kill switch ON — all automation paused globally</span>`;
  }
  if (!config) {
    return `<span class="nu-icon">⚙</span><span class="nu-text">No AI config yet — open ⚙ to set up</span>`;
  }
  if (config.paused) {
    return `<span class="nu-icon">⏸</span><span class="nu-text">Customer paused — no automated sends${config.pausedReason ? ' · ' + escapeHtml(config.pausedReason) : ''}</span>`;
  }
  // Onboarding in progress — overrides "AI is off" since the worker bypasses the mode-off check
  if (typeof config.onboardingState === 'string' && config.onboardingState.startsWith('awaiting-')) {
    const stepLabels = {
      'awaiting-goal': 'Goal (1/6)',
      'awaiting-age': 'Age (2/6)',
      'awaiting-gender': 'Coach gender (3/6)',
      'awaiting-style': 'Coach style (4/6)',
      'awaiting-intensity': 'Intensity (5/6)',
      'awaiting-language': 'Language (6/6)',
    };
    return `<span class="nu-icon">📝</span><span class="nu-text">Onboarding in progress — ${escapeHtml(stepLabels[config.onboardingState] || config.onboardingState)}. Customer is answering questions; coach AI is paused.</span>`;
  }
  if (!['draft-only', 'auto-send'].includes(config.autoCoachMode)) {
    return `<span class="nu-icon">○</span><span class="nu-text">AI is off for this customer — turn on in ⚙</span>`;
  }
  // Build candidates
  const now = Date.now();
  const candidates = [];
  const nextCron = computeNextMorningCron(config, now);
  if (nextCron) {
    candidates.push({ when: nextCron, label: `morning check-in at ${config.sendTimeIST || '08:00'} IST`, kind: 'cron' });
  }
  for (const r of reminders) {
    if (r.status !== 'pending' || !r.fireAt) continue;
    if (r.fireAt <= now) continue;
    candidates.push({ when: r.fireAt, label: shortReason(r), kind: 'reminder', source: r.source });
  }
  candidates.sort((a, b) => a.when - b.when);
  const next = candidates[0];

  const modeLabel = config.autoCoachMode === 'auto-send' ? 'auto-sends' : 'queues a draft';

  // Workout-today status for Ferra customers — read actual reminder status, not just the lastPostWorkoutDate flag
  let workoutStatus = '';
  if (customer?.found && customer.daysSinceLastSession === 0) {
    const istNow = new Date(Date.now() + 5.5 * 60 * 60000);
    const todayIst = istNow.toISOString().slice(0, 10);

    // Find today's post-workout reminder (any status)
    let todaysPw = null;
    for (const r of (reminders || [])) {
      if (r.source !== 'post-workout' || !r.ts) continue;
      const dStr = new Date(r.ts + 5.5 * 60 * 60000).toISOString().slice(0, 10);
      if (dStr === todayIst) { todaysPw = r; break; }
    }

    if (todaysPw) {
      if (todaysPw.status === 'pending') {
        // Will appear as the "next" entry via candidates — no extra pill
      } else if (todaysPw.status === 'sent') {
        workoutStatus = `<span class="nu-status nu-status-ok">🏋️ Workout ack sent</span>`;
      } else if (todaysPw.status === 'held') {
        workoutStatus = `<span class="nu-status nu-status-warn">🏋️ Workout ack held — review pending draft</span>`;
      } else if (todaysPw.status === 'cancelled') {
        workoutStatus = `<span class="nu-status nu-status-warn">🏋️ Workout ack cancelled</span>`;
      } else {
        workoutStatus = `<span class="nu-status nu-status-warn">🏋️ Workout ack: ${escapeHtml(todaysPw.status)}</span>`;
      }
    } else if (config.lastPostWorkoutDate === todayIst) {
      // Edge case: flag set but no reminder in last 20 (older entries pushed out, or the reminder failed to write)
      workoutStatus = `<span class="nu-status nu-status-warn">🏋️ Ack scheduled but not in recent list — check activity</span>`;
    } else {
      workoutStatus = `<span class="nu-status nu-status-warn">🏋️ Worked out today — no ack scheduled</span>`;
    }
  }

  let mainHtml;
  if (!next) {
    mainHtml = `<span class="nu-icon">💬</span><span class="nu-text">No scheduled events. AI ${modeLabel} when ${escapeHtml(customer?.name || 'this customer')} messages.</span>`;
  } else {
    const rel = relativeFuture(next.when - now);
    const abs = formatAbsolute(next.when);
    const kindLabel = next.kind === 'cron' ? '⏰' : '📅';
    mainHtml = `<span class="nu-icon">${kindLabel}</span><span class="nu-text">Next: ${escapeHtml(next.label)} · ${escapeHtml(abs)} (${escapeHtml(rel)})</span>`;
  }

  return mainHtml + workoutStatus;
}

function shortReason(r) {
  const map = {
    'stated-intent-followup': 'follow-up on stated workout time',
    'stated-intent-no-show': 'no-show check (if no workout reported)',
    'end-of-week-gym': 'end-of-week gym nudge',
    'streak-saver': 'streak restart nudge',
    'comeback': 'comeback nudge after silence',
    'post-workout': 'post-workout acknowledgment',
    'manual': 'your manual reminder',
  };
  const base = map[r.source] || r.source || 'scheduled reminder';
  if (r.reason && r.reason.length < 80) return `${base} — "${r.reason}"`;
  return base;
}

function computeNextMorningCron(config, nowMs) {
  const sendTime = config.sendTimeIST || '08:00';
  const sendWindowMs = 15 * 60 * 1000;
  const istNowMs = nowMs + 5.5 * 60 * 60000;
  const istNow = new Date(istNowMs);
  const todayStr = istNow.toISOString().slice(0, 10);
  const todayAtSendUtcMs = Date.parse(`${todayStr}T${sendTime}:00.000Z`) - 5.5 * 60 * 60000;
  const alreadyDoneToday = config.lastOutboundDate === todayStr && config.lastOutboundReason === 'cron-checkin';
  if (!alreadyDoneToday && nowMs < todayAtSendUtcMs + sendWindowMs) {
    return Math.max(todayAtSendUtcMs, nowMs + 1000);
  }
  const tomorrowIst = new Date(istNowMs + 86400000);
  const tomorrowStr = tomorrowIst.toISOString().slice(0, 10);
  return Date.parse(`${tomorrowStr}T${sendTime}:00.000Z`) - 5.5 * 60 * 60000;
}

function relativeFuture(ms) {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'in less than a minute';
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min} min`;
  const hr = Math.floor(min / 60);
  const remM = min % 60;
  if (hr < 24) {
    if (remM > 5) return `in ${hr}h ${remM}m`;
    return `in ${hr}h`;
  }
  const days = Math.floor(hr / 24);
  if (days < 7) return `in ${days}d`;
  return `in ${days}d`;
}

function formatAbsolute(ms) {
  const d = new Date(ms);
  const istMs = ms + 5.5 * 60 * 60000;
  const ist = new Date(istMs);
  const now = new Date();
  const today = new Date(now.getTime() + 5.5 * 60 * 60000).toISOString().slice(0, 10);
  const dStr = ist.toISOString().slice(0, 10);
  const hm = ist.toISOString().slice(11, 16);
  if (dStr === today) return `today ${hm} IST`;
  const tomorrowStr = new Date(now.getTime() + 86400000 + 5.5 * 60 * 60000).toISOString().slice(0, 10);
  if (dStr === tomorrowStr) return `tomorrow ${hm} IST`;
  // For dates within 7 days, show weekday
  const dayDiff = Math.floor((Date.parse(dStr) - Date.parse(today)) / 86400000);
  if (dayDiff > 0 && dayDiff < 7) {
    const weekday = ist.toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
    return `${weekday} ${hm} IST`;
  }
  return `${dStr} ${hm} IST`;
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
    // After messages are rendered, scan for orphans that Periskope may have failed to deliver
    maybeReplayOrphanInbounds().catch(err => console.error('replay scan failed:', err));
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
  if (!ev) {
    if (replayedMessageIds.has(messageId)) {
      return `<div class="ai-badge pending" title="Replay sent — waiting for worker result (~5-15s)">AI: replaying…</div>`;
    }
    // Try to find the message in currentMessages and check its age
    const msg = currentMessages.find(m => m.message_id === messageId);
    const ts = msg ? parseTimestamp(msg.timestamp) : 0;
    const ageMs = ts ? Date.now() - ts : 0;
    if (ts && ageMs > 30 * 60 * 1000) {
      // Older than 30 min and no entry — likely pushed out of the dashboard's visible window
      return `<div class="ai-badge idle" title="No entry visible — dashboard only shows the most recent 300 automation events. The actual processing likely happened (AI replied below).">AI: out of view</div>`;
    }
    return `<div class="ai-badge pending" title="No AI decision recorded yet — auto-replay fires after 60s if Periskope didn't deliver">AI: …</div>`;
  }

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
  } else if (r.acted === 'held') {
    cls = 'warn'; text = 'AI: held'; tooltip = 'You clicked Hold — message converted to a pending draft';
  } else if (r.acted === 'auto-paused') {
    cls = 'warn'; text = 'AI: paused customer'; tooltip = 'Opt-out keyword detected';
  } else if (r.acted === 'onboarding-advanced') {
    cls = 'ok'; text = `AI: onboarding · next: ${escapeHtml((r.nextState || '').replace('awaiting-', ''))}`; tooltip = 'Answer parsed; next question sent';
  } else if (r.acted === 'onboarding-complete') {
    cls = 'ok'; text = 'AI: onboarding done'; tooltip = `Personality assigned: ${escapeHtml(r.personality || '')}`;
  } else if (r.acted === 'onboarding-skipped') {
    cls = 'warn'; text = 'AI: onboarding skipped'; tooltip = 'Customer typed "skip" — defaults applied';
  } else if (r.ignored === 'unparseable-answer') {
    cls = 'skip'; text = `AI: onboarding · nudged`; tooltip = `Answer couldn't be parsed (${r.reason || 'unclear'}) — nudge sent`;
  } else if (r.ignored === 'webhook-rate-limit') {
    cls = 'skip'; text = 'AI: skip · rate-limit'; tooltip = `Suppressed to prevent burst. Last outbound was ${Math.round((r.lastOutboundDeltaMs || 0) / 1000)}s ago, gate is set higher in Tune AI → Safety.`;
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
  webhookSubLoaded = true;
  // Re-render badges in-place without scrolling
  document.querySelectorAll('.bubble.in[data-message-id]').forEach(el => {
    const id = el.dataset.messageId;
    if (!id) return;
    const oldBadge = el.querySelector('.ai-badge');
    const newHtml = renderAiBadge(id);
    if (oldBadge) oldBadge.outerHTML = newHtml;
    else el.insertAdjacentHTML('beforeend', newHtml);
  });
  // Catch webhook delivery gaps — Periskope sometimes drops events silently
  maybeReplayOrphanInbounds().catch(err => console.error('replay scan failed:', err));
}

async function maybeReplayOrphanInbounds() {
  if (!activeCustomer || !activeChatId) return;
  // Guard: don't fire replays until the webhook events subscription has loaded at least once.
  // Without this, opening a chat would replay every recent inbound because the local map is empty
  // — even for inbounds that already have a feed entry recording a (correct) rate-limit skip etc.
  if (!webhookSubLoaded) return;
  const startTs = activeCustomerConfig?.conversationStartTs || 0;
  const now = Date.now();
  const REPLAY_MAX_AGE_MS = 30 * 60 * 1000; // only replay inbounds from the last 30 minutes
  const orphans = [];
  for (const m of currentMessages) {
    if (m.from_me === true) continue;
    if (!m.message_id) continue;
    const ts = parseTimestamp(m.timestamp);
    if (!ts) continue;
    if (startTs && ts < startTs) continue;
    if (now - ts < 60_000) continue; // give Periskope 60s before replaying
    if (now - ts > REPLAY_MAX_AGE_MS) continue; // too old — don't retroactively process
    if (webhookEventsByMessageId.has(m.message_id)) continue;
    if (replayedMessageIds.has(m.message_id)) continue;
    orphans.push(m);
  }
  if (!orphans.length) return;
  const { workerUrl } = loadSettings();
  if (!workerUrl) return;
  const base = workerUrl.replace(/\/+$/, '');
  for (const m of orphans) {
    replayedMessageIds.add(m.message_id);
    try {
      await fetch(`${base}/periskope/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: activeChatId,
          message_id: m.message_id,
          body: m.body || '',
          timestamp: parseTimestamp(m.timestamp),
          message_type: m.message_type || 'chat',
        }),
      });
    } catch (err) {
      console.error('Replay POST failed for', m.message_id, err);
    }
  }
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
