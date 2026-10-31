// NYSE regular-session clock (America/New_York). Shared by the site, the API and the engine.
// Calendar: NYSE Group release "2026, 2027 and 2028 Holiday and Early Closings Calendar" (Dec 23 2025).

export const TZ = 'America/New_York';

export const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  // 2028 (no New Year's Day holiday: Jan 1 is a Saturday)
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04',
  '2028-09-04', '2028-11-23', '2028-12-25',
]);

// Early closes at 13:00 ET.
export const EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);

export const OPEN_HM = [9, 30];
export const CLOSE_HM = [16, 0];
export const EARLY_CLOSE_HM = [13, 0];

const DAY = 86400000;
let _fmt;
function fmt() {
  if (!_fmt) {
    _fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
  }
  return _fmt;
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts in New York for an epoch ms. */
export function etParts(ms) {
  const o = {};
  for (const p of fmt().formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second,
    wd: WD[o.weekday],
  };
}

/** Epoch ms for a New York wall-clock time. */
export function etToUtc(y, m, d, h = 0, mi = 0) {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = etParts(guess);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess = want - (asUtc - guess);
  }
  return guess;
}

export const dayKey = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Regular session for a civil date, or null when the exchange is shut that day. */
export function sessionFor(y, m, d) {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const key = dayKey(y, m, d);
  if (wd === 0 || wd === 6) return null;
  if (HOLIDAYS.has(key)) return null;
  const early = EARLY_CLOSES.has(key);
  const [ch, cm] = early ? EARLY_CLOSE_HM : CLOSE_HM;
  return { day: key, open: etToUtc(y, m, d, OPEN_HM[0], OPEN_HM[1]), close: etToUtc(y, m, d, ch, cm), early };
}

function civilAdd(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/** First session (today or later) whose close is after `ms`. */
export function nextSession(ms) {
  const p = etParts(ms);
  for (let i = 0; i < 20; i++) {
    const [y, m, d] = civilAdd(p.y, p.m, p.d, i);
    const s = sessionFor(y, m, d);
    if (s && s.close > ms) return s;
  }
  return null;
}

/** Most recent session whose close is at or before `ms`. */
export function lastSession(ms) {
  const p = etParts(ms);
  for (let i = 0; i < 20; i++) {
    const [y, m, d] = civilAdd(p.y, p.m, p.d, -i);
    const s = sessionFor(y, m, d);
    if (s && s.close <= ms) return s;
  }
  return null;
}

/** First session whose OPEN is strictly after `ms`. */
export function sessionOpeningAfter(ms) {
  const p = etParts(ms);
  for (let i = 0; i < 20; i++) {
    const [y, m, d] = civilAdd(p.y, p.m, p.d, i);
    const s = sessionFor(y, m, d);
    if (s && s.open > ms) return s;
  }
  return null;
}

/**
 * Market state at `ms`.
 * state: OPEN | CLOSED | WEEKEND | HOLIDAY ; phase for CLOSED: PRE | AFTER
 */
export function marketState(ms = Date.now()) {
  const p = etParts(ms);
  const today = sessionFor(p.y, p.m, p.d);
  const key = dayKey(p.y, p.m, p.d);
  const next = nextSession(ms);
  const last = lastSession(ms);
  let state, phase = null;
  if (today && ms >= today.open && ms < today.close) state = 'OPEN';
  else if (p.wd === 0 || p.wd === 6) state = 'WEEKEND';
  else if (HOLIDAYS.has(key)) state = 'HOLIDAY';
  else { state = 'CLOSED'; phase = today && ms < today.open ? 'PRE' : 'AFTER'; }
  const nextOpen = state === 'OPEN' ? sessionOpeningAfter(ms)?.open ?? null : next?.open ?? null;
  return {
    now: ms, state, phase,
    session: state === 'OPEN' ? today : null,
    nextOpen,
    nextOpenDay: state === 'OPEN' ? sessionOpeningAfter(ms)?.day ?? null : next?.day ?? null,
    nextClose: next?.close ?? null,
    nextCloseEarly: !!next?.early,
    lastClose: last?.close ?? null,
    lastCloseDay: last?.day ?? null,
    etDay: key,
  };
}

/** Session open/close events strictly inside (from, to]. Used to ring the bell on real events. */
export function eventsBetween(from, to) {
  const out = [];
  const p = etParts(from);
  for (let i = 0; i < 3; i++) {
    const [y, m, d] = civilAdd(p.y, p.m, p.d, i);
    const s = sessionFor(y, m, d);
    if (!s) continue;
    if (s.open > from && s.open <= to) out.push({ type: 'OPEN', at: s.open, day: s.day });
    if (s.close > from && s.close <= to) out.push({ type: 'CLOSE', at: s.close, day: s.day, early: s.early });
  }
  return out.sort((a, b) => a.at - b.at);
}
