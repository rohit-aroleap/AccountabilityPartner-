import { subscribeAutomationFeed } from './firebase-db.js';

const els = {};
let nextCronTimer = null;
let collapsed = true;
const COLLAPSE_KEY = 'ap.automationCollapsed';

export function initAutomationFeed() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  const stored = localStorage.getItem(COLLAPSE_KEY);
  collapsed = stored === null ? true : stored === '1';

  const panel = document.createElement('div');
  panel.className = 'auto-panel' + (collapsed ? ' collapsed' : '');
  panel.innerHTML = `
    <div class="auto-header">
      <span class="auto-title">Automation</span>
      <span class="auto-next" id="auto-next">Next cron: —</span>
      <button class="auto-toggle" id="auto-toggle" title="Toggle">${collapsed ? '+' : '−'}</button>
    </div>
    <div class="auto-feed" id="auto-feed">
      <div class="auto-empty">Waiting for events…</div>
    </div>
  `;
  sidebar.appendChild(panel);

  els.panel = panel;
  els.feed = document.getElementById('auto-feed');
  els.next = document.getElementById('auto-next');
  els.toggle = document.getElementById('auto-toggle');

  els.toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    panel.classList.toggle('collapsed', collapsed);
    els.toggle.textContent = collapsed ? '+' : '−';
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  });

  updateNextCron();
  nextCronTimer = setInterval(updateNextCron, 15_000);
  subscribeAutomationFeed(25, renderFeed);
}

function updateNextCron() {
  const now = new Date();
  const utcMinutes = Math.floor(now.getTime() / 60000);
  let nextUtcMinute = Math.ceil(utcMinutes / 15) * 15;
  if (nextUtcMinute === utcMinutes) nextUtcMinute += 15;
  const nextMs = nextUtcMinute * 60000;
  const istHm = new Date(nextMs + 5.5 * 60 * 60000).toISOString().slice(11, 16);
  const secsAway = Math.max(0, Math.round((nextMs - now.getTime()) / 1000));
  const m = Math.floor(secsAway / 60);
  const s = secsAway % 60;
  els.next.textContent = `Next cron ${istHm} IST · in ${m}m ${String(s).padStart(2, '0')}s`;
}

function renderFeed(events) {
  if (!events || !events.length) {
    els.feed.innerHTML = '<div class="auto-empty">No automation events yet</div>';
    return;
  }
  els.feed.innerHTML = events.map(renderRow).join('');
}

function renderRow(e) {
  const time = new Date(e.ts || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let summary, cls;
  if (e.type === 'cron') {
    const skipReasons = (e.skipped || []).slice(0, 3).map(s => s.why).join(', ');
    summary = `cron · processed ${e.processed ?? 0} · acted ${e.acted ?? 0}${skipReasons ? ' · skip: ' + skipReasons : ''}`;
    cls = e.acted > 0 ? 'ok' : 'idle';
  } else if (e.type === 'webhook') {
    const dir = e.from_me ? '→ outbound' : '← inbound';
    const body = e.body_preview ? `"${truncate(e.body_preview, 36)}"` : '(media)';
    const phoneShort = (e.chat_id || '').replace(/@.*/, '').slice(-6);
    let outcome = '';
    if (e.result?.acted) { outcome = ` ✓ ${e.result.acted}`; cls = 'ok'; }
    else if (e.result?.ignored) { outcome = ` · ignored: ${e.result.ignored}`; cls = 'skip'; }
    else if (e.result?.error || e.error) { outcome = ` · error: ${e.result?.error || e.error}`; cls = 'err'; }
    else { cls = 'idle'; }
    summary = `webhook ${dir} ${phoneShort} ${body}${outcome}`;
  } else {
    summary = JSON.stringify(e).slice(0, 80);
    cls = 'idle';
  }
  return `<div class="auto-event ${cls}"><span class="auto-time">${escapeHtml(time)}</span><span class="auto-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span></div>`;
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
