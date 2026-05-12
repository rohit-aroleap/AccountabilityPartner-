import { loadWorkoutData, getRecentDailyActivity, getRecentHabitScores } from './workout.js';
import { DEFAULT_SYSTEM_COACH, DEFAULT_SYSTEM_REPLY } from './defaults.js';
import { getCachedGlobalConfig } from './global-config.js';

export function getSystemCoach() {
  return getCachedGlobalConfig()?.prompts?.coach || DEFAULT_SYSTEM_COACH;
}

export function getSystemReply() {
  return getCachedGlobalConfig()?.prompts?.reply || DEFAULT_SYSTEM_REPLY;
}

export const SYSTEM_COACH = DEFAULT_SYSTEM_COACH;
export const SYSTEM_REPLY = DEFAULT_SYSTEM_REPLY;

export async function buildDraftPrompt(customer, recentMessages, { intent, mode = 'coach' } = {}) {
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
    lines.push(`This customer is not yet in the Ferra workout export. They may be brand new, pre-onboarding, or haven't set up the machine. No workout data available.`);
    if (mode === 'coach') {
      lines.push(`COACH PRIORITY: Get them onto the machine. Ask about blockers. Offer to help with setup or their first session.`);
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
