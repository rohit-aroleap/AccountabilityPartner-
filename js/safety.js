export const SAFETY = {
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  maxOutboundPerDay: 3,
  minMinutesBetweenOutbound: 240,
  replyWindowMinutes: 120,
  maxAutoTurnsPerSession: 4,
  optOutKeywords: ['stop', 'pause', 'mat karo', 'mat bhejo', "don't message", 'unsubscribe', 'leave me alone'],
};

export function checkOutboundSafety(config, now = new Date()) {
  const blocks = [];
  const warnings = [];

  if (config?.paused) blocks.push('Customer is paused');

  const ist = istHourMinute(now);
  if (inQuietHours(ist, SAFETY.quietHoursStart, SAFETY.quietHoursEnd)) {
    warnings.push(`Quiet hours (${SAFETY.quietHoursStart}–${SAFETY.quietHoursEnd} IST)`);
  }

  const today = istDateStr(now);
  if (config?.outboundCountDate === today && (config.outboundCountToday ?? 0) >= SAFETY.maxOutboundPerDay) {
    blocks.push(`Daily cap reached (${SAFETY.maxOutboundPerDay} messages)`);
  }

  if (config?.lastOutboundAt) {
    const minsSince = (now.getTime() - config.lastOutboundAt) / 60000;
    if (minsSince < SAFETY.minMinutesBetweenOutbound) {
      warnings.push(`Last sent ${Math.round(minsSince)} min ago (suggested gap ${SAFETY.minMinutesBetweenOutbound} min)`);
    }
  }

  return { ok: blocks.length === 0, blocks, warnings };
}

export function detectOptOut(messageText) {
  if (!messageText) return false;
  const t = String(messageText).toLowerCase();
  return SAFETY.optOutKeywords.some(k => t.includes(k));
}

export function istDateStr(date = new Date()) {
  return istParts(date).date;
}

export function istHourMinute(date = new Date()) {
  return istParts(date).hm;
}

function istParts(date) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60000);
  const iso = ist.toISOString();
  return { date: iso.slice(0, 10), hm: iso.slice(11, 16) };
}

function inQuietHours(hm, start, end) {
  if (start <= end) return hm >= start && hm < end;
  return hm >= start || hm < end;
}

export function nextOutboundCount(config, now = new Date()) {
  const today = istDateStr(now);
  return config?.outboundCountDate === today ? (config.outboundCountToday ?? 0) + 1 : 1;
}
