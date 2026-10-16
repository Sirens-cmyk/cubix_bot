// Vercel serverless function: Telegram login check, stats, arena (daily/weekly), Stars payments.
const crypto = require('crypto');

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, WEBHOOK_SECRET, SUPPORT_CONTACT } = process.env;
const PASS_STARS = parseInt(process.env.PASS_STARS || '100', 10);
const PASS_DAYS = 7;

const H = { apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
// Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys use only apikey.
if (!String(SUPABASE_SERVICE_KEY || '').startsWith('sb_')) H.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`;
const T = `${SUPABASE_URL}/rest/v1/players`;
const T_SC = `${SUPABASE_URL}/rest/v1/scores`;
const T_PAY = `${SUPABASE_URL}/rest/v1/payments`;

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
async function tgApi(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}
const total = r => parseInt((r.headers.get('content-range') || '*/0').split('/')[1], 10) || 0;

// UTC periods: daily = date, weekly = date of that week's Monday.
function periods(d = new Date()) {
  const wd = (d.getUTCDay() + 6) % 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - wd));
  return { daily: d.toISOString().slice(0, 10), weekly: mon.toISOString().slice(0, 10) };
}

async function arenaFor(id, per, passUntil) {
  const out = { periods: per, pass_until: passUntil, stars: PASS_STARS };
  for (const mode of ['daily', 'weekly']) {
    const q = `${T_SC}?mode=eq.${mode}&period=eq.${per[mode]}`;
    const lb = await (await sb(`${q}&order=ms.asc&limit=30&select=tg_id,ms,players(name,photo_url)`)).json();
    const mine = await (await sb(`${q}&tg_id=eq.${id}&select=ms`)).json();
    let best = null, rank = null;
    if (mine[0]) {
      best = mine[0].ms;
      const c = await sb(`${q}&ms=lt.${best}&select=tg_id&limit=1`, { headers: { Prefer: 'count=exact' } });
      rank = 1 + total(c);
    }
    out[mode] = {
      best, rank,
      board: lb.map(p => ({ id: p.tg_id, n: p.players ? p.players.name : 'Player', t: p.ms, photo: p.players && p.players.photo_url, me: p.tg_id === id }))
    };
  }
  return out;
}

// ---------- Telegram bot webhook (payments) ----------
async function handleHook(req, res) {
  if (!WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.status(401).end();
  const u = req.body || {};
  try {
    if (u.pre_checkout_query) {
      const q = u.pre_checkout_query;
      const ok = q.currency === 'XTR' && q.total_amount === PASS_STARS && q.invoice_payload === `pass:${q.from.id}`;
      await tgApi('answerPreCheckoutQuery', ok
        ? { pre_checkout_query_id: q.id, ok: true }
        : { pre_checkout_query_id: q.id, ok: false, error_message: 'This offer is no longer valid. Please reopen the app.' });
    } else if (u.message && u.message.successful_payment) {
      const sp = u.message.successful_payment, from = u.message.from.id;
      if (sp.currency === 'XTR' && sp.invoice_payload === `pass:${from}`) {
        const seen = await (await sb(`${T_PAY}?charge_id=eq.${encodeURIComponent(sp.telegram_payment_charge_id)}&select=charge_id`)).json();
        if (!seen.length) {
          const rows = await (await sb(`${T}?tg_id=eq.${from}&select=pass_until`)).json();
          const cur = rows[0] && rows[0].pass_until ? Date.parse(rows[0].pass_until) : 0;
          const until = new Date(Math.max(Date.now(), cur) + PASS_DAYS * 864e5).toISOString();
          await sb(`${T}?tg_id=eq.${from}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ pass_until: until }) });
          await sb(T_PAY, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ charge_id: sp.telegram_payment_charge_id, tg_id: from, stars: sp.total_amount }) });
          await tgApi('sendMessage', { chat_id: from, text: `Weekly pass active until ${until.slice(0, 10)}. Good luck in the arena!` });
        }
      }
    } else if (u.message && typeof u.message.text === 'string') {
      const text = u.message.text.trim().toLowerCase();
      if (text.startsWith('/paysupport')) {
        await tgApi('sendMessage', { chat_id: u.message.chat.id, text: `Payment help and refunds: contact ${SUPPORT_CONTACT || 'the bot owner'}. Please include your Telegram username and the time of purchase.` });
      } else if (text.startsWith('/start')) {
        await tgApi('sendMessage', { chat_id: u.message.chat.id, text: 'Tap the menu button below to open the game.' });
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(u.pre_checkout_query ? 200 : 500).json({ ok: false });
  }
}

