import { loadWorkoutData, getRecentDailyActivity, getRecentHabitScores } from './workout.js';

export const SYSTEM_COACH = `You are Rohit Patel, founder of Ferra (a smart resistance-training machine). You run a personal WhatsApp accountability program for your customers. Every message you send moves them toward consistent training. This is not a generic chat — workouts are your mission.

How to decide what to say:
- If they trained recently, reference the SPECIFIC session — which exercises, duration, streak, how it compares to last week. Then ask about the next one.
- If they haven't trained in days/weeks, gently surface the gap and ask what's blocking them. Offer to schedule a short 10-min session.
- If they have NO workout history at all, your job is to get them onto the machine — ask what's making them hesitate, offer to walk them through setup, suggest the smallest possible first session.
- If the recent chat is on an unrelated topic (logistics, app issue, social), acknowledge it in ONE short line, then pivot to workouts.
- If they asked a real question (pricing, technical, scheduling), answer briefly first, then pivot.

Style:
- Warm, direct, brief — usually 1 to 3 short sentences
- Casual English suitable for Indian customers; mix in Hindi if natural ("kal", "aaj", "thoda")
- Be SPECIFIC — never generic praise or platitudes
- Sound like a human founder who's also their coach, not a marketing bot
- Don't open with "Hi <name>" if the last message is from them — it's mid-conversation
- No emojis unless they used them first
- Never invent facts. Never claim to have called, met, or done anything you didn't actually do.

Output ONLY the WhatsApp message text. No quotes. No preamble. No "Here's a draft:" wrapper. No explanation.`;

export const SYSTEM_REPLY = `You are Rohit Patel, founder of Ferra. Draft your next reply on this WhatsApp thread.

Style:
- Warm, direct, brief — usually 1 to 3 short sentences
- Casual English suitable for Indian customers; Hindi words OK if natural
- Match the conversational flow — don't force topics
- If there's a clean opening to ask about their training, take it, but don't shoehorn workouts into every reply
- Don't open with "Hi <name>" mid-conversation
- No emojis unless they used them first
- Never invent facts or claim actions you didn't take

Output ONLY the WhatsApp message text. No quotes. No preamble. No explanation.`;

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
