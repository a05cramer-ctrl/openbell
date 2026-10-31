import { liveBoard } from './_lib/sources.js';
import { RULES } from './_lib/gap.js';

export default async function handler(req, res) {
  try {
    const b = await liveBoard(Date.now());
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ ok: true, rules: RULES, ...b });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=10');
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
}
