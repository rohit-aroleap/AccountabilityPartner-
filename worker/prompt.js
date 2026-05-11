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

export function getRecentDailyActivity(monthlySummaries, uid, days = 14) {
  const months = monthlySummaries[uid] || [];
  const all = {};
  for (const m of months) Object.assign(all, m.dailyActivity || {});
  return Object.entries(all)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, days)
    .map(([date, info]) => ({ date, ...info }));
}

export function getRecentHabitScores(habitHistory, uid, days = 14) {
  const months = habitHistory[uid] || [];
  const flat = {};
  for (const m of months) {
    for (const [k, v] of Object.entries(m)) {
      if (k.startsWith('dailyScores.')) flat[k.slice('dailyScores.'.length)] = v;
    }
  }
  return Object.entries(flat)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, days)
    .map(([date, info]) => ({ date, ...info }));
}

export function findUserInWorkout(raw, phoneDigits) {
  const all = [...(raw.users || []), ...(raw.cancelledUsers || [])];
  return all.find(u => String(u.phone || '').replace(/[^\d]/g, '') === phoneDigits) || null;
}

export function buildCronCheckinPrompt({ phone, user, raw, messages, istNow }) {
  const todayStr = istNow.iso.slice(0, 10);
  const lines = [];
  lines.push(`Today: ${todayStr} (${istNow.dayName}), ${istNow.hm} IST`);
  lines.push('');
  if (user) {
    lines.push(`Customer: ${user.name}`);
    lines.push(`Phone: +${phone}`);
    lines.push(`Habit score: ${Math.round(user.habitScore ?? 0)} / 100`);
    lines.push(`Tier: ${user.tierLabel || '—'}`);
    lines.push(`Segment: ${user.segment || '—'}`);
    lines.push(`Last active: ${user.lastActiveDate || '—'} (${user.daysSinceLastSession === 999 ? 'never' : `${user.daysSinceLastSession}d ago`})`);
    if (user.streak) {
      lines.push(`Streak: ${user.streak.days} days (${user.streak.active ? 'active' : 'broken'})`);
    }
    const activity = getRecentDailyActivity(raw.userMonthlySummaries || {}, user.uid, 14);
    const scores = getRecentHabitScores(raw.userHabitHistory || {}, user.uid, 14);
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
      for (const s of scores) lines.push(`  ${s.date}: ${Math.round(s.score)} (tier ${s.tier})`);
    }
  } else {
    lines.push(`Customer phone: +${phone}`);
    lines.push(`This customer is not yet in the Ferra workout export. They may be brand new, pre-onboarding, or haven't set up the machine. No workout data available.`);
    lines.push(`COACH PRIORITY: Get them onto the machine. Ask about blockers. Offer to help with setup or their first session.`);
  }

  lines.push('');
  lines.push('Recent WhatsApp messages (oldest first, last 20):');
  const last20 = (messages || []).slice(-20);
  if (last20.length === 0) {
    lines.push('  (no prior conversation)');
  } else {
    for (const m of last20) {
      const who = m.from_me ? 'me' : (user?.name || 'them');
      const ts = formatMessageTs(m.timestamp);
      const body = (m.body || '').replace(/\s+/g, ' ').trim();
      lines.push(`  [${ts} | ${who}] ${body}`);
    }
  }
  lines.push('');
  lines.push('This is the morning accountability check-in. Lead with workouts. Be specific to their data. If they replied last, acknowledge that briefly, then pivot to training.');
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
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
