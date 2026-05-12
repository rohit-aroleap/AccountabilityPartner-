import { loadWorkoutData, getRecentDailyActivity, getRecentHabitScores } from './workout.js';
import { DEFAULT_SYSTEM_COACH, DEFAULT_SYSTEM_REPLY, DEFAULT_SYSTEM_GYM_COACH } from './defaults.js';
import { getCachedGlobalConfig } from './global-config.js';

export function getSystemCoach() {
  return getCachedGlobalConfig()?.prompts?.coach || DEFAULT_SYSTEM_COACH;
}

export function getSystemReply() {
  return getCachedGlobalConfig()?.prompts?.reply || DEFAULT_SYSTEM_REPLY;
}

export function getSystemGymCoach() {
  return getCachedGlobalConfig()?.prompts?.gym || DEFAULT_SYSTEM_GYM_COACH;
}

export function getSystemForCustomer(customer, mode, config) {
  if (mode === 'reply') return getSystemReply();
  const type = resolveCustomerType(customer, config);
  return type === 'gym' ? getSystemGymCoach() : getSystemCoach();
}

export function resolveCustomerType(customer, config) {
  const explicit = config?.customerType;
  if (explicit === 'ferra' || explicit === 'gym') return explicit;
  return customer?.found ? 'ferra' : 'gym';
}

export const SYSTEM_COACH = DEFAULT_SYSTEM_COACH;
export const SYSTEM_REPLY = DEFAULT_SYSTEM_REPLY;

export async function buildDraftPrompt(customer, recentMessages, { intent, mode = 'coach', config = {}, workoutLog = [] } = {}) {
  const filtered = filterByConversationStart(recentMessages, config?.conversationStartTs);
  const type = resolveCustomerType(customer, config);
  if (type === 'gym' && mode === 'coach') {
    return buildGymPrompt(customer, filtered, { intent, config, workoutLog });
  }
  return buildFerraPrompt(customer, filtered, { intent, mode });
}

function filterByConversationStart(messages, startTs) {
  if (!startTs) return messages;
  return (messages || []).filter(m => {
    const ts = m.timestamp;
    if (!ts) return false;
    let ms;
    if (typeof ts === 'number') ms = ts < 1e12 ? ts * 1000 : ts;
    else {
      const n = Number(ts);
      if (!Number.isNaN(n) && n > 0) ms = n < 1e12 ? n * 1000 : n;
      else ms = Date.parse(ts);
    }
    return ms >= startTs;
  });
}

async function buildFerraPrompt(customer, recentMessages, { intent, mode }) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dayName = today.toLocaleDateString('en-IN', { weekday: 'long' });
  const localTime = today.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const lines = [];
  lines.push(`Today: ${todayStr} (${dayName}), ${localTime} IST`);
  lines.push('');

  if (customer.found) {
    lines.push(`Customer: ${customer.name}`);
    lines.push(`Phone: ${customer.phone}`);
    lines.push(`Customer type: Ferra machine`);
    lines.push(`Habit score: ${Math.round(customer.habitScore ?? 0)} / 100`);
    lines.push(`Tier: ${customer.tierLabel || '—'}`);
    lines.push(`Segment: ${customer.segment || '—'}`);
    lines.push(`Last active: ${customer.lastActiveDate || '—'} (${customer.daysSinceLastSession === 999 ? 'never' : `${customer.daysSinceLastSession}d ago`})`);
    if (customer.streak) {
      lines.push(`Streak: ${customer.streak.days} days (${customer.streak.active ? 'active' : 'broken'})`);
    }

    try {
      const idx = await loadWorkoutData();
      const activity = getRecentDailyActivity(idx, customer.uid, 14);
      const scores = getRecentHabitScores(idx, customer.uid, 14);
      if (activity.length) {
        lines.push('');
        lines.push('Last 14 days of training:');
        for (const a of activity) {
          const mins = Math.round((a.totalDuration || 0) / 60);
          lines.push(`  ${a.date}: ${a.exerciseCount} exercises, ${mins} min${a.progressiveOverloadCount ? `, ${a.progressiveOverloadCount} progressive overload sets` : ''}`);
        }
      } else {
        lines.push('');
        lines.push('No training in the last 14 days.');
      }
      if (scores.length) {
        lines.push('');
        lines.push('Last 14 days habit scores:');
        for (const s of scores) {
          lines.push(`  ${s.date}: ${Math.round(s.score)} (tier ${s.tier})`);
        }
      }
    } catch (err) {
      lines.push(`(Workout details unavailable: ${err.message})`);
    }
  } else {
    lines.push(`Customer phone: ${customer.phone}`);
    lines.push(`This customer is not yet in the Ferra workout export. They may be brand new, pre-onboarding, or haven't set up the machine. No workout data available — anchor the message on the WhatsApp conversation alone.`);
  }

  lines.push('');
  lines.push('Recent WhatsApp messages (oldest first, last 20):');
  const last20 = recentMessages.slice(-20);
  if (last20.length === 0) {
    lines.push('  (no prior conversation)');
  } else {
    for (const m of last20) {
      const who = m.from_me ? 'me' : (customer.name || 'them');
      const ts = formatMessageTs(m.timestamp);
      const body = (m.body || mediaLabel(m) || '').replace(/\s+/g, ' ').trim();
      lines.push(`  [${ts} | ${who}] ${body}`);
    }
  }

  lines.push('');
  if (intent && intent.trim()) {
    lines.push(`What I want to convey (rough idea — refine into a real message): ${intent.trim()}`);
  } else {
    const lastFromCustomer = last20.length > 0 && !last20[last20.length - 1].from_me;
    if (mode === 'coach') {
      lines.push(lastFromCustomer
        ? 'The customer just messaged. Draft an accountability-focused reply — acknowledge their message briefly, then pivot to workouts.'
        : 'Draft an accountability check-in. Lead with workouts. Be specific to their data.');
    } else {
      lines.push(lastFromCustomer
        ? 'Draft my next reply, continuing the conversation naturally.'
        : 'Draft my next outgoing message — natural continuation, no forced topic.');
    }
  }

  return lines.join('\n');
}