// ---------- Mini app API ----------
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (req.body && req.body.update_id !== undefined) return handleHook(req, res);
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
    const per = periods(new Date(now));
    const hasPass = !!(me.pass_until && Date.parse(me.pass_until) > now);
    let scoreMs = 0, scoreMode = null, scorePeriod = null, invoice = null;

    if (event) {
      if (event.type === 'cube_start') {
        me.cube_started_at = new Date(now).toISOString(); me.run_mode = null; me.run_period = null;
      } else if (event.type === 'run_start') {
        const mode = event.mode === 'weekly' ? 'weekly' : 'daily';
        if (mode === 'weekly' && !hasPass) return res.status(403).json({ error: 'pass_required' });
        me.cube_started_at = new Date(now).toISOString(); me.run_mode = mode; me.run_period = per[mode];
      } else if (event.type === 'cube_solve') {
        // Time is measured on the server between start and finish, so it can't be faked from the client.
        const st = me.cube_started_at ? Date.parse(me.cube_started_at) : 0;
        const runMode = me.run_mode, runPeriod = me.run_period;
        me.cube_started_at = null; me.run_mode = null; me.run_period = null;
        const ms = st ? now - st : 0;
        if (ms >= 4000 && ms <= 3600000) {
          me.cube_solves += 1;
          if (me.cube_best_ms == null || ms < me.cube_best_ms) me.cube_best_ms = ms;
          if (runMode && runPeriod === per[runMode]) { scoreMs = ms; scoreMode = runMode; scorePeriod = runPeriod; }
        }
      } else if (event.type === 'sudoku_win') {
        me.sudoku_solved += 1;
      } else if (event.type === 'lesson') {
        const i = event.i | 0;
        if (i >= 0 && i < 7) me.lessons = event.done ? (me.lessons | (1 << i)) : (me.lessons & ~(1 << i));
      } else if (event.type === 'buy_pass') {
        const j = await tgApi('createInvoiceLink', {
          title: 'Weekly Arena Pass',
          description: '7 days of weekly tournaments and arena access.',
          payload: `pass:${id}`, provider_token: '', currency: 'XTR',
          prices: [{ label: 'Weekly pass', amount: PASS_STARS }]
        });
        if (!j.ok) throw new Error(JSON.stringify(j));
        invoice = j.result;
      }
    }
    me.updated_at = new Date().toISOString();
    await sb(`${T}?on_conflict=tg_id`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(me) });

    if (scoreMs) {
      const q = `${T_SC}?tg_id=eq.${id}&mode=eq.${scoreMode}&period=eq.${scorePeriod}&select=ms`;
      const ex = await (await sb(q)).json();
      if (!ex[0] || scoreMs < ex[0].ms) {
        await sb(`${T_SC}?on_conflict=tg_id,mode,period`, {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ tg_id: id, mode: scoreMode, period: scorePeriod, ms: scoreMs, updated_at: new Date().toISOString() })
        });
      }
    }

    const lb = await (await sb(`${T}?cube_best_ms=not.is.null&order=cube_best_ms.asc&limit=50&select=tg_id,name,photo_url,cube_best_ms`)).json();
    let rank = null;
    if (me.cube_best_ms != null) {
      const c = await sb(`${T}?cube_best_ms=lt.${me.cube_best_ms}&select=tg_id&limit=1`, { headers: { Prefer: 'count=exact' } });
      rank = 1 + total(c);
    }
    const all = await sb(`${T}?select=tg_id&limit=1`, { headers: { Prefer: 'count=exact' } });

    const wantArena = event && (event.type === 'arena' || event.type === 'cube_solve');
    res.status(200).json({
      me: { cube_best_ms: me.cube_best_ms, cube_solves: me.cube_solves, sudoku_solved: me.sudoku_solved, lessons: me.lessons, pass_until: me.pass_until || null },
      board: lb.map(p => ({ id: p.tg_id, n: p.name, t: p.cube_best_ms, photo: p.photo_url, me: p.tg_id === id })),
      rank,
      total: total(all),
      invoice,
      arena: wantArena ? await arenaFor(id, per, me.pass_until || null) : undefined
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
};
      
