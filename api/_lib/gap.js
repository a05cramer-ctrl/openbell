// Pure gap / target / exit / accounting logic. No network. Shared by api/board.js and the engine.
import { marketState, sessionOpeningAfter, lastSession } from './session.js';

export const RULES = Object.freeze({
  MIN_VOL_USD: 50_000,   // 24h on-chain volume floor
  ENTRY_GAP_BPS: -150,   // buy only at a discount of 1.5% or more
  EXIT_BAND_BPS: 30,     // gap "closed" when on-chain is within 0.3% of the real price
  OPEN_REF_MAX_AGE_MS: 20 * 60_000, // during a session the real price must be this fresh
});

/** Map a tokenized-stock symbol to its listed ticker: NVDAx -> NVDA, SPYx -> SPY, BRK.Bx -> BRK-B. */
export function toTicker(symbol, category) {
  if (!symbol) return null;
  let s = String(symbol).trim();
  const isX = category === 'xstock' ? /x$/i.test(s) : /^[A-Z0-9.]+x$/.test(s);
  if (isX && s.length > 1) s = s.slice(0, -1);
  s = s.toUpperCase().replace(/\./g, '-');
  if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(s)) return null;
  return s;
}

/** Gap in basis points (float). Negative = on-chain trades below the real price. */
export function gapBps(onchain, real) {
  if (!(onchain > 0) || !(real > 0)) return null;
  return (onchain / real - 1) * 10_000;
}

/** Is the real reference price usable at time `now` given the market state? */
export function refUsable(ref, now = Date.now(), ms = marketState(now)) {
  if (!ref || !(ref.price > 0) || !ref.time) return false;
  if (ms.state === 'OPEN') return now - ref.time <= RULES.OPEN_REF_MAX_AGE_MS;
  // Closed: price must be from the most recent completed session (or later).
  const last = lastSession(now);
  if (!last) return true;
  return ref.time >= last.open;
}

/**
 * Build board rows.
 * tokens: [{mint,symbol,name,icon,category,ticker,vol24h,onchain}]
 * refs:   { [ticker]: {price,time,source} }
 */
export function buildRows(tokens, refs, now = Date.now(), rules = RULES) {
  const ms = marketState(now);
  const rows = tokens.map((t) => {
    const ref = t.ticker ? refs[t.ticker] : null;
    const usable = refUsable(ref, now, ms);
    const g = usable ? gapBps(t.onchain, ref.price) : null;
    const eligible = g != null && t.vol24h >= rules.MIN_VOL_USD && g <= rules.ENTRY_GAP_BPS;
    return {
      mint: t.mint, symbol: t.symbol, name: t.name || null, icon: t.icon || null,
      category: t.category || null, ticker: t.ticker || null,
      onchain: t.onchain ?? null, vol24h: t.vol24h ?? null,
      real: usable ? ref.price : null, realTime: usable ? ref.time : null, realSource: usable ? ref.source : null,
      gapBps: g == null ? null : Math.round(g * 100) / 100,
      eligible, target: false,
    };
  });
  const tgt = pickTarget(rows, rules);
  if (tgt) rows.find((r) => r.mint === tgt.mint).target = true;
  return { market: ms, rows, target: tgt ? tgt.mint : null };
}

/** The treasury target: deepest discount among liquid rows past the entry threshold. */
export function pickTarget(rows, rules = RULES) {
  let best = null;
  for (const r of rows) {
    if (r.gapBps == null || !(r.vol24h >= rules.MIN_VOL_USD)) continue;
    if (r.gapBps > rules.ENTRY_GAP_BPS) continue;
    if (!best || r.gapBps < best.gapBps || (r.gapBps === best.gapBps && r.vol24h > best.vol24h)) best = r;
  }
  return best;
}

/** Deadline for a position: close of the first regular session that opens after entry. */
export function exitDeadline(entryMs) {
  return sessionOpeningAfter(entryMs)?.close ?? null;
}

/**
 * Should an open position be sold?
 * position: {mint, entryAt}
 * row: current board row for that mint (may be missing)
 */
