// Network sources (server side: Vercel functions and the engine). Node 18+ global fetch.
import { toTicker, buildRows } from './gap.js';

const JUP = 'https://lite-api.jup.ag';
const STONKFUN = 'https://www.stonkfun.xyz/api/public/v1/pairs?launchable=true';
const UA = 'Mozilla/5.0 (compatible; openbell/1.0)';

async function getJSON(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function getText(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const vol = (t) => Number(t?.stats24h?.buyVolume || 0) + Number(t?.stats24h?.sellVolume || 0);

// ---------- discovery ----------
/** StonkFun launchable pairs, tokenized stocks only. Shape parsed defensively. */
export async function stonkfunStocks() {
  const j = await getJSON(STONKFUN);
  const list = Array.isArray(j) ? j : j.pairs || j.data || j.items || j.results || [];
  const out = [];
  for (const p of list) {
    const cat = String(p.category || p.type || p.kind || '').toLowerCase();
    if (cat !== 'backpack' && cat !== 'xstock' && cat !== 'xstocks') continue;
    const mint = p.mint || p.address || p.tokenMint || p.baseMint || p.token?.mint || p.token?.address || p.quoteMint;
    const symbol = p.symbol || p.ticker || p.token?.symbol || p.name;
    if (!mint || !symbol) continue;
    out.push({ mint, symbol, category: cat.startsWith('xstock') ? 'xstock' : 'backpack' });
  }
  return out;
}

/** Jupiter verified list filtered to tokenized stocks (tags: xstocks / backpack + stocks). */
export async function jupiterStocks() {
  const list = await getJSON(`${JUP}/tokens/v2/tag?query=verified`, {}, 12000);
  return (Array.isArray(list) ? list : []).filter((t) => {
    const tags = t.tags || [];
    return tags.includes('xstocks') || (tags.includes('backpack') && tags.includes('stocks')) || (tags.includes('stocks') && tags.includes('rwa'));
  });
}

/** Jupiter token metadata for a set of mints (search accepts comma-separated mints, up to 100). */
export async function jupiterTokens(mints) {
  const out = [];
  for (let i = 0; i < mints.length; i += 100) {
    const q = mints.slice(i, i + 100).join(',');
    const r = await getJSON(`${JUP}/tokens/v2/search?query=${encodeURIComponent(q)}`);
    if (Array.isArray(r)) out.push(...r);
  }
  return out;
}

/** Jupiter price v3 (50 ids per call). Returns {mint:{usdPrice, stockData?, ...}} */
export async function jupiterPrices(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 50) {
    const r = await getJSON(`${JUP}/price/v3?ids=${mints.slice(i, i + 50).join(',')}`);
    Object.assign(out, r || {});
  }
  return out;
}

let tokenCache = { at: 0, tokens: null };
/** Union of StonkFun + Jupiter discovery, with Jupiter metadata. Cached 10 min per instance. */
export async function discoverStocks() {
  if (tokenCache.tokens && Date.now() - tokenCache.at < 600_000) return tokenCache.tokens;
  const [sf, jv] = await Promise.allSettled([stonkfunStocks(), jupiterStocks()]);
  const byMint = new Map();
  if (jv.status === 'fulfilled') for (const t of jv.value) {
    byMint.set(t.id, { mint: t.id, symbol: t.symbol, category: (t.tags || []).includes('xstocks') || t.id.startsWith('Xs') ? 'xstock' : 'backpack', meta: t });
  }
  const missing = [];
  if (sf.status === 'fulfilled') for (const p of sf.value) {
    if (byMint.has(p.mint)) byMint.get(p.mint).category = p.category;
    else { byMint.set(p.mint, { ...p, meta: null }); missing.push(p.mint); }
  }
  if (missing.length) {
    try { for (const t of await jupiterTokens(missing)) if (byMint.has(t.id)) byMint.get(t.id).meta = t; } catch {}
  }
  const tokens = [...byMint.values()].map((x) => ({
    mint: x.mint,
    symbol: x.meta?.symbol || x.symbol,
    name: x.meta?.name || null,
    icon: x.meta?.icon || null,
    category: x.category,
    ticker: toTicker(x.meta?.symbol || x.symbol, x.category),
    vol24h: x.meta ? vol(x.meta) : null,
    onchain: x.meta?.usdPrice ?? null,
  }));
  if (!tokens.length) throw new Error('no tokenized stocks discovered');
  tokenCache = { at: Date.now(), tokens, sources: { stonkfun: sf.status, jupiter: jv.status } };
  return tokens;
}

// ---------- real-world prices ----------
/** Yahoo chart: regularMarketPrice is the live price in session and the official close after it. */
export async function yahooQuote(ticker) {
  const host = Math.random() < 0.5 ? 'query1' : 'query2';
  const j = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`, {}, 6000);
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || !(m.regularMarketPrice > 0) || !m.regularMarketTime) throw new Error('yahoo: no meta');
  return { price: m.regularMarketPrice, time: m.regularMarketTime * 1000, source: 'yahoo' };
}

/** Stooq batch CSV: Symbol,Date,Time,Open,High,Low,Close,Volume. Times are exchange-local-ish; use date+time as UTC-agnostic stamp. */
export async function stooqQuotes(tickers) {
  const out = {};
  if (!tickers.length) return out;
  const s = tickers.map((t) => `${t.toLowerCase()}.us`).join('+');
  const csv = await getText(`https://stooq.com/q/l/?s=${s}&f=sd2t2ohlcv&h&e=csv`);
  const lines = csv.trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const [sym, date, time, , , , close] = line.split(',');
    if (!sym || !date || date === 'N/D' || !(+close > 0)) continue;
    const tk = sym.replace(/\.US$/i, '').toUpperCase();
    // Stooq stamps US quotes in CET/CEST; treat as Europe/Warsaw wall time (UTC+1/+2) conservatively as UTC+1.
    const t = Date.parse(`${date}T${time || '22:00:00'}Z`) - 3600_000;
    out[tk] = { price: +close, time: t, source: 'stooq' };
  }
  return out;
}

