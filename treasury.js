import { parseMemos, foldHistory } from './_lib/gap.js';

const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// GET /api/treasury?wallet=<TREASURY>
export default async function handler(req, res) {
  const wallet = String(req.query?.wallet || '');
  const key = process.env.HELIUS_API_KEY;
  if (!B58.test(wallet)) return res.status(400).json({ ok: false, error: 'wallet' });
  if (!key) return res.status(503).json({ ok: false, error: 'HELIUS_API_KEY not set' });
  const url = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  try {
    const [bal, t1, t2, sigs] = await Promise.all([
      rpc(url, 'getBalance', [wallet, { commitment: 'confirmed' }]),
      rpc(url, 'getTokenAccountsByOwner', [wallet, { programId: TOKEN }, { encoding: 'jsonParsed' }]),
      rpc(url, 'getTokenAccountsByOwner', [wallet, { programId: TOKEN22 }, { encoding: 'jsonParsed' }]),
      rpc(url, 'getSignaturesForAddress', [wallet, { limit: 1000 }]),
    ]);
    const holdings = [...(t1?.value || []), ...(t2?.value || [])]
      .map((a) => a.account.data.parsed.info)
      .filter((i) => Number(i.tokenAmount.uiAmountString) > 0)
      .map((i) => ({ mint: i.mint, amount: i.tokenAmount.uiAmountString, raw: i.tokenAmount.amount, decimals: i.tokenAmount.decimals }));

    const events = [];
    for (const s of sigs || []) {
      if (s.err || !s.memo || !s.memo.includes('OPENBELL|')) continue;
      for (const m of parseMemos(s.memo)) events.push({ ...m, sig: s.signature, time: s.blockTime ? s.blockTime * 1000 : null });
    }
    const folded = foldHistory(events);

    // Entry cost of the open position: SOL that left the wallet in its BUY tx.
    let position = folded.position;
    if (position?.sig) {
      try {
        const tx = await rpc(url, 'getTransaction', [position.sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
        const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey || k);
        const i = keys.indexOf(wallet);
        if (i >= 0) position = { ...position, costLamports: String(tx.meta.preBalances[i] - tx.meta.postBalances[i]) };
      } catch {}
    }

    // Prices for live PnL (Jupiter price v3).
    let prices = {};
    try {
      const ids = [SOL, ...holdings.map((h) => h.mint)].slice(0, 50).join(',');
      prices = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`)).json();
    } catch {}

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=40');
    res.status(200).json({
      ok: true, wallet, updatedAt: Date.now(),
      solLamports: String(bal?.value ?? 0),
      solUsd: prices?.[SOL]?.usdPrice ?? null,
      holdings: holdings.map((h) => ({ ...h, usdPrice: prices?.[h.mint]?.usdPrice ?? null })),
      position,
      history: events.sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, 100),
      totals: { burnedRaw: folded.burnedRaw, realizedPnlLamports: folded.realizedPnlLamports, buys: folded.buys, sells: folded.sells },
    });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=10');
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
}
