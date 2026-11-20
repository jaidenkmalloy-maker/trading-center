// Free GEX (gamma exposure) levels from Cboe's delayed SPX options chain.
// Dealer convention used by most public GEX tools: dealers long calls (+), short puts (-).
'use strict';
const CBOE_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json';
function parseSym(s) {
  const m = /^([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(String(s || '').trim()); if (!m) return null;
  const y = 2000 + +m[2].slice(0, 2), mo = +m[2].slice(2, 4), d = +m[2].slice(4, 6);
  return { root: m[1], exp: Date.UTC(y, mo - 1, d, 21, 0), type: m[3], k: +m[4] / 1000 };
}
const npdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function bsGamma(S, K, T, v, r) {
  r = r == null ? 0.04 : r; if (!(T > 0 && v > 0 && S > 0 && K > 0)) return 0;
  const sv = v * Math.sqrt(T), d1 = (Math.log(S / K) + (r + v * v / 2) * T) / sv; return npdf(d1) / (S * sv);
}
const q = x => Math.round(x * 4) / 4;
function computeGex(json, now, opt) {
  now = now || Date.now(); opt = opt || {};
  const d = json && (json.data || json), opts = d && d.options;
  if (!Array.isArray(opts) || !opts.length) throw new Error('the Cboe data had no options in it');
  const spot = +(d.current_price || d.close || d.last || d.price);
  if (!(spot > 0)) throw new Error('the Cboe data had no SPX price');
  const maxDays = opt.maxDays || 45, rows = [];
  for (const o of opts) {
    const p = parseSym(o.option); if (!p) continue;
    const T = (p.exp - now) / (365 * 864e5); if (T <= 0 || T > maxDays / 365) continue;
    const oi = +o.open_interest || 0; if (!oi) continue;
    let iv = +o.iv || 0; if (iv > 3) iv /= 100;   // accept 15.2 or 0.152
    rows.push({ k: p.k, type: p.type, T, oi, iv, g: +o.gamma || 0 });
  }
  if (rows.length < 20) throw new Error('only ' + rows.length + ' usable options in the Cboe data');
  const sgn = r => (r.type === 'C' ? 1 : -1), dollar = (g, oi, S) => g * oi * 100 * S * S * 0.01;
  const by = {};
  for (const r of rows) { const v = dollar(r.g || bsGamma(spot, r.k, r.T, r.iv), r.oi, spot) * sgn(r); const e = by[r.k] || (by[r.k] = { k: r.k, call: 0, put: 0 }); if (r.type === 'C') e.call += v; else e.put += v; }
  const near = Object.values(by).filter(s => Math.abs(s.k - spot) / spot < 0.1);
  let callWall = null, putWall = null;
  let bigCall = null, bigPut = null;
  for (const s of near) {
    if (s.call > 0 && s.k >= spot && (!callWall || s.call > callWall.call)) callWall = s;   // ceiling: the biggest call strike at or above the price
    if (s.put < 0 && s.k <= spot && (!putWall || s.put < putWall.put)) putWall = s;         // floor: the biggest put strike at or below the price
    if (s.call > 0 && (!bigCall || s.call > bigCall.call)) bigCall = s; if (s.put < 0 && (!bigPut || s.put < bigPut.put)) bigPut = s;
  }
  const tot = S => rows.reduce((a, r) => a + dollar(bsGamma(S, r.k, r.T, r.iv), r.oi, S) * sgn(r), 0);
  const grid = []; for (let i = -24; i <= 24; i++) grid.push(spot * (1 + i * 0.0025)); const vals = grid.map(tot);
  let flip = null;
  for (let i = 1; i < grid.length; i++) if (vals[i - 1] !== 0 && Math.sign(vals[i]) !== Math.sign(vals[i - 1])) { const z = grid[i - 1] + (grid[i] - grid[i - 1]) * vals[i - 1] / (vals[i - 1] - vals[i]); if (flip == null || Math.abs(z - spot) < Math.abs(flip - spot)) flip = z; }
  const exps = [...new Set(rows.map(r => r.T))].sort((a, b) => a - b), Tm = exps.find(t => t >= 1 / 365) || exps[0];
  const atm = rows.filter(r => r.T === Tm && r.iv > 0).sort((a, b) => Math.abs(a.k - spot) - Math.abs(b.k - spot)).slice(0, 4);
  const iv = atm.length ? atm.reduce((a, r) => a + r.iv, 0) / atm.length : null, move = iv ? spot * iv * Math.sqrt(1 / 252) : null;
  const total = tot(spot);
  return { spot, quoteTime: json.timestamp || d.timestamp || null, totalGex: total, regime: total >= 0 ? 'positive' : 'negative',
    callWall: callWall && callWall.k, putWall: putWall && putWall.k, biggestCallStrike: bigCall && bigCall.k, biggestPutStrike: bigPut && bigPut.k, method: 2, flip: flip == null ? null : q(flip),
    ivAtm: iv, ivHi: move ? q(spot + move) : null, ivLo: move ? q(spot - move) : null, nOptions: rows.length };
}
const _f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
function ctNow(ms) {   // trading day rolls at 5:00 pm CT, like the dashboard
  const p = {}; for (const x of _f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const mins = +p.hour * 60 + +p.minute; let day = p.year + '-' + p.month + '-' + p.day;
  if (mins >= 1020) day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) + 864e5).toISOString().slice(0, 10);
  return { day, mins, dow: p.weekday };
}
module.exports = { CBOE_URL, parseSym, bsGamma, computeGex, ctNow };