/** Real prices for tickers: Yahoo first, Stooq for misses, Jupiter stockData last. */
export async function realPrices(tickers, jupPriceMap = {}, tickerToMint = {}) {
  const uniq = [...new Set(tickers.filter(Boolean))];
  const out = {};
  const ys = await Promise.allSettled(uniq.map((t) => yahooQuote(t)));
  ys.forEach((r, i) => { if (r.status === 'fulfilled') out[uniq[i]] = r.value; });
  const miss = uniq.filter((t) => !out[t]);
  if (miss.length) {
    try { Object.assign(out, await stooqQuotes(miss)); } catch {}
  }
  for (const t of uniq) {
    if (out[t]) continue;
    const sd = jupPriceMap[tickerToMint[t]]?.stockData;
    if (sd?.price > 0 && sd.updatedAt) out[t] = { price: sd.price, time: Date.parse(sd.updatedAt), source: 'jupiter-stockdata' };
  }
  return out;
}

/** The full board payload. */
export async function liveBoard(now = Date.now()) {
  const tokens = await discoverStocks();
  const mints = tokens.map((t) => t.mint);
  let prices = {};
  try { prices = await jupiterPrices(mints); } catch {}
  const fresh = tokens.map((t) => ({ ...t, onchain: prices[t.mint]?.usdPrice ?? t.onchain }));
  const tickerToMint = Object.fromEntries(fresh.filter((t) => t.ticker).map((t) => [t.ticker, t.mint]));
  const refs = await realPrices(fresh.map((t) => t.ticker), prices, tickerToMint);
  const board = buildRows(fresh.filter((t) => t.onchain > 0), refs, now);
  return { updatedAt: now, ...board, sources: tokenCache.sources || null };
}
