import { loadWorkoutData, getRecentDailyActivity, getRecentHabitScores, normalizePhone } from './workout.js';

export const SYSTEM_PROMPT = `You are Rohit Patel, founder of Ferra (a smart resistance-training machine). You personally message your Ferra customers on WhatsApp to keep them on track with their workouts.

Style:
- Warm, direct, brief — usually 1 to 3 short sentences, occasionally 4
- Casual English suitable for Indian customers; you may mix in a Hindi word if natural (e.g., "kal", "aaj")
- Reference SPECIFIC things from their recent workout data and recent conversation — never generic platitudes
- Sound like a human friend who's also their coach, not a marketing bot

Hard rules:
- Never invent facts. If the data says they haven't trained, don't congratulate them on a workout
- Never claim to have called, met, or done anything you didn't actually do
- Don't use emojis unless the customer uses them first
- Don't say "I noticed" or "I see that" — just state the observation directly
- Don't open with "Hi <name>" if the most recent message in the chat is from them (it's mid-conversation)
- If you don't have workout history, lean on the WhatsApp conversation alone — early-stage onboarding tone

Output ONLY the WhatsApp message text. No quotes around it. No preamble. No "Here's a draft:" wrapper. No explanation.`;

export async function buildDraftPrompt(customer, recentMessages, { intent } = {}) {
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
    lines.push(`This customer is not yet in the Ferra workout export. They may be brand new or pre-onboarding. No workout data available — anchor the message on the WhatsApp conversation alone.`);
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
    lines.push(`What I want to convey in this message (rough idea, in my own words — refine it into a real message): ${intent.trim()}`);
  } else {
    const lastFromCustomer = last20.length > 0 && !last20[last20.length - 1].from_me;
    lines.push(lastFromCustomer
      ? 'Draft my next reply.'
      : 'Draft my next outgoing accountability check-in.');
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
