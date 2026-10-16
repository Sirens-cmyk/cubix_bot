// Vercel serverless function: verifies Telegram login, stores stats in Supabase, returns leaderboard.
const crypto = require('crypto');

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const H = { apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
// Legacy service_role keys are JWTs and also go in Authorization; the new sb_secret_ keys use only the apikey header.
if (!String(SUPABASE_SERVICE_KEY || '').startsWith('sb_')) H.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`;
const T = `${SUPABASE_URL}/rest/v1/players`;

function verify(initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash || !p.get('user')) return null;
  p.delete('hash');
  const str = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  return JSON.parse(p.get('user'));
}

async function sb(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(await r.text());
  return r;
}
const total = r => parseInt((r.headers.get('content-range') || '*/0').split('/')[1], 10) || 0;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { initData, event } = req.body || {};
    const u = verify(initData || '');
    if (!u) return res.status(401).json({ error: 'bad auth' });

    const id = u.id;
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40) || 'Player';
    const rows = await (await sb(`${T}?tg_id=eq.${id}&select=*`)).json();
    const me = rows[0] || { tg_id: id, cube_best_ms: null, cube_solves: 0, cube_started_at: null, sudoku_solved: 0, lessons: 0 };
    me.name = name; me.username = u.username || null; me.photo_url = u.photo_url || null;

    const now = Date.now();
    if (event) {
      if (event.type === 'cube_start') {
        me.cube_started_at = new Date(now).toISOString();
      } else if (event.type === 'cube_solve') {
        // Time is measured on the server between start and finish, so it can't be faked from the client.
        const st = me.cube_started_at ? Date.parse(me.cube_started_at) : 0;
        me.cube_started_at = null;
        const ms = st ? now - st : 0;
        if (ms >= 4000 && ms <= 3600000) {
          me.cube_solves += 1;
          if (me.cube_best_ms == null || ms < me.cube_best_ms) me.cube_best_ms = ms;
        }
      } else if (event.type === 'sudoku_win') {
        me.sudoku_solved += 1;
      } else if (event.type === 'lesson') {
        const i = event.i | 0;
        if (i >= 0 && i < 7) me.lessons = event.done ? (me.lessons | (1 << i)) : (me.lessons & ~(1 << i));
      }
    }
    me.updated_at = new Date().toISOString();
    await sb(`${T}?on_conflict=tg_id`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(me) });

    const lb = await (await sb(`${T}?cube_best_ms=not.is.null&order=cube_best_ms.asc&limit=50&select=tg_id,name,photo_url,cube_best_ms`)).json();
    let rank = null;
    if (me.cube_best_ms != null) {
      const c = await sb(`${T}?cube_best_ms=lt.${me.cube_best_ms}&select=tg_id&limit=1`, { headers: { Prefer: 'count=exact' } });
      rank = 1 + total(c);
    }
    const all = await sb(`${T}?select=tg_id&limit=1`, { headers: { Prefer: 'count=exact' } });

    res.status(200).json({
      me: { cube_best_ms: me.cube_best_ms, cube_solves: me.cube_solves, sudoku_solved: me.sudoku_solved, lessons: me.lessons },
      board: lb.map(p => ({ id: p.tg_id, n: p.name, t: p.cube_best_ms, photo: p.photo_url, me: p.tg_id === id })),
      rank,
      total: total(all)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
};
