import { phoneToChatId, listMessages, sendMessage } from './periskope.js';
import { generateMessage } from './anthropic.js';
import { SYSTEM_COACH, SYSTEM_REPLY, buildDraftPrompt } from './prompt.js';
import { loadSettings } from './storage.js';

const els = {};
let activeChatId = null;
let activeCustomer = null;
let currentMessages = [];
let pollTimer = null;

export function initChat() {
  els.pane = document.querySelector('.chat-pane');
}

export async function openChatFor(customer) {
  stopPolling();
  activeCustomer = customer;
  activeChatId = phoneToChatId(customer.phone);
  currentMessages = [];
  renderShell(customer);
  await refreshMessages({ scroll: true });
  startPolling();
}

export function closeChat() {
  stopPolling();
  activeChatId = null;
  activeCustomer = null;
  currentMessages = [];
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
        <button class="icon-btn" id="chat-refresh" title="Refresh">&#x21bb;</button>
      </header>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-status">Loading messages…</div>
      </div>
      <form class="chat-composer" id="chat-composer">
        <div class="draft-btns">
          <button type="button" class="draft-btn coach" id="chat-draft-coach" title="Coach: workout accountability (Ctrl/Cmd+J)">&#x1F4AA;</button>
          <button type="button" class="draft-btn" id="chat-draft-reply" title="Reply: natural continuation">&#x1F4AC;</button>
        </div>
        <textarea
          id="chat-input"
          placeholder="Type a message, or click 💪 / 💬 to draft with AI…"
          rows="1"
          autocomplete="off"
        ></textarea>
        <button type="submit" class="btn" id="chat-send">Send</button>
      </form>
    </div>
  `;
  document.getElementById('chat-refresh').addEventListener('click', () => refreshMessages({ scroll: true }));
  document.getElementById('chat-composer').addEventListener('submit', onSend);
  document.getElementById('chat-draft-coach').addEventListener('click', () => onDraft('coach'));
  document.getElementById('chat-draft-reply').addEventListener('click', () => onDraft('reply'));
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

async function refreshMessages({ scroll = false } = {}) {
  if (!activeChatId) return;
  const container = document.getElementById('chat-messages');
  try {
    const data = await listMessages(activeChatId, { limit: 100, offset: 0 });
    const messages = (data.messages || []).slice().sort((a, b) => {
      return parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp);
    });
    currentMessages = messages;
    if (messages.length === 0) {
      container.innerHTML = `<div class="chat-status">No messages yet.</div>`;
      return;
    }
    container.innerHTML = messages.map(renderBubble).join('');
    if (scroll) container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = `<div class="chat-status error">${escapeHtml(err.message)}</div>`;
  }
}

function renderBubble(m) {
  const cls = m.from_me ? 'out' : 'in';
  const ts = formatTime(m.timestamp);
  const body = m.body || mediaLabel(m);
  return `
    <div class="bubble ${cls}">
      <div class="bubble-text">${escapeHtml(body)}</div>
      <div class="bubble-meta">${escapeHtml(ts)}</div>
    </div>
  `;
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
  if (!text || !activeChatId) return;
  btn.disabled = true;
  try {
    await sendMessage(activeChatId, text);
    input.value = '';
    autosize.call(input);
    setTimeout(() => refreshMessages({ scroll: true }), 800);
  } catch (err) {
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
    const userPrompt = await buildDraftPrompt(activeCustomer, currentMessages, { intent, mode });
    const draft = await generateMessage({
      system: mode === 'coach' ? SYSTEM_COACH : SYSTEM_REPLY,
      userPrompt,
      model: anthropicModel,
      maxTokens: 600,
    });
    input.value = draft || previousValue;
    autosize.call(input);
    input.focus();
  } catch (err) {
    input.value = previousValue;
    showError(err.message);
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
