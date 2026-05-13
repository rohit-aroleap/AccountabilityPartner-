import { loadGlobalConfig, saveGlobalConfig, getCachedGlobalConfig } from './global-config.js';
import { backfillWebhookFeeds } from './firebase-db.js';
import { DEFAULT_GLOBAL, DEFAULT_SYSTEM_COACH, DEFAULT_SYSTEM_REPLY, DEFAULT_SYSTEM_GYM_COACH, DEFAULT_SAFETY, DEFAULT_INTRO_MESSAGE, DEFAULT_INTRO_MESSAGE_FERRA, DEFAULT_INTRO_MESSAGE_GYM } from './defaults.js';
import { parseCustomerPhones, loadSettings } from './storage.js';
import { subscribeAiUsage } from './firebase-db.js';
import { loadWorkoutData, normalizePhone, getRecentDailyActivity } from './workout.js';
import { generateMessage } from './anthropic.js';
import { listMessages, phoneToChatId } from './periskope.js';
import { buildDraftPrompt } from './prompt.js';

let modalEl;
let working = { ...DEFAULT_GLOBAL };

export function initTuneAi() {
  modalEl = document.createElement('div');
  modalEl.id = 'tune-ai-modal';
  modalEl.className = 'modal';
  modalEl.innerHTML = buildModalHtml();
  document.body.appendChild(modalEl);

  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
  document.getElementById('tune-close').addEventListener('click', closeModal);
  document.getElementById('tune-form').addEventListener('submit', onSave);
  document.getElementById('tune-reset-coach').addEventListener('click', () => resetField('coach'));
  document.getElementById('tune-reset-reply').addEventListener('click', () => resetField('reply'));
  document.getElementById('tune-reset-gym').addEventListener('click', () => resetField('gym'));
  document.getElementById('tune-reset-intro-ferra').addEventListener('click', () => resetField('intro-ferra'));
  document.getElementById('tune-reset-intro-gym').addEventListener('click', () => resetField('intro-gym'));
  document.getElementById('tune-backfill').addEventListener('click', runBackfill);
  document.getElementById('tune-sandbox-run').addEventListener('click', runSandbox);
  modalEl.querySelectorAll('.tune-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

let usageUnsub = null;

export async function openTuneAi() {
  try {
    working = await loadGlobalConfig();
  } catch (err) {
    console.error('loadGlobalConfig failed:', err);
    working = { ...DEFAULT_GLOBAL };
  }
  hydrateForm();
  hydrateSandboxCustomers();
  if (usageUnsub) usageUnsub();
  usageUnsub = subscribeAiUsage(renderUsage);
  switchTab('prompts');
  modalEl.classList.add('open');
}

function renderUsage(byDate) {
  const el = document.getElementById('tune-usage');
  if (!el) return;
  const dates = Object.keys(byDate || {}).sort().reverse().slice(0, 14);
  if (dates.length === 0) {
    el.innerHTML = `<div class="cs-empty">No usage tracked yet. After the next AI call from the worker, stats will appear here.</div>`;
    return;
  }
  const rows = dates.map(d => {
    const u = byDate[d] || {};
    const inT = u.inputTokens || 0;
    const outT = u.outputTokens || 0;
    const cost = (inT * 15 / 1e6 + outT * 75 / 1e6);
    return `<tr>
      <td>${escapeHtml(d)}</td>
      <td class="num">${(u.calls || 0).toLocaleString()}</td>
      <td class="num">${inT.toLocaleString()}</td>
      <td class="num">${outT.toLocaleString()}</td>
      <td class="num">$${cost.toFixed(3)}</td>
      <td class="num ${(u.errors||0)>0?'err':''}">${u.errors || 0}</td>
    </tr>`;
  }).join('');
  const totalIn = dates.reduce((s,d)=>s+(byDate[d]?.inputTokens||0),0);
  const totalOut = dates.reduce((s,d)=>s+(byDate[d]?.outputTokens||0),0);
  const totalCalls = dates.reduce((s,d)=>s+(byDate[d]?.calls||0),0);
  const totalErrors = dates.reduce((s,d)=>s+(byDate[d]?.errors||0),0);
  const totalCost = (totalIn * 15 / 1e6 + totalOut * 75 / 1e6);
  el.innerHTML = `
    <table class="usage-table">
      <thead>
        <tr><th>Date (IST)</th><th class="num">Calls</th><th class="num">Input tokens</th><th class="num">Output tokens</th><th class="num">Est. cost</th><th class="num">Errors</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td><strong>Total (last ${dates.length}d)</strong></td><td class="num"><strong>${totalCalls.toLocaleString()}</strong></td><td class="num"><strong>${totalIn.toLocaleString()}</strong></td><td class="num"><strong>${totalOut.toLocaleString()}</strong></td><td class="num"><strong>$${totalCost.toFixed(3)}</strong></td><td class="num ${totalErrors>0?'err':''}"><strong>${totalErrors}</strong></td></tr>
      </tfoot>
    </table>
  `;
}

function closeModal() {
  modalEl.classList.remove('open');
  document.getElementById('tune-save-status').textContent = '';
}

function switchTab(name) {
  modalEl.querySelectorAll('.tune-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  modalEl.querySelectorAll('.tune-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
}

function hydrateForm() {
  const f = document.getElementById('tune-form');
  f.killSwitch.checked = !!working.killSwitch;
  f.coach.value = working.prompts.coach;
  f.reply.value = working.prompts.reply;
  f.gym.value = working.prompts.gym;
  f.introMessageFerra.value = working.introMessageFerra || DEFAULT_INTRO_MESSAGE_FERRA;
  f.introMessageGym.value = working.introMessageGym || DEFAULT_INTRO_MESSAGE_GYM;
  for (const k of Object.keys(DEFAULT_SAFETY)) {
    if (f[k]) f[k].value = working.safety[k];
  }
}

function resetField(key) {
  const f = document.getElementById('tune-form');
  if (key === 'coach') f.coach.value = DEFAULT_SYSTEM_COACH;
  if (key === 'reply') f.reply.value = DEFAULT_SYSTEM_REPLY;
  if (key === 'gym') f.gym.value = DEFAULT_SYSTEM_GYM_COACH;
  if (key === 'intro-ferra') f.introMessageFerra.value = DEFAULT_INTRO_MESSAGE_FERRA;
  if (key === 'intro-gym') f.introMessageGym.value = DEFAULT_INTRO_MESSAGE_GYM;
}

async function onSave(e) {
  e.preventDefault();
  const f = e.target;
  const data = new FormData(f);
  const newCfg = {
    killSwitch: data.get('killSwitch') === 'on',
    prompts: {
      coach: (data.get('coach') || '').trim() || DEFAULT_SYSTEM_COACH,
      reply: (data.get('reply') || '').trim() || DEFAULT_SYSTEM_REPLY,
      gym: (data.get('gym') || '').trim() || DEFAULT_SYSTEM_GYM_COACH,
    },
    introMessageFerra: (data.get('introMessageFerra') || '').trim() || DEFAULT_INTRO_MESSAGE_FERRA,
    introMessageGym: (data.get('introMessageGym') || '').trim() || DEFAULT_INTRO_MESSAGE_GYM,
    safety: {
      quietHoursStart: (data.get('quietHoursStart') || '21:00').trim(),
      quietHoursEnd: (data.get('quietHoursEnd') || '08:00').trim(),
      maxOutboundPerDay: parseInt(data.get('maxOutboundPerDay'), 10) || DEFAULT_SAFETY.maxOutboundPerDay,
      minMinutesBetweenOutbound: parseInt(data.get('minMinutesBetweenOutbound'), 10) || DEFAULT_SAFETY.minMinutesBetweenOutbound,
      minMinutesBetweenAutoTriggers: parseInt(data.get('minMinutesBetweenAutoTriggers'), 10) || DEFAULT_SAFETY.minMinutesBetweenAutoTriggers,
      maxAutoTurnsPerSession: parseInt(data.get('maxAutoTurnsPerSession'), 10) || DEFAULT_SAFETY.maxAutoTurnsPerSession,
      sessionIdleMinutes: parseInt(data.get('sessionIdleMinutes'), 10) || DEFAULT_SAFETY.sessionIdleMinutes,
      sendWindowMin: parseInt(data.get('sendWindowMin'), 10) || DEFAULT_SAFETY.sendWindowMin,
    },
  };
  const status = document.getElementById('tune-save-status');
  status.textContent = 'Saving…';
  try {
    await saveGlobalConfig(newCfg);
    working = newCfg;
    status.textContent = 'Saved. Worker picks up the change on the next call.';
    setTimeout(() => { status.textContent = ''; }, 4000);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
}

function hydrateSandboxCustomers() {
  const { customerPhonesRaw } = loadSettings();
  const phones = parseCustomerPhones(customerPhonesRaw);
  const select = document.getElementById('tune-sandbox-customer');
  select.innerHTML = phones.length
    ? phones.map(p => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join('')
    : '<option value="">No customers in settings — add phones first</option>';
}

async function runSandbox() {
  const phone = document.getElementById('tune-sandbox-customer').value;
  const inbound = document.getElementById('tune-sandbox-inbound').value.trim();
  const mode = document.querySelector('input[name="sandboxMode"]:checked')?.value || 'coach';
  const out = document.getElementById('tune-sandbox-output');
  if (!phone) { out.textContent = 'Pick a customer first.'; return; }

  out.textContent = 'Building prompt and calling Claude…';
  try {
    const idx = await loadWorkoutData();
    const user = idx.byPhone.get(normalizePhone(phone));
    const recent = user ? getRecentDailyActivity(idx, user.uid, 1) : [];
    const customer = user
      ? { phone, found: true, uid: user.uid, name: user.name || phone, habitScore: user.habitScore, tierLabel: user.tierLabel, segment: user.segment, lastActiveDate: user.lastActiveDate, daysSinceLastSession: user.daysSinceLastSession, streak: user.streak, todayExercises: recent[0]?.exerciseCount ?? 0 }
      : { phone, found: false };

    let recentMessages = [];
    try {
      const data = await listMessages(phoneToChatId(phone), { limit: 30, offset: 0 });
      recentMessages = (data.messages || []).slice().sort((a, b) => parseTs(a.timestamp) - parseTs(b.timestamp));
    } catch (err) {
      console.warn('Sandbox messages fetch failed:', err.message);
    }
    if (inbound) {
      recentMessages.push({ from_me: false, body: inbound, timestamp: Date.now() });
    }

    const userPrompt = await buildDraftPrompt(customer, recentMessages, { intent: '', mode });
    const cfg = getCachedGlobalConfig() || DEFAULT_GLOBAL;
    // Pick prompt based on customer type — gym customers get the gym prompt for coach mode
    const isGym = !customer.found;
    const systemPrompt = mode === 'reply'
      ? cfg.prompts.reply
      : (isGym ? cfg.prompts.gym : cfg.prompts.coach);
    const { anthropicModel } = loadSettings();
    const draft = await generateMessage({ system: systemPrompt, userPrompt, model: anthropicModel, maxTokens: 600 });
    out.textContent = draft || '(empty response)';
  } catch (err) {
    out.textContent = `Error: ${err.message}`;
  }
}

function parseTs(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const n = Number(ts);
  if (!Number.isNaN(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const p = Date.parse(ts);
  return Number.isNaN(p) ? 0 : p;
}

function buildModalHtml() {
  return `
    <div class="modal-card tune-card">
      <div class="modal-header">
        <h2>Tune AI</h2>
        <button class="icon-btn" id="tune-close">&times;</button>
      </div>
      <div class="tune-tabs">
        <button type="button" class="tune-tab-btn active" data-tab="prompts">Prompts</button>
        <button type="button" class="tune-tab-btn" data-tab="templates">Templates</button>
        <button type="button" class="tune-tab-btn" data-tab="safety">Safety</button>
        <button type="button" class="tune-tab-btn" data-tab="killswitch">Kill Switch</button>
        <button type="button" class="tune-tab-btn" data-tab="sandbox">Sandbox</button>
        <button type="button" class="tune-tab-btn" data-tab="usage">Usage</button>
        <button type="button" class="tune-tab-btn" data-tab="maintenance">Maintenance</button>
        <button type="button" class="tune-tab-btn" data-tab="best-practices">Best Practices</button>
      </div>
      <div class="modal-body tune-body">
        <form id="tune-form">
          <div class="tune-pane active" data-pane="prompts">
            <p class="tune-blurb">These prompts drive every AI message. The Worker reads from here on each invocation — no redeploy needed. Hardcoded defaults are fallback if Firebase is unreachable.</p>
            <div class="field">
              <div class="field-label-row">
                <label for="tune-coach">Coach system prompt</label>
                <button type="button" class="link-btn" id="tune-reset-coach">Reset to default</button>
              </div>
              <textarea id="tune-coach" name="coach" rows="18" spellcheck="false"></textarea>
              <div class="help">Used by ✨ Coach button, cron morning check-ins, and webhook auto-replies. Workout accountability is the mission.</div>
            </div>
            <div class="field">
              <div class="field-label-row">
                <label for="tune-gym">Gym Coach system prompt</label>
                <button type="button" class="link-btn" id="tune-reset-gym">Reset to default</button>
              </div>
              <textarea id="tune-gym" name="gym" rows="16" spellcheck="false"></textarea>
              <div class="help">Used for customers marked as type "gym" — they don't use Ferra, so there's no automatic workout data. AI relies on chat + weekly goal + manually/auto-logged workouts.</div>
            </div>
            <div class="field">
              <div class="field-label-row">
                <label for="tune-reply">Reply system prompt</label>
                <button type="button" class="link-btn" id="tune-reset-reply">Reset to default</button>
              </div>
              <textarea id="tune-reply" name="reply" rows="10" spellcheck="false"></textarea>
              <div class="help">Used by the 💬 Reply button only. Natural conversation continuation, no forced topic.</div>
            </div>
          </div>

          <div class="tune-pane" data-pane="templates">
            <p class="tune-blurb">Pre-written messages used in customer-facing flows. Two intros — the Add Customer modal auto-picks based on whether the phone is in the Ferra export.</p>
            <div class="field">
              <div class="field-label-row">
                <label for="tune-intro-ferra">Intro for Ferra customers</label>
                <button type="button" class="link-btn" id="tune-reset-intro-ferra">Reset to default</button>
              </div>
              <textarea id="tune-intro-ferra" name="introMessageFerra" rows="5" spellcheck="false"></textarea>
              <div class="help">Used when the new customer is detected as a Ferra machine user (phone is in the export).</div>
            </div>
            <div class="field">
              <div class="field-label-row">
                <label for="tune-intro-gym">Intro for Gym / other customers</label>
                <button type="button" class="link-btn" id="tune-reset-intro-gym">Reset to default</button>
              </div>
              <textarea id="tune-intro-gym" name="introMessageGym" rows="5" spellcheck="false"></textarea>
              <div class="help">Used when the new customer is NOT in the Ferra export. Skips Ferra-specific references.</div>
            </div>
          </div>

          <div class="tune-pane" data-pane="safety">
            <p class="tune-blurb">These limits apply to BOTH cron and webhook automation. Changes take effect on the next Worker invocation.</p>
            <div class="tune-grid">
              <div class="field">
                <label>Quiet hours start (IST)</label>
                <input type="time" name="quietHoursStart" />
                <div class="help">No automated sends after this time</div>
              </div>
              <div class="field">
                <label>Quiet hours end (IST)</label>
                <input type="time" name="quietHoursEnd" />
                <div class="help">Automation resumes at this time</div>
              </div>
              <div class="field">
                <label>Max outbound per customer per day</label>
                <input type="number" name="maxOutboundPerDay" min="1" max="20" />
                <div class="help">Hard cap. Both manual + automated count.</div>
              </div>
              <div class="field">
                <label>Suggested min gap between sends (minutes)</label>
                <input type="number" name="minMinutesBetweenOutbound" min="5" max="1440" />
                <div class="help">Manual sends get a warning if shorter than this; doesn't block</div>
              </div>
              <div class="field">
                <label>Hard min gap between AUTO triggers (minutes)</label>
                <input type="number" name="minMinutesBetweenAutoTriggers" min="5" max="1440" />
                <div class="help">Cron + scheduled reminders skip if last outbound was within this window. Webhook auto-replies are exempt (customer is actively chatting).</div>
              </div>
              <div class="field">
                <label>Max auto-replies per session</label>
                <input type="number" name="maxAutoTurnsPerSession" min="1" max="20" />
                <div class="help">After N auto-replies in one session, bot stops — you take over</div>
              </div>
              <div class="field">
                <label>Session idle reset (minutes)</label>
                <input type="number" name="sessionIdleMinutes" min="5" max="720" />
                <div class="help">If no inbound for this long, auto-turn counter resets to 0</div>
              </div>
              <div class="field">
                <label>Cron send window (minutes)</label>
                <input type="number" name="sendWindowMin" min="5" max="60" />
                <div class="help">A customer's sendTimeIST will match if current time is within this window</div>
              </div>
            </div>
          </div>

          <div class="tune-pane" data-pane="killswitch">
            <p class="tune-blurb">The big red button.</p>
            <label class="killswitch-row">
              <input type="checkbox" name="killSwitch" class="toggle" />
              <div>
                <div class="killswitch-title">Pause all automation</div>
                <div class="killswitch-sub">When ON, every cron tick exits early and every webhook returns ack without generating or sending. Manual sends from the dashboard still work. Per-customer pause toggles are independent of this.</div>
              </div>
            </label>
          </div>

          <div class="tune-pane" data-pane="sandbox">
            <p class="tune-blurb">Test the current prompts on a real customer + workout context without sending anything to WhatsApp.</p>
            <div class="field">
              <label>Customer</label>
              <select id="tune-sandbox-customer"></select>
            </div>
            <div class="field">
              <label>Hypothetical inbound message (optional)</label>
              <textarea id="tune-sandbox-inbound" rows="2" placeholder="e.g., Can I skip today?"></textarea>
              <div class="help">Appended to the real recent conversation. Leave empty to test a cold check-in.</div>
            </div>
            <div class="field">
              <label>Mode</label>
              <div class="radio-group">
                <label><input type="radio" name="sandboxMode" value="coach" checked /> Coach (accountability-focused)</label>
                <label><input type="radio" name="sandboxMode" value="reply" /> Reply (natural conversation)</label>
              </div>
            </div>
            <button type="button" class="btn" id="tune-sandbox-run">Generate draft</button>
            <pre id="tune-sandbox-output" class="tune-sandbox-out">Pick a customer and click Generate.</pre>
          </div>

          <div class="tune-pane" data-pane="usage">
            <p class="tune-blurb">Anthropic API usage tracked per IST date. Rough cost is computed assuming Opus 4 pricing (input $15/M, output $75/M). Switch model in Settings — actual model pricing may differ.</p>
            <div id="tune-usage" class="tune-usage">Loading…</div>
          </div>

          <div class="tune-pane" data-pane="maintenance">
            <p class="tune-blurb">One-time data operations. Read carefully before running.</p>
            <div class="field">
              <label>Backfill webhook events to per-customer feeds</label>
              <div class="help">v1.034 introduced per-customer <code>customers/&lt;phone&gt;/webhookFeed</code> paths so the AI badges in chat can stay resolved over a long history. This action copies every existing entry from the global <code>automation/feed</code> to the matching customer's per-customer feed. After this runs, even old "AI: out of view" bubbles will show their real decision. Safe to re-run — it skips entries already present in the per-customer feed.</div>
              <button type="button" class="btn" id="tune-backfill" style="margin-top:10px;">Run backfill</button>
              <div id="tune-backfill-progress" class="bf-progress" hidden></div>
              <div id="tune-backfill-log" class="bf-log" hidden></div>
            </div>
          </div>

          <div class="tune-pane" data-pane="best-practices">
            ${buildBestPracticesHtml()}
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <span id="tune-save-status" class="status"></span>
        <button type="button" class="btn-ghost btn" onclick="document.getElementById('tune-close').click()">Cancel</button>
        <button type="submit" form="tune-form" class="btn">Save all</button>
      </div>
    </div>
  `;
}

async function runBackfill() {
  const btn = document.getElementById('tune-backfill');
  const progressEl = document.getElementById('tune-backfill-progress');
  const logEl = document.getElementById('tune-backfill-log');
  if (!confirm('Run backfill? This reads the entire global automation/feed and writes per-customer copies. Typically takes a few seconds to a few minutes depending on history size. Safe to re-run.')) return;
  btn.disabled = true;
  progressEl.hidden = false;
  logEl.hidden = false;
  progressEl.textContent = 'Starting…';
  logEl.innerHTML = '';
  const append = (line) => {
    logEl.insertAdjacentHTML('beforeend', `<div class="bf-line">${escapeHtml(line)}</div>`);
    logEl.scrollTop = logEl.scrollHeight;
  };
  try {
    const result = await backfillWebhookFeeds({
      onLog: append,
      onProgress: (done, total) => { progressEl.textContent = `Processed ${done} / ${total}`; },
    });
    progressEl.textContent = `Done. Total ${result.total} · migrated ${result.migrated} · skipped (already present) ${result.skipped} · customers touched ${result.customers}.`;
    append(`Finished. Hard-reload the dashboard to see resolved badges for old bubbles.`);
  } catch (err) {
    progressEl.textContent = `Error: ${err.message}`;
    append(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function buildBestPracticesHtml() {
  const items = [
    ['Examples beat rules', 'A few worked examples in the prompt outperform 20 bullet-pointed rules. The model pattern-matches faster than it follows lists. When you find a bad draft, also add a "what to say instead" example to the prompt.'],
    ['Constrain output format explicitly', 'Always end the system prompt with: "Output ONLY the message text. No quotes. No preamble. No explanation." This kills 90% of preamble like "Sure, here\'s a draft:"'],
    ['Anti-patterns are gold', 'Show what NOT to write. Example: "Don\'t say \'I noticed\' — just state the observation directly." Pairs with positive examples.'],
    ['Separate persona from policy', 'Two distinct sections: who you are (Rohit, founder, warm, brief) and what you must/can\'t do (no medical advice, no fabrications). Easier to tune independently.'],
    ['Iterate from real failures', 'Every bad draft you intercept → fold into the prompt as an anti-example. The prompt sharpens monotonically over time. Use the sandbox here to verify before saving.'],
    ['Use the sandbox before saving', 'After every prompt change, run the sandbox on 3-5 customers with varying contexts (active, dormant, complaining). Check the drafts look right. If one regresses, the change is bad.'],
    ['Low temperature for factual replies', 'Accountability messages are factual (referencing real workouts). High temp (>0.7) makes the model creative — bad here. We use Anthropic\'s default; for safety, don\'t crank temperature.'],
    ['Brevity has to be enforced', 'LLMs default to verbose. Explicit "usually 1-3 short sentences" + examples of brief messages keeps it tight.'],
    ['Variables over hardcoded values', 'The prompt references "the customer" and "their data" — not specific names. The user prompt builder injects the actual values per call. Don\'t hardcode any customer-specific text here.'],
    ['Watch for model drift', 'Anthropic updates models. Behavior on the same prompt can shift between versions. Pin the model (we do — claude-opus-4-7) and re-test with the sandbox after model upgrades.'],
    ['Don\'t over-control', 'A 2000-token system prompt usually hurts more than a 500-token one. The model handles language well — trust it. Add rules only when you see specific failures, not preemptively.'],
    ['Eval set discipline', 'Keep a list of 10-20 representative inputs (good customer, dormant customer, opt-out edge case, ambiguous topic). After every prompt edit, mentally re-run them via the sandbox. Catches regressions.'],
  ];
  return `
    <p class="tune-blurb">These are the prompt-engineering rules of thumb baked into this dashboard's design.</p>
    <ol class="bp-list">
      ${items.map(([t, b]) => `<li><strong>${escapeHtml(t)}.</strong> ${escapeHtml(b)}</li>`).join('')}
    </ol>
  `;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