export function shouldExit(position, row, now = Date.now(), rules = RULES) {
  if (row && row.gapBps != null && Math.abs(row.gapBps) <= rules.EXIT_BAND_BPS) {
    return { exit: true, reason: 'GAP_CLOSED' };
  }
  const dl = exitDeadline(position.entryAt);
  if (dl != null && now >= dl) return { exit: true, reason: 'SESSION_CLOSED' };
  return { exit: false, reason: null, deadline: dl };
}

/** Realized PnL on a round trip, in lamports (BigInt). Only profit is burned. */
export function settle(costLamports, proceedsLamports) {
  const cost = BigInt(costLamports);
  const proceeds = BigInt(proceedsLamports);
  const pnl = proceeds - cost;
  return { pnl, burnLamports: pnl > 0n ? pnl : 0n, principalBack: proceeds > cost ? cost : proceeds };
}

/** Running totals after a settled sell and its buyback burn. */
export function applyLedger(ledger, { pnl = 0n, burnedRaw = 0n, burnSpentLamports = 0n, sell = false } = {}) {
  return {
    realizedPnlLamports: (BigInt(ledger?.realizedPnlLamports ?? 0) + BigInt(pnl)).toString(),
    burnedRaw: (BigInt(ledger?.burnedRaw ?? 0) + BigInt(burnedRaw)).toString(),
    burnSpentLamports: (BigInt(ledger?.burnSpentLamports ?? 0) + BigInt(burnSpentLamports)).toString(),
    trades: Number(ledger?.trades ?? 0) + (sell ? 1 : 0),
  };
}

/** Position size: all claimable SOL above a reserve, capped. All in lamports (BigInt). */
export function positionSize(balanceLamports, reserveLamports, maxLamports) {
  const free = BigInt(balanceLamports) - BigInt(reserveLamports);
  if (free <= 0n) return 0n;
  const max = BigInt(maxLamports);
  return free > max ? max : free;
}

// ---- memos -------------------------------------------------------------
export const memoBuy = (symbol, bps) => `OPENBELL|BUY|${symbol}|${Math.round(bps)}`;
export const memoSell = (symbol, pnlLamports) => `OPENBELL|SELL|${symbol}|${BigInt(pnlLamports).toString()}`;
export const memoBurn = (amountRaw) => `OPENBELL|BURN|${BigInt(amountRaw).toString()}`;

/** Parse an RPC `memo` field (may hold several memos like "[29] OPENBELL|BUY|NVDAx|-212; [4] gm"). */
export function parseMemos(field) {
  if (!field) return [];
  const out = [];
  const re = /OPENBELL\|(BUY|SELL|BURN)\|([^|;\s]+)(?:\|(-?\d+))?/g;
  let m;
  while ((m = re.exec(field))) {
    if (m[1] === 'BURN') out.push({ type: 'BURN', amountRaw: m[2] });
    else if (m[1] === 'BUY' && m[3] != null) out.push({ type: 'BUY', symbol: m[2], gapBps: Number(m[3]) });
    else if (m[1] === 'SELL' && m[3] != null) out.push({ type: 'SELL', symbol: m[2], pnlLamports: m[3] });
  }
  return out;
}

/** Fold a newest-first memo history into position + totals. */
export function foldHistory(events) {
  const chron = [...events].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  let position = null;
  let burnedRaw = 0n, realized = 0n, buys = 0, sells = 0;
  for (const e of chron) {
    if (e.type === 'BUY') { position = { symbol: e.symbol, gapBps: e.gapBps, time: e.time, sig: e.sig }; buys++; }
    else if (e.type === 'SELL') { realized += BigInt(e.pnlLamports); sells++; if (position && position.symbol === e.symbol) position = null; }
    else if (e.type === 'BURN') burnedRaw += BigInt(e.amountRaw);
  }
  return { position, burnedRaw: burnedRaw.toString(), realizedPnlLamports: realized.toString(), buys, sells };
}