function buildGymPrompt(customer, recentMessages, { intent, config, workoutLog }) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dayName = today.toLocaleDateString('en-IN', { weekday: 'long' });
  const localTime = today.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const lines = [];
  lines.push(`Today: ${todayStr} (${dayName}), ${localTime} IST`);
  lines.push('');
  lines.push(`Customer: ${customer.name || customer.phone}`);
  lines.push(`Phone: ${customer.phone}`);
  lines.push(`Customer type: Gym / other (NOT Ferra machine — no automatic workout data)`);

  const weeklyGoal = parseInt(config?.weeklyGoal, 10) || 3;
  lines.push(`Weekly workout goal: ${weeklyGoal} sessions`);

  const weekStart = getMondayOfWeek(today);
  const thisWeek = (workoutLog || []).filter(w => {
    const d = w.date ? new Date(w.date) : new Date(w.ts || 0);
    return d >= weekStart;
  });

  lines.push(`Workouts reported this week: ${thisWeek.length} of ${weeklyGoal}`);
  if (thisWeek.length > 0) {
    lines.push('');
    lines.push('This week\'s sessions (from chat reports):');
    for (const w of thisWeek) {
      lines.push(`  ${w.date || formatMessageTs(w.ts)}: ${w.type || 'workout'}${w.details ? ' — ' + w.details : ''}`);
    }
  }

  const recentLog = (workoutLog || []).slice(0, 10);
  if (recentLog.length > 0) {
    lines.push('');
    lines.push('Recent workout log (last 10, newest first):');
    for (const w of recentLog) {
      lines.push(`  ${w.date || formatMessageTs(w.ts)}: ${w.type || 'workout'}${w.details ? ' — ' + w.details : ''}`);
    }
  }

  lines.push('');
  lines.push('Recent WhatsApp messages (oldest first, last 20):');
  const last20 = recentMessages.slice(-20);
  if (last20.length === 0) {
    lines.push('  (no prior conversation)');
  } else {
    for (const m of last20) {
      const who = m.from_me ? 'me' : (customer.name || 'them');
      const ts = formatMessageTs(m.timestamp);
      const body = (m.body || mediaLabel(m) || '').replace(/\s+/g, ' ').trim();
      lines.push(`  [${ts} | ${who}] ${body}`);
    }
  }

  lines.push('');
  if (intent && intent.trim()) {
    lines.push(`What I want to convey (rough idea — refine into a real message): ${intent.trim()}`);
  } else {
    const lastFromCustomer = last20.length > 0 && !last20[last20.length - 1].from_me;
    lines.push(lastFromCustomer
      ? 'The customer just messaged. Draft my reply — acknowledge what they said, and if it\'s a workout report celebrate it specifically; if it\'s off-topic acknowledge briefly then pivot to their weekly goal.'
      : 'Draft an accountability check-in. Reference their weekly goal and where they are on it. If you haven\'t heard from them in a day or two, ask directly whether they trained.');
  }

  return lines.join('\n');
}

function getMondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d;
}

function formatMessageTs(ts) {
  if (!ts) return '';
  let ms;
  if (typeof ts === 'number') ms = ts < 1e12 ? ts * 1000 : ts;
  else {
    const n = Number(ts);
    if (!Number.isNaN(n) && n > 0) ms = n < 1e12 ? n * 1000 : n;
    else ms = Date.parse(ts);
  }
  if (!ms) return '';
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function mediaLabel(m) {
  if (m.media?.type) return `[${m.media.type}]`;
  if (m.message_type && m.message_type !== 'chat') return `[${m.message_type}]`;
  return '';
}
