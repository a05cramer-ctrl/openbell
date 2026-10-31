import { realPrices, discoverStocks, jupiterPrices } from './_lib/sources.js';
import { marketState } from './_lib/session.js';

// GET /api/closes?t=NVDA,TSLA  (no t = every tokenized stock's ticker)
export default async function handler(req, res) {
  try {
    const q = String(req.query?.t || '').toUpperCase().split(',').map((s) => s.trim()).filter((s) => /^[A-Z][A-Z0-9-]{0,9}$/.test(s)).slice(0, 80);
    let tickers = q, jp = {}, t2m = {};
    if (!tickers.length) {
      const tokens = await discoverStocks();
      tickers = tokens.map((t) => t.ticker).filter(Boolean);
      t2m = Object.fromEntries(tokens.filter((t) => t.ticker).map((t) => [t.ticker, t.mint]));
      try { jp = await jupiterPrices(Object.values(t2m)); } catch {}
    }
    const prices = await realPrices(tickers, jp, t2m);
    const ms = marketState(Date.now());
    res.setHeader('Cache-Control', ms.state === 'OPEN' ? 's-maxage=60, stale-while-revalidate=60' : 's-maxage=600, stale-while-revalidate=600');
    res.status(200).json({ ok: true, market: ms, prices });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=10');
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
}
